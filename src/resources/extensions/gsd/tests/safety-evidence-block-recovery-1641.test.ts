// Project/App: gsd-pi
// File Purpose: Regression for #1641 / #1649 — a blocking safety evidence
// cross-reference mismatch must carry its sanctioned exit: the Task Attempt is
// settled/routed through the canonical recovery seam (recovery action minted),
// the pause notification surfaces the recoveryActionId + resume instruction,
// and the finalize break reason never routes into the verified-task
// publication boundary.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  postUnitPreVerification,
  resolveEvidenceRoutePresentation,
  type PostUnitContext,
} from "../auto-post-unit.ts";
import { AutoSession } from "../auto/session.ts";
import { decideFinalizeResult } from "../auto/workflow-kernel.ts";
import {
  _getAdapter,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  insertVerificationEvidence,
  openDatabase,
} from "../gsd-db.ts";
import { recordToolCall, recordToolResult, resetEvidence } from "../safety/evidence-collector.ts";
import {
  claimTaskAttempt,
  isTaskAttemptAwaitingVerification,
  readLatestTaskAttempt,
  readTaskAttempt,
  settleTaskAttempt,
} from "../task-execution-domain-operation.ts";
import { runWithTaskExecutionAttempt } from "../auto/task-execution-cutover.ts";
import { readTaskRecoveryRoute, recordFailureAndSelectRecovery } from "../task-recovery-domain-operation.ts";
import {
  invalidateTaskTechnicalPass,
  readTaskTechnicalVerdict,
  recordTaskTechnicalVerdict,
} from "../task-verification-domain-operation.ts";
import { routeEvidenceCrossReferenceBlock } from "../auto-verification.ts";
import { cleanup, git, makeTempRepo } from "./test-utils.ts";

const TASK = { milestoneId: "M001", sliceId: "S01", taskId: "T01" } as const;

function settleCanonicalTaskForHostVerification(basePath: string): string {
  const db = _getAdapter();
  assert.ok(db, "DB should be open before claiming canonical task authority");
  const now = "2026-08-08T00:00:00.000Z";
  db.prepare(`
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES ('evidence-worker', 'test-host', 1, ?, 'test', ?, 'active', ?)
  `).run(now, now, basePath);
  db.prepare(`
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES ('M001', 'evidence-worker', 7, ?, '2099-08-08T00:00:00.000Z', 'held')
  `).run(now);
  const dispatch = db.prepare(`
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      'evidence-trace', 'evidence-turn', 'evidence-worker', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'claimed', 1, ?
    )
  `).run(now) as { lastInsertRowid: number | bigint };
  const claim = claimTaskAttempt({
    invocation: {
      idempotencyKey: "fixture:evidence-block-1641:claim",
      sourceTransport: "internal",
      actorType: "agent",
      actorId: "evidence-worker",
    },
    task: { ...TASK },
    workerId: "evidence-worker",
    milestoneLeaseToken: 7,
    coordinationDispatchId: Number(dispatch.lastInsertRowid),
  });
  settleTaskAttempt({
    invocation: {
      idempotencyKey: "fixture:evidence-block-1641:settle",
      sourceTransport: "internal",
      actorType: "agent",
      actorId: "evidence-worker",
    },
    attemptId: claim.attemptId,
    outcome: "succeeded",
    failureClass: "none",
    summary: "Executor result is ready for host evidence verification.",
    output: { verification: "npm test" },
  });
  return claim.attemptId;
}

test("blocking evidence-xref settles and routes the Attempt with a surfaced recoveryActionId (#1641/#1649)", async () => {
  const base = makeTempRepo("gsd-evidence-block-1641-");

  try {
    writeFileSync(join(base, ".gitignore"), ".gsd/\n");
    git(base, "add", ".gitignore");
    git(base, "commit", "-m", "chore: ignore gsd runtime");

    openDatabase(":memory:");
    insertMilestone({ id: "M001", title: "Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });
    insertTask({
      id: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      title: "Add app entrypoint",
      status: "complete",
      oneLiner: "Added app entrypoint",
      keyFiles: ["app.js"],
      planning: {
        description: "Create app entrypoint",
        estimate: "small",
        files: ["app.js"],
        verify: "npm test",
        inputs: [],
        expectedOutput: ["app.js"],
        observabilityImpact: "none",
      },
    });
    insertVerificationEvidence({
      taskId: "T01",
      sliceId: "S01",
      milestoneId: "M001",
      command: "npm test",
      exitCode: 0,
      verdict: "passed",
      durationMs: 10,
    });
    const attemptId = settleCanonicalTaskForHostVerification(base);
    assert.equal(
      isTaskAttemptAwaitingVerification(readLatestTaskAttempt({ ...TASK })),
      true,
      "fixture Attempt must start in the awaiting-verification state",
    );

    writeFileSync(join(base, "app.js"), "console.log('ready');\n");

    // The persisted evidence file is the operator's only proof of the
    // contradiction they are being asked to repair before resuming. It is
    // cleared on retryable routes so a retry cross-references fresh execution
    // (#1641), but a terminal abort has no retry to keep clean.
    const evidenceFile = join(base, ".gsd", "safety", "evidence-M001-S01-T01.json");
    mkdirSync(join(base, ".gsd", "safety"), { recursive: true });
    writeFileSync(evidenceFile, "[]\n");

    resetEvidence();
    recordToolCall("call-1", "bash", { command: "npm test" });
    recordToolResult("call-1", "bash", "Command exited with code 1\nfailed\n", true);

    const s = new AutoSession();
    s.active = true;
    s.basePath = base;
    s.currentUnit = { type: "execute-task", id: "M001/S01/T01", startedAt: Date.now() };

    let pauseCalled = false;
    const notifications: string[] = [];
    const pctx: PostUnitContext = {
      s,
      ctx: {
        ui: { notify: (message: string) => notifications.push(message) },
      } as unknown as PostUnitContext["ctx"],
      pi: {} as PostUnitContext["pi"],
      buildSnapshotOpts: () => ({}),
      lockBase: () => base,
      stopAuto: async () => {},
      pauseAuto: async () => {
        pauseCalled = true;
      },
      updateProgressWidget: () => {},
    };

    const result = await postUnitPreVerification(pctx, {
      skipSettleDelay: true,
      skipWorktreeSync: true,
    });

    // The blocking branch returns the dedicated evidence-xref-blocked signal and pauses.
    assert.equal(result, "evidence-xref-blocked");
    assert.equal(pauseCalled, true);
    assert.equal(
      existsSync(evidenceFile),
      true,
      "a terminal abort must not delete the evidence the operator has to inspect",
    );

    // The withheld verdict is durably recorded and the Attempt is routed out of
    // the awaiting-verification wedge — a resume no longer replays the
    // identical finalize sequence.
    const verdict = readTaskTechnicalVerdict(attemptId);
    assert.ok(verdict, "a host Technical Verdict must be recorded");
    assert.equal(verdict.verdict, "fail");
    assert.equal(
      isTaskAttemptAwaitingVerification(readLatestTaskAttempt({ ...TASK })),
      false,
      "the Attempt must leave the awaiting-verification state",
    );

    // The recovery action row exists — the sanctioned exit was minted.
    const route = readTaskRecoveryRoute(attemptId);
    assert.ok(route, "a recovery route must exist for the blocked Attempt");
    assert.ok(route.recoveryActionId.length > 0, "recoveryActionId must be minted");
    assert.equal(route.recoveryOwner, "agent");
    // Both terms the cutover gate reads (task-execution-cutover.ts:443).
    // `resumeAuthorized` means "has already been resumed", so a freshly minted
    // abort must report false — that falsity is what makes the next dispatch
    // break instead of claiming a fresh Attempt and re-running the whole task.
    assert.equal(route.resumeAuthorized, false);
    // The very first contradiction routes terminal, so the pause already names
    // the tool that can actually clear it rather than a full re-run that cannot.
    assert.equal(route.action, "abort");
    assert.deepEqual(s.lastSafetyBlockRecovery, {
      recoveryActionId: route.recoveryActionId,
      resumeInstruction: 'resume with gsd_task_recovery_resume',
    });

    // The pause notification carries the recoveryActionId and a resume
    // instruction, so the first pause already contains its sanctioned exit.
    const blockingNotification = notifications.find((message) =>
      message.includes("claimed passing verification"),
    );
    assert.ok(blockingNotification, `expected evidence-xref notification, got: ${notifications.join("\n")}`);
    assert.ok(
      blockingNotification.includes(route.recoveryActionId),
      `notification must surface the recoveryActionId: ${blockingNotification}`,
    );
    assert.match(blockingNotification, /resume with (\/gsd auto|gsd_task_recovery_resume)/);
    // The offending mismatch is surfaced (claimed vs recorded exit code).
    assert.match(blockingNotification, /Claimed exitCode=0 but actual exitCode=1/);

    // Finalize maps "evidence-xref-blocked" to a break reason that is NOT
    // complete-and-break, so the loop stops before the verified-task
    // publication boundary — the "Verified Task publication requires a passing
    // host Technical Verdict" throw is unreachable on this path.
    const safetyReason = `safety-evidence-block (recoveryActionId: ${route.recoveryActionId}; resume with gsd_task_recovery_resume)`;
    const decision = decideFinalizeResult({ action: "break", reason: safetyReason });
    assert.equal(decision.action, "stop");
  } finally {
    resetEvidence();
    closeDatabase();
    cleanup(base);
  }
});

test("an evidence contradiction routes an unbudgeted abort under its own failure kind", (t) => {
  const base = makeTempRepo("gsd-evidence-budget-");
  t.after(() => {
    closeDatabase();
    cleanup(base);
  });
  openDatabase(":memory:");
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "complete" });
  const attemptId = settleCanonicalTaskForHostVerification(base);
  const attempt = readLatestTaskAttempt({ ...TASK });
  assert.ok(attempt);
  assert.ok(attempt.resultId);

  const routed = routeEvidenceCrossReferenceBlock({
    attempt: attempt!,
    basePath: base,
    mismatch: {
      command: "npm test",
      claimedExitCode: 0,
      actualExitCode: 1,
      reason: "Claimed exitCode=0 but actual exitCode=1",
    },
  });

  assert.equal(routed.outcome, "abort");
  assert.equal(routed.action, "abort");

  // The observation is filed under the dedicated kind and binds no recovery
  // budget row. Under `verification-failed` it bound the `remediation` budget,
  // whose uses are counted per (lifecycle, failureKind, fingerprint,
  // policyClass) — i.e. per Task, across Attempts — so a contradiction shared
  // its allowance with every ordinary host verification failure on the same
  // Task and the number of wasted full re-runs before a resumable abort
  // depended on unrelated history. With no budget bound, `budgetUses` cannot
  // reach this decision at all.
  const stored = _getAdapter()!.prepare(`
    SELECT observation.failure_kind, action.action, action.recovery_budget_id
    FROM workflow_recovery_actions action
    JOIN workflow_failure_observations observation
      ON observation.failure_observation_id = action.failure_observation_id
    WHERE action.recovery_action_id = :recovery_action_id
  `).get({ ":recovery_action_id": routed.recoveryActionId });
  assert.deepEqual(stored, {
    failure_kind: "safety-evidence-xref",
    action: "abort",
    recovery_budget_id: null,
  });

  assert.equal(
    readTaskRecoveryRoute(attemptId)?.resumeAuthorized,
    false,
    "a freshly minted abort has not been resumed",
  );
});

test("evidence routing failure surfaces a supported retry instruction", async (t) => {
  const base = makeTempRepo("gsd-evidence-route-rollback-");
  t.after(() => {
    closeDatabase();
    cleanup(base);
  });
  openDatabase(":memory:");
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "complete" });
  const attemptId = settleCanonicalTaskForHostVerification(base);
  const attempt = readLatestTaskAttempt({ ...TASK });
  assert.ok(attempt);

  assert.throws(() => routeEvidenceCrossReferenceBlock({
    attempt: attempt!,
    basePath: base,
    mismatch: {
      command: "npm test",
      claimedExitCode: 0,
      actualExitCode: 1,
      reason: "Claimed exitCode=0 but actual exitCode=1",
    },
    taskAuthority: {
      readLatestTaskAttempt,
      readTaskTechnicalVerdict,
      recordTaskTechnicalVerdict,
      invalidateTaskTechnicalPass,
      routeTaskFailure: ((..._args: Parameters<typeof recordFailureAndSelectRecovery>) => {
        throw new Error("injected route failure");
      }) as typeof recordFailureAndSelectRecovery,
    },
  }), /injected route failure/);

  const verdict = readTaskTechnicalVerdict(attemptId);
  assert.ok(verdict, "the failing verdict remains durable when routing fails");
  assert.equal(
    isTaskAttemptAwaitingVerification(readLatestTaskAttempt({ ...TASK })),
    false,
    "the persisted failing verdict must advance the Attempt out of verification",
  );
  const presentation = resolveEvidenceRoutePresentation(null, "injected route failure");
  assert.deepEqual(presentation.recovery, {
    resumeInstruction: "resume with /gsd auto to retry evidence recovery routing",
  });
  assert.match(presentation.exitInstruction, /injected route failure/);
  assert.match(presentation.exitInstruction, /resume with \/gsd auto/);

  // The verdict survived the failed route, so the next dispatch finds a stored
  // failing verdict with no recovery route and re-routes it itself. It must
  // recover the originating policy from the verdict's own evidence marker —
  // otherwise this degraded path silently downgrades the contradiction back to
  // a budgeted `remediate` and buys the full re-run the dedicated failure kind
  // exists to prevent.
  assert.equal(readTaskTechnicalVerdict(attemptId)?.verificationPolicy, "safety-evidence-xref");

  const dispatch = _getAdapter()!.prepare(
    `SELECT rowid AS id FROM unit_dispatches LIMIT 1`,
  ).get() as { id: number };
  const routedInputs: Parameters<typeof recordFailureAndSelectRecovery>[0][] = [];
  const rerouted = await runWithTaskExecutionAttempt(
    {
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      dispatchId: dispatch.id,
      workerId: "evidence-worker",
      milestoneLeaseToken: 7,
      traceId: "evidence-trace",
      turnId: "evidence-turn",
      markCanonicalDispatchSettled: () => {},
    },
    async () => {
      throw new Error("the stored verdict must be routed before the executor runs");
    },
    {
      readLatestTaskAttempt,
      readTaskAttempt,
      readTaskRecoveryRoute,
      readTaskTechnicalVerdict,
      claimTaskAttempt: () => {
        throw new Error("a stored failing verdict must not claim a fresh Attempt");
      },
      settleTaskAttempt: () => {
        throw new Error("a stored failing verdict must not settle a fresh Attempt");
      },
      routeTaskFailure: (routeInput) => {
        routedInputs.push(routeInput);
        return {
          status: "committed",
          operationId: "op-reroute",
          resultingRevision: 1,
          lifecycleId: "lifecycle-reroute",
          attemptId,
          resultId: attempt!.resultId!,
          failureObservationId: "observation-reroute",
          recoveryActionId: "recovery-action-reroute",
          action: "abort",
          resumeAuthorized: false,
        };
      },
    },
  );

  assert.equal(routedInputs.length, 1);
  assert.equal(routedInputs[0]!.classification.failureKind, "safety-evidence-xref");
  assert.deepEqual(rerouted, {
    action: "break",
    reason:
      "task-recovery-abort (recoveryActionId: recovery-action-reroute; resume with gsd_task_recovery_resume)",
  });
});
