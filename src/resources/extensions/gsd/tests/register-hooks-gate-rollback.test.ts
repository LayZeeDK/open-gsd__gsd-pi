// Host-side arm/rollback pairing for the depth-verification gate.
//
// `tool_execution_start` is UNIVERSAL_TOOL_HOOKS, so the host arms the gate on
// every engine -- including the external claude-code-cli path, where the
// workflow MCP child's own arm/rollback pair is not the one in play. An arm that
// outlives a failed `ask_user_questions` is not a stale flag: every workflow
// tool is refused, the only tool the gate still permits is the call that just
// failed, and a milestone a human HAD verified silently loses that
// verification. These pin the pair at `tool_execution_end`.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { registerHooks } from "../bootstrap/register-hooks.ts";
import {
  getPendingGate,
  hostWriteGateAdapter,
  loadWriteGateSnapshot,
  resetWriteGateState,
  shouldBlockContextArtifactSave,
  shouldBlockPendingGate,
} from "../bootstrap/write-gate.ts";

const GATE_ID = "depth_verification_M002_confirm";
const QUESTIONS = [
  {
    id: GATE_ID,
    header: "Depth Check",
    question: "Did I capture the depth right?",
    options: [
      { label: "Yes, you got it (Recommended)", description: "Continue." },
      { label: "Not quite", description: "Clarify." },
    ],
  },
];

type Handler = (event: any, ctx?: any) => Promise<any> | any;

function makeTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `gsd-gate-rollback-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function registerTestHooks(): Map<string, Handler[]> {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, handler: Handler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
  } as any;

  registerHooks(pi, []);

  return handlers;
}

async function fire(
  handlers: Map<string, Handler[]>,
  event: string,
  payload: unknown,
  ctx?: unknown,
): Promise<void> {
  for (const handler of handlers.get(event) ?? []) {
    await handler(payload, ctx);
  }
}

test("register-hooks rolls the host gate arm back when ask_user_questions errors", async () => {
  const dir = makeTempDir("errored");
  try {
    resetWriteGateState(dir);
    const handlers = registerTestHooks();
    const ctx = { cwd: dir };

    await fire(handlers, "tool_execution_start", {
      toolCallId: "call-1",
      toolName: "ask_user_questions",
      args: { questions: QUESTIONS },
    }, ctx);

    assert.equal(getPendingGate(dir), GATE_ID, "the arm must land before delivery is attempted");

    await fire(handlers, "tool_execution_end", {
      toolCallId: "call-1",
      toolName: "ask_user_questions",
      isError: true,
      result: { content: [{ type: "text", text: "Client does not support form elicitation." }] },
    }, ctx);

    assert.equal(
      getPendingGate(dir),
      null,
      "an ask_user_questions that never reached the user must not leave the gate armed",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("register-hooks keeps the host gate arm when ask_user_questions returns a result", async () => {
  // The delivered-but-unanswered outcomes (cancelled / timed_out) come back as
  // normal results, not errors -- those are genuine re-asks and the gate must
  // stay armed. Only the error path is a failure to deliver.
  const dir = makeTempDir("delivered");
  try {
    resetWriteGateState(dir);
    const handlers = registerTestHooks();
    const ctx = { cwd: dir };

    await fire(handlers, "tool_execution_start", {
      toolCallId: "call-2",
      toolName: "ask_user_questions",
      args: { questions: QUESTIONS },
    }, ctx);

    await fire(handlers, "tool_execution_end", {
      toolCallId: "call-2",
      toolName: "ask_user_questions",
      isError: false,
      result: { structuredContent: { questions: QUESTIONS, response: null, cancelled: true } },
    }, ctx);

    assert.equal(getPendingGate(dir), GATE_ID);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("register-hooks restores a verification the host gate arm revoked", async () => {
  // The host adapter's verified-on-disk-wins policy suppresses the arm outright
  // when the gate is already verified, so this drives the case it does NOT
  // cover: a verification for a DIFFERENT milestone, which the arm leaves alone
  // and the rollback must therefore leave standing too.
  const dir = makeTempDir("verified");
  try {
    resetWriteGateState(dir);
    hostWriteGateAdapter.markDepthVerified("M001", dir);
    const handlers = registerTestHooks();
    const ctx = { cwd: dir };

    await fire(handlers, "tool_execution_start", {
      toolCallId: "call-3",
      toolName: "ask_user_questions",
      args: { questions: QUESTIONS },
    }, ctx);

    await fire(handlers, "tool_execution_end", {
      toolCallId: "call-3",
      toolName: "ask_user_questions",
      isError: true,
      result: "Client does not support form elicitation.",
    }, ctx);

    const snapshot = loadWriteGateSnapshot(dir);
    assert.equal(snapshot.pendingGateId, null);
    assert.deepEqual(
      snapshot.verifiedDepthMilestones,
      ["M001"],
      "a rollback must not take an unrelated milestone's verification with it",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("register-hooks arms nothing to roll back when the gate is already verified", async () => {
  const dir = makeTempDir("suppressed");
  try {
    resetWriteGateState(dir);
    hostWriteGateAdapter.markDepthVerified("M002", dir);
    const handlers = registerTestHooks();
    const ctx = { cwd: dir };

    await fire(handlers, "tool_execution_start", {
      toolCallId: "call-4",
      toolName: "ask_user_questions",
      args: { questions: QUESTIONS },
    }, ctx);

    assert.equal(getPendingGate(dir), null, "verified-on-disk wins over a re-arm");

    await fire(handlers, "tool_execution_end", {
      toolCallId: "call-4",
      toolName: "ask_user_questions",
      isError: true,
      result: "Client does not support form elicitation.",
    }, ctx);

    assert.deepEqual(
      loadWriteGateSnapshot(dir).verifiedDepthMilestones,
      ["M002"],
      "rolling back a suppressed arm must be a no-op, not a revocation",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("register-hooks leaves CONTEXT-DRAFT saveable after a failed ask, with CONTEXT still gated", async () => {
  // The reported deadlock in full: the gate demanded a question that cannot be
  // delivered, and the resulting pending arm then refused even the un-gated
  // CONTEXT-DRAFT save, so authored context was simply lost. After the rollback
  // the draft persists and the milestone parks in needs-discussion, which is
  // the correct outcome -- no human confirmed anything, so final CONTEXT stays
  // refused.
  const dir = makeTempDir("draft-saveable");
  try {
    resetWriteGateState(dir);
    const handlers = registerTestHooks();
    const ctx = { cwd: dir };

    await fire(handlers, "tool_execution_start", {
      toolCallId: "call-5",
      toolName: "ask_user_questions",
      args: { questions: QUESTIONS },
    }, ctx);

    assert.equal(
      shouldBlockPendingGate("gsd_summary_save", "M002", false, dir).block,
      true,
      "while armed, the pending gate refuses even the un-gated draft save",
    );

    await fire(handlers, "tool_execution_end", {
      toolCallId: "call-5",
      toolName: "ask_user_questions",
      isError: true,
      result: "Client does not support form elicitation.",
    }, ctx);

    assert.equal(shouldBlockPendingGate("gsd_summary_save", "M002", false, dir).block, false);
    assert.equal(shouldBlockPendingGate("bash", "M002", false, dir).block, false);
    assert.equal(shouldBlockContextArtifactSave("CONTEXT-DRAFT", "M002", null, dir).block, false);
    assert.equal(
      shouldBlockContextArtifactSave("CONTEXT", "M002", null, dir).block,
      true,
      "the rollback must not become a bypass -- nobody verified the depth",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
