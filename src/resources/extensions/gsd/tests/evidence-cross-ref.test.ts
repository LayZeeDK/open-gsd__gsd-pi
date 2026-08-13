// Project/App: gsd-pi
// File Purpose: Tests for verification evidence cross-reference mismatch policy.

import test from "node:test";
import assert from "node:assert/strict";

import { crossReferenceEvidence } from "../safety/evidence-cross-ref.ts";
import type { EvidenceEntry } from "../safety/evidence-collector.ts";
import { isTaskAttemptAwaitingVerification } from "../task-execution-domain-operation.ts";

test("evidence cross-reference waits for the canonical succeeded verify-stage Result", () => {
  assert.equal(isTaskAttemptAwaitingVerification(null), false);
  assert.equal(isTaskAttemptAwaitingVerification({
    state: "running",
    nextStage: "execute",
  }), false);
  assert.equal(isTaskAttemptAwaitingVerification({
    state: "settled",
    outcome: "succeeded",
    nextStage: "verify",
  }), true);
  assert.equal(isTaskAttemptAwaitingVerification({
    state: "settled",
    outcome: "failed",
    nextStage: "route",
  }), false);
});

test("claims of passing verification become errors when recorded bash evidence failed", () => {
  const mismatches = crossReferenceEvidence(
    [{ command: "npm test", exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command: "npm test",
        exitCode: 1,
        outputSnippet: "failed",
        timestamp: Date.now(),
      },
    ] as EvidenceEntry[],
  );

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].severity, "error");
  assert.match(mismatches[0].reason, /Claimed exitCode=0/);
});

test("passing retry evidence is not invalidated by an earlier failed run of the same command", () => {
  const command = "node todo.js add 'Task A' && node todo.js add 'Task B' && node todo.js done 1";
  const mismatches = crossReferenceEvidence(
    [{ command, exitCode: 0, verdict: "passed after retry" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command,
        exitCode: 1,
        outputSnippet: "Task #1 not found",
        timestamp: 1,
      },
      {
        kind: "bash",
        toolCallId: "call-2",
        command,
        exitCode: 0,
        outputSnippet: "Marked #1 done.",
        timestamp: 2,
      },
    ] as EvidenceEntry[],
  );

  assert.deepEqual(mismatches, []);
});

test("newer script-wrapped pass is not shadowed by a stale exact failing run", () => {
  const command = "npm test";
  const mismatches = crossReferenceEvidence(
    [{ command, exitCode: 0, verdict: "passed after retry" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command,
        exitCode: 1,
        outputSnippet: "failed",
        timestamp: 1,
      },
      {
        kind: "bash",
        toolCallId: "call-2",
        command: `cd /work && ${command}`,
        exitCode: 0,
        outputSnippet: "passed",
        timestamp: 2,
      },
    ] as EvidenceEntry[],
  );

  assert.deepEqual(mismatches, []);
});

test("later containing script does not override an exact successful run", () => {
  const command = "npm test";
  const mismatches = crossReferenceEvidence(
    [{ command, exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command,
        exitCode: 0,
        outputSnippet: "passed",
        timestamp: 1,
      },
      {
        kind: "bash",
        toolCallId: "call-2",
        command: `cd /work && ${command} && npm run lint`,
        exitCode: 1,
        outputSnippet: "lint failed",
        timestamp: 2,
      },
    ] as EvidenceEntry[],
  );

  assert.deepEqual(mismatches, []);
});

test("same-timestamp retry evidence prefers the later recorded run", () => {
  const command = "npm test";
  const mismatches = crossReferenceEvidence(
    [{ command, exitCode: 0, verdict: "passed after retry" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command,
        exitCode: 1,
        outputSnippet: "failed",
        timestamp: 1,
      },
      {
        kind: "bash",
        toolCallId: "call-2",
        command,
        exitCode: 0,
        outputSnippet: "passed",
        timestamp: 1,
      },
    ] as EvidenceEntry[],
  );

  assert.deepEqual(mismatches, []);
});

test("stale verification evidence batches are ignored when a newer completion batch exists", () => {
  const command = "node todo.js add 'Task A' && node todo.js add 'Task B' && node todo.js done 1";
  const resetCommand = `rm -f "$HOME/.config/todo/data.json" && ${command}`;
  const mismatches = crossReferenceEvidence(
    [
      { command, exitCode: 0, verdict: "pass", createdAt: "2026-05-14T11:16:48.588Z" },
      { command, exitCode: 1, verdict: "fail before reset", createdAt: "2026-05-14T11:28:36.952Z" },
      { command: resetCommand, exitCode: 0, verdict: "pass after reset", createdAt: "2026-05-14T11:28:36.952Z" },
    ],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command,
        exitCode: 1,
        outputSnippet: "Task #1 not found",
        timestamp: 1,
      },
      {
        kind: "bash",
        toolCallId: "call-2",
        command: resetCommand,
        exitCode: 0,
        outputSnippet: "Marked #1 done.",
        timestamp: 2,
      },
    ] as EvidenceEntry[],
  );

  assert.deepEqual(mismatches, []);
});

test("WSL bash-spawn failure is not flagged as a falsified passing verification", () => {
  // Issue #814: on Windows, `gsd_exec runtime=bash` resolves to a WSL with no
  // /bin/bash. The bash-runtime verification call exits 1 with a spawn-failure
  // banner (the command never ran); the LLM re-ran via a node runtime (exit 0)
  // that findMatches does not capture. The infra failure must not block.
  const command = "npx playwright test e2e/m039-s05-comparison-legibility.spec.ts";
  const mismatches = crossReferenceEvidence(
    [{ command, exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command: `${command} --reporter=line 2>&1 | tail -40`,
        exitCode: 1,
        outputSnippet:
          "<3>WSL (12 - Relay) ERROR: CreateProcessCommon:800: execvpe(/bin/bash) failed: No such file or directory",
        timestamp: 1,
      },
    ] as EvidenceEntry[],
  );

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].severity, "warning");
  assert.match(mismatches[0].reason, /inconclusive/);
});

test("missing tool failure (command not found: eslint) is a real error, not an infra spawn failure", () => {
  // Regression for overly-broad spawn signature: `command not found: eslint`
  // is a genuine verification failure (eslint not installed), not a missing
  // shell interpreter. It must produce a blocking error, not a warning.
  const command = "eslint src/";
  const mismatches = crossReferenceEvidence(
    [{ command, exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command,
        exitCode: 1,
        outputSnippet: "zsh: command not found: eslint",
        timestamp: Date.now(),
      },
    ] as EvidenceEntry[],
  );

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].severity, "error");
  assert.match(mismatches[0].reason, /Claimed exitCode=0/);
});

test("missing tool failure (command not found: node) is a real error, not an infra spawn failure", () => {
  // node is not a shell interpreter; its absence is a genuine env problem,
  // not a shell-spawn infra failure.
  const command = "node --test tests/verify.test.js";
  const mismatches = crossReferenceEvidence(
    [{ command, exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command,
        exitCode: 127,
        outputSnippet: "bash: command not found: node",
        timestamp: Date.now(),
      },
    ] as EvidenceEntry[],
  );

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].severity, "error");
  assert.match(mismatches[0].reason, /Claimed exitCode=0/);
});

test("missing shell interpreter (command not found: bash) is treated as an infra spawn failure", () => {
  // bash itself missing is the shell-spawn infra case; must remain a warning.
  const command = "npm test";
  const mismatches = crossReferenceEvidence(
    [{ command, exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command,
        exitCode: 1,
        outputSnippet: "command not found: bash",
        timestamp: Date.now(),
      },
    ] as EvidenceEntry[],
  );

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].severity, "warning");
  assert.match(mismatches[0].reason, /inconclusive/);
});

test("missing recorded bash evidence remains a warning", () => {
  const mismatches = crossReferenceEvidence(
    [{ command: "npm test", exitCode: 0, verdict: "passed" }],
    [],
  );

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].severity, "warning");
});

test("claimed command absent from bash calls reports a warning mismatch with null actual", () => {
  // Regression: postUnitPreVerification flags fabricated evidence by filtering
  // crossReferenceEvidence mismatches on `severity === "warning" && actual === null`.
  // A claimed command with no matching bash call must produce exactly that shape,
  // otherwise fabricated evidence silently bypasses the safety check.
  const mismatches = crossReferenceEvidence(
    [{ command: "npm run verify", exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command: "ls -la",
        exitCode: 0,
        outputSnippet: "files",
        timestamp: Date.now(),
      },
    ] as EvidenceEntry[],
  );

  const missing = mismatches.filter((m) => m.severity === "warning" && m.actual === null);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].actual, null);
});

test("a corrected re-run supersedes the failure it replaced instead of blocking", () => {
  // The exact shape recorded in a wedged consumer project: the claimed
  // verification is a compound command; its first run failed on a bad argument;
  // the agent fixed the argument and re-ran only the check, dropping the
  // already-completed build prefix. The failed run still matches the claim by
  // SUBSTRING, and `findMatches` returns the first tier that hits — so the
  // newer, successful run (which only matches on tokens) was never consulted
  // and a verification that genuinely passed was refused.
  const claimedCommand =
    "nx build ngx-foundation-sites && node -e \"const sass=require('sass');" +
    "const r=sass.compileString('@use theme;', {loadPaths:['dist/packages/ngx-foundation-sites']})\"";
  const mismatches = crossReferenceEvidence(
    [{ command: claimedCommand, exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command: claimedCommand,
        exitCode: 1,
        outputSnippet: "",
        timestamp: 1_786_617_938_147,
      },
      {
        kind: "bash",
        toolCallId: "call-2",
        command:
          "node -e \"const sass=require('sass');const r=sass.compileString('@use theme;', " +
          "{loadPaths:['dist/packages']})\"",
        exitCode: 0,
        outputSnippet: "bytes: 0",
        timestamp: 1_786_617_938_155,
      },
    ] as EvidenceEntry[],
  );

  // Downgraded, not dropped: only `error` severity blocks the unit.
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0]!.severity, "warning");
  assert.match(mismatches[0]!.reason, /a later matching run exited 0/);
  assert.equal(mismatches[0]!.actual?.toolCallId, "call-2");
});

test("an earlier success does not excuse a later failure of the same command", () => {
  // The relaxation must be one-directional. A run that succeeded BEFORE the
  // failure is not a re-verification of it.
  const mismatches = crossReferenceEvidence(
    [{ command: "npm test", exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command: "npm test",
        exitCode: 0,
        outputSnippet: "ok",
        timestamp: 1_000,
      },
      {
        kind: "bash",
        toolCallId: "call-2",
        command: "npm test",
        exitCode: 1,
        outputSnippet: "failed",
        timestamp: 2_000,
      },
    ] as EvidenceEntry[],
  );

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0]!.severity, "error", "a stale success must not unblock a real failure");
});

test("an unrelated later success does not excuse a failure", () => {
  const mismatches = crossReferenceEvidence(
    [{ command: "npm run build:production", exitCode: 0, verdict: "passed" }],
    [
      {
        kind: "bash",
        toolCallId: "call-1",
        command: "npm run build:production",
        exitCode: 1,
        outputSnippet: "failed",
        timestamp: 1_000,
      },
      {
        kind: "bash",
        toolCallId: "call-2",
        command: "git status --short",
        exitCode: 0,
        outputSnippet: "",
        timestamp: 2_000,
      },
    ] as EvidenceEntry[],
  );

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0]!.severity, "error", "an unrelated command must not count as a re-run");
});
