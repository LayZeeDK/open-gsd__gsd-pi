// Project/App: gsd-pi
// File Purpose: How forensics must treat the agent loop's synthetic answer for
// a tool call an abort never ran.

import assert from "node:assert/strict";
import test from "node:test";

import { ABORTED_TOOL_CALL_TEXT } from "../../../../../packages/pi-agent-core/src/agent-loop.ts";
import { extractTrace, isAbortedNotExecutedResult } from "../session-forensics.ts";

// The predicate tests import the REAL consumer, not a copy of its regex. A copy
// would only catch drift on the producer side and would stay green if this
// regex were narrowed or rewritten by a rebase, which rerere can replay
// silently in this repo.

test("the forensics filter recognises the agent loop's synthetic abort answer", () => {
  assert.ok(
    isAbortedNotExecutedResult(ABORTED_TOOL_CALL_TEXT),
    "session-forensics no longer recognises the agent loop's abort answer",
  );
});

test("the filter tolerates the whitespace a transcript round trip can add", () => {
  assert.ok(isAbortedNotExecutedResult(`\n  ${ABORTED_TOOL_CALL_TEXT}  \n`));
});

test("the filter does not swallow a real tool failure", () => {
  for (const realFailure of [
    "Error: command not found",
    "The run was aborted, but this text is a genuine tool error",
    "Not executed because the schema was invalid",
    "",
  ]) {
    assert.equal(
      isAbortedNotExecutedResult(realFailure),
      false,
      `filter must not swallow: ${JSON.stringify(realFailure)}`,
    );
  }
});

function abortedBatchEntries(): unknown[] {
  // One assistant turn with two bash calls; the first really ran, the second
  // was answered synthetically because the abort landed first.
  return [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm run build" } },
          { type: "toolCall", id: "call-2", name: "bash", arguments: { command: "rm -rf dist && npm run deploy" } },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        isError: false,
        content: [{ type: "text", text: "build ok" }],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call-2",
        toolName: "bash",
        isError: true,
        content: [{ type: "text", text: ABORTED_TOOL_CALL_TEXT }],
      },
    },
  ];
}

test("a never-run command is never reported as having succeeded", () => {
  // The failure this pins: `commandsRun` is pushed when the toolCall block is
  // PARSED, before any result. Consuming the synthetic result at the result site
  // leaves that entry at `failed: false`, so the recovery briefing renders the
  // command under "Commands Already Run" with a check mark, beneath an
  // instruction not to re-run what already succeeded. For a deploy or an
  // `rm -rf` that is far worse than the phantom error it replaced.
  const trace = extractTrace(abortedBatchEntries());

  const deploy = trace.commandsRun.find((c) => c.command.includes("deploy"));
  assert.ok(deploy, "the never-run command should still be listed");
  assert.equal(deploy.failed, true, "a never-run command must not render as succeeded");

  const build = trace.commandsRun.find((c) => c.command === "npm run build");
  assert.ok(build);
  assert.equal(build.failed, false, "the command that really ran is untouched");
});

test("an aborted batch still counts its tool calls", () => {
  // `toolCallCount === 0` sends synthesizeCrashRecovery into its project-wide
  // activity-log fallback, which briefs the operator with a DIFFERENT unit's
  // history. Dropping aborted calls from `toolCalls` could reach zero for a
  // batch aborted on its first call.
  const trace = extractTrace(abortedBatchEntries());
  assert.equal(trace.toolCallCount, 2);
  assert.equal(trace.toolCalls.length, 2);
});

test("a successful result quoting the abort sentence is not dropped", () => {
  // Gated on isError as well as the text: a `read` or `bash` over a session
  // transcript can legitimately echo it back.
  const entries = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "cat session.jsonl" } },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        isError: false,
        content: [{ type: "text", text: ABORTED_TOOL_CALL_TEXT }],
      },
    },
  ];

  const trace = extractTrace(entries);
  assert.equal(trace.toolCalls.length, 1);
  assert.equal(trace.toolCalls[0].isError, false);
  assert.equal(trace.commandsRun[0].failed, false, "a successful command must not be marked failed");
});
