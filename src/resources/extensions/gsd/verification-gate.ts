// GSD Extension — Verification Gate
// Pure functions for discovering and running verification commands.
// Discovery order (D003): task plan verify → preference → package.json scripts.
// First non-empty source wins.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { join, basename, delimiter, dirname } from "node:path";
import type { AuditWarning, RuntimeError, VerificationCheck, VerificationResult } from "./types.js";
import { DEFAULT_COMMAND_TIMEOUT_MS } from "./constants.js";
import { rewriteCommandWithRtk } from "../shared/rtk.js";
import { normalizePythonCommand } from "./python-resolver.js";
import {
  isWorkflowSurfaceAliasTool,
  isWorkflowToolSurfaceName,
  stripMcpToolPrefix,
} from "./workflow-tool-surface.js";

/** Target bytes of stdout/stderr retained per command. See `truncate` for the bound. */
const MAX_OUTPUT_BYTES = 10 * 1024;

/** Share of a truncation budget kept from the start; the remainder is kept from the end. */
const TRUNCATION_HEAD_SHARE = 0.3;

/** Below this budget the marker would cost more than the content it describes. */
const TRUNCATION_MARKER_FLOOR_BYTES = 64;

/**
 * Truncate to maxBytes by dropping the MIDDLE, keeping both ends.
 *
 * `maxBytes` bounds the retained OUTPUT, not the returned string: the inserted
 * marker sits on top of it. The guarantee is that the result is never longer
 * than the input, which is what the callers actually need. The overshoot is the
 * marker, about 35 bytes. The no-cut band above is wider than that, because the
 * result must shrink in characters as well as bytes: at a 200-byte budget a
 * value up to about 1.5x it is returned whole, falling to about 1.05x at 2,000.
 *
 * Operates on UTF-8 bytes, so the encode step normalises a lone surrogate to
 * U+FFFD before any cut happens. Unreachable from the gate, whose values come
 * pre-decoded from spawnSync, but it is part of the contract now this is
 * exported.
 *
 * Keeping only the head -- which this did -- discards the part that says what
 * went wrong. A failing command prints its error last, after whatever progress
 * output came before it, and a compound `a && b` is the worst case: a's log
 * fills the budget and b's error, the reason the check failed, is thrown away.
 * Nothing downstream can recover it, so the operator, the retry context and
 * the recovery record all get the progress log instead of the diagnosis. (The
 * evidence JSON is unaffected: verification-evidence.ts excludes stdout/stderr
 * by design.)
 *
 * Keeping only the tail would fix that shape and break the opposite one (a
 * compiler that reports errors first and then a summary), so keep both ends and
 * drop the middle. The split favours the tail because errors skew late.
 */
export function truncate(value: string | null | undefined, maxBytes: number): string {
  if (!value) return "";
  // Measure before allocating: this runs on every check's stdout and stderr at
  // capture, where most values are under budget and copying them is pure cost.
  if (Buffer.byteLength(value, "utf-8") <= maxBytes) return value;
  const buf = Buffer.from(value, "utf-8");
  // A budget too small to carry the marker would otherwise return the marker and
  // none of the content -- total silent loss. Keep the end and say nothing. No
  // current caller is near this, but the budget is a parameter of an exported
  // function and a computed one (`CAP - header.length`) can land here.
  if (maxBytes < TRUNCATION_MARKER_FLOOR_BYTES) {
    return buf.subarray(nextCharBoundary(buf, buf.byteLength - maxBytes)).toString("utf-8");
  }
  // Both cuts land on arbitrary byte offsets, so move them to character
  // boundaries first. Otherwise a multi-byte character straddling a cut decodes
  // to U+FFFD, and command output is full of them (nx, vite and esbuild all draw
  // boxes). The head cut always had this; the tail cut would add a second.
  const headEnd = priorCharBoundary(buf, Math.floor(maxBytes * TRUNCATION_HEAD_SHARE));
  let tailStart = Math.max(headEnd, nextCharBoundary(buf, buf.byteLength - (maxBytes - headEnd)));
  // Prefer starting the tail on a line boundary. A byte-aligned cut opens the
  // excerpt mid-line, and command output is full of ANSI escapes, so it can open
  // inside one -- printing literal escape text, or swallowing what follows. The
  // repo's own tool-output truncator cuts at line boundaries for the same reason.
  // Bounded, so a long line cannot cost the whole tail; unterminated output with
  // no newline at all keeps the byte boundary.
  const lineSnapLimit = Math.floor(maxBytes / 10);
  const nextNewline = buf.indexOf(0x0a, tailStart);
  if (nextNewline !== -1 && nextNewline + 1 < buf.byteLength && nextNewline - tailStart <= lineSnapLimit) {
    tailStart = nextNewline + 1;
  }
  // "at least", because these cuts layer. Capture caps at 10 KB for storage and
  // the display sites cap the result again at 2,000 / 500 / 200, so the value
  // arriving here often already carries a marker -- which then lands in the
  // middle this cut drops. Counting only our own loss would report 8 KB where 42
  // KB went missing. Summing the inner count instead would be exact only while
  // the marker keeps landing in the dropped middle, which is a silent dependency
  // on the budget ratios; a weaker claim that cannot go stale is worth more here
  // than a precise one that can.
  const cut = [
    buf.subarray(0, headEnd).toString("utf-8"),
    `...[at least ${tailStart - headEnd} bytes truncated]`,
    buf.subarray(tailStart).toString("utf-8"),
  ].join("\n");
  // Cutting only pays when the marker costs less than the bytes it removes; just
  // over the budget it does not, and the reader would lose a line of real output
  // to be told that one byte went missing. Measure rather than estimate -- an
  // approximate bound on the marker was wrong by a byte and the pathology
  // survived it.
  // Both units: a multi-byte input can shrink in bytes while growing in chars,
  // and callers such as MAX_FAILURE_CONTEXT_CHARS budget in chars.
  return Buffer.byteLength(cut, "utf-8") < buf.byteLength && cut.length < value.length ? cut : value;
}

/** True for a UTF-8 continuation byte, i.e. a byte that cannot start a character. */
function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

/** Move an index forward to the next UTF-8 character boundary at or after it. */
function nextCharBoundary(buf: Buffer, index: number): number {
  let i = Math.max(0, index);
  while (i < buf.byteLength && isContinuationByte(buf[i])) i += 1;
  return i;
}

/** Move an index back to the UTF-8 character boundary at or before it. */
function priorCharBoundary(buf: Buffer, index: number): number {
  let i = Math.min(index, buf.byteLength);
  while (i > 0 && isContinuationByte(buf[i])) i -= 1;
  return i;
}

// ─── Command Discovery ──────────────────────────────────────────────────────

/** Structured evidence staged by `gsd_task_complete` for the current Task. */
export interface TaskVerificationEvidence {
  command: string;
  exitCode: number;
  verdict: string;
  durationMs?: number;
}

export interface DiscoverCommandsOptions {
  preferenceCommands?: string[];
  taskPlanVerify?: string;
  /** Structured task-specific evidence supplied at completion (#1591). */
  taskEvidence?: TaskVerificationEvidence[];
  cwd: string;
}

/**
 * Task-specific evidence qualifies when at least one record exists and every
 * record reports a passing verdict with a zero exit code (#1591).
 */
export function hasQualifyingTaskEvidence(
  evidence: TaskVerificationEvidence[] | undefined,
): boolean {
  if (!evidence || evidence.length === 0) return false;
  return evidence.every((record) =>
    record.exitCode === 0 && /^(pass|passed)$/i.test((record.verdict ?? "").trim())
  );
}

export interface DiscoveredCommands {
  commands: string[];
  source: VerificationResult["discoverySource"];
}

/** Package.json script keys to probe, in order. */
const PACKAGE_SCRIPT_KEYS = ["typecheck", "lint", "test"] as const;
const INTERPRETER_PREFIX_RE = /^(bash|sh|zsh|node|python3?|ts-node|tsx):\s*/;

/**
 * Discover verification commands using the first-non-empty-wins strategy (D003):
 *   1. Task plan verify field (split on newlines)
 *   2. Explicit preference commands
 *   3. package.json scripts (typecheck, lint, test)
 *   4. Python pytest project markers
 *   5. Dependency-free Node test files
 *   6. None found
 */
export function discoverCommands(options: DiscoverCommandsOptions): DiscoveredCommands {
  const taskPlanVerify = options.taskPlanVerify && options.taskPlanVerify.trim()
    ? options.taskPlanVerify
    : undefined;
  let hasTaskPlanProse = false;
  let hasUnsafeTaskPlanCommand = false;

  // 1. Task plan verify field (commands are untrusted — sanitize)
  if (taskPlanVerify) {
    const commands: string[] = [];
    const candidates = taskPlanVerify
      .split(/\r?\n/)
      .map(c => c.trim())
      .filter(Boolean);
    for (const candidate of candidates) {
      const normalized = candidate.replace(INTERPRETER_PREFIX_RE, "").trim();
      const validation = validateVerificationCommand(normalized);
      if (validation.ok) {
        commands.push(normalized);
      } else if (isGsdWorkflowToolInvocation(normalized)) {
        // A GSD tool name describes tool-verified evidence, not a runnable
        // shell command — route to the task-plan-prose fallback instead of
        // executing exit-127 noise that false-fails the task (#1628).
        hasTaskPlanProse = true;
      } else if (validation.reason === "does not look like a runnable command") {
        hasTaskPlanProse = true;
      } else if (splitUnquotedStatements(normalized).some(s => !isLikelyCommand(s))) {
        // Rejected for unsafe syntax, but at least one `;`-separated clause reads
        // as prose — treat the whole candidate as a description, not a command.
        hasTaskPlanProse = true;
      } else {
        hasUnsafeTaskPlanCommand = true;
      }
    }
    if (commands.length > 0) {
      return { commands, source: "task-plan" };
    }
  }

  // 1b. Prose task verify backed by passing structured task evidence (#1591).
  // Task-specific evidence must not be silently replaced by unrelated
  // project-wide preference commands.
  if (
    hasTaskPlanProse &&
    !hasUnsafeTaskPlanCommand &&
    hasQualifyingTaskEvidence(options.taskEvidence)
  ) {
    return { commands: [], source: "task-plan-prose" };
  }

  // 2. Preference commands
  if (options.preferenceCommands && options.preferenceCommands.length > 0) {
    const filtered = options.preferenceCommands
      .map(c => c.trim())
      .filter(Boolean);
    if (filtered.length > 0) {
      return { commands: filtered, source: "preference" };
    }
  }

  // 3. package.json scripts
  const pkgPath = join(options.cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const raw = readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(raw);
      if (pkg && typeof pkg === "object" && pkg.scripts && typeof pkg.scripts === "object") {
        const commands: string[] = [];
        for (const key of PACKAGE_SCRIPT_KEYS) {
          if (typeof pkg.scripts[key] === "string") {
            commands.push(`npm run ${key}`);
          }
        }
        if (commands.length > 0) {
          return { commands, source: "package-json" };
        }
      }
    } catch {
      // Malformed package.json — fall through to "none"
    }
  }

  const pythonCommand = discoverPythonPytestCommand(options.cwd);
  if (pythonCommand) {
    return { commands: [pythonCommand], source: "python-project" };
  }

  const nodeTestCommand = discoverNodeTestFileCommand(options.cwd);
  if (nodeTestCommand) {
    return { commands: [nodeTestCommand], source: "node-test-file" };
  }

  if (hasTaskPlanProse && !hasUnsafeTaskPlanCommand) {
    return { commands: [], source: "task-plan-prose" };
  }

  // 6. Nothing found
  return { commands: [], source: "none" };
}

function discoverNodeTestFileCommand(cwd: string): string | null {
  let entries: Dirent[];
  try {
    entries = readdirSync(cwd, { withFileTypes: true });
  } catch {
    return null;
  }

  const testFile = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /^test-[A-Za-z0-9._-]+\.js$|^[A-Za-z0-9._-]+\.test\.js$/.test(name))
    .sort()[0];

  return testFile ? `node ${testFile}` : null;
}

function discoverPythonPytestCommand(cwd: string): string | null {
  const hasPythonTestFiles = hasPythonTests(join(cwd, "tests"));
  const hasPytestConfig = existsSync(join(cwd, "pytest.ini"));
  const pyprojectPath = join(cwd, "pyproject.toml");
  const hasPyproject = existsSync(pyprojectPath);

  if (!hasPythonTestFiles && !hasPytestConfig && !hasPyproject) {
    return null;
  }

  if (hasPytestConfig || hasPythonTestFiles) {
    return "python3 -m pytest";
  }

  try {
    const pyproject = readFileSync(pyprojectPath, "utf-8");
    if (
      pyproject.includes("[tool.pytest]") ||
      pyproject.includes("[tool.pytest.") ||
      pyproject.includes("[pytest]") ||
      pyproject.includes("[tool:pytest]")
    ) {
      return "python3 -m pytest";
    }
  } catch {
    // Ignore unreadable pyproject.toml and fall through.
  }

  return null;
}

function hasPythonTests(dir: string): boolean {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && hasPythonTests(path)) {
      return true;
    }
    if (entry.isFile() && /^test_.*\.py$|^.*_test\.py$/.test(entry.name)) {
      return true;
    }
  }

  return false;
}

// ─── Failure Context Formatting ──────────────────────────────────────────────

/** Target bytes of command output retained per failed check. See `truncate` for the bound. */
const MAX_FAILURE_OUTPUT_PER_CHECK = 2_000;

/**
 * Maximum total chars for the combined failure context.
 *
 * Must stay above one block's worth, because `formatFailureContext` keeps its
 * first block unconditionally; below that the backstop slice there becomes
 * reachable, and it is the one path that cuts a block rather than dropping it.
 *
 * A block is NOT `output + command + overhead`. `fenceFor` sizes each delimiter
 * past the longest backtick run in the output and emits it twice, so all-backtick
 * output costs about three times the output cap:
 *
 *     3 x MAX_FAILURE_OUTPUT_PER_CHECK + MAX_FAILURE_COMMAND_CHARS + ~260
 *
 * Measured worst case at the current values: 6,383 chars against this 10,000,
 * peaking at 2,034 backticks of stderr -- the largest input `truncate` still
 * returns unchanged, not at the 2,000 budget. The naive two-term formula gives
 * 2,460, so raising the output cap on that reading would look safe at 3,000
 * (true worst ~9,300) and go live at 3,300.
 *
 * `MAX_FAILURE_OUTPUT_PER_CHECK` is therefore the one to keep far below this,
 * not merely under it: it sizes the DELIMITER LINE, and the backstop closes the
 * fence it assumes the cut landed inside. A cut landing inside a ~2,000-char
 * opening delimiter would make the appended close an opener instead.
 */
const MAX_FAILURE_CONTEXT_CHARS = 10_000;

/**
 * Maximum code points of a check's command retained in its heading. The
 * per-check cap above bounds the OUTPUT only, so an unbounded command -- a
 * failing `node -e "<40 KB script>"` -- otherwise walks straight past the total
 * cap.
 */
const MAX_FAILURE_COMMAND_CHARS = 200;

/**
 * A fence long enough that nothing in `output` can close it early.
 *
 * A check's own output can contain a fence: a markdown linter, a doc test
 * echoing a snippet, a formatter over `.md`. With a three-backtick delimiter
 * that inner fence closes the block, the rest of the output leaks as prose, and
 * the block's own closing fence OPENS a new one -- which then swallows the
 * retry prompt appended after this text. Sizing the delimiter past the longest
 * run in the content is the standard fenced-block rule and needs no counting.
 */
function fenceFor(output: string): string {
  let longest = 0;
  for (const run of output.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * Format failed verification checks into a prompt-injectable text block.
 *
 * Each failed check gets a heading with the command name and exit code,
 * followed by a truncated stderr excerpt. Individual stderr is capped to
 * about 2 000 bytes (`truncate` bounds the retained output, not the returned
 * string); the total is capped to 10 000 chars plus the truncation marker,
 * which is appended after the check.
 *
 * The result is injected into a retry prompt that appends further instructions
 * AFTER it, so no code fence may be left open -- see `fenceFor`.
 *
 * Returns an empty string when all checks pass or the checks array is empty.
 */
export function formatFailureContext(result: VerificationResult): string {
  const failures = result.checks.filter((c) => c.exitCode !== 0);
  if (failures.length === 0) return "";

  const header = "## Verification Failures\n\n";
  const blocks: string[] = [];
  let truncated = false;

  for (const check of failures) {
    const hasStderr = (check.stderr ?? "").trim().length > 0;
    const outputLabel = hasStderr ? "stderr" : "stdout";
    // Same reasoning as the capture-time cut: this is one command's own output,
    // so the end is the part worth keeping. The TOTAL cap below is left alone --
    // it drops whole later checks, and the first failure is usually the root
    // cause with the rest cascading from it.
    const output = truncate(hasStderr ? check.stderr ?? "" : check.stdout ?? "", MAX_FAILURE_OUTPUT_PER_CHECK);
    // A `###` heading is one line, so flatten the command first. A newline in it
    // -- prose routed into a task plan's `Verify` field is a documented failure
    // mode -- otherwise breaks the heading, and a fence after that newline opens
    // a block that the delimiter below then closes, leaving the real block open.
    // Flattened, backticks in the command can only spoil an inline code span.
    // Trimmed as well, matching `formatFailureSignature` below, so a command
    // ending in a newline does not render a stray space inside the code span.
    const flat = check.command.replace(/\s+/gu, " ").trim();
    // Cut on code points so a surrogate pair cannot be split. `truncate` is the
    // sibling for this job and is deliberately not reused: it keeps both ends
    // around a marker containing a newline, which a heading cannot carry.
    const points = [...flat];
    const command = points.length > MAX_FAILURE_COMMAND_CHARS
      ? points.slice(0, MAX_FAILURE_COMMAND_CHARS).join("") + "...[command truncated]"
      : flat;
    const fence = fenceFor(output);
    const block = `### ❌ \`${command}\` (exit code ${check.exitCode})\n${fence}${outputLabel}\n${output}\n${fence}`;

    // Spend the cap per block. Slicing the joined body at a character offset
    // instead lands anywhere, including inside a block, leaving its fence open.
    // Bound by the body this will actually emit rather than by a running total,
    // which has to mirror the join and has nothing to catch it drifting. The
    // first block is kept unconditionally so at least one failure survives; the
    // backstop below is what keeps that from making the cap advisory.
    if (blocks.length > 0
      && header.length + [...blocks, block].join("\n\n").length > MAX_FAILURE_CONTEXT_CHARS) {
      truncated = true;
      break;
    }

    blocks.push(block);
  }

  let body = blocks.join("\n\n");

  if (header.length + body.length > MAX_FAILURE_CONTEXT_CHARS) {
    // Unreachable at the current constants, and kept so that raising a per-check
    // bound cannot silently make the total one advisory -- see
    // MAX_FAILURE_CONTEXT_CHARS. It can only ever cut the FIRST block: every
    // later one was pushed only after the joined body was measured under the cap,
    // so `blocks.length > 1` implies this cannot fire.
    //
    // Drop the partial last line before closing, so a cut landing inside a
    // delimiter cannot leave half of one for the close to pair with. What remains
    // ends at a line boundary, and the open delimiter is itself a run within
    // `cut`, so sizing the close against `cut` can never be short. With no line
    // boundary at all there is no block to close and nothing worth keeping --
    // appending a delimiter there would OPEN one, which is the defect this whole
    // function exists to prevent.
    const cut = body.slice(0, MAX_FAILURE_CONTEXT_CHARS - header.length);
    const lastBreak = cut.lastIndexOf("\n");
    body = lastBreak === -1 ? "" : `${cut.slice(0, lastBreak)}\n${fenceFor(cut)}`;
    truncated = true;
  }

  if (truncated) {
    body += "\n\n…[remaining failures truncated]";
  }

  return header + body;
}

export function formatFailureSignature(result: VerificationResult): string {
  return result.checks
    .filter((check) => check.exitCode !== 0)
    .map((check) => `${check.command.trim()}#${check.exitCode}`)
    .sort()
    .join("\n");
}

// ─── Gate Execution ─────────────────────────────────────────────────────────

/** Characters that indicate shell control syntax when unquoted in a command string. */
const UNQUOTED_SHELL_CONTROL_CHARS = new Set([";", "<", ">"]);
const EXIT_CODE_ECHO_SUFFIX = /^;\s*echo\s+(?:"exit:\$\?"|'exit:\$\?'|exit:\$\?)\s*$/;

function isAllowedExitCodeEchoSuffix(suffix: string): boolean {
  return EXIT_CODE_ECHO_SUFFIX.test(suffix);
}

/** Returns true when command text contains unquoted shell control syntax. */
function hasUnsafeShellSyntax(cmd: string): boolean {
  // Command substitution remains unsafe even when quoted with double quotes.
  if (cmd.includes("$(") || cmd.includes("`")) return true;

  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === "\"" && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && ch === "|" && cmd[i + 1] === "|") {
      return true;
    }
    if (!inSingle && !inDouble && UNQUOTED_SHELL_CONTROL_CHARS.has(ch)) {
      if (ch === ";" && isAllowedExitCodeEchoSuffix(cmd.slice(i))) {
        return hasUnsafeShellSyntax(cmd.slice(0, i).trim());
      }
      return true;
    }
  }

  return false;
}

/**
 * Split a candidate string on unquoted `;` into individual statements.
 * Used to re-classify prose-vs-command for candidates rejected as unsafe.
 */
function splitUnquotedStatements(cmd: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && !inSingle) {
      current += ch;
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === "\"" && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }
    if (ch === ";" && !inSingle && !inDouble) {
      statements.push(current);
      current = "";
      continue;
    }
    current += ch;
  }

  statements.push(current);
  return statements.map(s => s.trim()).filter(Boolean);
}

function splitLeadingShellWords(cmd: string): string[] {
  const words: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\" && !inSingle) {
      escaped = true;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }

    if (ch === "\"" && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if (!inSingle && !inDouble) {
      if (/\s/.test(ch)) {
        if (current) {
          words.push(current);
          current = "";
        }
        continue;
      }

      if ([";", "|", "&", "<", ">"].includes(ch)) {
        break;
      }
    }

    current += ch;
  }

  if (current) {
    words.push(current);
  }

  return words;
}

function isCountFlag(token: string): boolean {
  return (
    token === "--count" ||
    token.startsWith("--count=") ||
    token === "--count-matches" ||
    token.startsWith("--count-matches=") ||
    /^-[A-Za-z]*c[A-Za-z]*$/.test(token)
  );
}

function countSearchWarning(command: string, exitCode: number): string | null {
  if (exitCode !== 1) return null;

  const trimmed = command.trim();
  if (trimmed.startsWith("!")) return null;

  const [tool, ...args] = splitLeadingShellWords(trimmed);
  if (tool !== "grep" && tool !== "rg") return null;
  if (!args.some(isCountFlag)) return null;

  return `verification-gate: warning: '${tool} -c' returns exit 1 when count=0; for absence checks use '! ${tool} -q ...' instead.`;
}

function appendStderrWarning(stderr: string, warning: string | null): string {
  if (!warning) return stderr;
  const trimmed = stderr.trimEnd();
  return trimmed ? `${trimmed}\n${warning}` : warning;
}

/**
 * Known executable first-tokens that are safe to run.
 * Lowercase commands, common build/test tools, and npm/yarn/pnpm invocations.
 */
const KNOWN_COMMAND_PREFIXES = new Set([
  "npm", "npx", "yarn", "pnpm", "bun", "bunx", "deno",
  "uv",
  "node", "ts-node", "tsx", "tsc",
  "sh", "bash", "zsh",
  "echo", "cat", "ls", "test", "true", "false", "pwd", "env",
  "make", "cargo", "go", "python", "python3", "pip", "pip3",
  "ruby", "gem", "bundle", "rake",
  "java", "javac", "mvn", "gradle",
  "docker", "docker-compose",
  "git", "gh",
  "eslint", "prettier", "vitest", "jest", "mocha", "pytest", "phpunit",
  "curl", "wget",
  "grep", "find", "diff", "wc", "sort", "head", "tail",
]);

/**
 * English words that never appear as a shell sub-command or operand but are
 * common in descriptive prose. Deliberately excludes:
 *   - words that double as sub-commands (`build`, `test`, `show`, `run`, ...)
 *   - bare prepositions and single letters, which are plausible operands —
 *     `git diff on master` and `cat a b c` must stay commands
 */
const PROSE_MARKER_WORDS = new Set([
  "an", "the", "is", "are", "was", "were", "should", "shows", "showing",
  "returns", "contains", "confirms", "exists", "exits", "piped", "authored",
  "that", "which", "whether", "there", "its", "their",
]);

/** Is this token a prose marker, ignoring trailing sentence punctuation? */
function isProseMarker(token: string): boolean {
  return PROSE_MARKER_WORDS.has(token.toLowerCase().replace(/[.,;:!?]+$/, ""));
}

/**
 * A bare English word or number — nothing an operand would carry. No path
 * separator, dot, quote, uppercase letter or other shell-ish punctuation, which
 * is what keeps `README.md`, `packages/core/src` and `"the"` out.
 */
function isBareEnglishWord(token: string): boolean {
  const bare = token.replace(/[.,;:!?]+$/, "");

  return /^[a-z]+$/.test(bare) || /^[0-9]+$/.test(bare);
}

/**
 * Does a known-command-prefixed string read as prose rather than a command?
 * True when English function words appear where operands should — e.g.
 * "git log shows the scaffold commit authored by ...".
 *
 * A flag no longer disables the check outright. Bailing on
 * `tokens.some(t => t.startsWith("-"))` meant one flag anywhere disabled prose
 * detection for the whole line, so `git grep -n "Theming" README.md confirms
 * the section exists` ran verbatim and false-failed a task that had passed.
 *
 * The `tokens.length < 4` guard is load-bearing, not incidental: with it the
 * no-flags branch is EXACTLY the previous rule rewritten around markerIndex, so
 * nothing it calls prose today was called a command before. Drop the guard and
 * that branch genuinely widens — `grep exists f.txt` would flip.
 *
 * With flags present the rule is narrower than a bare marker hit: only a
 * TRAILING RUN of bare English words counts, so a real operand keeps the line
 * runnable (`git grep -n the README.md` stays a command because `README.md` is
 * not a bare word) while a description does not.
 *
 * Two further conditions on that run, both narrowing, both keeping the
 * canonical `<check> && echo <marker>` idiom runnable:
 *
 *   - A ONE-word run is an operand, not a sentence. Without this,
 *     `test -f dist/index.js && echo exists` reads as prose — the marker is the
 *     last token, so the run is the single word `exists` and passes `every`
 *     vacuously — and a check that used to run is silently skipped.
 *   - A run introduced by a command word is that command's arguments, so
 *     `... && echo the build exists` stays runnable too.
 *
 * Known trade-off: an unquoted marker word inside a trailing run of bare-word
 * operands (`git grep -n the`, `grep -rn contains src`) reads as prose and is
 * skipped rather than run. A quoted marker or one carrying a path separator,
 * dot or uppercase is unaffected. Skipping is the fail-safe direction — a
 * skipped check reports as unverified, an executed sentence fails a task that
 * succeeded.
 */
function readsAsProseAfterCommandWord(tokens: string[]): boolean {
  if (tokens.length < 4) return false;

  const markerIndex = tokens.findIndex((token, index) => index > 0 && isProseMarker(token));
  if (markerIndex === -1) return false;

  if (!tokens.some(t => t.startsWith("-"))) return true;

  const proseRun = tokens.slice(markerIndex);
  if (proseRun.length < 2) return false;
  if (KNOWN_COMMAND_PREFIXES.has(tokens[markerIndex - 1])) return false;

  return proseRun.every(isBareEnglishWord);
}

/**
 * Heuristic check: does this string look like an executable shell command
 * rather than a prose description?
 *
 * Returns true when the string appears to be a command. Returns false
 * for English prose (e.g. "Document exists, contains all 5 scale names").
 *
 * Heuristics (any true → command-like):
 *   1. First token is a known command prefix
 *   2. First token starts with `.` or `/` (path-like)
 *   3. Any token starts with `-` (flag-like)
 *   4. First token contains no uppercase letters (commands are lowercase)
 *      AND first token does not end with a comma or colon (prose punctuation)
 *
 * Heuristics (any true → prose-like):
 *   1. First token starts with an uppercase letter and the string has 4+ words
 *   2. String contains commas followed by spaces (prose clause structure)
 *   3. First token has no ASCII letters or digits and the string has 4+ words
 */
export function isLikelyCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (!trimmed) return false;

  const tokens = trimmed.split(/\s+/);
  const firstToken = tokens[0];
  const effectiveFirstToken = firstToken === "!" ? (tokens[1] ?? "") : firstToken;
  const effectiveTokens = firstToken === "!" ? tokens.slice(1) : tokens;
  if (firstToken === "!" && effectiveTokens.length === 0) return false;

  // Known command prefix → command, unless the rest reads as English prose
  if (KNOWN_COMMAND_PREFIXES.has(effectiveFirstToken)) {
    return !readsAsProseAfterCommandWord(effectiveTokens);
  }

  // Path-like first token → command, unless the rest reads as English prose.
  // "./out/report.txt exists and contains the summary" is a description of a
  // file, not an invocation of it.
  if (effectiveFirstToken.startsWith("/") || effectiveFirstToken.startsWith("./") || effectiveFirstToken.startsWith("../")) {
    return !readsAsProseAfterCommandWord(effectiveTokens);
  }

  // Has flag-like tokens → command
  if (effectiveTokens.some(t => t.startsWith("-"))) return true;

  // First token starts with uppercase + 4 or more words → prose
  if (/^[A-Z]/.test(effectiveFirstToken) && effectiveTokens.length >= 4) return false;

  // Contains comma-space patterns (prose clause separators) → prose
  if (/,\s/.test(trimmed) && tokens.length >= 4) return false;

  // First token has uppercase letters and no path separators → prose
  if (/[A-Z]/.test(effectiveFirstToken) && !effectiveFirstToken.includes("/")) return false;

  // Non-ASCII prose with multiple words should not be executed as a command.
  if (!/[A-Za-z0-9]/.test(effectiveFirstToken) && effectiveTokens.length >= 4) return false;

  // Everything above only rejects prose that announces itself with a capital
  // letter or comma. Lowercase prose fell through to "command" and got executed
  // — `greet/hello.txt exists and contains "hello"` ran the .txt file as a
  // program and failed with exit 126 "Permission denied", failing the gate for
  // a task that had in fact succeeded. English function words are the tell.
  return !readsAsProseAfterCommandWord(effectiveTokens);
}

/**
 * A verify line whose first word names a GSD workflow tool (e.g.
 * `gsd_exec_search limit 1 query D023`) can never run in a shell — executing
 * it yields exit 127 "command not found" and false-fails a task whose
 * substance already passed (#1628). Tool names come from the canonical
 * workflow tool surface (including MCP-prefixed and alias forms); the
 * reserved `gsd_*` namespace also covers planner-written near-tool names.
 * The bare `gsd` CLI is deliberately not matched — `gsd status` is a real
 * shell command.
 */
export function isGsdWorkflowToolInvocation(candidate: string): boolean {
  const firstToken = candidate.trim().replace(INTERPRETER_PREFIX_RE, "").split(/\s+/)[0] ?? "";
  if (!firstToken) return false;
  const baseName = stripMcpToolPrefix(firstToken);
  if (isWorkflowToolSurfaceName(baseName) || isWorkflowSurfaceAliasTool(baseName)) return true;
  return /^gsd_[a-z0-9_]+$/i.test(baseName);
}

/**
 * Find the first verify line that names a GSD workflow tool, for plan-time
 * rejection (#1628). Returns null when every line is tool-name-free.
 */
export function findGsdToolInvocationInVerify(verify: string): string | null {
  return verify
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => isGsdWorkflowToolInvocation(line)) ?? null;
}

/**
 * Plan-time guard (#1628): throw when a task verify names a GSD workflow tool,
 * so tool-name verifies never persist and never reach the gate as exit-127
 * noise. Shared by gsd_plan_task and gsd_replan_task.
 */
export function assertVerifyIsShellCheckable(verify: string): void {
  const toolVerifyLine = findGsdToolInvocationInVerify(verify);
  if (toolVerifyLine) {
    throw new Error(
      `verify must be a shell command, not a GSD tool invocation: "${toolVerifyLine}" — ` +
      "use a shell-checkable command, or describe the tool-verified outcome as prose",
    );
  }
}

/**
 * Validate a command string for obvious shell injection patterns.
 * Returns the command unchanged if safe, or null if suspicious.
 */
export function validateVerificationCommand(cmd: string): { ok: true } | { ok: false; reason: string } {
  if (isGsdWorkflowToolInvocation(cmd)) {
    return { ok: false, reason: "names a GSD workflow tool, which cannot run as a shell command" };
  }
  if (hasUnsafeShellSyntax(cmd)) {
    return { ok: false, reason: "contains shell control syntax such as `||` fallbacks, redirects, semicolons, backticks, or command substitution" };
  }
  if (!isLikelyCommand(cmd)) {
    return { ok: false, reason: "does not look like a runnable command" };
  }
  return { ok: true };
}

export interface RunVerificationGateOptions {
  cwd: string;
  preferenceCommands?: string[];
  taskPlanVerify?: string;
  /** Structured task-specific evidence supplied at completion (#1591). */
  taskEvidence?: TaskVerificationEvidence[];
  /** Per-command timeout in ms. Defaults to 120 000 (2 minutes). */
  commandTimeoutMs?: number;
}

export interface VerificationTarget {
  id: string;
  cwd: string;
  preferenceCommands?: string[];
}

/**
 * Where to look for a POSIX shell on Windows, in priority order.
 *
 * Deliberately NOT a bare "bash": on this platform PATH commonly resolves that
 * to the WSL launcher stub, which boots a VM instead of running the command.
 */
function windowsBashCandidates(env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  const explicit = env["GSD_VERIFICATION_SHELL"]?.trim();
  if (explicit) candidates.push(explicit);

  for (const root of [env["ProgramFiles"], env["ProgramW6432"], env["ProgramFiles(x86)"]]) {
    if (root) candidates.push(join(root, "Git", "usr", "bin", "bash.exe"));
  }
  if (env["LOCALAPPDATA"]) {
    candidates.push(join(env["LOCALAPPDATA"], "Programs", "Git", "usr", "bin", "bash.exe"));
  }

  return candidates;
}

export interface VerificationShell {
  /** Executable to spawn. */
  bin: string;
  /** Build the argv for a given command string. */
  args: (command: string) => string[];
  /**
   * Directory to prepend to PATH, or null. Spawning Git Bash directly skips the
   * launcher that puts `usr/bin` on PATH, so shell builtins like `test` work
   * while external tools like `grep` and `sed` fail with exit 127.
   */
  pathPrefix: string | null;
}

/** Is this resolved path a bash, as opposed to some other POSIX shell? */
function isBashExecutable(shellPath: string): boolean {
  return /^bash(\.exe)?$/i.test(basename(shellPath));
}

const POSIX_SHELL_ARGS = (command: string): string[] => [
  "-c",
  "if command -v bash >/dev/null 2>&1; then exec bash -o pipefail -c \"$1\" verification-gate; fi\nexec sh -c \"$1\" verification-gate",
  "verification-gate",
  command,
];

/**
 * Choose the shell that runs verify commands.
 *
 * Verify lines are POSIX shell commands (`test -f x`, `grep -q y z`, pipelines).
 * On Windows they were handed to `cmd.exe`, which fails on that syntax no matter
 * whether the task itself succeeded -- the gate then reported a
 * `verification-abort` for work that had actually passed. Prefer a real POSIX
 * shell when the host has one, and fall back to `cmd` when it does not so
 * machines without Git for Windows keep today's behaviour.
 *
 * `exists` is injected so every branch is testable without depending on what
 * happens to be installed on the machine running the tests.
 */
export function resolveVerificationShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): VerificationShell {
  if (platform !== "win32") {
    return { bin: "sh", args: POSIX_SHELL_ARGS, pathPrefix: null };
  }

  const bash = windowsBashCandidates(env).find((candidate) => exists(candidate));
  if (!bash) {
    return { bin: "cmd", args: (command) => ["/c", command], pathPrefix: null };
  }

  return {
    bin: bash,
    // `-o pipefail` is a bashism, and only the Git-for-Windows candidates are
    // known to be bash. GSD_VERIFICATION_SHELL names an arbitrary shell -- and
    // `sh.exe` ships in the same `usr/bin` as the bash this looks for -- so
    // handing it bash's argv fails EVERY check with `Illegal option -o
    // pipefail` rather than falling back. Anything not named bash gets the
    // portable argv, which re-execs bash when it is on PATH and runs sh
    // otherwise.
    args: isBashExecutable(bash)
      ? (command) => ["-o", "pipefail", "-c", command]
      : POSIX_SHELL_ARGS,
    // `<git>/usr/bin/bash.exe` -> `<git>/usr/bin`, derived rather than hardcoded.
    pathPrefix: dirname(bash),
  };
}

function verificationChildEnvironment(pathPrefix: string | null = null): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "GSD_PROJECT_ROOT",
    "GSD_MILESTONE_LOCK",
    "GSD_PARALLEL_WORKER",
    "GSD_SLICE_LOCK",
    "GSD_SLICE_WORKER_TOKEN",
  ]) {
    delete env[key];
  }

  if (pathPrefix) {
    // Windows env keys are case-insensitive but the object's are not, so find
    // whichever spelling this process actually has.
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    env[pathKey] = `${pathPrefix}${delimiter}${env[pathKey] ?? ""}`;
  }

  return env;
}

// When targets use different discovery methods, return the highest-priority
// source. Precedence: explicit preference > task-plan > package-json >
// python-project. This avoids a misleading "mixed" label while still
// surfacing that at least one authoritative source was active.
function mergeDiscoverySource(
  sources: VerificationResult["discoverySource"][],
): VerificationResult["discoverySource"] {
  if (sources.length === 0) return "none";
  const first = sources[0];
  if (sources.every((source) => source === first)) return first;
  const precedence: VerificationResult["discoverySource"][] = [
    "preference",
    "task-plan",
    "package-json",
    "python-project",
    "node-test-file",
    "task-plan-prose",
  ];
  for (const source of precedence) {
    if (sources.includes(source)) return source;
  }
  return "none";
}

/**
 * Run the verification gate: discover commands, execute each via spawnSync,
 * and return a structured result.
 *
 * - All commands run sequentially regardless of individual pass/fail.
 * - `passed` is true when every command exits 0 (or no commands are discovered).
 * - stdout/stderr per command are cut to about 10 KB (see `truncate`).
 */
export function runVerificationGate(options: RunVerificationGateOptions): VerificationResult {
  const timestamp = Date.now();

  const { commands, source } = discoverCommands({
    preferenceCommands: options.preferenceCommands,
    taskPlanVerify: options.taskPlanVerify,
    ...(options.taskEvidence ? { taskEvidence: options.taskEvidence } : {}),
    cwd: options.cwd,
  });

  if (commands.length === 0) {
    return {
      passed: true,
      checks: [],
      discoverySource: source,
      timestamp,
    };
  }

  const checks: VerificationCheck[] = [];

  for (const command of commands) {
    const start = Date.now();
    const rewrittenCommand = normalizePythonCommand(rewriteCommandWithRtk(command));
    // Pass the command string as an argument to the shell explicitly
    // to avoid Node.js DEP0190 (spawnSync with shell: true and no args).
    const shell = resolveVerificationShell();
    const result: SpawnSyncReturns<string> = spawnSync(shell.bin, shell.args(rewrittenCommand), {
      cwd: options.cwd,
      env: verificationChildEnvironment(shell.pathPrefix),
      stdio: "pipe",
      encoding: "utf-8",
      timeout: options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    });
    const durationMs = Date.now() - start;

    let exitCode: number;
    let stderr: string;

    // Left uncapped here on purpose: the cap is applied once, at the push below,
    // after the warning is appended. Truncating twice would put the second
    // middle cut through the first cut's marker, leaving a marker that reports
    // only what the second pass dropped -- 28 bytes where 34 KB went missing.
    if (result.error) {
      // Command not found or spawn failure
      exitCode = 127;
      stderr = (result.stderr || "") + "\n" + (result.error as Error).message;
    } else {
      // status is null when killed by signal — treat as failure
      exitCode = result.status ?? 1;
      stderr = result.stderr ?? "";
    }

    const warning = countSearchWarning(command, exitCode);

    checks.push({
      command,
      exitCode,
      stdout: truncate(result.stdout, MAX_OUTPUT_BYTES),
      stderr: truncate(appendStderrWarning(stderr, warning), MAX_OUTPUT_BYTES),
      durationMs,
    });
  }

  return {
    passed: checks.every(c => c.exitCode === 0),
    checks,
    discoverySource: source,
    timestamp,
  };
}

export function runVerificationGateForTargets(options: {
  targets: VerificationTarget[];
  preferenceCommands?: string[];
  taskPlanVerify?: string;
  /** Structured task-specific evidence supplied at completion (#1591). */
  taskEvidence?: TaskVerificationEvidence[];
  commandTimeoutMs?: number;
}): VerificationResult {
  const timestamp = Date.now();
  if (options.targets.length === 0) {
    return {
      passed: true,
      checks: [],
      discoverySource: "none",
      timestamp,
    };
  }

  const checks: VerificationCheck[] = [];
  const sources: VerificationResult["discoverySource"][] = [];
  let passed = true;

  for (const target of options.targets) {
    const result = runVerificationGate({
      cwd: target.cwd,
      preferenceCommands: options.preferenceCommands ?? target.preferenceCommands,
      taskPlanVerify: options.taskPlanVerify,
      ...(options.taskEvidence ? { taskEvidence: options.taskEvidence } : {}),
      commandTimeoutMs: options.commandTimeoutMs,
    });
    passed = passed && result.passed;
    sources.push(result.discoverySource);
    for (const check of result.checks) {
      checks.push({
        ...check,
        command: target.id === "project" ? check.command : `[${target.id}] ${check.command}`,
      });
    }
  }

  return {
    passed,
    checks,
    discoverySource: mergeDiscoverySource(sources),
    timestamp,
  };
}

// ─── Runtime Error Capture ──────────────────────────────────────────────────

/** Maximum characters of browser console text to retain per entry. */
const MAX_BROWSER_TEXT_CHARS = 500;

/** Fatal signals that indicate a crash regardless of other status fields. */
const FATAL_SIGNALS = new Set(["SIGABRT", "SIGSEGV", "SIGBUS"]);

/**
 * Injectable dependencies for captureRuntimeErrors.
 * When omitted the function uses dynamic import() to access
 * bg-shell's processes Map and browser-tools' getConsoleLogs().
 * Provide overrides in tests to avoid module mocking.
 */
export interface CaptureRuntimeErrorsOptions {
  getProcesses?: () => Map<string, unknown>;
  getConsoleLogs?: () => Array<{ type: string; text: string; timestamp: number; url: string }>;
}

/**
 * Scan bg-shell processes and browser console logs for runtime errors.
 *
 * Severity classification follows D004:
 *   - bg-shell status "crashed" → blocking crash
 *   - bg-shell !alive && exitCode !== 0 && exitCode !== null → blocking crash
 *   - bg-shell signal SIGABRT/SIGSEGV/SIGBUS → blocking crash
 *   - Browser console error with "Unhandled"/"UnhandledRejection" → blocking crash
 *   - Browser console error (general) → non-blocking error
 *   - Browser console warning with deprecation text → non-blocking warning
 *   - bg-shell alive process with recentErrors → non-blocking error
 *
 * Returns RuntimeError[] — empty when both sources are unavailable.
 */
export async function captureRuntimeErrors(
  options?: CaptureRuntimeErrorsOptions,
): Promise<RuntimeError[]> {
  const errors: RuntimeError[] = [];

  // ── bg-shell scan ─────────────────────────────────────────────────────
  try {
    let processes: Map<string, unknown>;
    if (options?.getProcesses) {
      processes = options.getProcesses();
    } else {
      const mod = await import("../bg-shell/process-manager.js");
      processes = mod.processes;
    }

    for (const [id, raw] of processes) {
      const proc = raw as {
        id: string;
        label?: string;
        status?: string;
        alive?: boolean;
        exitCode?: number | null;
        signal?: string | null;
        recentErrors?: string[];
      };

      const name = proc.label || proc.id || id;

      // Check for fatal signal first (applies regardless of alive/status)
      if (proc.signal && FATAL_SIGNALS.has(proc.signal)) {
        errors.push({
          source: "bg-shell",
          severity: "crash",
          message: buildBgShellMessage(name, proc.exitCode, proc.signal, proc.recentErrors),
          blocking: true,
        });
        continue;
      }

      // Crashed status
      if (proc.status === "crashed") {
        errors.push({
          source: "bg-shell",
          severity: "crash",
          message: buildBgShellMessage(name, proc.exitCode, proc.signal, proc.recentErrors),
          blocking: true,
        });
        continue;
      }

      // Non-zero exit on dead process
      if (
        !proc.alive &&
        proc.exitCode !== 0 &&
        proc.exitCode !== null &&
        proc.exitCode !== undefined
      ) {
        errors.push({
          source: "bg-shell",
          severity: "crash",
          message: buildBgShellMessage(name, proc.exitCode, proc.signal, proc.recentErrors),
          blocking: true,
        });
        continue;
      }

      // Alive process with recent errors — non-blocking
      if (proc.alive && proc.recentErrors && proc.recentErrors.length > 0) {
        const snippet = proc.recentErrors.slice(0, 3).join("; ");
        errors.push({
          source: "bg-shell",
          severity: "error",
          message: `[${name}] recent errors: ${snippet}`,
          blocking: false,
        });
      }
    }
  } catch {
    // bg-shell not available — skip silently
  }

  // ── browser console scan ──────────────────────────────────────────────
  try {
    let logs: Array<{ type: string; text: string; timestamp: number; url: string }>;
    if (options?.getConsoleLogs) {
      logs = options.getConsoleLogs();
    } else {
      const mod = await import("../browser-tools/state.js");
      logs = mod.getConsoleLogs();
    }

    for (const entry of logs) {
      const text =
        entry.text.length > MAX_BROWSER_TEXT_CHARS
          ? entry.text.slice(0, MAX_BROWSER_TEXT_CHARS) + "…[truncated]"
          : entry.text;

      if (entry.type === "error") {
        // Unhandled rejection / unhandled error → blocking crash
        if (/unhandled/i.test(entry.text)) {
          errors.push({
            source: "browser",
            severity: "crash",
            message: text,
            blocking: true,
          });
        } else {
          // General console.error → non-blocking error
          errors.push({
            source: "browser",
            severity: "error",
            message: text,
            blocking: false,
          });
        }
      } else if (entry.type === "warning" && /deprecated/i.test(entry.text)) {
        // Deprecation warning → non-blocking warning
        errors.push({
          source: "browser",
          severity: "warning",
          message: text,
          blocking: false,
        });
      }
      // Non-deprecation warnings are intentionally ignored
    }
  } catch {
    // browser-tools not available — skip silently
  }

  return errors;
}

/** Build a human-readable message for a bg-shell process error. */
function buildBgShellMessage(
  name: string,
  exitCode: number | null | undefined,
  signal: string | null | undefined,
  recentErrors: string[] | undefined,
): string {
  const parts: string[] = [`[${name}]`];
  if (signal) parts.push(`signal=${signal}`);
  if (exitCode !== null && exitCode !== undefined) parts.push(`exitCode=${exitCode}`);
  if (recentErrors && recentErrors.length > 0) {
    const snippet = recentErrors.slice(0, 3).join("; ");
    parts.push(`errors: ${snippet}`);
  }
  return parts.join(" ");
}

// ─── Dependency Audit ───────────────────────────────────────────────────────

/** Top-level dependency files that trigger an audit when changed. */
const DEPENDENCY_FILES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
]);

/**
 * Injectable dependencies for runDependencyAudit (D023 pattern).
 * When omitted the function uses real git/npm via spawnSync.
 * Provide overrides in tests to avoid real git repos and npm registries.
 */
export interface DependencyAuditOptions {
  gitDiff?: (cwd: string) => string[];
  npmAudit?: (cwd: string) => { stdout: string; exitCode: number };
}

/**
 * Default gitDiff: runs `git diff --name-only HEAD` and returns file paths.
 * Returns empty array on any failure (non-git dir, git not found, etc.).
 */
function defaultGitDiff(cwd: string): string[] {
  try {
    const result = spawnSync("git", ["diff", "--name-only", "HEAD"], {
      cwd,
      encoding: "utf-8",
      timeout: 10_000,
    });
    if (result.status !== 0 || !result.stdout) return [];
    return result.stdout.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Default npmAudit: runs `npm audit --audit-level=moderate --json`.
 * Returns { stdout, exitCode }. Non-zero exit is expected when vulnerabilities exist.
 */
function defaultNpmAudit(cwd: string): { stdout: string; exitCode: number } {
  const result = spawnSync("npm", ["audit", "--audit-level=moderate", "--json"], {
    cwd,
    encoding: "utf-8",
    timeout: 60_000,
  });
  return {
    stdout: result.stdout ?? "",
    exitCode: result.status ?? 1,
  };
}

/**
 * Detect dependency file changes and run npm audit if changes are found.
 *
 * - Calls gitDiff to get changed files, checks if any are top-level dependency files
 * - If no dependency files changed, returns []
 * - Runs npmAudit and parses JSON output into AuditWarning[]
 * - Never throws — all errors return []
 * - Non-zero npm audit exit code is expected (vulnerabilities found), not an error
 */
export function runDependencyAudit(
  cwd: string,
  options?: DependencyAuditOptions,
): AuditWarning[] {
  try {
    const gitDiff = options?.gitDiff ?? defaultGitDiff;
    const npmAudit = options?.npmAudit ?? defaultNpmAudit;

    // Get changed files and check for top-level dependency file matches
    const changedFiles = gitDiff(cwd);
    const hasDependencyChange = changedFiles.some((filePath) => {
      const name = basename(filePath);
      // Only match top-level files: the path must equal just the filename
      // (no directory separators) to be considered top-level
      return DEPENDENCY_FILES.has(name) && filePath === name;
    });

    if (!hasDependencyChange) return [];

    // Run npm audit
    const auditResult = npmAudit(cwd);

    // Parse JSON output — npm audit exits non-zero when vulnerabilities exist
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(auditResult.stdout);
    } catch {
      return [];
    }

    // Extract vulnerabilities from the parsed output
    const vulnerabilities = parsed.vulnerabilities;
    if (!vulnerabilities || typeof vulnerabilities !== "object") return [];

    const warnings: AuditWarning[] = [];
    for (const [name, raw] of Object.entries(vulnerabilities as Record<string, unknown>)) {
      const vuln = raw as {
        severity?: string;
        fixAvailable?: boolean;
        via?: unknown[];
      };
      if (!vuln || typeof vuln !== "object") continue;

      const severity = vuln.severity;
      if (
        severity !== "low" &&
        severity !== "moderate" &&
        severity !== "high" &&
        severity !== "critical"
      ) {
        continue;
      }

      // Find the first `via` entry that's an object (not a string reference)
      let title = name;
      let url = "";
      if (Array.isArray(vuln.via)) {
        for (const entry of vuln.via) {
          if (entry && typeof entry === "object" && !Array.isArray(entry)) {
            const obj = entry as { title?: string; url?: string };
            if (obj.title) title = obj.title;
            if (obj.url) url = obj.url;
            break;
          }
        }
      }

      warnings.push({
        name,
        severity: severity as AuditWarning["severity"],
        title,
        url,
        fixAvailable: vuln.fixAvailable === true,
      });
    }

    return warnings;
  } catch {
    return [];
  }
}
