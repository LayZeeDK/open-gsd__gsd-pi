// Project/App: gsd-pi
// File Purpose: A refused `gsd_task_recovery_resume` must name the condition
// that refused it. The eligibility gate ANDs nine conditions into one query and
// used to collapse every miss into one generic sentence, so a caller could not
// tell "superseded by a newer Attempt" from "already resumed" from "wrong
// owner" without hand-reading the journal.

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
  settleTaskAttempt,
} from "../task-execution-domain-operation.ts";
import {
  describeResumeRefusal,
  recordFailureAndSelectRecovery,
  resumeTaskRecovery,
  type ResumeRefusalRow,
} from "../task-recovery-domain-operation.ts";

const TASK = { milestoneId: "M001", sliceId: "S01", taskId: "T01" } as const;
const REPAIR = {
  repairSummary: "Re-ran the verification command and recorded the real exit code.",
  evidence: {
    evidenceClass: "command",
    commandOrTool: "npm test",
    workingDirectory: "/tmp/project",
    startedAt: "2026-08-13T00:00:00.000Z",
    endedAt: "2026-08-13T00:00:01.000Z",
    exitCode: 0,
    observation: "passed",
    durableOutputRef: "db://test/repair",
  },
} as const;

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
  const dir = mkdtempSync(join(tmpdir(), "resume-diagnosis-"));
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
      'diagnosis-worker', 'test-host', 1, '2026-08-13T00:00:00.000Z', 'test',
      '2026-08-13T00:00:00.000Z', 'active', '/tmp/project'
    );
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES (
      'M001', 'diagnosis-worker', 7, '2026-08-13T00:00:00.000Z',
      '2099-08-13T00:00:00.000Z', 'held'
    );
  `);
}

/** Claim and settle one failed Attempt, leaving it parked at the route stage. */
function seedFailedAttempt(
  attemptNumber: number,
  retryOfAttemptId?: string,
): { attemptId: string; resultId: string } {
  const db = _getAdapter();
  assert.ok(db);
  db.prepare(`
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      :trace, :turn, 'diagnosis-worker', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'claimed', :attempt_n, '2026-08-13T00:00:00.000Z'
    )
  `).run({
    ":trace": `trace-${attemptNumber}`,
    ":turn": `turn-${attemptNumber}`,
    ":attempt_n": attemptNumber,
  });
  const dispatch = db.prepare(
    "SELECT id FROM unit_dispatches WHERE trace_id = :trace",
  ).get({ ":trace": `trace-${attemptNumber}` });
  const claim = claimTaskAttempt({
    invocation: internalExecutionInvocation(`test:resume-diagnosis:claim:${attemptNumber}`),
    task: { ...TASK },
    workerId: "diagnosis-worker",
    milestoneLeaseToken: 7,
    coordinationDispatchId: Number(dispatch?.["id"]),
    ...(retryOfAttemptId ? { retryOfAttemptId } : {}),
  });
  const settled = settleTaskAttempt({
    invocation: internalExecutionInvocation(`test:resume-diagnosis:settle:${attemptNumber}`),
    attemptId: claim.attemptId,
    outcome: "failed",
    failureClass: "executor-failed",
    summary: "executor failed",
    output: {},
  });
  assert.ok(settled.resultId);
  return { attemptId: claim.attemptId, resultId: settled.resultId! };
}

/**
 * `fatal` is deliberate: it has no `budgetedRule` case, so it reaches a terminal
 * abort on the first route via `selectRecoveryDecision`'s `default`. Any
 * unbudgeted kind would do. Do NOT reach for a kind introduced by another patch
 * — this suite must compile when cherry-picked on its own.
 */
function routeFailure(
  attempt: { attemptId: string; resultId: string },
  failureKind: "fatal" | "verification-failed",
  key: string,
): { recoveryActionId: string; action: string } {
  const receipt = recordFailureAndSelectRecovery({
    invocation: internalExecutionInvocation(`test:resume-diagnosis:route:${key}`),
    attemptId: attempt.attemptId,
    resultId: attempt.resultId,
    owner: "agent",
    classification: { failureKind },
    summary: "routed for the resume diagnosis fixture",
    evidence: { unitType: "execute-task", unitId: "M001/S01/T01" },
    rationale: "fixture",
  });
  return { recoveryActionId: receipt.recoveryActionId, action: receipt.action };
}

function refusalFor(recoveryActionId: string, key: string): string {
  try {
    resumeTaskRecovery({
      invocation: internalExecutionInvocation(`test:resume-diagnosis:resume:${key}`),
      recoveryActionId,
      ...REPAIR,
    });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return assert.fail(`resume of ${recoveryActionId} should have been refused`);
}

// The diagnosis-throws fallback is deliberately NOT tested. Every table the
// diagnosis reads is also read by the gate query that precedes it, so schema
// surgery breaks the gate first and its error escapes directly — there is no
// deterministic way to make only the diagnosis fail. Reaching that branch needs
// a transient fault (e.g. SQLITE_BUSY between the two queries). The fallback is
// a debugLog plus the unchanged bare refusal; the sibling fallbacks in
// auto/task-recovery-relaunch.ts are untested for the same reason.

test("an unknown recoveryActionId is named as unknown, not as a wrong-state abort", () => {
  makeProject();
  seedFailedAttempt(1);

  const message = refusalFor("00000000-0000-4000-8000-000000000000", "unknown");

  assert.match(message, /^Task recovery resume requires the current agent-owned abort: /);
  assert.match(message, /no recovery action with that id exists/);
});

test("a non-abort route is named by the action it actually routed", () => {
  makeProject();
  const attempt = seedFailedAttempt(1);
  const routed = routeFailure(attempt, "verification-failed", "remediate");
  assert.equal(routed.action, "remediate", "fixture must produce a budgeted, non-terminal route");

  const message = refusalFor(routed.recoveryActionId, "remediate");

  assert.match(message, new RegExp(`recovery action ${routed.recoveryActionId} routed 'remediate', not 'abort'`));
});

test("an abort superseded by a newer Attempt says so instead of failing generically", () => {
  makeProject();
  const first = seedFailedAttempt(1);
  const routed = routeFailure(first, "fatal", "abort");
  assert.equal(routed.action, "abort");

  // A new Attempt cannot be claimed on top of an unresumed abort — the domain
  // refuses with "retry claim requires current causal recovery authority", which
  // is the abort doing its job. So the only way an id goes stale is the one the
  // bug report hit: the recovery moved on, and a caller is still holding the
  // older id.
  resumeTaskRecovery({
    invocation: internalExecutionInvocation("test:resume-diagnosis:resume:supersede"),
    recoveryActionId: routed.recoveryActionId,
    ...REPAIR,
  });
  seedFailedAttempt(2, first.attemptId);

  const message = refusalFor(routed.recoveryActionId, "superseded");

  // Both "superseded" and "already resumed" are true here. Superseded wins
  // because it is the more actionable half: it points at the current Attempt.
  assert.match(message, /superseded: Attempt 1 is not the current Attempt 2/);
});

test("a resumable abort resumes once, and the second refusal names it as already resumed", () => {
  makeProject();
  const attempt = seedFailedAttempt(1);
  const routed = routeFailure(attempt, "fatal", "abort");
  assert.equal(routed.action, "abort");

  const receipt = resumeTaskRecovery({
    invocation: internalExecutionInvocation("test:resume-diagnosis:resume:first"),
    recoveryActionId: routed.recoveryActionId,
    ...REPAIR,
  });
  assert.equal(receipt.recoveryActionId, routed.recoveryActionId);
  assert.ok(receipt.workCheckpointId.length > 0);

  // A DISTINCT invocation is load-bearing. Replaying the first idempotency key
  // returns the committed receipt without reaching the eligibility gate at all,
  // so the assertion below would pass while testing nothing.
  const message = refusalFor(routed.recoveryActionId, "second");

  assert.match(message, /already resumed/);
});

// ─── Branch coverage for the diagnosis itself ──────────────────────────────
//
// The DB-backed cases above reach four of the ten conditions. The rest are not
// producible through the domain writers: `recordFailureObservation` is the only
// production writer of `workflow_failure_observations` and always supplies an
// Attempt and a Result, and the domain will not mint an `abort` that is
// human-owned or carries a blocker. Reaching them from a DB fixture would mean
// hand-inserting states the domain refuses to create — a fixture built past the
// code under test. Drive the pure selector instead, which is why it is split
// out of the query.

/** A row where every condition passes; each case below breaks exactly one. */
const ELIGIBLE_ROW: Record<string, unknown> = {
  action_value: "abort",
  blocker_id: null,
  observation_id: "observation-1",
  result_id: "result-1",
  owner_value: "agent",
  lifecycle_value: "in_progress",
  attempt_state_value: "settled",
  attempt_number: 2,
  max_attempt_number: 2,
  causal_authority_ok: 1,
  has_open_blocker: 0,
  already_resumed: 0,
};

const BRANCHES: Array<{ name: string; row: ResumeRefusalRow; expect: RegExp }> = [
  {
    name: "unknown id",
    row: undefined,
    expect: /^no recovery action with that id exists$/,
  },
  {
    name: "non-abort action",
    row: { ...ELIGIBLE_ROW, action_value: "remediate" },
    expect: /routed 'remediate', not 'abort'/,
  },
  {
    name: "human-owned abort",
    row: { ...ELIGIBLE_ROW, blocker_id: "blocker-1" },
    expect: /human-owned \(it carries a blocker\)/,
  },
  {
    name: "missing observation",
    row: { ...ELIGIBLE_ROW, observation_id: null, owner_value: null, lifecycle_value: null },
    expect: /no failure observation to resume from/,
  },
  {
    name: "non-agent owner",
    row: { ...ELIGIBLE_ROW, owner_value: "user" },
    expect: /owned by 'user', not the agent/,
  },
  {
    name: "closed lifecycle",
    row: { ...ELIGIBLE_ROW, lifecycle_value: "completed" },
    expect: /lifecycle is 'completed', not 'in_progress'/,
  },
  {
    // The regression finding #2 named: with the lifecycle joined through the
    // Attempt, a NULL attempt_id made lifecycle_value NULL too, and this was
    // reported as "the Task lifecycle is 'unknown'".
    name: "missing attempt",
    row: {
      ...ELIGIBLE_ROW,
      attempt_number: null,
      max_attempt_number: null,
      attempt_state_value: null,
    },
    expect: /^the observation records no Attempt to resume$/,
  },
  {
    name: "running attempt",
    row: { ...ELIGIBLE_ROW, attempt_state_value: "running" },
    expect: /the Attempt is 'running', not 'settled'/,
  },
  {
    name: "superseded attempt",
    row: { ...ELIGIBLE_ROW, attempt_number: 1, max_attempt_number: 3 },
    expect: /^superseded: Attempt 1 is not the current Attempt 3$/,
  },
  {
    name: "missing result",
    row: { ...ELIGIBLE_ROW, result_id: null },
    expect: /no Attempt Result to resume from/,
  },
  {
    name: "stale causal authority",
    row: { ...ELIGIBLE_ROW, causal_authority_ok: 0 },
    expect: /no longer the current evidence-backed failure/,
  },
  {
    name: "open blocker",
    row: { ...ELIGIBLE_ROW, has_open_blocker: 1 },
    expect: /open blocker on the Task must be resolved first/,
  },
  {
    name: "already resumed",
    row: { ...ELIGIBLE_ROW, already_resumed: 1 },
    expect: /^already resumed$/,
  },
  {
    name: "no condition failed",
    row: { ...ELIGIBLE_ROW },
    expect: /a condition this diagnosis does not cover/,
  },
];

for (const branch of BRANCHES) {
  test(`the diagnosis names the ${branch.name}`, () => {
    assert.match(describeResumeRefusal(branch.row, "recovery-action-1"), branch.expect);
  });
}

test("a missing Attempt is never misreported as a wrong Attempt state or a stale number", () => {
  // Both guards for finding #7: the attempt-number comparison must not be a
  // `null !== null` no-op, and a NULL state must not read as "not 'settled'".
  const message = describeResumeRefusal(
    { ...ELIGIBLE_ROW, attempt_number: null, max_attempt_number: null, attempt_state_value: null },
    "recovery-action-1",
  );
  assert.doesNotMatch(message, /not 'settled'/);
  assert.doesNotMatch(message, /superseded/);
});
