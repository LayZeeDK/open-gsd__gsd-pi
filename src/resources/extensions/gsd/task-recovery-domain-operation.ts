// Project/App: gsd-pi
// File Purpose: Replay-safe semantic Domain Operations for Task recovery history.

import {
  canonicalDomainJson,
  executeDomainOperation,
  type DomainJsonValue,
  type DomainOperationContext,
  type DomainOperationMutation,
  type DomainOperationRequest,
  type DomainOperationResult,
} from "./db/domain-operation.js";
import { debugLog } from "./debug-logger.js";
import { getDb } from "./db/engine.js";
import {
  CURRENT_EVIDENCE_BACKED_FAILURE_VERDICT_SQL,
  CURRENT_TASK_RECOVERY_CAUSAL_AUTHORITY_SQL,
} from "./db/sql-constants.js";
import {
  appendRecoveryWorkCheckpoint,
  createOrReadRecoveryBudget,
  grantRecoveryWaiver,
  openRecoveryBlocker,
  recordFailureObservation,
  recordRecoveryAction,
  recordRequirementDisposition,
  resolveRecoveryBlocker,
  terminateRecoveryWaiver,
  type AppendRecoveryWorkCheckpointInput,
  type GrantRecoveryWaiverInput,
  type RecordRequirementDispositionInput,
} from "./db/writers/task-recovery.js";
import {
  readDomainOperationFence,
  isTaskRecoveryResumeAuthorized,
} from "./db/writers/lifecycle-commands.js";
import type { ExecutionInvocation } from "./execution-invocation.js";

export {
  cancelTask,
  reopenTask,
  type TaskLifecycleIdentity,
  type TaskLifecycleReceipt,
} from "./task-lifecycle-domain-operation.js";
import {
  normalizeFailureFingerprint,
  selectRecoveryDecision,
  type HumanBlockerKind,
  type RecoveryDecision,
  type RecoveryPolicyInput,
  type TaskFailureKind,
} from "./recovery-policy.js";

type AgentClassification = Extract<RecoveryPolicyInput, { owner: "agent" }>["classification"];
type ReceiptStatus = DomainOperationResult["status"];

interface TaskScope {
  lifecycleId: string;
  milestoneId: string;
  sliceId: string;
  taskId: string;
}

interface FailedAttemptScope extends TaskScope {
  attemptId: string;
  resultId: string;
  kernelCheckpointId: string;
  boundaryStage: "execute" | "verify";
}

export type RouteFailureInput = {
  invocation: ExecutionInvocation;
  attemptId: string;
  resultId: string;
  summary: string;
  evidence: DomainJsonValue;
  rationale: string;
  targetLifecycleId?: string;
  supersedesResolvedBlockerId?: string;
} & (
  | { owner: "agent"; classification: AgentClassification }
  | {
      owner: "user" | "external";
      classification: { failureKind: TaskFailureKind };
      blocker: {
        blockerKind: HumanBlockerKind;
        description: string;
        requestedAction: string;
      };
    }
);

export interface TaskRecoveryReceipt {
  status: ReceiptStatus;
  operationId: string;
  resultingRevision: number;
  lifecycleId: string;
  attemptId: string;
  resultId: string;
  failureObservationId: string;
  recoveryActionId: string;
  action: RecoveryDecision["action"];
  recoveryBudgetId?: string;
  blockerId?: string;
  workCheckpointId?: string;
  resumeAuthorized?: boolean;
}

export interface TaskRecoveryResumeReceipt {
  status: ReceiptStatus;
  operationId: string;
  resultingRevision: number;
  lifecycleId: string;
  attemptId: string;
  resultId: string;
  recoveryActionId: string;
  workCheckpointId: string;
}

export interface PendingTaskRecoveryContext {
  action: Extract<RecoveryDecision["action"], "retry" | "repair" | "remediate" | "replan"> | "resume";
  recoveryActionId: string;
  attemptId: string;
  resultId: string;
  failureKind: string;
  summary: string;
  evidence: DomainJsonValue;
  rationale: string;
  replanCompleted: boolean;
  checkpoint: {
    checkpointId: string;
    confirmedContext: string;
    unresolvedSummary: string;
    evidenceSummary: string;
    suggestedNextAction: string;
  };
}

export interface BlockerResolutionReceipt {
  status: ReceiptStatus;
  operationId: string;
  resultingRevision: number;
  blockerId: string;
  blockerStatus: "resolved" | "dismissed";
  workCheckpointId: string;
}

export interface WaiverReceipt {
  status: ReceiptStatus;
  operationId: string;
  resultingRevision: number;
  waiverId: string;
  waiverStatus: "active" | "revoked" | "expired";
  dispositionId?: string;
}

export interface RequirementDispositionReceipt {
  status: ReceiptStatus;
  operationId: string;
  resultingRevision: number;
  dispositionId: string;
  disposition: "unsatisfied" | "satisfied" | "waived";
}

export interface WorkCheckpointReceipt {
  status: ReceiptStatus;
  operationId: string;
  resultingRevision: number;
  workCheckpointId: string;
  sequence: number;
}

export interface TaskRecoveryBlockerSnapshot {
  blockerId: string;
  blockerKind: HumanBlockerKind;
  blockerStatus: "open" | "resolved" | "dismissed";
  resolutionOwner: "user" | "external";
  resolution: string;
  recoveryAction: RecoveryDecision["action"];
  resolvedOperationId?: string;
  resolvedProjectRevision?: number;
}

export interface TaskRecoveryRouteSnapshot {
  recoveryActionId: string;
  action: RecoveryDecision["action"];
  recoveryOwner: "agent" | "user" | "external";
  failureKind: string;
  blocker: TaskRecoveryBlockerSnapshot | null;
  resumeAuthorized: boolean;
}

function taskRecoveryBlockerSnapshot(
  stored: Record<string, unknown>,
): TaskRecoveryBlockerSnapshot {
  return {
    blockerId: String(stored["blocker_id"]),
    blockerKind: String(stored["blocker_kind"]) as HumanBlockerKind,
    blockerStatus: String(stored["blocker_status"]) as TaskRecoveryBlockerSnapshot["blockerStatus"],
    resolutionOwner: String(stored["resolution_owner"]) as TaskRecoveryBlockerSnapshot["resolutionOwner"],
    resolution: String(stored["resolution"]),
    recoveryAction: String(stored["action"]) as RecoveryDecision["action"],
    ...(stored["resolved_operation_id"]
      ? { resolvedOperationId: String(stored["resolved_operation_id"]) }
      : {}),
    ...(stored["resolved_project_revision"]
      ? { resolvedProjectRevision: Number(stored["resolved_project_revision"]) }
      : {}),
  };
}

function operationRequest(
  operationType: string,
  invocation: ExecutionInvocation,
  payload: DomainJsonValue,
): DomainOperationRequest {
  const fence = readDomainOperationFence(invocation.idempotencyKey);
  return {
    operationType,
    idempotencyKey: invocation.idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: invocation.actorType,
    ...(invocation.actorId ? { actorId: invocation.actorId } : {}),
    sourceTransport: invocation.sourceTransport,
    ...(invocation.traceId ? { traceId: invocation.traceId } : {}),
    ...(invocation.turnId ? { turnId: invocation.turnId } : {}),
    payload,
  };
}

function mutation(
  eventType: string,
  entityId: string,
  payload: DomainJsonValue,
): DomainOperationMutation {
  return {
    events: [{
      eventType,
      entityType: "task",
      entityId,
      payload,
      destinations: ["projection"],
    }],
    projections: [{
      projectionKey: `${eventType}/${entityId}`.toLowerCase(),
      projectionKind: "task-recovery",
      rendererVersion: "1",
    }],
  };
}

function taskEntity(scope: Pick<FailedAttemptScope, "milestoneId" | "sliceId" | "taskId">): string {
  return `${scope.milestoneId}/${scope.sliceId}/${scope.taskId}`;
}

function checkpointScope(scope: Pick<FailedAttemptScope, "milestoneId" | "sliceId" | "taskId">): string {
  return `task:${taskEntity(scope)}`.toLowerCase();
}

function requireNonBlank(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must not be blank`);
  }
  return value.trim();
}

function requireRepairEvidence(evidence: DomainJsonValue): DomainJsonValue {
  if (
    evidence === null ||
    Array.isArray(evidence) ||
    typeof evidence !== "object" ||
    Object.keys(evidence).length === 0
  ) {
    throw new Error("evidence must be a non-empty object");
  }
  return evidence;
}

function suggestedAgentRecoveryAction(
  action: Extract<RecoveryDecision, { owner: "agent" }>["action"],
): string {
  switch (action) {
    case "retry":
      return "Retry the Task using the preserved failure evidence.";
    case "repair":
      return "Repair the deterministic execution fault before continuing the Task.";
    case "remediate":
      return "Remediate the failed verification evidence, then rerun verification.";
    case "replan":
      return "Replan the Task before implementation, then execute the replacement plan.";
    case "abort":
      return "Stop automatic Task execution and preserve this failure for diagnosis.";
  }
}

export function readPendingTaskRecoveryContext(
  task: Pick<TaskScope, "milestoneId" | "sliceId" | "taskId">,
): PendingTaskRecoveryContext | null {
  const stored = getDb().prepare(`
    SELECT lifecycle.lifecycle_id, action.action, action.recovery_action_id,
           attempt.attempt_id, observation.result_id,
           observation.failure_kind, observation.summary, observation.evidence_json,
           action.rationale,
           CASE WHEN EXISTS (
             SELECT 1 FROM workflow_domain_events replan
             WHERE replan.project_id = action.project_id
               AND replan.event_type = 'workflow.task.replanned'
               AND replan.entity_type = 'task'
               AND replan.entity_id = lifecycle.milestone_id || '/' || lifecycle.slice_id || '/' || lifecycle.task_id
               AND replan.project_revision > action.project_revision
           ) THEN 1 ELSE 0 END AS replan_completed,
           checkpoint.checkpoint_id, checkpoint.confirmed_context,
           checkpoint.unresolved_summary, checkpoint.evidence_summary,
           checkpoint.suggested_next_action
    FROM workflow_item_lifecycles lifecycle
    JOIN workflow_execution_attempts attempt
      ON attempt.lifecycle_id = lifecycle.lifecycle_id
     AND attempt.project_id = lifecycle.project_id
    JOIN workflow_kernel_checkpoints kernel
      ON kernel.lifecycle_id = lifecycle.lifecycle_id
     AND kernel.attempt_id = attempt.attempt_id
     AND kernel.project_id = lifecycle.project_id
     AND kernel.next_stage = 'route'
     AND NOT EXISTS (
       SELECT 1 FROM workflow_kernel_checkpoints successor
       WHERE successor.previous_kernel_checkpoint_id = kernel.kernel_checkpoint_id
     )
    JOIN workflow_failure_observations observation
      ON observation.attempt_id = attempt.attempt_id
     AND observation.lifecycle_id = lifecycle.lifecycle_id
     AND observation.project_id = lifecycle.project_id
    JOIN workflow_attempt_results result
      ON result.result_id = observation.result_id
     AND result.attempt_id = observation.attempt_id
     AND result.lifecycle_id = observation.lifecycle_id
     AND result.project_id = observation.project_id
    JOIN workflow_recovery_actions action
      ON action.failure_observation_id = observation.failure_observation_id
     AND action.lifecycle_id = lifecycle.lifecycle_id
     AND action.project_id = lifecycle.project_id
    JOIN workflow_work_checkpoints checkpoint
      ON checkpoint.operation_id = action.operation_id
     AND checkpoint.lifecycle_id = lifecycle.lifecycle_id
     AND checkpoint.project_id = lifecycle.project_id
    WHERE lifecycle.item_kind = 'task'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id = :slice_id
      AND lifecycle.task_id = :task_id
      AND action.action IN ('retry', 'repair', 'remediate', 'replan', 'abort')
      AND ${CURRENT_TASK_RECOVERY_CAUSAL_AUTHORITY_SQL}
      AND attempt.attempt_number = (
        SELECT MAX(latest.attempt_number)
        FROM workflow_execution_attempts latest
        WHERE latest.lifecycle_id = lifecycle.lifecycle_id
          AND latest.project_id = lifecycle.project_id
      )
  `).get({
    ":milestone_id": task.milestoneId,
    ":slice_id": task.sliceId,
    ":task_id": task.taskId,
  }) as Record<string, unknown> | undefined;
  if (!stored) return null;
  const attemptId = String(stored["attempt_id"]);
  const storedAction = String(stored["action"]);
  let checkpoint = stored;
  if (storedAction === "abort") {
    if (!isTaskRecoveryResumeAuthorized(attemptId)) return null;
    const lifecycleId = String(stored["lifecycle_id"]);
    const resumed = getDb().prepare(`
      SELECT checkpoint.checkpoint_id, checkpoint.confirmed_context,
             checkpoint.unresolved_summary, checkpoint.evidence_summary,
             checkpoint.suggested_next_action
      FROM workflow_domain_events event
      JOIN workflow_recovery_actions resumed_action
        ON resumed_action.project_id = event.project_id
       AND resumed_action.recovery_action_id = json_extract(event.payload_json, '$.recoveryActionId')
      JOIN workflow_work_checkpoints checkpoint
        ON checkpoint.project_id = event.project_id
       AND checkpoint.operation_id = event.operation_id
       AND checkpoint.checkpoint_id = json_extract(event.payload_json, '$.workCheckpointId')
       AND checkpoint.lifecycle_id = resumed_action.lifecycle_id
      WHERE event.event_type = 'task.recovery.resumed'
        AND event.entity_type = 'task'
        AND event.entity_id = :entity_id
        AND resumed_action.recovery_action_id = :recovery_action_id
        AND resumed_action.lifecycle_id = :lifecycle_id
        AND json_extract(event.payload_json, '$.lifecycleId') = :lifecycle_id
        AND json_extract(event.payload_json, '$.attemptId') = :attempt_id
        AND json_extract(event.payload_json, '$.resultId') = :result_id
      ORDER BY event.project_revision DESC
      LIMIT 1
    `).get({
      ":entity_id": taskEntity({
        milestoneId: task.milestoneId,
        sliceId: task.sliceId,
        taskId: task.taskId,
      }),
      ":lifecycle_id": lifecycleId,
      ":recovery_action_id": String(stored["recovery_action_id"]),
      ":attempt_id": attemptId,
      ":result_id": String(stored["result_id"]),
    }) as Record<string, unknown> | undefined;
    if (!resumed) throw new Error("Authorized Task recovery resume is missing its Work Checkpoint");
    checkpoint = resumed;
  }
  return {
    action: storedAction === "abort"
      ? "resume"
      : storedAction as PendingTaskRecoveryContext["action"],
    recoveryActionId: String(stored["recovery_action_id"]),
    attemptId,
    resultId: String(stored["result_id"]),
    failureKind: String(stored["failure_kind"]),
    summary: String(stored["summary"]),
    evidence: JSON.parse(String(stored["evidence_json"])) as DomainJsonValue,
    rationale: String(stored["rationale"]),
    replanCompleted: Number(stored["replan_completed"]) === 1,
    checkpoint: {
      checkpointId: String(checkpoint["checkpoint_id"]),
      confirmedContext: String(checkpoint["confirmed_context"]),
      unresolvedSummary: String(checkpoint["unresolved_summary"]),
      evidenceSummary: String(checkpoint["evidence_summary"]),
      suggestedNextAction: String(checkpoint["suggested_next_action"]),
    },
  };
}

function loadRoutedFailureScope(attemptId: string, resultId: string): FailedAttemptScope {
  const scope = getDb().prepare(`
    SELECT lifecycle.lifecycle_id, lifecycle.milestone_id, lifecycle.slice_id,
           lifecycle.task_id, attempt.attempt_id, result.result_id,
           checkpoint.kernel_checkpoint_id,
           CASE WHEN result.outcome = 'succeeded' THEN 'verify' ELSE 'execute' END AS boundary_stage
    FROM workflow_execution_attempts attempt
    JOIN workflow_attempt_results result
      ON result.attempt_id = attempt.attempt_id
     AND result.project_id = attempt.project_id
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.lifecycle_id = attempt.lifecycle_id
     AND lifecycle.project_id = attempt.project_id
    JOIN workflow_kernel_checkpoints checkpoint
      ON checkpoint.lifecycle_id = lifecycle.lifecycle_id
     AND checkpoint.attempt_id = attempt.attempt_id
     AND checkpoint.project_id = lifecycle.project_id
    WHERE attempt.attempt_id = :attempt_id
      AND result.result_id = :result_id
      AND attempt.attempt_state = 'settled'
      AND (
        result.outcome IN ('failed', 'interrupted') OR
        (result.outcome = 'succeeded' AND ${CURRENT_EVIDENCE_BACKED_FAILURE_VERDICT_SQL})
      )
      AND checkpoint.next_stage = 'route'
      AND NOT EXISTS (
        SELECT 1 FROM workflow_kernel_checkpoints successor
        WHERE successor.previous_kernel_checkpoint_id = checkpoint.kernel_checkpoint_id
      )
  `).get({ ":attempt_id": attemptId, ":result_id": resultId }) as Record<string, unknown> | undefined;
  if (!scope) throw new Error("Task recovery requires a current execute or verification failure route head");
  return {
    lifecycleId: String(scope["lifecycle_id"]),
    milestoneId: String(scope["milestone_id"]),
    sliceId: String(scope["slice_id"]),
    taskId: String(scope["task_id"]),
    attemptId: String(scope["attempt_id"]),
    resultId: String(scope["result_id"]),
    kernelCheckpointId: String(scope["kernel_checkpoint_id"]),
    boundaryStage: String(scope["boundary_stage"]) as "execute" | "verify",
  };
}

function requireRoutableResult(
  resultId: string,
  newOwner: RouteFailureInput["owner"],
  supersedesResolvedBlockerId?: string,
): void {
  const routed = getDb().prepare(`
    SELECT action.recovery_action_id, action.action, action.blocker_id,
           observation.recovery_owner, blocker.blocker_status
    FROM workflow_failure_observations observation
    LEFT JOIN workflow_recovery_actions action
      ON action.failure_observation_id = observation.failure_observation_id
    LEFT JOIN workflow_blockers blocker ON blocker.blocker_id = action.blocker_id
    WHERE observation.result_id = :result_id
    ORDER BY observation.project_revision DESC
    LIMIT 1
  `).get({ ":result_id": resultId }) as Record<string, unknown> | undefined;
  if (!routed) return;
  const supersedesResolvedBlocker = supersedesResolvedBlockerId &&
    newOwner === "agent" &&
    routed["blocker_id"] === supersedesResolvedBlockerId &&
    ["user", "external"].includes(String(routed["recovery_owner"])) &&
    ["clarify", "pause"].includes(String(routed["action"])) &&
    ["resolved", "dismissed"].includes(String(routed["blocker_status"]));
  if (!supersedesResolvedBlocker) {
    throw new Error("Task Result already has a recovery observation");
  }
}

function recoveryUseCounts(
  lifecycleId: string,
  failureKind: string,
  fingerprint: string,
  policyClass?: string,
): { budgetUses: number; replanUses: number } {
  const budgetUses = policyClass
    ? Number((getDb().prepare(`
        SELECT COUNT(*) AS count
        FROM workflow_recovery_actions action
        JOIN workflow_recovery_budgets budget
          ON budget.recovery_budget_id = action.recovery_budget_id
        WHERE budget.lifecycle_id = :lifecycle_id
          AND budget.failure_kind = :failure_kind
          AND budget.failure_fingerprint = :fingerprint
          AND budget.policy_class = :policy_class
      `).get({
        ":lifecycle_id": lifecycleId,
        ":failure_kind": failureKind,
        ":fingerprint": fingerprint,
        ":policy_class": policyClass,
      }) as Record<string, unknown> | undefined)?.["count"] ?? 0)
    : 0;
  const replanUses = Number((getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM workflow_recovery_actions action
    JOIN workflow_failure_observations observation
      ON observation.failure_observation_id = action.failure_observation_id
    WHERE observation.lifecycle_id = :lifecycle_id
      AND observation.failure_kind = :failure_kind
      AND observation.failure_fingerprint = :fingerprint
      AND action.action = 'replan'
  `).get({
    ":lifecycle_id": lifecycleId,
    ":failure_kind": failureKind,
    ":fingerprint": fingerprint,
  }) as Record<string, unknown> | undefined)?.["count"] ?? 0);
  return { budgetUses, replanUses };
}

function selectAgentDecision(
  input: Extract<RouteFailureInput, { owner: "agent" }>,
  scope: FailedAttemptScope,
  failureKind: string,
  fingerprint: string,
): RecoveryDecision {
  const preview = selectRecoveryDecision({
    owner: "agent",
    classification: input.classification,
    budgetUses: 0,
    replanUses: 0,
  });
  const counts = recoveryUseCounts(
    scope.lifecycleId,
    failureKind,
    fingerprint,
    preview.owner === "agent" ? preview.budget?.policyClass : undefined,
  );
  return selectRecoveryDecision({
    owner: "agent",
    classification: input.classification,
    ...counts,
  });
}

function loadTaskRecoveryReceipt(
  operation: DomainOperationResult,
): TaskRecoveryReceipt {
  const stored = getDb().prepare(`
    SELECT observation.lifecycle_id, observation.attempt_id, observation.result_id,
           observation.failure_observation_id, action.recovery_action_id,
           action.action, action.recovery_budget_id, action.blocker_id,
           checkpoint.checkpoint_id
    FROM workflow_recovery_actions action
    JOIN workflow_failure_observations observation
      ON observation.failure_observation_id = action.failure_observation_id
    LEFT JOIN workflow_work_checkpoints checkpoint
      ON checkpoint.operation_id = action.operation_id
     AND checkpoint.lifecycle_id = observation.lifecycle_id
    WHERE action.operation_id = :operation_id
  `).get({ ":operation_id": operation.operationId }) as Record<string, unknown> | undefined;
  if (!stored) throw new Error("Task recovery receipt is missing its Observation or Action");
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    lifecycleId: String(stored["lifecycle_id"]),
    attemptId: String(stored["attempt_id"]),
    resultId: String(stored["result_id"]),
    failureObservationId: String(stored["failure_observation_id"]),
    recoveryActionId: String(stored["recovery_action_id"]),
    action: String(stored["action"]) as RecoveryDecision["action"],
    ...(stored["recovery_budget_id"]
      ? { recoveryBudgetId: String(stored["recovery_budget_id"]) }
      : {}),
    ...(stored["blocker_id"] ? { blockerId: String(stored["blocker_id"]) } : {}),
    ...(stored["checkpoint_id"]
      ? { workCheckpointId: String(stored["checkpoint_id"]) }
      : {}),
    resumeAuthorized: isTaskRecoveryResumeAuthorized(String(stored["attempt_id"])),
  };
}

const RESUME_REFUSAL_PREFIX = "Task recovery resume requires the current agent-owned abort";

function describeSqlText(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "unknown";
}

/** One row of the resume-refusal diagnostic, or `undefined` when the id is unknown. */
export type ResumeRefusalRow = Record<string, unknown> | undefined;

/**
 * Choose which condition to blame for a refused resume.
 *
 * Split from the query so every branch is reachable from a unit test with a
 * plain object. Several of these conditions are not producible through the
 * domain writers today — `recordFailureObservation` is the only production
 * writer of `workflow_failure_observations` and always supplies an Attempt and
 * Result — so a DB-backed test could only reach them by hand-inserting states
 * the domain refuses to create. This keeps them honestly covered instead.
 *
 * Ordered from "this id is meaningless" outward to "this id was valid and is
 * spent", and stops at the first failure. Where more than one condition holds
 * the earlier one is the more actionable: "superseded" points at the current
 * Attempt, which is what a caller holding a stale id needs.
 */
export function describeResumeRefusal(row: ResumeRefusalRow, recoveryActionId: string): string {
  if (!row) return "no recovery action with that id exists";
  if (row["action_value"] !== "abort") {
    return `recovery action ${recoveryActionId} routed '${describeSqlText(row["action_value"])}', not 'abort'`;
  }
  if (row["blocker_id"] !== null && row["blocker_id"] !== undefined) {
    return "the abort is human-owned (it carries a blocker)";
  }
  if (row["observation_id"] === null || row["observation_id"] === undefined) {
    return "the abort has no failure observation to resume from";
  }
  if (row["owner_value"] !== "agent") {
    return `the abort is owned by '${describeSqlText(row["owner_value"])}', not the agent`;
  }
  if (row["lifecycle_value"] !== "in_progress") {
    return `the Task lifecycle is '${describeSqlText(row["lifecycle_value"])}', not 'in_progress'`;
  }
  // Checked before the Attempt state, so a missing Attempt is never reported as
  // a wrong Attempt state — and so the attempt-number comparison below can
  // never be a `null !== null` no-op.
  if (row["attempt_number"] === null || row["attempt_number"] === undefined) {
    return "the observation records no Attempt to resume";
  }
  if (row["attempt_state_value"] !== "settled") {
    return `the Attempt is '${describeSqlText(row["attempt_state_value"])}', not 'settled'`;
  }
  if (row["attempt_number"] !== row["max_attempt_number"]) {
    return `superseded: Attempt ${String(row["attempt_number"])} is not the current Attempt ${String(row["max_attempt_number"] ?? "unknown")}`;
  }
  if (row["result_id"] === null || row["result_id"] === undefined) {
    return "the observation records no Attempt Result to resume from";
  }
  if (row["causal_authority_ok"] !== 1) {
    return "the routed Result is no longer the current evidence-backed failure";
  }
  if (row["has_open_blocker"] === 1) {
    return "an open blocker on the Task must be resolved first";
  }
  if (row["already_resumed"] === 1) return "already resumed";
  // Reachable: the causal-authority fragment folds a two-branch evidence-verdict
  // test into one column, and any condition added to the gate later lands here
  // by default. Never leave the suffix undefined.
  return "the eligibility query refused it for a condition this diagnosis does not cover";
}

/**
 * Explain which of the eligibility gate's conditions refused a resume.
 *
 * The gate in `requireResumableAbortScope` ANDs nine conditions into one query
 * and is deliberately left as the single authority — splitting it into
 * sequential checks would duplicate its joins and let the diagnosis drift from
 * the decision. This runs only after that gate has already refused, purely to
 * name the reason.
 *
 * It must NOT reuse the gate's joins. The gate reaches its predicates through
 * four INNER JOINs, so a diagnostic built the same way returns no row whenever
 * any joined row is missing and would then report "no such id" for an id that
 * plainly exists. Anchor on the action, LEFT JOIN everything else, and read
 * NULL-propagating comparisons as failures.
 *
 * The lifecycle is reached through the OBSERVATION, not through the Attempt.
 * `workflow_failure_observations.attempt_id` is nullable outside the `execute`
 * boundary stage, and joining the lifecycle through a NULL Attempt would report
 * a missing Attempt as a wrong lifecycle status — the exact misdirection the
 * LEFT JOINs exist to avoid.
 */
function diagnoseResumeRefusal(recoveryActionId: string): string {
  const stored = getDb().prepare(`
    SELECT action.action AS action_value,
           action.blocker_id AS blocker_id,
           observation.failure_observation_id AS observation_id,
           observation.result_id AS result_id,
           observation.recovery_owner AS owner_value,
           lifecycle.lifecycle_status AS lifecycle_value,
           attempt.attempt_state AS attempt_state_value,
           attempt.attempt_number AS attempt_number,
           (
             SELECT MAX(latest.attempt_number)
             FROM workflow_execution_attempts latest
             WHERE latest.project_id = attempt.project_id
               AND latest.lifecycle_id = attempt.lifecycle_id
           ) AS max_attempt_number,
           CASE WHEN ${CURRENT_TASK_RECOVERY_CAUSAL_AUTHORITY_SQL} THEN 1 ELSE 0 END
             AS causal_authority_ok,
           CASE WHEN EXISTS (
             SELECT 1 FROM workflow_blockers blocker
             WHERE blocker.project_id = action.project_id
               AND blocker.lifecycle_id = action.lifecycle_id
               AND blocker.blocker_status = 'open'
           ) THEN 1 ELSE 0 END AS has_open_blocker,
           CASE WHEN EXISTS (
             SELECT 1 FROM workflow_domain_events resumed
             WHERE resumed.project_id = action.project_id
               AND resumed.event_type = 'task.recovery.resumed'
               AND json_extract(resumed.payload_json, '$.recoveryActionId')
                     = action.recovery_action_id
           ) THEN 1 ELSE 0 END AS already_resumed
    FROM workflow_recovery_actions action
    LEFT JOIN workflow_failure_observations observation
      ON observation.project_id = action.project_id
     AND observation.lifecycle_id = action.lifecycle_id
     AND observation.failure_observation_id = action.failure_observation_id
    LEFT JOIN workflow_execution_attempts attempt
      ON attempt.project_id = observation.project_id
     AND attempt.lifecycle_id = observation.lifecycle_id
     AND attempt.attempt_id = observation.attempt_id
    LEFT JOIN workflow_attempt_results result
      ON result.project_id = observation.project_id
     AND result.lifecycle_id = observation.lifecycle_id
     AND result.attempt_id = observation.attempt_id
     AND result.result_id = observation.result_id
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.project_id = action.project_id
     AND lifecycle.lifecycle_id = action.lifecycle_id
    WHERE action.recovery_action_id = :recovery_action_id
  `).get({ ":recovery_action_id": recoveryActionId }) as ResumeRefusalRow;

  return describeResumeRefusal(stored, recoveryActionId);
}

function requireResumableAbortScope(recoveryActionId: string): FailedAttemptScope {
  const stored = getDb().prepare(`
    SELECT observation.attempt_id, observation.result_id
    FROM workflow_recovery_actions action
    JOIN workflow_failure_observations observation
      ON observation.project_id = action.project_id
     AND observation.lifecycle_id = action.lifecycle_id
     AND observation.failure_observation_id = action.failure_observation_id
    JOIN workflow_execution_attempts attempt
      ON attempt.project_id = observation.project_id
     AND attempt.lifecycle_id = observation.lifecycle_id
     AND attempt.attempt_id = observation.attempt_id
    JOIN workflow_attempt_results result
      ON result.project_id = observation.project_id
     AND result.lifecycle_id = observation.lifecycle_id
     AND result.attempt_id = observation.attempt_id
     AND result.result_id = observation.result_id
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.project_id = attempt.project_id
     AND lifecycle.lifecycle_id = attempt.lifecycle_id
    WHERE action.recovery_action_id = :recovery_action_id
      AND action.action = 'abort'
      AND action.blocker_id IS NULL
      AND observation.recovery_owner = 'agent'
      AND lifecycle.lifecycle_status = 'in_progress'
      AND attempt.attempt_state = 'settled'
      AND ${CURRENT_TASK_RECOVERY_CAUSAL_AUTHORITY_SQL}
      AND attempt.attempt_number = (
        SELECT MAX(latest.attempt_number)
        FROM workflow_execution_attempts latest
        WHERE latest.project_id = attempt.project_id
          AND latest.lifecycle_id = attempt.lifecycle_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM workflow_blockers blocker
        WHERE blocker.project_id = action.project_id
          AND blocker.lifecycle_id = action.lifecycle_id
          AND blocker.blocker_status = 'open'
      )
      AND NOT EXISTS (
        SELECT 1 FROM workflow_domain_events resumed
        WHERE resumed.project_id = action.project_id
          AND resumed.event_type = 'task.recovery.resumed'
          AND json_extract(resumed.payload_json, '$.recoveryActionId') = action.recovery_action_id
      )
  `).get({ ":recovery_action_id": recoveryActionId }) as Record<string, unknown> | undefined;
  if (!stored) {
    let diagnosis: string;
    try {
      diagnosis = diagnoseResumeRefusal(recoveryActionId);
    } catch (error) {
      // Never mask a refusal with a second error — the caller asked why the
      // resume was refused, not why the explanation failed. But do NOT discard
      // the explanation's own failure: falling back silently reproduces exactly
      // the reason-less message this diagnosis exists to replace, and leaves an
      // operator with a dead end. Log it, then fall back.
      debugLog("taskRecovery", {
        phase: "resume-refusal-diagnosis-failed",
        recoveryActionId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(RESUME_REFUSAL_PREFIX);
    }
    throw new Error(`${RESUME_REFUSAL_PREFIX}: ${diagnosis}`);
  }
  return loadRoutedFailureScope(String(stored["attempt_id"]), String(stored["result_id"]));
}

function loadTaskRecoveryResumeReceipt(
  operation: DomainOperationResult,
): TaskRecoveryResumeReceipt {
  const stored = getDb().prepare(`
    SELECT event.payload_json, checkpoint.checkpoint_id
    FROM workflow_domain_events event
    JOIN workflow_work_checkpoints checkpoint
      ON checkpoint.project_id = event.project_id
     AND checkpoint.operation_id = event.operation_id
    WHERE event.operation_id = :operation_id
      AND event.event_type = 'task.recovery.resumed'
  `).get({ ":operation_id": operation.operationId }) as Record<string, unknown> | undefined;
  if (!stored) throw new Error("Task recovery resume receipt is missing its event or Work Checkpoint");
  const payload = JSON.parse(String(stored["payload_json"])) as Record<string, unknown>;
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    lifecycleId: String(payload["lifecycleId"]),
    attemptId: String(payload["attemptId"]),
    resultId: String(payload["resultId"]),
    recoveryActionId: String(payload["recoveryActionId"]),
    workCheckpointId: String(stored["checkpoint_id"]),
  };
}

export function resumeTaskRecovery(input: {
  invocation: ExecutionInvocation;
  recoveryActionId: string;
  repairSummary: string;
  evidence: DomainJsonValue;
}): TaskRecoveryResumeReceipt {
  const recoveryActionId = requireNonBlank(input.recoveryActionId, "recoveryActionId");
  const repairSummary = requireNonBlank(input.repairSummary, "repairSummary");
  const evidence = requireRepairEvidence(input.evidence);
  const operation = executeDomainOperation(operationRequest(
    "task.recovery.resume",
    input.invocation,
    { recoveryActionId, repairSummary, evidence },
  ), (context) => {
    const scope = requireResumableAbortScope(recoveryActionId);
    const checkpoint = appendRecoveryWorkCheckpoint(context, {
      lifecycleId: scope.lifecycleId,
      scopeKey: checkpointScope(scope),
      checkpointKind: "correction",
      confirmedContext: repairSummary,
      unresolvedSummary: "",
      evidenceSummary: canonicalDomainJson(evidence),
      suggestedNextAction: "Claim one new Task Attempt using the recorded repair evidence.",
    });
    return mutation("task.recovery.resumed", taskEntity(scope), {
      lifecycleId: scope.lifecycleId,
      attemptId: scope.attemptId,
      resultId: scope.resultId,
      recoveryActionId,
      repairSummary,
      evidence,
      workCheckpointId: checkpoint.checkpointId,
    });
  });
  return loadTaskRecoveryResumeReceipt(operation);
}

/**
 * Marker stamped on the repair evidence of a resume that was authorized by an
 * operator relaunching GSD, rather than by an operator attesting a repair.
 *
 * It exists so the two are distinguishable forever in
 * `workflow_domain_events`, and so the relaunch budget can count only its own.
 */
export const AUTO_RELAUNCH_RESUME_AUTHORIZATION = "auto-relaunch" as const;

/**
 * True when an auto-relaunch resume has already been spent on this recovery
 * action's lifecycle for the same failure kind.
 *
 * Keyed on (lifecycle, failure kind) rather than on the recoveryActionId,
 * because a recurring failure mints a NEW action id every time — bounding per
 * id would not bound anything, and the loop it fails to stop costs a full paid
 * task run per cycle.
 *
 * Operator-attested resumes carry no marker, so they neither consume this
 * budget nor are blocked by it.
 *
 * The marker alone is NOT trusted. `gsd_task_recovery_resume` takes `evidence`
 * as a free-form object, so any MCP caller — including the executing agent the
 * abort is constraining — could stamp `authorization: "auto-relaunch"` to forge
 * the audit trail or to burn the budget and keep the Task wedged. The operation
 * behind the event must therefore also be `internal`, which the domain layer
 * sets from the invocation and the MCP surface cannot claim: every MCP
 * invocation is built server-side with `sourceTransport: "workflow-mcp"`.
 */
export function hasSpentAutoRelaunchResume(recoveryActionId: string): boolean {
  const stored = getDb().prepare(`
    SELECT EXISTS (
      SELECT 1
      FROM workflow_domain_events event
      JOIN workflow_operations prior_operation
        ON prior_operation.project_id = event.project_id
       AND prior_operation.operation_id = event.operation_id
      JOIN workflow_recovery_actions prior_action
        ON prior_action.project_id = event.project_id
       AND prior_action.recovery_action_id =
             json_extract(event.payload_json, '$.recoveryActionId')
      JOIN workflow_failure_observations prior_observation
        ON prior_observation.project_id = prior_action.project_id
       AND prior_observation.lifecycle_id = prior_action.lifecycle_id
       AND prior_observation.failure_observation_id =
             prior_action.failure_observation_id
      WHERE event.event_type = 'task.recovery.resumed'
        AND prior_operation.source_transport = 'internal'
        AND json_extract(event.payload_json, '$.evidence.authorization')
              = :authorization
        AND prior_observation.lifecycle_id = observation.lifecycle_id
        AND prior_observation.failure_kind = observation.failure_kind
    ) AS spent
    FROM workflow_recovery_actions action
    JOIN workflow_failure_observations observation
      ON observation.project_id = action.project_id
     AND observation.lifecycle_id = action.lifecycle_id
     AND observation.failure_observation_id = action.failure_observation_id
    WHERE action.recovery_action_id = :recovery_action_id
  `).get({
    ":recovery_action_id": recoveryActionId,
    ":authorization": AUTO_RELAUNCH_RESUME_AUTHORIZATION,
  }) as Record<string, unknown> | undefined;
  // Callers only reach here with an id they just read from a live route, and
  // the action -> observation join is FK-backed, so a row always comes back.
  // The real fail-closed for an unreadable state is the caller's catch; this
  // default only keeps an impossible read from resuming.
  return stored ? Number(stored["spent"]) === 1 : true;
}

export function readTaskRecoveryRoute(attemptId: string): TaskRecoveryRouteSnapshot | null {
  const stored = getDb().prepare(`
    SELECT action.recovery_action_id, action.action,
           observation.recovery_owner, observation.failure_kind,
           blocker.blocker_id, blocker.blocker_kind, blocker.blocker_status,
           blocker.resolution_owner, blocker.resolution,
           blocker.resolved_operation_id, blocker.resolved_project_revision
    FROM workflow_failure_observations observation
    JOIN workflow_recovery_actions action
      ON action.failure_observation_id = observation.failure_observation_id
     AND action.project_id = observation.project_id
    LEFT JOIN workflow_blockers blocker
      ON blocker.blocker_id = action.blocker_id
     AND blocker.project_id = action.project_id
     AND blocker.lifecycle_id = action.lifecycle_id
    WHERE observation.attempt_id = :attempt_id
    ORDER BY action.project_revision DESC
    LIMIT 1
  `).get({ ":attempt_id": attemptId }) as Record<string, unknown> | undefined;
  if (!stored) return null;
  const blocker = stored["blocker_id"] ? taskRecoveryBlockerSnapshot(stored) : null;
  return {
    recoveryActionId: String(stored["recovery_action_id"]),
    action: String(stored["action"]) as RecoveryDecision["action"],
    recoveryOwner: String(stored["recovery_owner"]) as TaskRecoveryRouteSnapshot["recoveryOwner"],
    failureKind: String(stored["failure_kind"]),
    blocker,
    resumeAuthorized: stored["action"] === "abort" && isTaskRecoveryResumeAuthorized(attemptId),
  };
}

export function readTaskRecoveryBlocker(attemptId: string): TaskRecoveryBlockerSnapshot | null {
  return readTaskRecoveryRoute(attemptId)?.blocker ?? null;
}

export function readResolvedTaskHumanReviewBlocker(
  attemptId: string,
): TaskRecoveryBlockerSnapshot | null {
  const stored = getDb().prepare(`
    SELECT blocker.blocker_id, blocker.blocker_kind, blocker.blocker_status,
           blocker.resolution_owner, blocker.resolution,
           blocker.resolved_operation_id, blocker.resolved_project_revision,
           action.action
    FROM workflow_failure_observations observation
    JOIN workflow_recovery_actions action
      ON action.failure_observation_id = observation.failure_observation_id
     AND action.project_id = observation.project_id
    JOIN workflow_blockers blocker
      ON blocker.blocker_id = action.blocker_id
     AND blocker.project_id = action.project_id
     AND blocker.lifecycle_id = action.lifecycle_id
    WHERE observation.attempt_id = :attempt_id
      AND blocker.blocker_kind = 'subjective_uat'
      AND blocker.blocker_status = 'resolved'
    ORDER BY action.project_revision DESC
    LIMIT 1
  `).get({ ":attempt_id": attemptId }) as Record<string, unknown> | undefined;
  if (!stored) return null;
  return taskRecoveryBlockerSnapshot(stored);
}

export function recordFailureAndSelectRecovery(
  input: RouteFailureInput,
): TaskRecoveryReceipt {
  const operation = executeDomainOperation(operationRequest(
    "attempt.route",
    input.invocation,
    {
      attemptId: input.attemptId,
      resultId: input.resultId,
      owner: input.owner,
      classification: input.classification,
      summary: input.summary,
      evidence: input.evidence,
      rationale: input.rationale,
      targetLifecycleId: input.targetLifecycleId ?? null,
      supersedesResolvedBlockerId: input.supersedesResolvedBlockerId ?? null,
      ...(input.owner === "agent" ? {} : { blocker: input.blocker }),
    },
  ), (context) => {
    const scope = loadRoutedFailureScope(input.attemptId, input.resultId);
    requireRoutableResult(input.resultId, input.owner, input.supersedesResolvedBlockerId);
    const failureKind = input.classification.failureKind.trim().toLowerCase();
    const fingerprint = normalizeFailureFingerprint(input.classification);
    const decision = input.owner === "agent"
      ? selectAgentDecision(input, scope, failureKind, fingerprint)
      : selectRecoveryDecision({ owner: input.owner, blockerKind: input.blocker.blockerKind });

    let blockerId: string | undefined;
    if (input.owner !== "agent") {
      blockerId = openRecoveryBlocker(context, {
        lifecycleId: scope.lifecycleId,
        attemptId: scope.attemptId,
        kernelCheckpointId: scope.kernelCheckpointId,
        blockerKind: input.blocker.blockerKind,
        resolutionOwner: input.owner,
        description: input.blocker.description,
        requestedAction: input.blocker.requestedAction,
      }).blockerId;
    }
    const observation = recordFailureObservation(context, {
      lifecycleId: scope.lifecycleId,
      attemptId: scope.attemptId,
      resultId: scope.resultId,
      boundaryStage: scope.boundaryStage,
      kernelCheckpointId: scope.kernelCheckpointId,
      ...(blockerId ? { blockerId } : {}),
      recoveryOwner: decision.owner,
      failureKind,
      failureFingerprint: fingerprint,
      summary: input.summary,
      evidence: input.evidence,
    });
    const budget = decision.owner === "agent" && decision.budget
      ? createOrReadRecoveryBudget(context, {
          lifecycleId: scope.lifecycleId,
          failureKind,
          failureFingerprint: fingerprint,
          policyClass: decision.budget.policyClass,
          maxUses: decision.budget.maxUses,
          policyVersion: decision.policyVersion,
        })
      : undefined;
    const targetLifecycleId = decision.owner === "agent" &&
        ["retry", "repair", "replan", "remediate"].includes(decision.action)
      ? input.targetLifecycleId ?? scope.lifecycleId
      : undefined;
    const action = recordRecoveryAction(context, {
      lifecycleId: scope.lifecycleId,
      failureObservationId: observation.failureObservationId,
      action: decision.action,
      ...(budget ? { recoveryBudgetId: budget.recoveryBudgetId } : {}),
      ...(targetLifecycleId ? { targetLifecycleId } : {}),
      ...(blockerId ? { blockerId } : {}),
      rationale: input.rationale,
      policyVersion: decision.policyVersion,
    });
    let workCheckpointId: string;
    if (decision.owner === "agent") {
      workCheckpointId = appendRecoveryWorkCheckpoint(context, {
        lifecycleId: scope.lifecycleId,
        scopeKey: checkpointScope(scope),
        checkpointKind: "correction",
        confirmedContext: input.summary,
        unresolvedSummary: failureKind,
        evidenceSummary: canonicalDomainJson(input.evidence),
        suggestedNextAction: suggestedAgentRecoveryAction(decision.action),
      }).checkpointId;
    } else {
      const humanInput = input as Extract<RouteFailureInput, { owner: "user" | "external" }>;
      workCheckpointId = appendRecoveryWorkCheckpoint(context, {
        lifecycleId: scope.lifecycleId,
        scopeKey: checkpointScope(scope),
        checkpointKind: "pause",
        confirmedContext: input.summary,
        unresolvedSummary: humanInput.blocker.description,
        evidenceSummary: input.rationale,
        suggestedNextAction: humanInput.blocker.requestedAction,
      }).checkpointId;
    }
    return mutation("task.recovery.routed", taskEntity(scope), {
      attemptId: scope.attemptId,
      resultId: scope.resultId,
      failureObservationId: observation.failureObservationId,
      recoveryActionId: action.recoveryActionId,
      action: decision.action,
      workCheckpointId,
    });
  });
  return loadTaskRecoveryReceipt(operation);
}

function loadTaskIdentity(lifecycleId: string): TaskScope {
  const lifecycle = getDb().prepare(`
    SELECT lifecycle_id, milestone_id, slice_id, task_id
    FROM workflow_item_lifecycles
    WHERE lifecycle_id = :lifecycle_id AND item_kind = 'task'
  `).get({ ":lifecycle_id": lifecycleId }) as Record<string, unknown> | undefined;
  if (!lifecycle) throw new Error("Task lifecycle is missing");
  return {
    lifecycleId: String(lifecycle["lifecycle_id"]),
    milestoneId: String(lifecycle["milestone_id"]),
    sliceId: String(lifecycle["slice_id"]),
    taskId: String(lifecycle["task_id"]),
  };
}

export function resolveTaskBlocker(input: {
  invocation: ExecutionInvocation;
  blockerId: string;
  disposition: "resolved" | "dismissed";
  resolution: string;
  checkpoint: Omit<AppendRecoveryWorkCheckpointInput, "lifecycleId" | "scopeKey">;
}): BlockerResolutionReceipt {
  const operation = executeDomainOperation(operationRequest(
    "task.blocker.resolve",
    input.invocation,
    {
      blockerId: input.blockerId,
      disposition: input.disposition,
      resolution: input.resolution,
      checkpoint: input.checkpoint,
    },
  ), (context) => {
    const blocker = getDb().prepare(`
      SELECT lifecycle_id, resolution_owner FROM workflow_blockers
      WHERE blocker_id = :blocker_id AND blocker_status = 'open'
    `).get({ ":blocker_id": input.blockerId }) as Record<string, unknown> | undefined;
    if (!blocker) throw new Error("Recovery Blocker must be the current open Blocker");
    if (input.invocation.actorType !== blocker["resolution_owner"]) {
      throw new Error("Recovery Blocker may only be closed by its resolution owner");
    }
    const scope = loadTaskIdentity(String(blocker["lifecycle_id"]));
    resolveRecoveryBlocker(context, {
      blockerId: input.blockerId,
      disposition: input.disposition,
      resolution: input.resolution,
    });
    appendRecoveryWorkCheckpoint(context, {
      ...input.checkpoint,
      lifecycleId: scope.lifecycleId,
      scopeKey: checkpointScope(scope),
    });
    return mutation("task.blocker.resolved", taskEntity(scope), {
      blockerId: input.blockerId,
      disposition: input.disposition,
    });
  });
  const stored = getDb().prepare(`
    SELECT blocker.blocker_id, blocker.blocker_status, checkpoint.checkpoint_id
    FROM workflow_blockers blocker
    JOIN workflow_work_checkpoints checkpoint
      ON checkpoint.operation_id = blocker.resolved_operation_id
     AND checkpoint.lifecycle_id = blocker.lifecycle_id
    WHERE blocker.resolved_operation_id = :operation_id
  `).get({ ":operation_id": operation.operationId }) as Record<string, unknown> | undefined;
  if (!stored) throw new Error("Blocker resolution receipt is incomplete");
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    blockerId: String(stored["blocker_id"]),
    blockerStatus: String(stored["blocker_status"]) as "resolved" | "dismissed",
    workCheckpointId: String(stored["checkpoint_id"]),
  };
}

export function grantTaskWaiver(
  input: { invocation: ExecutionInvocation } & GrantRecoveryWaiverInput,
): WaiverReceipt {
  const { invocation, ...waiver } = input;
  if (waiver.grantedByActorType === "user" &&
      (invocation.actorType !== "user" || invocation.actorId !== waiver.grantedByActorId)) {
    throw new Error("A user-granted Waiver requires the matching user invocation identity");
  }
  if (waiver.grantedByActorType === "policy" &&
      invocation.actorType !== "agent" && invocation.actorType !== "policy") {
    throw new Error("A policy-granted Waiver requires an agent or policy invocation");
  }
  const operation = executeDomainOperation(operationRequest(
    "task.waiver.grant",
    invocation,
    waiver as unknown as DomainJsonValue,
  ), (context) => {
    const stored = grantRecoveryWaiver(context, waiver);
    const scope = loadTaskIdentity(waiver.lifecycleId);
    return mutation("task.waiver.granted", taskEntity(scope), { waiverId: stored.waiverId });
  });
  const stored = getDb().prepare(`
    SELECT waiver_id, waiver_status FROM workflow_waivers
    WHERE operation_id = :operation_id
  `).get({ ":operation_id": operation.operationId }) as Record<string, unknown> | undefined;
  if (!stored) throw new Error("Waiver grant receipt is missing");
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    waiverId: String(stored["waiver_id"]),
    waiverStatus: "active",
  };
}

export function recordTaskRequirementDisposition(
  input: { invocation: ExecutionInvocation } & RecordRequirementDispositionInput,
): RequirementDispositionReceipt {
  const { invocation, ...disposition } = input;
  const operation = executeDomainOperation(operationRequest(
    "task.disposition.record",
    invocation,
    disposition as unknown as DomainJsonValue,
  ), (context) => {
    const stored = recordRequirementDisposition(context, disposition);
    return mutation("task.requirement.disposition.recorded", disposition.requirementId, {
      dispositionId: stored.dispositionId,
      disposition: stored.disposition,
    });
  });
  const stored = getDb().prepare(`
    SELECT disposition_id, disposition
    FROM workflow_requirement_dispositions
    WHERE operation_id = :operation_id
  `).get({ ":operation_id": operation.operationId }) as Record<string, unknown> | undefined;
  if (!stored) throw new Error("Requirement Disposition receipt is missing");
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    dispositionId: String(stored["disposition_id"]),
    disposition: String(stored["disposition"]) as RequirementDispositionReceipt["disposition"],
  };
}

export function terminateTaskWaiver(input: {
  invocation: ExecutionInvocation;
  waiverId: string;
  requirementId: string;
  disposition: "revoked" | "expired";
  successorDisposition: "unsatisfied" | "satisfied";
  supersedesDispositionId: string;
  rationale: string;
}): WaiverReceipt {
  const operation = executeDomainOperation(operationRequest(
    "task.waiver.terminate",
    input.invocation,
    {
      waiverId: input.waiverId,
      requirementId: input.requirementId,
      disposition: input.disposition,
      successorDisposition: input.successorDisposition,
      supersedesDispositionId: input.supersedesDispositionId,
      rationale: input.rationale,
    },
  ), (context) => {
    const currentWaivedHead = getDb().prepare(`
      SELECT disposition.disposition_id
      FROM workflow_waivers waiver
      JOIN workflow_requirement_dispositions disposition
        ON disposition.waiver_id = waiver.waiver_id
       AND disposition.requirement_id = waiver.requirement_id
      WHERE waiver.waiver_id = :waiver_id
        AND waiver.requirement_id = :requirement_id
        AND waiver.waiver_status = 'active'
        AND disposition.disposition_id = :disposition_id
        AND disposition.disposition = 'waived'
        AND NOT EXISTS (
          SELECT 1 FROM workflow_requirement_dispositions successor
          WHERE successor.supersedes_disposition_id = disposition.disposition_id
        )
    `).get({
      ":waiver_id": input.waiverId,
      ":requirement_id": input.requirementId,
      ":disposition_id": input.supersedesDispositionId,
    });
    if (!currentWaivedHead) {
      throw new Error("Waiver termination requires its matching current waived disposition head");
    }
    const successor = recordRequirementDisposition(context, {
      requirementId: input.requirementId,
      disposition: input.successorDisposition,
      supersedesDispositionId: input.supersedesDispositionId,
      rationale: input.rationale,
    });
    terminateRecoveryWaiver(context, {
      waiverId: input.waiverId,
      disposition: input.disposition,
    });
    return mutation("task.waiver.terminated", input.requirementId, {
      waiverId: input.waiverId,
      dispositionId: successor.dispositionId,
      status: input.disposition,
    });
  });
  const stored = getDb().prepare(`
    SELECT waiver.waiver_id, waiver.waiver_status, disposition.disposition_id
    FROM workflow_waivers waiver
    JOIN workflow_requirement_dispositions disposition
      ON disposition.operation_id = waiver.ended_operation_id
     AND disposition.requirement_id = waiver.requirement_id
    WHERE waiver.ended_operation_id = :operation_id
  `).get({ ":operation_id": operation.operationId }) as Record<string, unknown> | undefined;
  if (!stored) throw new Error("Waiver termination receipt is incomplete");
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    waiverId: String(stored["waiver_id"]),
    waiverStatus: String(stored["waiver_status"]) as "revoked" | "expired",
    dispositionId: String(stored["disposition_id"]),
  };
}

export function appendTaskWorkCheckpoint(input: {
  invocation: ExecutionInvocation;
  lifecycleId: string;
} & Omit<AppendRecoveryWorkCheckpointInput, "lifecycleId" | "scopeKey">): WorkCheckpointReceipt {
  const { invocation, lifecycleId, ...checkpoint } = input;
  const operation = executeDomainOperation(operationRequest(
    "task.checkpoint.append",
    invocation,
    { lifecycleId, ...checkpoint } as unknown as DomainJsonValue,
  ), (context) => {
    const scope = loadTaskIdentity(lifecycleId);
    const stored = appendRecoveryWorkCheckpoint(context, {
      ...checkpoint,
      lifecycleId,
      scopeKey: checkpointScope(scope),
    });
    return mutation("task.checkpoint.appended", taskEntity(scope), {
      checkpointId: stored.checkpointId,
      sequence: stored.sequence,
    });
  });
  const stored = getDb().prepare(`
    SELECT checkpoint_id, sequence FROM workflow_work_checkpoints
    WHERE operation_id = :operation_id
  `).get({ ":operation_id": operation.operationId }) as Record<string, unknown> | undefined;
  if (!stored) throw new Error("Work Checkpoint receipt is missing");
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    workCheckpointId: String(stored["checkpoint_id"]),
    sequence: Number(stored["sequence"]),
  };
}
