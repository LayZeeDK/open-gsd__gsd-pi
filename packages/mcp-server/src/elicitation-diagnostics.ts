/**
 * Durable record of failed elicitation attempts.
 *
 * When `ask_user_questions` cannot reach the user, the fact that decides the
 * cause is the client capabilities **as the server resolved them** -- i.e.
 * after the SDK's `ElicitationCapabilitySchema` preprocess, which rewrites an
 * empty `elicitation: {}` to `{ form: {} }`. A client's raw initialize params
 * do NOT show that, and reasoning from them produced a wrong fix once already.
 *
 * Written only on the failure path, so this is not a hot-path cost, and every
 * operation is best-effort: a diagnostic must never be the reason a tool call
 * fails.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Rotate the log once it passes this, keeping one previous generation, so the
 * file is bounded at roughly twice this size.
 *
 * A client that supports no elicitation at all fails EVERY `ask_user_questions`
 * call, and each failure appends a full capabilities dump. Without a cap that
 * grows for the lifetime of the install, in the shared global gsd home rather
 * than per-project. The recorded entries are read newest-first (`tail`), so
 * discarding the oldest generation costs nothing diagnostically.
 */
const MAX_DIAGNOSTICS_BYTES = 1024 * 1024;

/** The subset of the SDK server this needs. Both accessors may throw. */
export interface ElicitationDiagnosticServer {
  getClientCapabilities?(): unknown;
  getClientVersion?(): unknown;
}

/** Mirrors gsd-home.ts: `GSD_HOME` overrides, else `~/.gsd`. */
function gsdHome(): string {
  const override = process.env['GSD_HOME'];

  return override ? resolve(override) : join(homedir(), '.gsd');
}

export function elicitationDiagnosticsPath(): string {
  return join(gsdHome(), 'diagnostics.jsonl');
}

function callSafely(accessor: (() => unknown) | undefined): unknown {
  if (typeof accessor !== 'function') return null;
  try {
    return accessor() ?? null;
  } catch {
    return null;
  }
}

/** Move the log aside once it passes the cap. Best-effort, like everything here. */
function rotateIfOversized(path: string): void {
  try {
    if (statSync(path).size > MAX_DIAGNOSTICS_BYTES) renameSync(path, `${path}.1`);
  } catch {
    // No file yet, or a concurrent server won the rotation. Either way the
    // append below is still the right next step.
  }
}

/**
 * Append one JSON line describing a failed elicitation attempt.
 *
 * Deliberately records the capability object verbatim rather than a derived
 * boolean: the open question is the exact shape, and a summary would throw away
 * precisely the detail that matters.
 */
export function recordElicitationDiagnostic(
  server: ElicitationDiagnosticServer,
  error: unknown,
): void {
  try {
    const entry = {
      at: new Date().toISOString(),
      kind: 'elicitation-failed',
      error: error instanceof Error ? error.message : String(error),
      capabilities: callSafely(server.getClientCapabilities?.bind(server)),
      clientInfo: callSafely(server.getClientVersion?.bind(server)),
    };

    const path = elicitationDiagnosticsPath();
    mkdirSync(gsdHome(), { recursive: true });
    rotateIfOversized(path);
    appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf-8');
  } catch {
    // Best-effort by design: never let a diagnostic break the tool call.
  }
}
