// Project/App: gsd-pi
// File Purpose: In-band recovery from a standing agent-owned Task recovery abort.

/**
 * A Task parked on an agent-owned `abort` with `resumeAuthorized: false` wedges
 * auto-mode permanently: `runWithTaskExecutionAttempt` breaks every dispatch
 * before any work starts, and the guided flow never surfaces the abort, so
 * neither `/gsd auto` nor `/gsd next` can make progress.
 *
 * There is exactly one in-band lever on that state. The Result cannot be
 * re-routed to a human-owned blocker — `requireRoutableResult` allows a second
 * recovery observation only when an AGENT route supersedes an already-resolved
 * HUMAN blocker, so escalation runs human -> agent, never agent -> human. And a
 * fresh running Attempt cannot be opened out of band, because
 * `trg_workflow_attempt_fencing` requires a held milestone lease. What remains
 * is `task.recovery.resumed`, which flips `resumeAuthorized` so the next
 * dispatch claims a new Attempt instead of breaking.
 *
 * The operator's relaunch is the authorization. That is deliberately weaker
 * than an attested repair, so two things keep it honest: the durable
 * `repairSummary` claims no repair, and the resume is capped at one per
 * (lifecycle, failure kind) — see `hasSpentAutoRelaunchResume`. Without that cap
 * a recurring failure would resume, re-dispatch, fail identically, mint a new
 * abort id, and resume again, burning a full paid task run every cycle.
 */

import { debugLog } from "../debug-logger.js";
import { internalExecutionInvocation } from "../execution-invocation.js";
import { isDbAvailable } from "../gsd-db.js";
import { parseUnitId } from "../unit-id.js";
import { readLatestTaskAttempt } from "../task-execution-domain-operation.js";
import {
  AUTO_RELAUNCH_RESUME_AUTHORIZATION,
  hasSpentAutoRelaunchResume,
  readTaskRecoveryRoute,
  resumeTaskRecovery,
} from "../task-recovery-domain-operation.js";

export type StandingAbortResolution =
  | { status: "resumed"; recoveryActionId: string }
  | { status: "exhausted"; recoveryActionId: string }
  | { status: "refused"; recoveryActionId: string; reason: string }
  | { status: "not-applicable" };

const NOT_APPLICABLE: StandingAbortResolution = { status: "not-applicable" };

/** The record must never read as a repair the operator did not make. */
const RELAUNCH_REPAIR_SUMMARY =
  "Auto-relaunch authorization: the operator re-ran GSD against this standing " +
  "abort. No repair evidence was supplied; the re-dispatch itself is the check.";

export function resumeStandingTaskRecoveryAbort(
  unitType: string,
  unitId: string,
): StandingAbortResolution {
  if (unitType !== "execute-task" || !isDbAvailable()) return NOT_APPLICABLE;

  const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
  if (!mid || !sid || !tid) return NOT_APPLICABLE;

  let recoveryActionId: string;
  try {
    const attempt = readLatestTaskAttempt({
      milestoneId: mid,
      sliceId: sid,
      taskId: tid,
    });
    if (!attempt) return NOT_APPLICABLE;

    const route = readTaskRecoveryRoute(attempt.attemptId);
    // Only an agent-owned abort that has not already been resumed is wedged.
    // A human-owned route is already handled by the cutover, and a resumed one
    // is not blocking anything.
    if (
      !route ||
      route.recoveryOwner !== "agent" ||
      route.action !== "abort" ||
      route.resumeAuthorized
    ) {
      return NOT_APPLICABLE;
    }
    recoveryActionId = route.recoveryActionId;

    if (hasSpentAutoRelaunchResume(recoveryActionId)) {
      return { status: "exhausted", recoveryActionId };
    }
  } catch (error) {
    // A read failure must not turn into a resume — fail closed and let the
    // caller pause exactly as it does today. Log it: degrading silently to
    // "nothing to resume here" is indistinguishable from a healthy no-op and
    // costs the one diagnostic that explains why a relaunch stopped working.
    debugLog("taskRecoveryRelaunch", {
      phase: "standing-abort-read-failed",
      unitId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NOT_APPLICABLE;
  }

  try {
    resumeTaskRecovery({
      invocation: internalExecutionInvocation(
        `internal:auto:task.recovery.auto-relaunch:${recoveryActionId}`,
      ),
      recoveryActionId,
      repairSummary: RELAUNCH_REPAIR_SUMMARY,
      evidence: {
        authorization: AUTO_RELAUNCH_RESUME_AUTHORIZATION,
        recoveryActionId,
        unitType,
        unitId,
      },
    });
  } catch (error) {
    // `requireResumableAbortScope` enforces gates this function does not
    // pre-check — an open blocker, a non-`in_progress` lifecycle, a superseded
    // Attempt. Its refusal now names which one. Swallowing that into a generic
    // pause would bury the diagnosis the companion patch exists to produce.
    return {
      status: "refused",
      recoveryActionId,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return { status: "resumed", recoveryActionId };
}
