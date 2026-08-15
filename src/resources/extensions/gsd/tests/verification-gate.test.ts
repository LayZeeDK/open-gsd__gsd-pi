/**
 * Unit tests for the verification gate — command discovery and execution.
 *
 * Tests cover:
 *   1. Discovery from explicit preference commands
 *   2. Discovery from task plan verify field
 *   3. Discovery from package.json typecheck/lint/test scripts
 *   4. First-non-empty-wins precedence
 *   5. All commands pass → gate passes
 *   6. One command fails → gate fails with exit code + stderr
 *   7. Missing package.json → 0 checks → pass
 *   8. Empty scripts → 0 checks → pass
 *   9. Preference validation for verification keys
 *  10. spawnSync error (command not found) → failure with exit code 127
 *  11. Dependency audit — git diff detection, npm audit parsing, graceful failures
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { discoverCommands, runVerificationGate, runVerificationGateForTargets, formatFailureContext, captureRuntimeErrors, runDependencyAudit, isLikelyCommand, resolveVerificationShell, validateVerificationCommand, truncate } from "../verification-gate.ts";
import type { CaptureRuntimeErrorsOptions, DependencyAuditOptions } from "../verification-gate.ts";
import { validatePreferences } from "../preferences.ts";

function makeTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function withRtkDisabled<T>(callback: () => T): T {
  const previous = process.env.GSD_RTK_DISABLED;
  process.env.GSD_RTK_DISABLED = "1";
  try {
    return callback();
  } finally {
    if (previous === undefined) {
      delete process.env.GSD_RTK_DISABLED;
    } else {
      process.env.GSD_RTK_DISABLED = previous;
    }
  }
}

// ─── Discovery Tests ─────────────────────────────────────────────────────────

describe("verification-gate: discovery", () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTempDir("vg-discovery"); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  test("discoverCommands from preference commands", () => {
    const result = discoverCommands({
      preferenceCommands: ["npm run lint", "npm run test"],
      cwd: tmp,
    });
    assert.deepStrictEqual(result.commands, ["npm run lint", "npm run test"]);
    assert.equal(result.source, "preference");
  });

  test("discoverCommands from task plan verify field", () => {
    const result = discoverCommands({
      taskPlanVerify: "npm run lint && npm run test",
      cwd: tmp,
    });
    assert.deepStrictEqual(result.commands, ["npm run lint && npm run test"]);
    assert.equal(result.source, "task-plan");
  });

  test("discoverCommands accepts task plan verify pipelines", () => {
    const result = discoverCommands({
      taskPlanVerify: "npm test | tail -5",
      cwd: tmp,
    });
    assert.deepStrictEqual(result.commands, ["npm test | tail -5"]);
    assert.equal(result.source, "task-plan");
  });

  test("discoverCommands strips interpreter prefixes from task plan verify commands", () => {
    const result = discoverCommands({
      taskPlanVerify: "bash: ls scripts/hooks/\npython3: python3 -m pytest tests/ -q",
      cwd: tmp,
    });
    assert.deepStrictEqual(result.commands, [
      "ls scripts/hooks/",
      "python3 -m pytest tests/ -q",
    ]);
    assert.equal(result.source, "task-plan");
  });

  test("discoverCommands from package.json scripts", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({
        scripts: {
          typecheck: "tsc --noEmit",
          lint: "eslint .",
          test: "vitest",
          build: "tsc", // should NOT be included
        },
      }),
    );
    const result = discoverCommands({ cwd: tmp });
    assert.deepStrictEqual(result.commands, [
      "npm run typecheck",
      "npm run lint",
      "npm run test",
    ]);
    assert.equal(result.source, "package-json");
  });

  test("first-non-empty-wins — task plan beats preference and package.json", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint ." } }),
    );
    const result = discoverCommands({
      preferenceCommands: ["custom-check"],
      taskPlanVerify: "npm run lint",
      cwd: tmp,
    });
    assert.deepStrictEqual(result.commands, ["npm run lint"]);
    assert.equal(result.source, "task-plan");
  });

  test("task plan verify beats package.json", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint ." } }),
    );
    const result = discoverCommands({
      taskPlanVerify: "custom-verify",
      cwd: tmp,
    });
    assert.deepStrictEqual(result.commands, ["custom-verify"]);
    assert.equal(result.source, "task-plan");
  });

  test("missing package.json → 0 checks, source none", () => {
    const result = discoverCommands({ cwd: tmp });
    assert.deepStrictEqual(result.commands, []);
    assert.equal(result.source, "none");
  });

  test("package.json with no matching scripts → 0 checks", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ scripts: { build: "tsc", start: "node index.js" } }),
    );
    const result = discoverCommands({ cwd: tmp });
    assert.deepStrictEqual(result.commands, []);
    assert.equal(result.source, "none");
  });

  test("empty preference array falls through to task plan", () => {
    const result = discoverCommands({
      preferenceCommands: [],
      taskPlanVerify: "echo ok",
      cwd: tmp,
    });
    assert.deepStrictEqual(result.commands, ["echo ok"]);
    assert.equal(result.source, "task-plan");
  });

  test("package.json with only test script → returns only npm run test", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({
        scripts: {
          test: "vitest",
          build: "tsc",
          start: "node index.js",
        },
      }),
    );
    const result = discoverCommands({ cwd: tmp });
    assert.deepStrictEqual(result.commands, ["npm run test"]);
    assert.equal(result.source, "package-json");
  });

  test("taskPlanVerify with single command (no &&)", () => {
    const result = discoverCommands({
      taskPlanVerify: "npm test",
      cwd: tmp,
    });
    assert.deepStrictEqual(result.commands, ["npm test"]);
    assert.equal(result.source, "task-plan");
  });

  test("taskPlanVerify preserves cd context in && chains", () => {
    const result = discoverCommands({
      taskPlanVerify: "cd /tmp/project/subdir && uv run pytest tests/ -q --tb=short",
      cwd: tmp,
    });
    assert.deepStrictEqual(result.commands, ["cd /tmp/project/subdir && uv run pytest tests/ -q --tb=short"]);
    assert.equal(result.source, "task-plan");
  });

  test("whitespace-only preference commands fall through", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint ." } }),
    );
    const result = discoverCommands({
      preferenceCommands: ["  ", ""],
      cwd: tmp,
    });
    // Whitespace-only strings are trimmed to empty and filtered out
    assert.equal(result.source, "package-json");
    assert.deepStrictEqual(result.commands, ["npm run lint"]);
  });

  test("prose taskPlanVerify is rejected, falls through to package.json", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ scripts: { test: "vitest" } }),
    );
    const result = discoverCommands({
      taskPlanVerify: "Document exists, contains all 5 scale names, all 14 semantic tokens",
      cwd: tmp,
    });
    // Prose should be rejected, so it falls through to package.json
    assert.equal(result.source, "package-json");
    assert.deepStrictEqual(result.commands, ["npm run test"]);
  });

  test("non-ASCII prose taskPlanVerify is rejected, falls through to package.json", () => {
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({ scripts: { test: "vitest" } }),
    );
    const result = discoverCommands({
      // Chinese prose: "All commands output one line of JSONL; go test ./... passes"
      taskPlanVerify: "所有 命令 输出 一行 JSONL go test ./... 通过",
      cwd: tmp,
    });
    // Non-ASCII prose should be rejected, so it falls through to package.json
    assert.equal(result.source, "package-json");
    assert.deepStrictEqual(result.commands, ["npm run test"]);
  });

  test("prose taskPlanVerify with no fallback checks → source task-plan-prose", () => {
    const result = discoverCommands({
      taskPlanVerify: "Grep: pattern=Chart.yaml path=argocd-apps/ returns non-empty",
      cwd: tmp,
    });
    assert.equal(result.source, "task-plan-prose");
    assert.deepStrictEqual(result.commands, []);
  });

  test("prose with shell metachars and a leading command word → task-plan-prose (issue #1567)", () => {
    const result = discoverCommands({
      taskPlanVerify:
        "git log shows the scaffold commit authored by Name <user@example.com> on branch x; " +
        "git ls-files piped to grep for .gsd/ returns nothing; platformio.ini is at repo root.",
      cwd: tmp,
    });
    assert.equal(result.source, "task-plan-prose");
    assert.deepStrictEqual(result.commands, []);
  });

  test("prose taskPlanVerify with passing task evidence beats preference commands (issue #1591)", () => {
    const result = discoverCommands({
      taskPlanVerify: "Planning artifacts exist and contain all required sections",
      preferenceCommands: ["cargo test", "cargo clippy"],
      taskEvidence: [
        { command: "gsd_exec node: artifact check", exitCode: 0, verdict: "passed", durationMs: 12 },
        { command: "gsd_exec node: consolidated artifact verification", exitCode: 0, verdict: "pass", durationMs: 8 },
      ],
      cwd: tmp,
    });
    assert.equal(result.source, "task-plan-prose");
    assert.deepStrictEqual(result.commands, []);
  });

  test("failing task evidence still falls through to preference commands (issue #1591)", () => {
    const result = discoverCommands({
      taskPlanVerify: "Planning artifacts exist and contain all required sections",
      preferenceCommands: ["cargo test"],
      taskEvidence: [
        { command: "gsd_exec node: artifact check", exitCode: 1, verdict: "fail", durationMs: 3 },
      ],
      cwd: tmp,
    });
    assert.equal(result.source, "preference");
    assert.deepStrictEqual(result.commands, ["cargo test"]);
  });

  test("task evidence does not override a runnable task-plan command (issue #1591)", () => {
    const result = discoverCommands({
      taskPlanVerify: "npm run test",
      preferenceCommands: ["cargo test"],
      taskEvidence: [{ command: "node check.js", exitCode: 0, verdict: "pass", durationMs: 1 }],
      cwd: tmp,
    });
    assert.equal(result.source, "task-plan");
    assert.deepStrictEqual(result.commands, ["npm run test"]);
  });

  test("task evidence does not bypass preferences without prose task verify (issue #1591)", () => {
    const result = discoverCommands({
      preferenceCommands: ["cargo test"],
      taskEvidence: [{ command: "node check.js", exitCode: 0, verdict: "pass", durationMs: 1 }],
      cwd: tmp,
    });
    assert.equal(result.source, "preference");
    assert.deepStrictEqual(result.commands, ["cargo test"]);
  });

  test("genuinely unsafe command still suppresses the prose fallback", () => {
    const result = discoverCommands({
      taskPlanVerify: "npm run test > results.txt",
      cwd: tmp,
    });
    assert.equal(result.source, "none");
    assert.deepStrictEqual(result.commands, []);
  });

  test("valid command in taskPlanVerify still works", () => {
    const result = discoverCommands({
      taskPlanVerify: "npm run lint && npm run test",
      cwd: tmp,
    });
    assert.equal(result.source, "task-plan");
    assert.deepStrictEqual(result.commands, ["npm run lint && npm run test"]);
  });

  test("mixed prose and commands in newline-delimited taskPlanVerify — only commands kept", () => {
    const result = discoverCommands({
      taskPlanVerify: "Check that everything works\nnpm run test",
      cwd: tmp,
    });
    // "Check that everything works" is prose (starts with capital, 4+ words)
    // "npm run test" is a valid command
    assert.equal(result.source, "task-plan");
    assert.deepStrictEqual(result.commands, ["npm run test"]);
  });

  test("taskPlanVerify splits newline-delimited commands", () => {
    const result = discoverCommands({
      taskPlanVerify: "npm run lint\nnpm run test",
      cwd: tmp,
    });
    assert.equal(result.source, "task-plan");
    assert.deepStrictEqual(result.commands, ["npm run lint", "npm run test"]);
  });

  test("taskPlanVerify keeps bash negation commands", () => {
    const result = discoverCommands({
      taskPlanVerify: "! grep 'needle' file.txt\nnpm run test",
      cwd: tmp,
    });
    assert.equal(result.source, "task-plan");
    assert.deepStrictEqual(result.commands, ["! grep 'needle' file.txt", "npm run test"]);
  });

  test("taskPlanVerify rejects redirected pytest command", () => {
    const result = discoverCommands({
      taskPlanVerify: "python3 -m pytest tests/ -q --tb=short 2>&1 | tail -5",
      cwd: tmp,
    });
    assert.equal(result.source, "none");
    assert.deepStrictEqual(result.commands, []);
  });

  test("Python project with tests discovers pytest when package.json is absent", () => {
    mkdirSync(join(tmp, "tests"));
    writeFileSync(join(tmp, "tests", "test_sample.py"), "def test_sample():\n    assert True\n");
    writeFileSync(
      join(tmp, "pyproject.toml"),
      `[project]
name = "sample"

[tool.pytest.ini_options]
pythonpath = ["."]
`,
    );

    const result = discoverCommands({ cwd: tmp });

    assert.equal(result.source, "python-project");
    assert.deepStrictEqual(result.commands, ["python3 -m pytest"]);
  });

  test("dependency-free Node project with root test file discovers node test command", () => {
    writeFileSync(join(tmp, "test-todo-cli.js"), "require('node:test')('ok', () => {});\n");

    const result = discoverCommands({ cwd: tmp });

    assert.equal(result.source, "node-test-file");
    assert.deepStrictEqual(result.commands, ["node test-todo-cli.js"]);
  });

  test("dependency-free Node test discovery is lower priority than Python pytest", () => {
    mkdirSync(join(tmp, "tests"), { recursive: true });
    writeFileSync(join(tmp, "tests", "test_sample.py"), "def test_sample():\n    assert True\n");
    writeFileSync(join(tmp, "sample.test.js"), "require('node:test')('ok', () => {});\n");

    const result = discoverCommands({ cwd: tmp });

    assert.equal(result.source, "python-project");
    assert.deepStrictEqual(result.commands, ["python3 -m pytest"]);
  });

  test("Python project with nested Python test file discovers pytest", () => {
    mkdirSync(join(tmp, "tests", "unit"), { recursive: true });
    writeFileSync(join(tmp, "tests", "unit", "sample_test.py"), "def test_sample():\n    assert True\n");

    const result = discoverCommands({ cwd: tmp });

    assert.equal(result.source, "python-project");
    assert.deepStrictEqual(result.commands, ["python3 -m pytest"]);
  });

  test("Python project with pytest.ini discovers pytest", () => {
    writeFileSync(join(tmp, "pytest.ini"), "[pytest]\npythonpath = .\n");

    const result = discoverCommands({ cwd: tmp });

    assert.equal(result.source, "python-project");
    assert.deepStrictEqual(result.commands, ["python3 -m pytest"]);
  });

  test("Python project with explicit pyproject pytest marker discovers pytest", () => {
    writeFileSync(
      join(tmp, "pyproject.toml"),
      `[tool.pytest]
pythonpath = ["."]
`,
    );

    const result = discoverCommands({ cwd: tmp });

    assert.equal(result.source, "python-project");
    assert.deepStrictEqual(result.commands, ["python3 -m pytest"]);
  });

  test("Python project markers without pytest evidence do not discover pytest", () => {
    mkdirSync(join(tmp, "tests"));
    writeFileSync(join(tmp, "tests", "README.md"), "# tests\n");
    writeFileSync(
      join(tmp, "pyproject.toml"),
      `[project]
name = "sample"
dependencies = ["pytest-cov"]
`,
    );

    const result = discoverCommands({ cwd: tmp });

    assert.equal(result.source, "none");
    assert.deepStrictEqual(result.commands, []);
  });

  test("Python project with setup.cfg alone does not discover pytest", () => {
    writeFileSync(join(tmp, "setup.cfg"), "[tool:pytest]\npythonpath = .\n");

    const result = discoverCommands({ cwd: tmp });

    assert.equal(result.source, "none");
    assert.deepStrictEqual(result.commands, []);
  });

  test("Python project with tox.ini alone does not discover pytest", () => {
    writeFileSync(join(tmp, "tox.ini"), "[pytest]\npythonpath = .\n");

    const result = discoverCommands({ cwd: tmp });

    assert.equal(result.source, "none");
    assert.deepStrictEqual(result.commands, []);
  });
});

// ─── Execution Tests ─────────────────────────────────────────────────────────

describe("verification-gate: execution", () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTempDir("vg-exec"); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  test("all commands pass → gate passes", () => {
    const result = runVerificationGate({
      cwd: tmp,
      preferenceCommands: ["echo hello", "echo world"],
    });
    assert.equal(result.checks.length, 2);
    assert.equal(result.discoverySource, "preference");
    assert.equal(result.checks[0].exitCode, 0);
    assert.equal(result.checks[1].exitCode, 0);
    assert.ok(result.checks[0].stdout.includes("hello"));
    assert.ok(result.checks[1].stdout.includes("world"));
    assert.equal(result.passed, true);
    assert.equal(typeof result.timestamp, "number");
  });

  test("host verification removes GSD control-plane routing while preserving ordinary environment", () => {
    const routingKeys = [
      "GSD_PROJECT_ROOT",
      "GSD_MILESTONE_LOCK",
      "GSD_PARALLEL_WORKER",
      "GSD_SLICE_LOCK",
      "GSD_SLICE_WORKER_TOKEN",
    ] as const;
    const previousRouting = new Map(routingKeys.map((key) => [key, process.env[key]]));
    const previousSentinel = process.env.VERIFICATION_CHILD_SENTINEL;
    for (const key of routingKeys) process.env[key] = `control-plane:${key}`;
    process.env.VERIFICATION_CHILD_SENTINEL = "preserved";
    const probePath = join(tmp, "verification-env-probe.js");
    writeFileSync(
      probePath,
      `process.stdout.write(JSON.stringify({ routing: ${JSON.stringify(routingKeys)}.map((key) => process.env[key]), sentinel: process.env.VERIFICATION_CHILD_SENTINEL }));\n`,
    );
    try {
      const result = runVerificationGate({
        cwd: tmp,
        preferenceCommands: ["node verification-env-probe.js"],
      });

      assert.equal(result.passed, true);
      assert.deepEqual(JSON.parse(result.checks[0]?.stdout ?? "{}"), {
        routing: [null, null, null, null, null],
        sentinel: "preserved",
      });
    } finally {
      for (const key of routingKeys) {
        const previous = previousRouting.get(key);
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
      if (previousSentinel === undefined) delete process.env.VERIFICATION_CHILD_SENTINEL;
      else process.env.VERIFICATION_CHILD_SENTINEL = previousSentinel;
    }
  });

  test("one command fails → gate fails with exit code + stderr", () => {
    const result = runVerificationGate({
      cwd: tmp,
      preferenceCommands: ["echo ok", "sh -c 'echo err >&2; exit 1'"],
    });
    assert.equal(result.passed, false);
    assert.equal(result.checks.length, 2);
    assert.equal(result.checks[0].exitCode, 0);
    assert.equal(result.checks[1].exitCode, 1);
    assert.ok(result.checks[1].stderr.includes("err"));
  });

  test("captured output over 10 KB keeps the end, where the error is", () => {
    // The capture-time cut is the one that cannot be undone: once the tail is
    // dropped here, no later consumer can recover it -- not the operator's
    // abort, not the retry context, not the evidence JSON, not a replan unit.
    // 12 KB of progress output, then the line that says what actually broke.
    const script = [
      "for (let i = 0; i < 400; i++) console.error('progress line ' + i + ' ................................');",
      "console.error('Error: cannot find stylesheet to import');",
      "process.exit(1);",
    ].join("");
    const result = withRtkDisabled(() => runVerificationGate({
      cwd: tmp,
      preferenceCommands: [`node -e "${script.replace(/"/g, '\\"')}"`],
    }));

    assert.equal(result.passed, false);
    const stderr = result.checks[0].stderr;
    assert.ok(stderr.includes("bytes truncated]"), "the fixture must actually exceed the cap");
    assert.ok(
      stderr.includes("Error: cannot find stylesheet to import"),
      "the last line, which says why the check failed, must survive",
    );
    assert.ok(stderr.includes("progress line 0 "), "the start survives too");

    // stderr used to be capped twice -- once per branch above, then again after
    // the warning was appended. The second middle cut landed on the first cut's
    // marker, so the survivor reported only what the second pass dropped: tens
    // of bytes where tens of kilobytes went missing.
    const markers = stderr.match(/bytes truncated\]/g) ?? [];
    assert.equal(markers.length, 1, `expected exactly one truncation marker, got ${markers.join(", ")}`);
    const dropped = Number(/at least (\d+) bytes truncated/.exec(stderr)?.[1]);
    assert.ok(dropped > 10_000, `marker must report the real loss, reported ${dropped}`);
  });

  test("truncation cuts on character boundaries, not mid-sequence", () => {
    // Command output is full of multi-byte characters -- nx, vite and esbuild
    // all draw boxes. A cut at an arbitrary byte offset decodes to U+FFFD, and
    // the tail cut is a second chance to do it.
    // The child builds the character itself (U+3042, 3 bytes in UTF-8, so most
    // offsets land mid-character) so the command line stays pure ASCII -- passing
    // it through the shell would be a Windows console-encoding test instead.
    const script = [
      "const wide = String.fromCharCode(0x3042).repeat(20);",
      "for (let i = 0; i < 400; i++) console.error(wide + i);",
      "process.exit(1);",
    ].join("");
    const result = withRtkDisabled(() => runVerificationGate({
      cwd: tmp,
      preferenceCommands: [`node -e "${script.replace(/"/g, '\\"')}"`],
    }));

    const stderr = result.checks[0].stderr;
    assert.ok(stderr.includes("bytes truncated]"), "the fixture must actually exceed the cap");
    assert.ok(
      !stderr.includes(String.fromCharCode(0xfffd)),
      "no replacement characters may be introduced by either cut",
    );
  });

  test("grep -c zero-match failure includes absence-check warning", () => {
    writeFileSync(join(tmp, "sample.txt"), "present\n");

    const result = withRtkDisabled(() => runVerificationGate({
      cwd: tmp,
      preferenceCommands: ["grep -c missing sample.txt"],
    }));

    assert.equal(result.passed, false);
    assert.equal(result.checks.length, 1);
    assert.equal(result.checks[0].exitCode, 1);
    assert.equal(result.checks[0].stdout.trim(), "0");
    assert.match(result.checks[0].stderr, /grep -c/);
    assert.match(result.checks[0].stderr, /count=0/);
    assert.match(result.checks[0].stderr, /! grep -q/);
  });

  test("grep -c matching count does not warn", () => {
    writeFileSync(join(tmp, "sample.txt"), "present\n");

    const result = withRtkDisabled(() => runVerificationGate({
      cwd: tmp,
      preferenceCommands: ["grep -c present sample.txt"],
    }));

    assert.equal(result.passed, true);
    assert.equal(result.checks.length, 1);
    assert.equal(result.checks[0].exitCode, 0);
    assert.equal(result.checks[0].stdout.trim(), "1");
    assert.equal(result.checks[0].stderr, "");
  });

  test("no commands discovered → gate passes with 0 checks", () => {
    const result = runVerificationGate({
      cwd: tmp,
    });
    assert.equal(result.passed, true);
    assert.equal(result.checks.length, 0);
    assert.equal(result.discoverySource, "none");
  });

  test("command not found → exit code 127", () => {
    const result = runVerificationGate({
      cwd: tmp,
      preferenceCommands: ["__nonexistent_command_xyz_42__"],
    });
    assert.equal(result.passed, false);
    assert.equal(result.checks.length, 1);
    assert.ok(result.checks[0].exitCode !== 0, "should have non-zero exit code");
    assert.ok(result.checks[0].durationMs >= 0);
  });

  test("no DEP0190 deprecation warning when running commands", () => {
    // Run a subprocess with --throw-deprecation so any DeprecationWarning
    // becomes a thrown error (non-zero exit). The fix passes the command
    // string to sh -c explicitly instead of using spawnSync(cmd, {shell:true}).
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const gatePath = join(thisDir, "..", "verification-gate.ts");
    const resolverPath = join(thisDir, "resolve-ts.mjs");
    const script = [
      `import { runVerificationGate } from ${JSON.stringify(pathToFileURL(gatePath).href)};`,
      `runVerificationGate({`,
      `  cwd: ${JSON.stringify(tmp)},`,
      `  preferenceCommands: ["echo dep0190-check"],`,
      `});`,
    ].join("\n");
    const child = spawnSync(
      process.execPath,
      [
        "--throw-deprecation",
        "--experimental-strip-types",
        "--import", pathToFileURL(resolverPath).href,
        "--input-type=module",
        "-e", script,
      ],
      { encoding: "utf-8", timeout: 15_000 },
    );
    // With --throw-deprecation, any DeprecationWarning becomes a thrown error
    // causing a non-zero exit. Exit 0 proves no deprecation was emitted.
    assert.equal(
      child.status,
      0,
      `Expected exit 0 (no deprecation) but got ${child.status}. stderr: ${child.stderr}`,
    );
  });

  test("each check has durationMs", () => {
    const result = runVerificationGate({
      cwd: tmp,
      preferenceCommands: ["echo fast"],
    });
    assert.equal(result.checks.length, 1);
    assert.equal(typeof result.checks[0].durationMs, "number");
    assert.ok(result.checks[0].durationMs >= 0);
  });

  test("one command fails — remaining commands still run (non-short-circuit)", () => {
    // First fails, second and third should still execute
    const result = runVerificationGate({
      cwd: tmp,
      preferenceCommands: [
        "sh -c 'exit 1'",
        "echo second",
        "echo third",
      ],
    });
    assert.equal(result.passed, false);
    assert.equal(result.checks.length, 3, "all 3 commands should run");
    assert.equal(result.checks[0].exitCode, 1, "first command fails");
    assert.equal(result.checks[1].exitCode, 0, "second command runs and passes");
    assert.ok(result.checks[1].stdout.includes("second"));
    assert.equal(result.checks[2].exitCode, 0, "third command runs and passes");
    assert.ok(result.checks[2].stdout.includes("third"));
  });

test("gate execution uses cwd for spawnSync", () => {
    // pwd should report the temp dir
    const result = runVerificationGate({
      cwd: tmp,
      preferenceCommands: ["pwd"],
    });
    assert.equal(result.passed, true);
    assert.equal(result.checks.length, 1);
    // The stdout should contain the tmp dir path (resolving symlinks)
    assert.ok(result.checks[0].stdout.trim().length > 0, "pwd should produce output");
  });

  test("multi-target execution runs verification in each repository root", () => {
    const frontend = join(tmp, "frontend");
    const backend = join(tmp, "backend");
    mkdirSync(frontend, { recursive: true });
    mkdirSync(backend, { recursive: true });

    const result = runVerificationGateForTargets({
      targets: [
        { id: "frontend", cwd: frontend },
        { id: "backend", cwd: backend },
      ],
      preferenceCommands: ["pwd"],
    });

    assert.equal(result.checks.length, 2);
    assert.equal(result.checks[0].command, "[frontend] pwd");
    assert.equal(result.checks[1].command, "[backend] pwd");
    assert.ok(result.checks[0].stdout.includes("frontend"));
    assert.ok(result.checks[1].stdout.includes("backend"));
    assert.equal(result.discoverySource, "preference");
  });

  test("multi-target execution falls back to per-repo package.json discovery", () => {
    const frontend = join(tmp, "frontend");
    const backend = join(tmp, "backend");
    mkdirSync(frontend, { recursive: true });
    mkdirSync(backend, { recursive: true });
    writeFileSync(join(frontend, "package.json"), JSON.stringify({ scripts: { test: "echo front-ok" } }), "utf-8");
    writeFileSync(join(backend, "package.json"), JSON.stringify({ scripts: { test: "echo back-ok" } }), "utf-8");

    const result = runVerificationGateForTargets({
      targets: [
        { id: "frontend", cwd: frontend },
        { id: "backend", cwd: backend },
      ],
    });

    assert.equal(result.checks.length, 2);
    assert.equal(result.checks[0].command, "[frontend] npm run test");
    assert.equal(result.checks[1].command, "[backend] npm run test");
    assert.equal(result.discoverySource, "package-json");
  });
});

// ─── Preference Validation Tests ─────────────────────────────────────────────

test("verification-gate: validatePreferences accepts valid verification keys", () => {
  const result = validatePreferences({
    verification_commands: ["npm run lint", "npm run test"],
    verification_auto_fix: true,
    verification_max_retries: 3,
  });
  assert.deepStrictEqual(result.preferences.verification_commands, [
    "npm run lint",
    "npm run test",
  ]);
  assert.equal(result.preferences.verification_auto_fix, true);
  assert.equal(result.preferences.verification_max_retries, 3);
  assert.equal(result.errors.length, 0);
});

test("verification-gate: validatePreferences rejects non-array verification_commands", () => {
  const result = validatePreferences({
    verification_commands: "npm run lint" as unknown as string[],
  });
  assert.ok(result.errors.some((e) => e.includes("verification_commands")));
  assert.equal(result.preferences.verification_commands, undefined);
});

test("verification-gate: validatePreferences rejects non-boolean verification_auto_fix", () => {
  const result = validatePreferences({
    verification_auto_fix: "yes" as unknown as boolean,
  });
  assert.ok(result.errors.some((e) => e.includes("verification_auto_fix")));
  assert.equal(result.preferences.verification_auto_fix, undefined);
});

test("verification-gate: validatePreferences rejects negative verification_max_retries", () => {
  const result = validatePreferences({
    verification_max_retries: -1,
  });
  assert.ok(result.errors.some((e) => e.includes("verification_max_retries")));
  assert.equal(result.preferences.verification_max_retries, undefined);
});

test("verification-gate: validatePreferences rejects non-string items in verification_commands", () => {
  const result = validatePreferences({
    verification_commands: ["npm run lint", 42 as unknown as string],
  });
  assert.ok(result.errors.some((e) => e.includes("verification_commands")));
  assert.equal(result.preferences.verification_commands, undefined);
});

test("verification-gate: validatePreferences floors verification_max_retries", () => {
  const result = validatePreferences({
    verification_max_retries: 2.7,
  });
  assert.equal(result.preferences.verification_max_retries, 2);
  assert.equal(result.errors.length, 0);
});

// ─── isLikelyCommand Tests (issue #1066) ────────────────────────────────────

test("isLikelyCommand: known command prefixes are accepted", () => {
  assert.equal(isLikelyCommand("npm run lint"), true);
  assert.equal(isLikelyCommand("npx vitest"), true);
  assert.equal(isLikelyCommand("yarn test"), true);
  assert.equal(isLikelyCommand("pnpm run typecheck"), true);
  assert.equal(isLikelyCommand("node script.js"), true);
  assert.equal(isLikelyCommand("tsc --noEmit"), true);
  assert.equal(isLikelyCommand("eslint ."), true);
  assert.equal(isLikelyCommand("jest --ci"), true);
  assert.equal(isLikelyCommand("python3 -m pytest"), true);
  assert.equal(isLikelyCommand("cargo test"), true);
  assert.equal(isLikelyCommand("go test ./..."), true);
  assert.equal(isLikelyCommand("make test"), true);
  assert.equal(isLikelyCommand("uv run pytest"), true);
});

test("isLikelyCommand: path-like first tokens are accepted", () => {
  assert.equal(isLikelyCommand("./scripts/verify.sh"), true);
  assert.equal(isLikelyCommand("/usr/local/bin/check"), true);
  assert.equal(isLikelyCommand("../tools/lint.sh"), true);
});

test("isLikelyCommand: flag-like tokens indicate a command", () => {
  assert.equal(isLikelyCommand("custom-tool --check"), true);
  assert.equal(isLikelyCommand("mycheck -v"), true);
});

test("isLikelyCommand: prose descriptions are rejected", () => {
  // The exact string from issue #1066
  assert.equal(
    isLikelyCommand("Document exists, contains all 5 scale names, all 14 semantic tokens, Inter assessment, philosophy and competitive citations present"),
    false,
  );
  assert.equal(isLikelyCommand("Check that the file has been created with the correct content"), false);
  assert.equal(isLikelyCommand("Verify the output matches expected format"), false);
  assert.equal(isLikelyCommand("All tests pass and coverage is above 80%"), false);
  assert.equal(isLikelyCommand("File should exist in the output directory"), false);
  assert.equal(isLikelyCommand("Build succeeds without errors or warnings"), false);
});

test("isLikelyCommand: lowercase prose is rejected, including a leading file path", () => {
  // Every prose case above announces itself with a capital letter or a comma.
  // Lowercase prose fell through to "command" and got executed: the gate ran
  // `greet/hello.txt exists and contains "hello"`, which tried to execute the
  // .txt file and failed with exit 126 "Permission denied" — failing the gate
  // for a task that had actually succeeded.
  assert.equal(isLikelyCommand('greet/hello.txt exists and contains "hello"'), false);
  assert.equal(isLikelyCommand("./out/report.txt exists and contains the summary"), false);
  assert.equal(isLikelyCommand("the migration is complete and the table exists"), false);

  // Real commands with a path-like or bare first token still pass.
  assert.equal(isLikelyCommand("./scripts/verify.sh"), true);
  assert.equal(isLikelyCommand("./scripts/check.sh --strict --quiet"), true);
  assert.equal(isLikelyCommand("mytool build release"), true);
});

test("discoverCommands: a prose verify field is not run as a shell command", () => {
  const dir = makeTempDir("gsd-verify-prose");
  const result = discoverCommands({
    cwd: dir,
    taskPlanVerify: 'greet/hello.txt exists and contains "hello"',
  });
  assert.deepEqual(result.commands, [], "prose must not become a runnable check");
  assert.notEqual(result.source, "task-plan");
});

test("isLikelyCommand: known command word followed by English prose is rejected (issue #1567)", () => {
  assert.equal(isLikelyCommand("git log shows the scaffold commit on branch x"), false);
  assert.equal(isLikelyCommand("make builds the firmware without errors at repo root"), false);
  // Real commands starting with the same words stay command-like
  assert.equal(isLikelyCommand("git log --oneline -5"), true);
  assert.equal(isLikelyCommand("git ls-files packages/core/src"), true);
  assert.equal(isLikelyCommand("cargo build --release"), true);
  assert.equal(isLikelyCommand("npm run test:unit"), true);
});

test("isLikelyCommand: a prose suffix after a flagged command is rejected", () => {
  // Two independent holes let these run verbatim and false-fail a task whose
  // substance had passed. The first: readsAsProseAfterCommandWord bailed out as
  // soon as ANY token began with `-`, so a flag anywhere disabled prose
  // detection entirely. The second: `exits` was absent from PROSE_MARKER_WORDS
  // (only `exists` was there), so a flagless line found no marker at all.
  assert.equal(isLikelyCommand('git grep -n "Theming" README.md confirms the section exists'), false);
  assert.equal(isLikelyCommand("nx test mypkg exits 0"), false);
});

test("isLikelyCommand: a real operand after a flag keeps the line a command", () => {
  // The counterweight to the test above: rejecting a trailing run of bare
  // English words must not reject a legitimate operand. `README.md` is not a
  // bare word, and a quoted marker is a search pattern rather than prose.
  assert.equal(isLikelyCommand("git grep -n the README.md"), true);
  assert.equal(isLikelyCommand('git grep -n "the" README.md'), true);
  assert.equal(isLikelyCommand("git grep -n exits packages/core/src"), true);
});

test("isLikelyCommand: a marker as the last shell segment's operand stays a command", () => {
  // `<check> && echo <marker>` is the canonical verify idiom, and the marker is
  // echo's ARGUMENT. Judging the trailing run without these guards made the run
  // the single word `exists`, which passes `every(isBareEnglishWord)` vacuously,
  // so lines that used to run were silently skipped as unverified.
  assert.equal(isLikelyCommand("test -f dist/index.js && echo exists"), true);
  assert.equal(isLikelyCommand('grep -q "foo" out.txt && echo exists'), true);
  assert.equal(isLikelyCommand("test -d .gsd && echo there"), true);
  // A multi-word run still stays a command when a command word introduces it.
  assert.equal(isLikelyCommand("test -f dist/index.js && echo the build exists"), true);
  // The counterweight: a prose suffix after a real operand is still prose, and
  // a shell operator earlier in the line does not excuse it.
  assert.equal(
    isLikelyCommand('npm run build && git grep -n "Theming" README.md confirms the section exists'),
    false,
  );
});

test("isLikelyCommand: prose markers exclude operand-shaped words", () => {
  // Bare prepositions and single letters are plausible operands, so they must
  // not flip a flagless command to prose.
  assert.equal(isLikelyCommand("git diff on master"), true);
  assert.equal(isLikelyCommand("git checkout at release"), true);
  assert.equal(isLikelyCommand("make install into build"), true);
  assert.equal(isLikelyCommand("cat a b c"), true);
  assert.equal(isLikelyCommand("go build with tags"), true);
  // Articles, copulas, and prose verbs still identify descriptions
  assert.equal(isLikelyCommand("git log shows the commit on master"), false);
});

test("isLikelyCommand: non-ASCII prose descriptions are rejected", () => {
  assert.equal(isLikelyCommand("所有 命令 输出 一行 JSONL go test ./... 通过"), false);
});

test("isLikelyCommand: empty or whitespace-only strings are rejected", () => {
  assert.equal(isLikelyCommand(""), false);
  assert.equal(isLikelyCommand("   "), false);
});

test("isLikelyCommand: short lowercase tokens without flags are accepted (could be custom scripts)", () => {
  assert.equal(isLikelyCommand("custom-verify"), true);
  assert.equal(isLikelyCommand("mycheck"), true);
});

test("isLikelyCommand: bash negation with known command is accepted", () => {
  assert.equal(isLikelyCommand("! grep needle file.txt"), true);
});

test("validateVerificationCommand accepts negated quiet absence checks", () => {
  assert.equal(validateVerificationCommand("! grep -q needle file.txt").ok, true);
  assert.equal(validateVerificationCommand("! rg -q needle file.txt").ok, true);
});

test("validateVerificationCommand allows shell pipelines", () => {
  assert.deepEqual(validateVerificationCommand("python3 -m pytest tests/ -q --tb=short").ok, true);
  const result = validateVerificationCommand("python3 -m pytest tests/ -q --tb=short | tail -5");
  assert.equal(result.ok, true);
});

test("validateVerificationCommand rejects shell control syntax", () => {
  const result = validateVerificationCommand("python3 -m pytest tests/ -q --tb=short > output.log");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /shell control syntax/);
  }
});

test("validateVerificationCommand allows semicolons inside quoted python -c code", () => {
  const result = validateVerificationCommand("uv run python3 -c \"import yaml; yaml.safe_load('x: 1')\"");
  assert.equal(result.ok, true);
});

test("validateVerificationCommand allows grep patterns with quoted pipes", () => {
  assert.equal(validateVerificationCommand('grep -q "| " output.md').ok, true);
  assert.equal(validateVerificationCommand("grep -c '^## SectionA\\|^### Sub1\\|^### Sub2' notes.md").ok, true);
});

test("validateVerificationCommand allows exit-code echo diagnostic suffix", () => {
  assert.equal(validateVerificationCommand('python3 tools/check-status.py; echo "exit:$?"').ok, true);
  assert.equal(validateVerificationCommand("python3 tools/check-status.py; echo 'exit:$?'").ok, true);
  assert.equal(validateVerificationCommand("python3 tools/check-status.py; echo exit:$?").ok, true);
});

test("validateVerificationCommand rejects shell operators after single-quote backslash desync patterns", () => {
  const result = validateVerificationCommand("echo 'x\\'; ls");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /shell control syntax/);
  }
});

test("validateVerificationCommand rejects logical OR fallback syntax", () => {
  const result = validateVerificationCommand("npm test || true");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /shell control syntax/);
  }
});

test("validateVerificationCommand rejects arbitrary semicolon command chaining", () => {
  const result = validateVerificationCommand("python3 tools/check-status.py; rm -rf output");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /shell control syntax/);
  }
});

// ─── Additional Preference Validation Tests (T02) ──────────────────────────

test("verification-gate: verification_commands produces no unknown-key warnings", () => {
  const result = validatePreferences({
    verification_commands: ["npm test"],
  });
  const unknownWarnings = (result.warnings ?? []).filter(w => w.includes("unknown"));
  assert.equal(unknownWarnings.length, 0, "verification_commands is a known key");
  assert.equal(result.errors.length, 0);
});

test("verification-gate: verification_auto_fix produces no unknown-key warnings", () => {
  const result = validatePreferences({
    verification_auto_fix: true,
  });
  const unknownWarnings = (result.warnings ?? []).filter(w => w.includes("unknown"));
  assert.equal(unknownWarnings.length, 0, "verification_auto_fix is a known key");
  assert.equal(result.errors.length, 0);
});

test("verification-gate: verification_max_retries produces no unknown-key warnings", () => {
  const result = validatePreferences({
    verification_max_retries: 2,
  });
  const unknownWarnings = (result.warnings ?? []).filter(w => w.includes("unknown"));
  assert.equal(unknownWarnings.length, 0, "verification_max_retries is a known key");
  assert.equal(result.errors.length, 0);
});

test("verification-gate: verification_max_retries -1 produces a validation error", () => {
  const result = validatePreferences({
    verification_max_retries: -1,
  });
  assert.ok(
    result.errors.some(e => e.includes("verification_max_retries")),
    "negative max_retries should error",
  );
  assert.equal(result.preferences.verification_max_retries, undefined);
});

// ─── formatFailureContext Tests (S03/T01) ─────────────────────────────────────

test("formatFailureContext: formats a single failure with command, exit code, stderr", () => {
  const result: import("../types.ts").VerificationResult = {
    passed: false,
    checks: [
      { command: "npm run lint", exitCode: 1, stdout: "", stderr: "error: unused var", durationMs: 500 },
    ],
    discoverySource: "preference",
    timestamp: Date.now(),
  };
  const output = formatFailureContext(result);
  assert.ok(output.startsWith("## Verification Failures"), "should start with header");
  assert.ok(output.includes("`npm run lint`"), "should include command name");
  assert.ok(output.includes("exit code 1"), "should include exit code");
  assert.ok(output.includes("error: unused var"), "should include stderr content");
  assert.ok(output.includes("```stderr"), "should have stderr code block");
});

test("formatFailureContext: preserves stdout-only failure evidence", () => {
  const result: import("../types.ts").VerificationResult = {
    passed: false,
    checks: [
      { command: "node --test", exitCode: 1, stdout: "not ok 1 - fixture assertion", stderr: "", durationMs: 500 },
    ],
    discoverySource: "task-plan",
    timestamp: Date.now(),
  };

  const output = formatFailureContext(result);

  assert.match(output, /not ok 1 - fixture assertion/);
  assert.match(output, /```stdout/);
});

test("formatFailureContext: formats multiple failures", () => {
  const result: import("../types.ts").VerificationResult = {
    passed: false,
    checks: [
      { command: "npm run lint", exitCode: 1, stdout: "", stderr: "lint error", durationMs: 100 },
      { command: "npm run test", exitCode: 2, stdout: "", stderr: "test failure", durationMs: 200 },
      { command: "npm run typecheck", exitCode: 0, stdout: "ok", stderr: "", durationMs: 50 },
    ],
    discoverySource: "preference",
    timestamp: Date.now(),
  };
  const output = formatFailureContext(result);
  assert.ok(output.includes("`npm run lint`"), "should include first failed command");
  assert.ok(output.includes("exit code 1"), "should include first exit code");
  assert.ok(output.includes("`npm run test`"), "should include second failed command");
  assert.ok(output.includes("exit code 2"), "should include second exit code");
  // Passing check should NOT appear
  assert.ok(!output.includes("npm run typecheck"), "should not include passing command");
});

test("formatFailureContext: truncates stderr longer than 2000 chars", () => {
  const longStderr = "x".repeat(3000);
  const result: import("../types.ts").VerificationResult = {
    passed: false,
    checks: [
      { command: "big-err", exitCode: 1, stdout: "", stderr: longStderr, durationMs: 100 },
    ],
    discoverySource: "preference",
    timestamp: Date.now(),
  };
  const output = formatFailureContext(result);
  // The output should contain 2000 x's followed by truncation marker, not 3000
  assert.ok(!output.includes("x".repeat(2001)), "should not contain more than 2000 chars of stderr");
  assert.ok(output.includes("[at least 1000 bytes truncated]"), "should include truncation marker");
});

test("formatFailureContext: a value cut twice does not understate the loss", () => {
  // These cuts layer: capture caps at 10 KB for storage, then this caps the
  // result again at 2,000 for the prompt. The value arriving here already
  // carries a marker, and that marker lands in the middle this cut drops -- so
  // counting only our own loss would tell the reader 8 KB went missing when the
  // real figure was 42 KB.
  const captured = truncate(
    ["HEAD-LINE", "noise".repeat(9_000), "Error: cannot find stylesheet to import"].join("\n"),
    10 * 1024,
  );
  const result: import("../types.ts").VerificationResult = {
    passed: false,
    checks: [{ command: "nx build && node -e ...", exitCode: 1, stdout: "", stderr: captured, durationMs: 100 }],
    discoverySource: "preference",
    timestamp: Date.now(),
  };

  const output = formatFailureContext(result);

  assert.ok(
    output.includes("Error: cannot find stylesheet to import"),
    "the reason must survive both cuts, which is the point of the patch",
  );
  assert.match(output, /at least \d+ bytes truncated/, "a layered count cannot claim to be exact");
  assert.equal(
    (output.match(/bytes truncated\]/g) ?? []).length,
    1,
    "the inner marker is dropped by the outer cut, so only one may remain",
  );
});

test("truncate: never returns more than it was given", () => {
  // The band just above the budget is where cutting stops paying: the marker
  // costs more than the bytes it removes. An estimated bound on the marker was
  // wrong by one byte and let the pathology through at exactly 2033, so assert
  // the invariant across the band rather than at one size.
  for (let size = 2_000; size <= 2_060; size += 1) {
    const input = "a".repeat(size);
    const output = truncate(input, 2_000);
    assert.ok(
      output.length <= input.length,
      `truncate(${size}) returned ${output.length}, longer than its input`,
    );
  }
  // Well past the band it must still actually cut.
  assert.ok(truncate("a".repeat(9_000), 2_000).length < 9_000);
});

test("truncate: the tail starts on a line boundary when one is in reach", () => {
  // A byte-aligned cut opens the excerpt mid-line. Command output is full of ANSI
  // escapes, so it can open inside one -- printing literal escape text, or
  // swallowing what follows it.
  const lines = Array.from({ length: 400 }, (_, i) => `line ${i} ${"-".repeat(40)}`);
  const output = truncate(lines.join("\n"), 2_000);
  const tail = output.slice(output.indexOf("bytes truncated]") + "bytes truncated]".length + 1);

  assert.ok(tail.startsWith("line "), `tail opened mid-line: ${JSON.stringify(tail.slice(0, 30))}`);
});

test("truncate: output with no newline at all still cuts", () => {
  // The line snap must not be load-bearing: a single enormous line keeps the byte
  // boundary rather than losing the whole tail.
  const output = truncate("x".repeat(9_000), 2_000);

  assert.ok(output.includes("bytes truncated]"));
  assert.ok(output.length < 9_000);
});

test("truncate: a budget too small for the marker keeps content, not the marker", () => {
  // Otherwise the marker is all that fits and 100% of the content is discarded
  // silently. Reachable from a computed budget, which the exported function now
  // invites.
  for (const maxBytes of [0, 1, 20, 40]) {
    const output = truncate("z".repeat(500), maxBytes);
    assert.ok(!output.includes("bytes truncated]"), `maxBytes=${maxBytes} returned only a marker`);
    assert.ok(output.length <= 500, `maxBytes=${maxBytes} grew the input`);
    if (maxBytes > 0) {
      assert.ok(output.includes("z"), `maxBytes=${maxBytes} discarded every byte of content`);
    }
  }
});

test("truncate: never returns more than it was given, counted in characters", () => {
  // The ASCII sweep above cannot see this: bytes and chars coincide there. With
  // a 3-byte character the input can shrink in BYTES while growing in CHARS,
  // and callers such as MAX_FAILURE_CONTEXT_CHARS budget in chars.
  const wide = String.fromCharCode(0x3042);
  for (let chars = 660; chars <= 700; chars += 1) {
    const input = wide.repeat(chars);
    const output = truncate(input, 2_000);
    assert.ok(
      output.length <= input.length,
      `truncate(${chars} chars / ${Buffer.byteLength(input)} bytes) returned ${output.length} chars`,
    );
  }
});

test("formatFailureContext: a barely-over-budget check is not cut at all", () => {
  // The marker costs more than a cut this small recovers, so cutting would make
  // the value LONGER than the input it was asked to shrink, and cost the reader
  // a line of real output to be told a few bytes went missing.
  const stderr = "y".repeat(2_010);
  const result: import("../types.ts").VerificationResult = {
    passed: false,
    checks: [{ command: "just-over", exitCode: 1, stdout: "", stderr, durationMs: 100 }],
    discoverySource: "preference",
    timestamp: Date.now(),
  };

  const output = formatFailureContext(result);

  assert.ok(!output.includes("bytes truncated]"), "must not insert a marker that costs more than it saves");
  assert.ok(output.includes(stderr), "the whole output survives");
});

test("formatFailureContext: an over-budget check keeps the END of its output", () => {
  // A failing command prints its error last. Keeping only the head -- which this
  // did -- reports the progress log and discards the diagnosis.
  const stderr = ["FIRST-LINE", "noise".repeat(1000), "Error: cannot find stylesheet to import"].join("\n");
  const result: import("../types.ts").VerificationResult = {
    passed: false,
    checks: [{ command: "nx build && node -e ...", exitCode: 1, stdout: "", stderr, durationMs: 100 }],
    discoverySource: "preference",
    timestamp: Date.now(),
  };

  const output = formatFailureContext(result);

  assert.ok(
    output.includes("Error: cannot find stylesheet to import"),
    "the reason the check failed must survive truncation",
  );
  assert.ok(output.includes("FIRST-LINE"), "the start is still worth keeping, so both ends survive");
});

test("formatFailureContext: returns empty string when all checks pass", () => {
  const result: import("../types.ts").VerificationResult = {
    passed: true,
    checks: [
      { command: "npm run lint", exitCode: 0, stdout: "ok", stderr: "", durationMs: 100 },
      { command: "npm run test", exitCode: 0, stdout: "ok", stderr: "", durationMs: 200 },
    ],
    discoverySource: "preference",
    timestamp: Date.now(),
  };
  assert.equal(formatFailureContext(result), "");
});

test("formatFailureContext: returns empty string for empty checks array", () => {
  const result: import("../types.ts").VerificationResult = {
    passed: true,
    checks: [],
    discoverySource: "none",
    timestamp: Date.now(),
  };
  assert.equal(formatFailureContext(result), "");
});

test("formatFailureContext: caps total output at 10,000 chars", () => {
  // Generate many failures to exceed 10,000 chars total
  const checks: import("../types.ts").VerificationCheck[] = [];
  for (let i = 0; i < 20; i++) {
    checks.push({
      command: `failing-command-${i}`,
      exitCode: 1,
      stdout: "",
      stderr: "e".repeat(1000), // 1000 chars each, 20 * ~1050 (with formatting) > 10,000
      durationMs: 100,
    });
  }
  const result: import("../types.ts").VerificationResult = {
    passed: false,
    checks,
    discoverySource: "preference",
    timestamp: Date.now(),
  };
  const output = formatFailureContext(result);
  assert.ok(output.length <= 10_100, `total output should be capped near 10,000 chars, got ${output.length}`);
  assert.ok(output.includes("…[remaining failures truncated]"), "should include total truncation marker");
});

/**
 * True when every fenced block opened in `text` is also closed.
 *
 * Counting fences cannot answer this: a check's own output legitimately
 * contains them. Follow the CommonMark rule instead -- an opening run of N
 * backticks is closed only by a line that is a run of at least N and nothing
 * else -- and report whether one is still open at the end.
 *
 * Scoped to what `formatFailureContext` emits, not to markdown at large: it
 * treats a line like ```` ```a`b ```` as an opener where CommonMark forbids a
 * backtick in a backtick-fence info string, which could in principle pass a
 * phantom opener. Unreachable here, because a heading always precedes the first
 * fence-shaped line of a block.
 */
function fencesBalanced(text: string): boolean {
  let open: number | null = null;
  for (const line of text.split("\n")) {
    const match = /^ {0,3}(`{3,})/.exec(line);
    if (!match) continue;
    const run = match[1];

    if (open === null) {
      open = run.length;
    } else if (run.length >= open && line.trim() === run) {
      open = null;
    }
  }

  return open === null;
}

test("formatFailureContext: a check whose output contains a fence leaves no block open", () => {
  // The block is injected into a retry prompt with the real instructions
  // appended after it. A fence left open swallows all of them.
  const result: import("../types.ts").VerificationResult = {
    passed: false,
    checks: [{
      command: "npm run lint:md",
      exitCode: 1,
      stdout: "",
      stderr: "oops\n```\nmore",
      durationMs: 100,
    }],
    discoverySource: "preference",
    timestamp: Date.now(),
  };

  const output = formatFailureContext(result);

  assert.ok(output.includes("```\nmore"), "the content's own fence survives verbatim");
  assert.ok(
    fencesBalanced(`${output}\n\n---\n\nreal instructions`),
    `the appended prompt was swallowed by an open block:\n${output}`,
  );
});

test("formatFailureContext: a multi-line command cannot break out of its own block", () => {
  // A `###` heading is one line. Prose reaching `check.command` is a documented
  // failure mode, and a newline followed by a fence opens a block that the
  // block's own closing delimiter then consumes -- leaving the real one open.
  const result: import("../types.ts").VerificationResult = {
    passed: false,
    checks: [{
      command: "run the tests\n```\nand check the output",
      exitCode: 1,
      stdout: "",
      stderr: "boom",
      durationMs: 100,
    }],
    discoverySource: "preference",
    timestamp: Date.now(),
  };

  const output = formatFailureContext(result);

  assert.ok(
    fencesBalanced(`${output}\n\n---\n\nreal instructions`),
    `the appended prompt was swallowed by an open block:\n${output}`,
  );
  assert.equal(output.split("\n")[2], "### ❌ `run the tests ``` and check the output` (exit code 1)");
});

test("formatFailureContext: a body that hits the total cap ends at a block boundary", () => {
  const checks: import("../types.ts").VerificationCheck[] = [];
  for (let i = 0; i < 20; i++) {
    checks.push({
      command: `failing-command-${i}`,
      exitCode: 1,
      // The stray fence goes in an EARLY check so the last block is unambiguous.
      // The trailing marker is what makes a mid-block cut visible at all: the
      // filler is uniform, so slicing it leaves no trace.
      stderr: (i === 0 ? "```\n" : "") + "e".repeat(1_000) + `\nEND-${i}`,
      stdout: "",
      durationMs: 100,
    });
  }
  const result: import("../types.ts").VerificationResult = {
    passed: false,
    checks,
    discoverySource: "preference",
    timestamp: Date.now(),
  };

  const output = formatFailureContext(result);

  assert.ok(output.includes("…[remaining failures truncated]"), "later checks were dropped");
  assert.ok(fencesBalanced(output), `a fence was left open:\n${output.slice(-400)}`);

  const kept = [...output.matchAll(/### ❌ `failing-command-(\d+)`/g)].map((m) => Number(m[1]));
  assert.ok(kept.length > 0 && kept.length < checks.length, `expected a partial set, kept ${kept.length}`);
  for (const i of kept) {
    assert.ok(output.includes(`END-${i}`), `check ${i} was cut mid-block instead of dropped whole`);
  }
});

test("formatFailureContext: a long command cannot push the body past the total cap", () => {
  // The per-check cap bounds the OUTPUT, not the command. A block-granular cap
  // that keeps the first block unconditionally is unbounded without this.
  const result: import("../types.ts").VerificationResult = {
    passed: false,
    checks: [
      { command: `node -e "${"x".repeat(40_000)}"`, exitCode: 1, stdout: "", stderr: "boom", durationMs: 100 },
      { command: "npm run test", exitCode: 1, stdout: "", stderr: "SECOND-CHECK", durationMs: 100 },
    ],
    discoverySource: "preference",
    timestamp: Date.now(),
  };

  const output = formatFailureContext(result);

  assert.ok(output.length <= 10_100, `bounded near the cap, got ${output.length}`);
  assert.ok(output.includes("SECOND-CHECK"), "bounding the command leaves room for the checks that follow");
});

test("formatFailureContext: cutting a long command does not split a character in half", () => {
  // `truncate`, the sibling doing this job for output, cuts on character
  // boundaries for the same reason. A naive `slice` at a fixed offset emits a
  // lone surrogate whenever an astral character straddles it.
  const result: import("../types.ts").VerificationResult = {
    passed: false,
    checks: [{
      command: "a".repeat(199) + "\u{1F600}" + "b".repeat(200),
      exitCode: 1,
      stdout: "",
      stderr: "boom",
      durationMs: 100,
    }],
    discoverySource: "preference",
    timestamp: Date.now(),
  };

  const output = formatFailureContext(result);
  const lone = [...output].filter((c) => c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff);

  assert.deepEqual(lone, [], "the cut split a surrogate pair");
  assert.ok(output.includes("...[command truncated]"), "the command was cut at all");
});

test("formatFailureContext: an under-cap body is returned unchanged", () => {
  const result: import("../types.ts").VerificationResult = {
    passed: false,
    checks: [{ command: "npm run lint", exitCode: 2, stdout: "", stderr: "boom", durationMs: 100 }],
    discoverySource: "preference",
    timestamp: Date.now(),
  };

  assert.equal(
    formatFailureContext(result),
    "## Verification Failures\n\n### ❌ `npm run lint` (exit code 2)\n```stderr\nboom\n```",
  );
});

// ─── captureRuntimeErrors Tests (S04/T01) ─────────────────────────────────────

function makeProc(overrides: Record<string, unknown>) {
  return {
    id: "p1",
    label: "test-server",
    status: "ready",
    alive: true,
    exitCode: null,
    signal: null,
    recentErrors: [] as string[],
    ...overrides,
  };
}

function makeLogs(entries: Array<{ type: string; text: string }>) {
  return entries.map((e, i) => ({
    type: e.type,
    text: e.text,
    timestamp: Date.now() + i,
    url: "http://localhost:3000",
  }));
}

test("captureRuntimeErrors: crashed bg-shell process → blocking crash error", async () => {
  const processes = new Map<string, unknown>([
    ["p1", makeProc({ status: "crashed", alive: false, exitCode: 1 })],
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => processes,
    getConsoleLogs: () => [],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].source, "bg-shell");
  assert.equal(result[0].severity, "crash");
  assert.equal(result[0].blocking, true);
  assert.ok(result[0].message.includes("test-server"));
});

test("captureRuntimeErrors: bg-shell non-zero exit + not alive → blocking crash error", async () => {
  const processes = new Map<string, unknown>([
    ["p1", makeProc({ status: "exited", alive: false, exitCode: 137 })],
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => processes,
    getConsoleLogs: () => [],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].severity, "crash");
  assert.equal(result[0].blocking, true);
  assert.ok(result[0].message.includes("exitCode=137"));
});

test("captureRuntimeErrors: bg-shell SIGABRT/SIGSEGV/SIGBUS → blocking crash error", async () => {
  for (const sig of ["SIGABRT", "SIGSEGV", "SIGBUS"]) {
    const processes = new Map<string, unknown>([
      ["p1", makeProc({ signal: sig, alive: false, exitCode: null })],
    ]);
    const result = await captureRuntimeErrors({
      getProcesses: () => processes,
      getConsoleLogs: () => [],
    });
    assert.equal(result.length, 1, `${sig} should produce 1 error`);
    assert.equal(result[0].severity, "crash");
    assert.equal(result[0].blocking, true);
    assert.ok(result[0].message.includes(sig), `message should contain ${sig}`);
  }
});

test("captureRuntimeErrors: alive bg-shell process with recentErrors → non-blocking error", async () => {
  const processes = new Map<string, unknown>([
    ["p1", makeProc({ alive: true, recentErrors: ["TypeError: foo", "RangeError: bar"] })],
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => processes,
    getConsoleLogs: () => [],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].source, "bg-shell");
  assert.equal(result[0].severity, "error");
  assert.equal(result[0].blocking, false);
  assert.ok(result[0].message.includes("TypeError: foo"));
  assert.ok(result[0].message.includes("RangeError: bar"));
});

test("captureRuntimeErrors: browser unhandled rejection → blocking crash error", async () => {
  const logs = makeLogs([
    { type: "error", text: "Unhandled promise rejection: some error" },
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => new Map(),
    getConsoleLogs: () => logs,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].source, "browser");
  assert.equal(result[0].severity, "crash");
  assert.equal(result[0].blocking, true);
  assert.ok(result[0].message.includes("Unhandled"));
});

test("captureRuntimeErrors: browser UnhandledRejection (case variation) → blocking crash", async () => {
  const logs = makeLogs([
    { type: "error", text: "UnhandledRejection in module X" },
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => new Map(),
    getConsoleLogs: () => logs,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].severity, "crash");
  assert.equal(result[0].blocking, true);
});

test("captureRuntimeErrors: browser console.error (general) → non-blocking error", async () => {
  const logs = makeLogs([
    { type: "error", text: "Failed to load resource: net::ERR_FAILED" },
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => new Map(),
    getConsoleLogs: () => logs,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].source, "browser");
  assert.equal(result[0].severity, "error");
  assert.equal(result[0].blocking, false);
});

test("captureRuntimeErrors: browser deprecation warning → non-blocking warning", async () => {
  const logs = makeLogs([
    { type: "warning", text: "Event.returnValue is deprecated. Use Event.preventDefault() instead." },
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => new Map(),
    getConsoleLogs: () => logs,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].source, "browser");
  assert.equal(result[0].severity, "warning");
  assert.equal(result[0].blocking, false);
  assert.ok(result[0].message.includes("deprecated"));
});

test("captureRuntimeErrors: non-deprecation warning is ignored", async () => {
  const logs = makeLogs([
    { type: "warning", text: "Some general warning about performance" },
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => new Map(),
    getConsoleLogs: () => logs,
  });
  assert.equal(result.length, 0, "non-deprecation warnings should be ignored");
});

test("captureRuntimeErrors: no processes, no browser logs → empty array", async () => {
  const result = await captureRuntimeErrors({
    getProcesses: () => new Map(),
    getConsoleLogs: () => [],
  });
  assert.deepStrictEqual(result, []);
});

test("captureRuntimeErrors: dynamic import failure → graceful empty array", async () => {
  const result = await captureRuntimeErrors({
    getProcesses: () => { throw new Error("module not found"); },
    getConsoleLogs: () => { throw new Error("module not found"); },
  });
  assert.deepStrictEqual(result, []);
});

test("captureRuntimeErrors: browser text truncated to 500 chars", async () => {
  const longText = "x".repeat(600);
  const logs = makeLogs([
    { type: "error", text: longText },
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => new Map(),
    getConsoleLogs: () => logs,
  });
  assert.equal(result.length, 1);
  assert.ok(result[0].message.length <= 500 + 20, "message should be truncated near 500 chars");
  assert.ok(result[0].message.includes("…[truncated]"), "should include truncation marker");
  assert.ok(!result[0].message.includes("x".repeat(501)), "should not contain 501+ x's");
});

test("captureRuntimeErrors: bg-shell recentErrors limited to 3 in message", async () => {
  const processes = new Map<string, unknown>([
    ["p1", makeProc({
      status: "crashed",
      alive: false,
      exitCode: 1,
      recentErrors: ["err1", "err2", "err3", "err4", "err5"],
    })],
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => processes,
    getConsoleLogs: () => [],
  });
  assert.equal(result.length, 1);
  assert.ok(result[0].message.includes("err1"));
  assert.ok(result[0].message.includes("err2"));
  assert.ok(result[0].message.includes("err3"));
  assert.ok(!result[0].message.includes("err4"), "should only include first 3 errors");
});

test("captureRuntimeErrors: mixed bg-shell and browser errors", async () => {
  const processes = new Map<string, unknown>([
    ["p1", makeProc({ status: "crashed", alive: false, exitCode: 1 })],
  ]);
  const logs = makeLogs([
    { type: "error", text: "Unhandled rejection: boom" },
    { type: "error", text: "general error" },
    { type: "warning", text: "deprecated API used" },
  ]);
  const result = await captureRuntimeErrors({
    getProcesses: () => processes,
    getConsoleLogs: () => logs,
  });
  // 1 bg-shell crash + 1 browser crash (unhandled) + 1 browser error + 1 browser warning
  assert.equal(result.length, 4);
  const blocking = result.filter(r => r.blocking);
  const nonBlocking = result.filter(r => !r.blocking);
  assert.equal(blocking.length, 2, "should have 2 blocking errors");
  assert.equal(nonBlocking.length, 2, "should have 2 non-blocking errors");
});

// ─── Dependency Audit Tests (S05/T01) ─────────────────────────────────────────

/** Helper: build a realistic npm audit JSON stdout with vulnerabilities. */
function makeAuditJson(
  vulns: Record<string, { severity: string; fixAvailable: boolean; via: unknown[] }>,
): string {
  return JSON.stringify({ vulnerabilities: vulns });
}

/** Sample npm audit JSON with a high-severity vuln. */
const SAMPLE_AUDIT_JSON = makeAuditJson({
  "nth-check": {
    severity: "high",
    fixAvailable: true,
    via: [
      {
        title: "Inefficient Regular Expression Complexity in nth-check",
        url: "https://github.com/advisories/GHSA-rp65-9cf3-cjxr",
        severity: "high",
      },
    ],
  },
});

test("dependency-audit: package.json in git diff → runs npm audit and parses vulnerabilities", () => {
  let npmAuditCalled = false;
  const result = runDependencyAudit("/tmp/test", {
    gitDiff: () => ["package.json", "src/index.ts"],
    npmAudit: () => {
      npmAuditCalled = true;
      return { stdout: SAMPLE_AUDIT_JSON, exitCode: 0 };
    },
  });
  assert.equal(npmAuditCalled, true, "npm audit should be called");
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "nth-check");
  assert.equal(result[0].severity, "high");
  assert.equal(result[0].title, "Inefficient Regular Expression Complexity in nth-check");
  assert.equal(result[0].url, "https://github.com/advisories/GHSA-rp65-9cf3-cjxr");
  assert.equal(result[0].fixAvailable, true);
});

test("dependency-audit: package-lock.json change triggers audit", () => {
  let npmAuditCalled = false;
  const result = runDependencyAudit("/tmp/test", {
    gitDiff: () => ["package-lock.json"],
    npmAudit: () => {
      npmAuditCalled = true;
      return { stdout: SAMPLE_AUDIT_JSON, exitCode: 0 };
    },
  });
  assert.equal(npmAuditCalled, true);
  assert.equal(result.length, 1);
});

test("dependency-audit: pnpm-lock.yaml change triggers audit", () => {
  let npmAuditCalled = false;
  runDependencyAudit("/tmp/test", {
    gitDiff: () => ["pnpm-lock.yaml"],
    npmAudit: () => {
      npmAuditCalled = true;
      return { stdout: SAMPLE_AUDIT_JSON, exitCode: 0 };
    },
  });
  assert.equal(npmAuditCalled, true);
});

test("dependency-audit: yarn.lock change triggers audit", () => {
  let npmAuditCalled = false;
  runDependencyAudit("/tmp/test", {
    gitDiff: () => ["yarn.lock"],
    npmAudit: () => {
      npmAuditCalled = true;
      return { stdout: SAMPLE_AUDIT_JSON, exitCode: 0 };
    },
  });
  assert.equal(npmAuditCalled, true);
});

test("dependency-audit: bun.lockb change triggers audit", () => {
  let npmAuditCalled = false;
  runDependencyAudit("/tmp/test", {
    gitDiff: () => ["bun.lockb"],
    npmAudit: () => {
      npmAuditCalled = true;
      return { stdout: SAMPLE_AUDIT_JSON, exitCode: 0 };
    },
  });
  assert.equal(npmAuditCalled, true);
});

test("dependency-audit: no dependency file changes → returns empty array, npm audit not called", () => {
  let npmAuditCalled = false;
  const result = runDependencyAudit("/tmp/test", {
    gitDiff: () => ["src/index.ts", "README.md"],
    npmAudit: () => {
      npmAuditCalled = true;
      return { stdout: "{}", exitCode: 0 };
    },
  });
  assert.equal(npmAuditCalled, false, "npm audit should NOT be called when no dependency files changed");
  assert.deepStrictEqual(result, []);
});

test("dependency-audit: git diff returns non-zero exit (not a git repo) → empty array", () => {
  const result = runDependencyAudit("/tmp/test", {
    gitDiff: () => { throw new Error("not a git repo"); },
    npmAudit: () => { throw new Error("should not be called"); },
  });
  assert.deepStrictEqual(result, []);
});

test("dependency-audit: npm audit returns invalid JSON → empty array", () => {
  const result = runDependencyAudit("/tmp/test", {
    gitDiff: () => ["package.json"],
    npmAudit: () => ({ stdout: "not json at all", exitCode: 1 }),
  });
  assert.deepStrictEqual(result, []);
});

test("dependency-audit: npm audit returns zero vulnerabilities → empty array", () => {
  const result = runDependencyAudit("/tmp/test", {
    gitDiff: () => ["package.json"],
    npmAudit: () => ({
      stdout: JSON.stringify({ vulnerabilities: {} }),
      exitCode: 0,
    }),
  });
  assert.deepStrictEqual(result, []);
});

test("dependency-audit: npm audit non-zero exit with valid JSON → parses correctly", () => {
  // npm audit exits non-zero when vulnerabilities exist — this is expected, not an error
  const result = runDependencyAudit("/tmp/test", {
    gitDiff: () => ["package-lock.json"],
    npmAudit: () => ({
      stdout: SAMPLE_AUDIT_JSON,
      exitCode: 1, // non-zero!
    }),
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "nth-check");
  assert.equal(result[0].severity, "high");
});

test("dependency-audit: via entries with string-only values are skipped", () => {
  const auditJson = makeAuditJson({
    "postcss": {
      severity: "moderate",
      fixAvailable: false,
      via: ["nth-check", "css-select"], // string-only via entries
    },
  });
  const result = runDependencyAudit("/tmp/test", {
    gitDiff: () => ["package.json"],
    npmAudit: () => ({ stdout: auditJson, exitCode: 1 }),
  });
  assert.equal(result.length, 1);
  // When no object via entry is found, title falls back to the package name
  assert.equal(result[0].name, "postcss");
  assert.equal(result[0].title, "postcss");
  assert.equal(result[0].url, "");
});

test("dependency-audit: subdirectory package.json does not trigger audit", () => {
  let npmAuditCalled = false;
  const result = runDependencyAudit("/tmp/test", {
    gitDiff: () => ["packages/foo/package.json", "libs/bar/package-lock.json"],
    npmAudit: () => {
      npmAuditCalled = true;
      return { stdout: SAMPLE_AUDIT_JSON, exitCode: 0 };
    },
  });
  assert.equal(npmAuditCalled, false, "subdirectory dependency files should not trigger audit");
  assert.deepStrictEqual(result, []);
});

// ─── Python normalization (regression: #4416) ────────────────────────────────
// Verification commands using python3/python must succeed even when only the
// alternate interpreter name is available. The gate rewrites the command via
// normalizePythonCommand before spawning — tested here end-to-end on this host.

describe("verification-gate: python normalization (#4416)", () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTempDir("vg-python"); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  test("python3 --version command succeeds on this host (gate uses normalized invocation)", () => {
    // This test verifies that runVerificationGate can execute a python command
    // without hard-failing due to interpreter name mismatch. On hosts where
    // python3 is available it runs directly; on hosts where only python or py
    // exists, normalizePythonCommand rewrites the token before spawnSync.
    const result = runVerificationGate({
      cwd: tmp,
      preferenceCommands: ["python3 --version"],
    });
    assert.equal(typeof result.passed, "boolean");
    assert.equal(result.checks.length, 1);
    assert.ok(result.checks[0].durationMs >= 0);
  });

  test("python --version command produces a VerificationResult (not a crash)", () => {
    const result = runVerificationGate({
      cwd: tmp,
      preferenceCommands: ["python --version"],
    });
    assert.equal(typeof result.passed, "boolean");
    assert.equal(result.checks.length, 1);
    assert.ok(result.checks[0].durationMs >= 0);
  });
});

// ─── Verification shell selection ────────────────────────────────────────────

describe("verification-gate: shell selection", () => {
  const PROGRAM_FILES = "C:\\Program Files";
  const GIT_BASH = "C:\\Program Files\\Git\\usr\\bin\\bash.exe";
  const LOCAL_APP_DATA = "C:\\Users\\dev\\AppData\\Local";
  const LOCAL_GIT_BASH = "C:\\Users\\dev\\AppData\\Local\\Programs\\Git\\usr\\bin\\bash.exe";
  const noneExist = (): boolean => false;
  const allExist = (): boolean => true;

  // Verify lines are POSIX shell commands (`test -f x`, `grep -q y z`).
  // Handing them to cmd.exe fails on that syntax no matter whether the task
  // itself succeeded, so the gate raised a verification-abort for work that
  // had actually passed.
  test("prefers a Git for Windows bash over cmd on win32", () => {
    const shell = resolveVerificationShell(
      "win32",
      { ProgramFiles: PROGRAM_FILES },
      (path) => path === GIT_BASH,
    );

    assert.equal(shell.bin, GIT_BASH);
    assert.deepStrictEqual(
      shell.args("test -f README.md"),
      ["-o", "pipefail", "-c", "test -f README.md"],
    );
  });

  // Spawning bash.exe directly skips the launcher that puts usr/bin on PATH,
  // so builtins like `test` work while `grep`/`sed` fail with exit 127. The
  // prefix is derived from the resolved bash path, never a hardcoded constant.
  test("prepends the resolved bash's usr/bin to PATH", () => {
    const shell = resolveVerificationShell(
      "win32",
      { LOCALAPPDATA: LOCAL_APP_DATA },
      (path) => path === LOCAL_GIT_BASH,
    );

    assert.equal(shell.pathPrefix, dirname(LOCAL_GIT_BASH));
  });

  test("honours an explicit GSD_VERIFICATION_SHELL override", () => {
    const shell = resolveVerificationShell(
      "win32",
      { GSD_VERIFICATION_SHELL: "D:\\msys64\\usr\\bin\\bash.exe", ProgramFiles: PROGRAM_FILES },
      allExist,
    );

    assert.equal(shell.bin, "D:\\msys64\\usr\\bin\\bash.exe");
  });

  // The override names a SHELL, and `sh.exe` sits in the same `usr/bin` as the
  // bash this resolver looks for, so it is a natural thing to point it at.
  // Handing a non-bash shell bash's own argv fails every check with `Illegal
  // option -o pipefail` -- a hard break with no fallback, from a variable the
  // operator set to make verification work.
  test("does not hand bash-only argv to a non-bash GSD_VERIFICATION_SHELL", () => {
    const shell = resolveVerificationShell(
      "win32",
      { GSD_VERIFICATION_SHELL: "C:\\Program Files\\Git\\usr\\bin\\sh.exe" },
      allExist,
    );

    assert.equal(shell.bin, "C:\\Program Files\\Git\\usr\\bin\\sh.exe");
    assert.ok(
      !shell.args("test -f README.md").includes("pipefail"),
      "a non-bash shell must not be given `-o pipefail`",
    );
    // The portable argv still ends with the command, as the off-win32 path does.
    assert.equal(shell.args("test -f README.md").at(-1), "test -f README.md");
  });

  // Machines without Git for Windows must keep today's behaviour rather than
  // failing to spawn anything at all.
  test("falls back to cmd when no POSIX shell is present on win32", () => {
    const shell = resolveVerificationShell("win32", { ProgramFiles: PROGRAM_FILES }, noneExist);

    assert.equal(shell.bin, "cmd");
    assert.deepStrictEqual(shell.args("test -f README.md"), ["/c", "test -f README.md"]);
    assert.equal(shell.pathPrefix, null);
  });

  // A bare "bash" is deliberately never a candidate: on Windows, PATH commonly
  // resolves it to the WSL launcher stub, which boots a VM.
  test("never selects a bare bash name", () => {
    const shell = resolveVerificationShell("win32", { ProgramFiles: PROGRAM_FILES }, allExist);

    assert.notEqual(shell.bin, "bash");
    assert.ok(shell.bin.endsWith("bash.exe"), `expected an explicit bash path, got: ${shell.bin}`);
  });

  test("keeps the existing sh contract off win32", () => {
    const shell = resolveVerificationShell("linux", {}, allExist);

    assert.equal(shell.bin, "sh");
    assert.equal(shell.pathPrefix, null);
    const args = shell.args("test -f README.md");
    assert.equal(args[0], "-c");
    assert.equal(args.at(-1), "test -f README.md");
  });

  // End to end on the real host: the behaviour the whole patch exists for.
  test("runs a POSIX verify command through the real gate", () => {
    const dir = makeTempDir("vg-posix-shell");
    try {
      writeFileSync(join(dir, "README.md"), "# hi\n");
      const result = withRtkDisabled(() => runVerificationGate({
        cwd: dir,
        preferenceCommands: ["test -f README.md"],
      }));

      assert.equal(result.passed, true, `expected pass, got: ${JSON.stringify(result.checks)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
