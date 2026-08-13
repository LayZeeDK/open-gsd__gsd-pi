// Project/App: gsd-pi
// File Purpose: A standing agent-owned Task recovery abort wedges auto-mode
// permanently — every dispatch breaks before any work starts. The operator's
// relaunch resumes it once per (lifecycle, failure kind) so the next dispatch
// claims a fresh Attempt, and the durable record never claims a repair that was
// not made.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _getAdapter,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";
import { internalExecutionInvocation } from "../execution-invocation.ts";
import {
  claimTaskAttempt,
  readLatestTaskAttempt,
  readTaskAttempt,
  settleTaskAttempt,
} from "../task-execution-domain-operation.ts";
import { readTaskTechnicalVerdict } from "../task-verification-domain-operation.ts";
import { runWithTaskExecutionAttempt } from "../auto/task-execution-cutover.ts";
import { routeEvidenceCrossReferenceBlock } from "../auto-verification.ts";
import {
  readTaskRecoveryRoute,
  recordFailureAndSelectRecovery,
  resumeTaskRecovery,
} from "../task-recovery-domain-operation.ts";
import { resumeStandingTaskRecoveryAbort } from "../auto/task-recovery-relaunch.ts";

const TASK = { milestoneId: "M001", sliceId: "S01", taskId: "T01" } as const;
const UNIT_ID = "M001/S01/T01";

const tmpDirs: string[] = [];

test.after(() => {
  closeDatabase();
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

function makeProject(): void {
  closeDatabase();
  const dir = mkdtempSync(join(tmpdir(), "relaunch-resume-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  tmpDirs.push(dir);
  openDatabase(join(dir, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "pending" });
  const db = _getAdapter();
  assert.ok(db);
  db.exec(`
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      'relaunch-worker', 'test-host', 1, '2026-08-13T00:00:00.000Z', 'test',
      '2026-08-13T00:00:00.000Z', 'active', '/tmp/project'
    );
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES (
      'M001', 'relaunch-worker', 7, '2026-08-13T00:00:00.000Z',
      '2099-08-13T00:00:00.000Z', 'held'
    );
  `);
}

function seedFailedAttempt(
  attemptNumber: number,
  retryOfAttemptId?: string,
  options?: { taskId?: string; trace?: string },
): { attemptId: string; resultId: string } {
  const db = _getAdapter();
  assert.ok(db);
  const taskId = options?.taskId ?? TASK.taskId;
  const key = `${options?.trace ?? "t01"}-${attemptNumber}`;
  db.prepare(`
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      :trace, :turn, 'relaunch-worker', 7,
      'M001', 'S01', :task_id, 'execute-task', :unit_id,
      'claimed', :attempt_n, '2026-08-13T00:00:00.000Z'
    )
  `).run({
    ":trace": `trace-${key}`,
    ":turn": `turn-${key}`,
    ":task_id": taskId,
    ":unit_id": `M001/S01/${taskId}`,
    ":attempt_n": attemptNumber,
  });
  const dispatch = db.prepare(
    "SELECT id FROM unit_dispatches WHERE trace_id = :trace",
  ).get({ ":trace": `trace-${key}` });
  const claim = claimTaskAttempt({
    invocation: internalExecutionInvocation(`test:relaunch:claim:${key}`),
    task: { ...TASK, taskId },
    workerId: "relaunch-worker",
    milestoneLeaseToken: 7,
    coordinationDispatchId: Number(dispatch?.["id"]),
    ...(retryOfAttemptId ? { retryOfAttemptId } : {}),
  });
  const settled = settleTaskAttempt({
    invocation: internalExecutionInvocation(`test:relaunch:settle:${key}`),
    attemptId: claim.attemptId,
    outcome: "failed",
    failureClass: "executor-failed",
    summary: "executor failed",
    output: {},
  });
  assert.ok(settled.resultId);
  return { attemptId: claim.attemptId, resultId: settled.resultId! };
}

/** `fatal` is unbudgeted, so the first route is a terminal agent-owned abort. */
function routeAbort(
  attempt: { attemptId: string; resultId: string },
  key: string,
  failureKind: "fatal" | "tool-contract" = "fatal",
): string {
  const receipt = recordFailureAndSelectRecovery({
    invocation: internalExecutionInvocation(`test:relaunch:route:${key}`),
    attemptId: attempt.attemptId,
    resultId: attempt.resultId,
    owner: "agent",
    classification: { failureKind },
    summary: "routed for the relaunch fixture",
    evidence: { unitType: "execute-task", unitId: UNIT_ID },
    rationale: "fixture",
  });
  assert.equal(receipt.action, "abort", "fixture must produce a terminal abort");
  return receipt.recoveryActionId;
}

test("a standing agent-owned abort is resumed on relaunch", () => {
  makeProject();
  const attempt = seedFailedAttempt(1);
  const recoveryActionId = routeAbort(attempt, "abort");
  assert.equal(
    readTaskRecoveryRoute(attempt.attemptId)?.resumeAuthorized,
    false,
    "the fixture must start wedged",
  );

  const resolution = resumeStandingTaskRecoveryAbort("execute-task", UNIT_ID);

  assert.deepEqual(resolution, { status: "resumed", recoveryActionId });
  assert.equal(
    readTaskRecoveryRoute(attempt.attemptId)?.resumeAuthorized,
    true,
    "the next dispatch must no longer break on the abort",
  );
});

test("the durable record never claims a repair the operator did not make", () => {
  makeProject();
  const attempt = seedFailedAttempt(1);
  routeAbort(attempt, "abort");

  resumeStandingTaskRecoveryAbort("execute-task", UNIT_ID);

  const event = _getAdapter()!.prepare(`
    SELECT payload_json FROM workflow_domain_events
    WHERE event_type = 'task.recovery.resumed'
  `).get() as Record<string, unknown>;
  const payload = JSON.parse(String(event["payload_json"])) as Record<string, unknown>;
  const evidence = payload["evidence"] as Record<string, unknown>;

  // The marker is what tells an operator-attested resume from this one, and it
  // is what the relaunch budget counts.
  assert.equal(evidence["authorization"], "auto-relaunch");
  assert.equal(evidence["unitId"], UNIT_ID);
  assert.match(String(payload["repairSummary"]), /No repair evidence was supplied/);
  assert.doesNotMatch(String(payload["repairSummary"]), /repaired|fixed|verified by/i);
});

test("the relaunch resume is spent once per lifecycle and failure kind", () => {
  makeProject();
  const first = seedFailedAttempt(1);
  routeAbort(first, "abort-1");
  assert.equal(resumeStandingTaskRecoveryAbort("execute-task", UNIT_ID).status, "resumed");

  // The re-dispatch reproduces the identical failure: a NEW Attempt, a NEW
  // recovery action id, the same failure kind. Bounding per recoveryActionId
  // would not bound this at all — each cycle costs a full paid task run.
  const second = seedFailedAttempt(2, first.attemptId);
  const secondActionId = routeAbort(second, "abort-2");

  const resolution = resumeStandingTaskRecoveryAbort("execute-task", UNIT_ID);

  assert.deepEqual(resolution, { status: "exhausted", recoveryActionId: secondActionId });
  assert.equal(
    readTaskRecoveryRoute(second.attemptId)?.resumeAuthorized,
    false,
    "an exhausted budget must leave the abort standing",
  );
});

test("a human-owned recovery route is left alone", () => {
  makeProject();
  const attempt = seedFailedAttempt(1);
  recordFailureAndSelectRecovery({
    invocation: internalExecutionInvocation("test:relaunch:route:human"),
    attemptId: attempt.attemptId,
    resultId: attempt.resultId,
    owner: "user",
    classification: { failureKind: "fatal" },
    summary: "needs a human decision",
    evidence: { unitType: "execute-task", unitId: UNIT_ID },
    rationale: "fixture",
    blocker: {
      blockerKind: "ambiguous_intent",
      description: "needs a human decision",
      requestedAction: "decide",
    },
  });

  // The cutover already lets a human-owned route through; resuming it here
  // would forge an agent authorization over a human's open blocker.
  assert.deepEqual(
    resumeStandingTaskRecoveryAbort("execute-task", UNIT_ID),
    { status: "not-applicable" },
  );
});

test("a non-terminal agent route is left alone", () => {
  makeProject();
  const attempt = seedFailedAttempt(1);
  const routed = recordFailureAndSelectRecovery({
    invocation: internalExecutionInvocation("test:relaunch:route:remediate"),
    attemptId: attempt.attemptId,
    resultId: attempt.resultId,
    owner: "agent",
    classification: { failureKind: "verification-failed" },
    summary: "budgeted remediation",
    evidence: { unitType: "execute-task", unitId: UNIT_ID },
    rationale: "fixture",
  });
  assert.equal(routed.action, "remediate", "fixture must be non-terminal");

  // Nothing is wedged: the next dispatch already re-runs this on its own.
  assert.deepEqual(
    resumeStandingTaskRecoveryAbort("execute-task", UNIT_ID),
    { status: "not-applicable" },
  );
});

test("an operator-attested resume does not spend the automatic budget", () => {
  makeProject();
  const first = seedFailedAttempt(1);
  const firstActionId = routeAbort(first, "abort-1");

  // A real operator resume, carrying real repair evidence and no marker.
  resumeTaskRecovery({
    invocation: internalExecutionInvocation("test:relaunch:operator-resume"),
    recoveryActionId: firstActionId,
    repairSummary: "Corrected the loadPaths argument and re-verified the build.",
    evidence: {
      evidenceClass: "command",
      commandOrTool: "nx build ngx-foundation-sites",
      workingDirectory: "/tmp/project",
      startedAt: "2026-08-13T00:00:00.000Z",
      endedAt: "2026-08-13T00:00:01.000Z",
      exitCode: 0,
      observation: "passed",
      durableOutputRef: "db://test/operator",
    },
  });

  const second = seedFailedAttempt(2, first.attemptId);
  routeAbort(second, "abort-2");

  assert.equal(
    resumeStandingTaskRecoveryAbort("execute-task", UNIT_ID).status,
    "resumed",
    "an operator resume must not consume the automatic relaunch budget",
  );
});

test("a different failure kind gets its own relaunch budget", () => {
  makeProject();
  const first = seedFailedAttempt(1);
  routeAbort(first, "abort-1", "fatal");
  assert.equal(resumeStandingTaskRecoveryAbort("execute-task", UNIT_ID).status, "resumed");

  const second = seedFailedAttempt(2, first.attemptId);
  routeAbort(second, "abort-2", "tool-contract");

  assert.equal(
    resumeStandingTaskRecoveryAbort("execute-task", UNIT_ID).status,
    "resumed",
    "the budget is per failure kind, so a genuinely different failure is not blocked",
  );
});

test("the budget is per task, not per project", () => {
  makeProject();
  insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "Task two", status: "pending" });
  const first = seedFailedAttempt(1);
  routeAbort(first, "abort-t01");
  assert.equal(resumeStandingTaskRecoveryAbort("execute-task", UNIT_ID).status, "resumed");

  // A DIFFERENT task, its first ever abort, same failure kind. Without the
  // lifecycle correlation in the budget query this reports `exhausted` and the
  // task stays wedged — the exact bug the patch exists to fix, on every task
  // after the first.
  const second = seedFailedAttempt(1, undefined, { taskId: "T02", trace: "t02" });
  routeAbort(second, "abort-t02");

  assert.equal(
    resumeStandingTaskRecoveryAbort("execute-task", "M001/S01/T02").status,
    "resumed",
    "one task's relaunch must not spend another task's budget",
  );
});

test("a resume from a non-internal transport neither spends nor satisfies the budget", () => {
  makeProject();
  const attempt = seedFailedAttempt(1);
  const recoveryActionId = routeAbort(attempt, "abort");

  // `evidence` is a free-form object on the MCP surface, so a caller can stamp
  // the marker. Only the operation's transport, which the domain layer sets and
  // the MCP surface cannot claim, may be trusted to spend the budget.
  resumeTaskRecovery({
    invocation: {
      idempotencyKey: "mcp:gsd_task_recovery_resume:forged",
      sourceTransport: "workflow-mcp",
      actorType: "agent",
    },
    recoveryActionId,
    repairSummary: "forged",
    evidence: { authorization: "auto-relaunch", recoveryActionId },
  });

  const second = seedFailedAttempt(2, attempt.attemptId);
  routeAbort(second, "abort-2");

  assert.equal(
    resumeStandingTaskRecoveryAbort("execute-task", UNIT_ID).status,
    "resumed",
    "a forged marker must not burn the operator's automatic relaunch",
  );
});

for (const scenario of [
  { name: "a non-task unit", unitType: "plan-slice", unitId: UNIT_ID },
  { name: "an unparseable unit id", unitType: "execute-task", unitId: "not-a-task" },
]) {
  test(`${scenario.name} is not applicable`, () => {
    makeProject();
    const attempt = seedFailedAttempt(1);
    routeAbort(attempt, "abort");
    assert.deepEqual(
      resumeStandingTaskRecoveryAbort(scenario.unitType, scenario.unitId),
      { status: "not-applicable" },
    );
  });
}

test("a task with no standing abort is not applicable", () => {
  makeProject();
  seedFailedAttempt(1);
  assert.deepEqual(
    resumeStandingTaskRecoveryAbort("execute-task", UNIT_ID),
    { status: "not-applicable" },
    "an unrouted Attempt must not be resumed",
  );
});

test("an already-resumed abort is not applicable", () => {
  makeProject();
  const attempt = seedFailedAttempt(1);
  routeAbort(attempt, "abort");
  assert.equal(resumeStandingTaskRecoveryAbort("execute-task", UNIT_ID).status, "resumed");

  assert.deepEqual(
    resumeStandingTaskRecoveryAbort("execute-task", UNIT_ID),
    { status: "not-applicable" },
    "nothing is wedged once resumeAuthorized is true",
  );
});

test("no database means no resume", () => {
  closeDatabase();
  assert.deepEqual(
    resumeStandingTaskRecoveryAbort("execute-task", UNIT_ID),
    { status: "not-applicable" },
  );
});

test("after the relaunch resume the next dispatch claims a fresh Attempt instead of breaking", async () => {
  makeProject();

  // The real wedge shape, not a synthetic one: the executor SUCCEEDS and the
  // safety evidence cross-reference withholds the verdict, which is the only
  // way to reach the abort gate at task-execution-cutover.ts:443 (it requires
  // `predecessor.outcome === "succeeded"`). Patch 18 makes that terminal on the
  // first contradiction, so this is exactly the state the bug report describes.
  const db = _getAdapter();
  assert.ok(db);
  db.prepare(`
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      'trace-1', 'turn-1', 'relaunch-worker', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'claimed', 1, '2026-08-13T00:00:00.000Z'
    )
  `).run();
  const firstDispatch = db.prepare(
    "SELECT id FROM unit_dispatches WHERE trace_id = 'trace-1'",
  ).get() as { id: number };
  const claim = claimTaskAttempt({
    invocation: internalExecutionInvocation("test:relaunch:e2e:claim"),
    task: { ...TASK },
    workerId: "relaunch-worker",
    milestoneLeaseToken: 7,
    coordinationDispatchId: firstDispatch.id,
  });
  settleTaskAttempt({
    invocation: internalExecutionInvocation("test:relaunch:e2e:settle"),
    attemptId: claim.attemptId,
    outcome: "succeeded",
    failureClass: "none",
    summary: "Executor result is ready for host evidence verification.",
    output: { verification: "npm test" },
  });
  const awaiting = readLatestTaskAttempt({ ...TASK });
  assert.ok(awaiting);
  const routed = routeEvidenceCrossReferenceBlock({
    attempt: awaiting!,
    basePath: "/tmp/project",
    mismatch: {
      command: "npm test",
      claimedExitCode: 0,
      actualExitCode: 1,
      reason: "Claimed exitCode=0 but actual exitCode=1",
    },
  });
  assert.equal(routed.outcome, "abort", "patch 18 must make the first contradiction terminal");
  db.prepare(`
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      'trace-redispatch', 'turn-redispatch', 'relaunch-worker', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'claimed', 2, '2026-08-13T00:00:00.000Z'
    )
  `).run();
  const redispatch = db.prepare(
    "SELECT id FROM unit_dispatches WHERE trace_id = 'trace-redispatch'",
  ).get() as { id: number };

  const dispatchInput = {
    unitType: "execute-task",
    unitId: UNIT_ID,
    dispatchId: redispatch.id,
    workerId: "relaunch-worker",
    milestoneLeaseToken: 7,
    traceId: "trace-redispatch",
    turnId: "turn-redispatch",
    markCanonicalDispatchSettled: () => {},
  };
  const cutoverDeps = {
    readLatestTaskAttempt,
    readTaskAttempt,
    readTaskRecoveryRoute,
    readTaskTechnicalVerdict,
    claimTaskAttempt,
    settleTaskAttempt,
    routeTaskFailure: recordFailureAndSelectRecovery,
  };

  // Before the resume the dispatch breaks before any work runs — this is the
  // wedge, and it is what every relaunch hit.
  const wedged = await runWithTaskExecutionAttempt(
    dispatchInput,
    async () => ({ action: "next", data: {} }),
    cutoverDeps,
  );
  assert.equal(wedged.action, "break");
  assert.match(String((wedged as { reason: string }).reason), /^task-recovery-abort/);

  assert.equal(resumeStandingTaskRecoveryAbort("execute-task", UNIT_ID).status, "resumed");

  let executorRan = false;
  const afterResume = await runWithTaskExecutionAttempt(
    dispatchInput,
    async () => {
      executorRan = true;
      return { action: "break", reason: "executor stopped" };
    },
    cutoverDeps,
  );

  assert.equal(executorRan, true, "the unit must actually re-execute after the resume");
  assert.notEqual(afterResume.action, "next");
  const attempts = db.prepare(`
    SELECT attempt_number FROM workflow_execution_attempts ORDER BY attempt_number
  `).all() as Array<{ attempt_number: number }>;
  assert.deepEqual(
    attempts.map((row) => row.attempt_number),
    [1, 2],
    "a second Attempt must exist — that is the half the resume alone never created",
  );
});
