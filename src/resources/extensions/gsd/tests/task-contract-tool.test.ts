// Project/App: gsd-pi
// File Purpose: gsd_task_contract reads back the contract gsd_replan_task demands,
// and is registered on every surface that can reach a workflow tool.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { normalizeRealPath } from "../paths.ts";
import { resolveProjectRootDbPath } from "../db-workspace.ts";

import { WORKFLOW_TOOL_CONTRACTS } from "../../../../../packages/contracts/src/workflow.ts";
import { registerWorkflowTools } from "../../../../../packages/mcp-server/src/workflow-tools.ts";
import { MINIMAL_GSD_TOOL_NAMES } from "../bootstrap/register-hooks.ts";
import { shouldBlockAutoUnitToolCall } from "../auto-unit-tool-scope.ts";
import { UNIT_REGISTRY } from "../unit-registry.ts";
import { registerQueryTools } from "../bootstrap/query-tools.ts";
import { describeReplanBlockers, executeTaskContract } from "../tools/workflow-tool-executors.ts";
import {
  _getAdapter,
  closeDatabase,
  openDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  getTask,
} from "../gsd-db.ts";

const TOOL = "gsd_task_contract";

// --- Registration parity ---------------------------------------------------
//
// Five surfaces must agree. The plan's own risk note: the likely failure of an
// additive read tool is not a wrong value, it is a tool that exists on one
// surface and is missing on another. These assertions matter more than the read
// tests below.

test(`${TOOL} is declared read-only in the workflow contracts registry`, () => {
  const contract = WORKFLOW_TOOL_CONTRACTS.find((tool) => tool.canonicalName === TOOL);
  assert.ok(contract, `${TOOL} missing from WORKFLOW_TOOL_CONTRACTS`);
  assert.equal(contract.writePolicy, "read");
  assert.equal(contract.executorId, "executeTaskContract");
  assert.match(contract.schemaId, /^workflow\./);
  assert.match(contract.auditEvent, /^workflow\./);
});

test(`${TOOL} is scoped to the units that replan, not advertised to all of them`, () => {
  // Deliberately NOT in MINIMAL_GSD_TOOL_NAMES. `buildMinimalAutoGsdToolSet`
  // unions that list into EVERY auto unit's surface, while listing the tool in
  // any unit contract also makes it a scoped lifecycle tool -- so a MINIMAL
  // entry would show it to units like execute-task and plan-slice and then
  // HARD BLOCK them for calling it, which is a maximal-severity rejection for a
  // zero-side-effect read. Reachability is not lost: WORKFLOW_GSD_TOOL_NAMES
  // unions AUTO_UNIT_SCOPED_TOOLS, so GSD-driven requests still see it, the
  // claude-code-cli host resolves it from `allowedGsdTools`, and external MCP
  // clients are not scoped by any of this.
  assert.ok(
    !(MINIMAL_GSD_TOOL_NAMES as readonly string[]).includes(TOOL),
    `${TOOL} in MINIMAL would advertise it to every auto unit and hard-block most of them`,
  );
  assert.ok(
    !shouldBlockAutoUnitToolCall("replan-task", TOOL).block,
    "the unit whose whole purpose is replanning must be able to call the read",
  );
  assert.ok(
    !shouldBlockAutoUnitToolCall("complete-slice", TOOL).block,
    "complete-slice may call gsd_replan_task, so it must be able to read first",
  );
});

test(`${TOOL} is registered as an in-process Pi tool`, () => {
  const names: string[] = [];
  const pi = {
    registerTool(tool: { name: string }) {
      names.push(tool.name);
    },
  };
  registerQueryTools(pi as never);
  assert.ok(names.includes(TOOL), `registerQueryTools did not register ${TOOL}`);
});

test(`${TOOL} is registered on the workflow MCP server`, () => {
  const tools: Array<{ name: string; params: Record<string, unknown> }> = [];
  const server = {
    tool(name: string, _description: string, params: Record<string, unknown>) {
      tools.push({ name, params });
    },
  };
  registerWorkflowTools(server as never);
  const registered = tools.find((tool) => tool.name === TOOL);
  assert.ok(registered, `registerWorkflowTools did not register ${TOOL}`);
  // The three identity parameters are what make the read addressable at all.
  for (const key of ["milestoneId", "sliceId", "taskId"]) {
    assert.ok(key in registered.params, `${TOOL} MCP schema is missing ${key}`);
  }
});

test(`${TOOL} is allowed to every unit that rewrites a task contract`, () => {
  // The minimal/auto surfaces union MINIMAL_GSD_TOOL_NAMES in, but the
  // claude-code-cli host builds its allowed set from the UNIT CONTRACT alone
  // (`resolveExactWorkflowMcpToolsForPhase` reads `allowedGsdTools`). Without
  // this, the automated replan path -- the one that produced the observed
  // expectedOutput corruption -- still could not read the contract, while the
  // interactive path could. That is the exact "one surface, not another"
  // failure the other registration tests exist to catch.
  const allowedFor = (descriptor: unknown): string[] => {
    const contract = (descriptor as { toolContract?: { allowedGsdTools?: readonly string[] } })
      .toolContract;
    return [...(contract?.allowedGsdTools ?? [])];
  };
  // Both replan tools rewrite a stored per-task contract wholesale:
  // `gsd_replan_slice.updatedTasks` carries the same full field set and
  // overwrites it. And because listing the read on ANY unit makes it a scoped
  // lifecycle tool, a unit that rewrites contracts without it is not merely
  // missing a convenience -- it is hard-blocked from the read it needs most.
  const WRITERS = ["gsd_replan_task", "gsd_replan_slice"];
  const rewritingUnits = Object.entries(UNIT_REGISTRY).filter(
    ([, descriptor]) => WRITERS.some((tool) => allowedFor(descriptor).includes(tool)),
  );
  assert.ok(rewritingUnits.length > 0, "expected at least one unit allowed to rewrite a task contract");
  for (const [unitType, descriptor] of rewritingUnits) {
    assert.ok(
      allowedFor(descriptor).includes(TOOL),
      `unit ${unitType} rewrites task contracts but cannot reach ${TOOL}`,
    );
    assert.ok(
      !shouldBlockAutoUnitToolCall(unitType, TOOL).block,
      `unit ${unitType} rewrites task contracts but is hard-blocked from ${TOOL}`,
    );
  }
});

// --- Replan blockers (pure, so every branch is reachable) -------------------

test("describeReplanBlockers reports nothing for an open task in an open slice", () => {
  assert.equal(
    describeReplanBlockers({
      legacyStatus: "pending",
      canonicalStatus: "ready",
      sliceStatus: "in_progress",
      canonicalSliceStatus: null,
      sliceMissing: false,
    }),
    null,
  );
});

test("describeReplanBlockers catches a canonical lifecycle row the legacy column hides", () => {
  // The case that motivated reading both: `handleReplanTask` rejects on the
  // canonical row INDEPENDENTLY, so a legacy-only check reports "pending" and
  // the write bounces anyway.
  const blockers = describeReplanBlockers({
    legacyStatus: "pending",
    canonicalStatus: "completed",
    sliceStatus: "in_progress",
    canonicalSliceStatus: null,
    sliceMissing: false,
  });

  assert.ok(blockers);
  assert.match(blockers, /canonical lifecycle status is "completed"/);
  assert.match(blockers, /divergence is drift/);
});

test("describeReplanBlockers does not double-report when both statuses are closed", () => {
  const blockers = describeReplanBlockers({
    legacyStatus: "complete",
    canonicalStatus: "completed",
    sliceStatus: "in_progress",
    canonicalSliceStatus: null,
    sliceMissing: false,
  });

  assert.ok(blockers);
  assert.match(blockers, /gsd_task_reopen/);
  assert.doesNotMatch(blockers, /divergence is drift/);
});

test("describeReplanBlockers catches a deferred task with no lifecycle row yet", () => {
  // `deferred` is NOT in RAW_CLOSED_STATUSES, so isClosedStatus is false and a
  // status-list check reports an all-clear. But handleReplanTask adopts
  // `normalizeLegacyLifecycleStatus(status) ?? "ready"` when no canonical row
  // exists, and LEGACY_STATUS_MAP maps deferred -> cancelled, so the replan
  // refuses. Mirroring the adoption is what makes every such alias work.
  const blockers = describeReplanBlockers({
    legacyStatus: "deferred",
    canonicalStatus: null,
    sliceStatus: "in_progress",
    canonicalSliceStatus: null,
    sliceMissing: false,
  });

  assert.ok(blockers, "a deferred task must not be reported as writable");
  assert.match(blockers, /gsd_task_reopen|cancelled/);
});

test("describeReplanBlockers catches a deferred parent slice", () => {
  const blockers = describeReplanBlockers({
    legacyStatus: "pending",
    canonicalStatus: null,
    sliceStatus: "deferred",
    canonicalSliceStatus: null,
    sliceMissing: false,
  });

  assert.ok(blockers, "a deferred parent slice must not be reported as writable");
  assert.match(blockers, /gsd_slice_reopen/);
});

test("describeReplanBlockers catches slice-level canonical drift the legacy column hides", () => {
  // handleReplanTask applies the canonical completed/cancelled guard to the
  // PARENT SLICE too, independently of slices.status. Reading both for the task
  // but only the legacy column for the slice was the asymmetry.
  const blockers = describeReplanBlockers({
    legacyStatus: "pending",
    canonicalStatus: "ready",
    sliceStatus: "in_progress",
    canonicalSliceStatus: "completed",
    sliceMissing: false,
  });

  assert.ok(blockers, "slice-level shadow drift must not be reported as writable");
  assert.match(blockers, /gsd_slice_reopen/);
  assert.match(blockers, /canonical lifecycle "completed"/);
});

test("describeReplanBlockers reports a closed slice and a missing slice distinctly", () => {
  const closed = describeReplanBlockers({
    legacyStatus: "pending",
    canonicalStatus: "ready",
    sliceStatus: "complete",
    canonicalSliceStatus: null,
    sliceMissing: false,
  });
  assert.ok(closed);
  assert.match(closed, /gsd_slice_reopen/);

  const missing = describeReplanBlockers({
    legacyStatus: "pending",
    canonicalStatus: "ready",
    sliceStatus: null,
    canonicalSliceStatus: null,
    sliceMissing: true,
  });
  assert.ok(missing);
  assert.match(missing, /missing parent slice/);
  assert.doesNotMatch(missing, /gsd_slice_reopen/);
});

// --- The read itself -------------------------------------------------------

function withProject(run: (basePath: string) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const basePath = join(tmpdir(), `gsd-task-contract-${randomUUID()}`);
    mkdirSync(join(basePath, ".gsd"), { recursive: true });
    try {
      // Seed through the SAME resolution the executor's ensureDbOpen uses.
      // Hand-building `<base>/.gsd/gsd.db` seeds a different handle than
      // `resolveGsdPathContract` resolves, and then every read comes back
      // not-found -- which a not-found test would pass on for the wrong reason.
      assert.equal(openDatabase(resolveProjectRootDbPath(normalizeRealPath(basePath))), true);
      await run(basePath);
    } finally {
      closeDatabase();
      rmSync(basePath, { recursive: true, force: true });
    }
  };
}

function seedTask(): void {
  insertMilestone({ id: "M001", title: "Milestone", status: "in_progress" });
  insertSlice({ milestoneId: "M001", id: "S01", title: "Slice", status: "in_progress" });
  insertTask({
    milestoneId: "M001",
    sliceId: "S01",
    id: "T01",
    title: "Distinctive title",
    status: "pending",
    planning: {
      description: "Distinctive description",
      estimate: "2h",
      // Deliberately NOT alphabetical: a reordered array is a silent diff a
      // caller would write straight back.
      files: ["zeta.ts", "alpha.ts"],
      verify: "npm run distinctive-check",
      inputs: ["input-b.ts", "input-a.ts"],
      expectedOutput: ["out-b.ts", "out-a.ts"],
      observabilityImpact: "",
    },
  });
}

test("reads back every stored field, preserving array order", withProject(async (basePath) => {
  seedTask();
  const result = await executeTaskContract({ milestoneId: "M001", sliceId: "S01", taskId: "T01" }, basePath);
  const details = result.details as Record<string, unknown>;

  assert.equal(details["operation"], "task_contract");
  assert.equal(details["title"], "Distinctive title");
  assert.equal(details["description"], "Distinctive description");
  assert.equal(details["estimate"], "2h");
  assert.equal(details["verify"], "npm run distinctive-check");
  assert.deepEqual(details["files"], ["zeta.ts", "alpha.ts"]);
  assert.deepEqual(details["inputs"], ["input-b.ts", "input-a.ts"]);
  assert.deepEqual(details["expectedOutput"], ["out-b.ts", "out-a.ts"]);
}));

test("warns that an MCP replan re-resolves targetRepositories", withProject(async (basePath) => {
  seedTask();
  const result = await executeTaskContract({ milestoneId: "M001", sliceId: "S01", taskId: "T01" }, basePath);
  const details = result.details as Record<string, unknown>;

  // Silently omitting this recreates the same guessing one layer down.
  assert.ok("targetRepositories" in details);
  const caveats = details["caveats"] as Record<string, string>;

  // The caveat must not claim the value is recomputed and ignorable, and must
  // not claim it is resendable in-process either: NO replan tool schema accepts
  // targetRepositories (`db-tools.ts` exposes it on gsd_plan_task /
  // gsd_plan_slice only), so every replan re-resolves through the PARENT
  // SLICE's targets and silently widens a deliberately narrowed task. That is
  // the failure class this tool exists to prevent, so the caveat has to send
  // the caller to record and re-check.
  assert.match(caveats["targetRepositories"], /NOT resendable/);
  assert.match(caveats["targetRepositories"], /slice/i);
  assert.match(caveats["targetRepositories"], /afterwards|check/i);
  assert.doesNotMatch(caveats["targetRepositories"], /no effect/i);
  assert.doesNotMatch(caveats["targetRepositories"], /WINS/);
  // The caveat must NOT send the caller to gsd_plan_task as a remedy: that tool
  // does accept targetRepositories, but it is not a safe destination for THIS
  // contract -- it blanks observabilityImpact (which this response does not
  // return, so a round trip through it loses the stored value) and applies
  // path-only validation gsd_replan_task does not. Naming an unsafe remedy is
  // worse than naming none, so the caveat says to report rather than repair.
  assert.match(caveats["targetRepositories"], /no supported way to restore/i);
  assert.match(caveats["targetRepositories"], /observabilityImpact/);
  assert.match(caveats["targetRepositories"], /[Rr]eport the widening/);
}));

test("reports fullPlanMd presence without shipping the document", withProject(async (basePath) => {
  seedTask();
  const result = await executeTaskContract({ milestoneId: "M001", sliceId: "S01", taskId: "T01" }, basePath);
  const details = result.details as Record<string, unknown>;

  // The column is unbounded and not round-trippable, and `details` is
  // serialized twice on the MCP path (content text + structuredContent), so
  // only the signal is carried.
  assert.ok(!("fullPlanMd" in details), "the unbounded document must not be returned");
  assert.equal(details["fullPlanMdPresent"], false);
  assert.equal(details["fullPlanMdLength"], 0);
  const caveats = details["caveats"] as Record<string, string>;
  assert.match(caveats["fullPlanMd"], /Not a gsd_replan_task parameter/);
}));

test("flags an authored plan as a staleness risk", withProject(async (basePath) => {
  seedTask();
  insertTask({
    milestoneId: "M001",
    sliceId: "S01",
    id: "T01",
    planning: {
      description: "Distinctive description",
      estimate: "2h",
      files: ["zeta.ts", "alpha.ts"],
      verify: "npm run distinctive-check",
      inputs: ["input-b.ts", "input-a.ts"],
      expectedOutput: ["out-b.ts", "out-a.ts"],
      observabilityImpact: "",
      fullPlanMd: "# Authored plan\n\nHand-written body.",
    },
  });

  const result = await executeTaskContract({ milestoneId: "M001", sliceId: "S01", taskId: "T01" }, basePath);
  const details = result.details as Record<string, unknown>;

  assert.equal(details["fullPlanMdPresent"], true);
  assert.ok((details["fullPlanMdLength"] as number) > 0);
  assert.ok(!("fullPlanMd" in details));
  const caveats = details["caveats"] as Record<string, string>;
  // A present authored plan means the renderer bypasses the per-task path, so
  // PLAN.md can disagree with the DB after a replan.
  assert.match(caveats["fullPlanMd"], /stale/i);
}));

test("a missing task fails closed instead of returning an empty contract", withProject(async (basePath) => {
  seedTask();
  const result = await executeTaskContract({ milestoneId: "M001", sliceId: "S01", taskId: "T99" }, basePath);
  const details = result.details as Record<string, unknown>;

  assert.equal(result.isError, true);
  assert.equal(details["error"], "not_found");
  // An empty contract written back to gsd_replan_task would wipe the row, so
  // the absence of the planning fields is the point of this assertion.
  assert.ok(!("verify" in details));
  assert.ok(!("expectedOutput" in details));
}));

test("names stored-empty required fields as unresendable", withProject(async (basePath) => {
  // A task completed with no plan row, or a legacy import, stores empty
  // description/estimate/verify. `gsd_replan_task` rejects those, so "resend
  // untouched fields verbatim" would fail validation and push the caller back
  // into inventing values -- the failure this tool exists to prevent.
  insertMilestone({ id: "M001", title: "Milestone", status: "in_progress" });
  insertSlice({ milestoneId: "M001", id: "S01", title: "Slice", status: "in_progress" });
  insertTask({
    milestoneId: "M001",
    sliceId: "S01",
    id: "T02",
    title: "Has a title",
    status: "pending",
    planning: {
      description: "",
      estimate: "",
      files: [],
      verify: "   ",
      inputs: [],
      expectedOutput: [],
      observabilityImpact: "",
    },
  });

  const result = await executeTaskContract({ milestoneId: "M001", sliceId: "S01", taskId: "T02" }, basePath);
  const details = result.details as Record<string, unknown>;
  const unresendable = details["unresendableFields"] as Array<{ field: string; reason: string }>;
  const fields = unresendable.map((entry) => entry.field).sort();

  assert.deepEqual(fields, ["description", "estimate", "verify"]);
  assert.ok(!fields.includes("title"), "title has a value and must not be flagged");
  for (const entry of unresendable) {
    assert.match(entry.reason, /Stored empty/);
  }
  const caveats = details["caveats"] as Record<string, string>;
  assert.match(caveats["unresendableFields"], /cannot be resent verbatim/);
}));

test("a fully populated task flags no empty required fields", withProject(async (basePath) => {
  seedTask();
  const result = await executeTaskContract({ milestoneId: "M001", sliceId: "S01", taskId: "T01" }, basePath);
  const details = result.details as Record<string, unknown>;

  assert.deepEqual(details["unresendableFields"], []);
  const caveats = details["caveats"] as Record<string, string>;
  assert.ok(!("unresendableFields" in caveats), "no caveat when every field is resendable");
}));

test("flags a stored verify that names a GSD tool as unresendable", withProject(async (basePath) => {
  // `assertVerifyIsShellCheckable` gates gsd_plan_task and gsd_replan_task
  // only -- gsd_plan_slice / gsd_replan_slice and legacy imports do not -- so a
  // slice-planned task can hold a tool-name verify. Resending it verbatim, as
  // this tool otherwise instructs, would be rejected by the replan.
  insertMilestone({ id: "M001", title: "Milestone", status: "in_progress" });
  insertSlice({ milestoneId: "M001", id: "S01", title: "Slice", status: "in_progress" });
  insertTask({
    milestoneId: "M001",
    sliceId: "S01",
    id: "T03",
    title: "Slice-planned task",
    status: "pending",
    planning: {
      description: "Planned through the slice",
      estimate: "1h",
      files: ["a.ts"],
      verify: "gsd_task_complete once the suite passes",
      inputs: ["b.ts"],
      expectedOutput: ["c.ts"],
      observabilityImpact: "",
    },
  });

  const result = await executeTaskContract({ milestoneId: "M001", sliceId: "S01", taskId: "T03" }, basePath);
  const details = result.details as Record<string, unknown>;
  const unresendable = details["unresendableFields"] as Array<{ field: string; reason: string }>;
  const verifyEntry = unresendable.find((entry) => entry.field === "verify");

  assert.ok(verifyEntry, "a tool-name verify must be flagged");
  assert.match(verifyEntry.reason, /Names a GSD tool/);
  assert.match(verifyEntry.reason, /gsd_task_complete/);
  // The stored value is still returned -- the caller needs to see what to replace.
  assert.equal(details["verify"], "gsd_task_complete once the suite passes");
}));

test("flags blank entries inside files/inputs/expectedOutput", withProject(async (basePath) => {
  // `gsd_replan_slice` types these as plain string arrays on both transports
  // and validates no elements, so a slice-replanned task can store a blank.
  // `gsd_replan_task` then rejects the WHOLE array, and the response's own
  // "everything not listed is safe to resend" would have been false.
  insertMilestone({ id: "M001", title: "Milestone", status: "in_progress" });
  insertSlice({ milestoneId: "M001", id: "S01", title: "Slice", status: "in_progress" });
  insertTask({
    milestoneId: "M001",
    sliceId: "S01",
    id: "T04",
    title: "Slice-replanned task",
    status: "pending",
    planning: {
      description: "Planned through the slice",
      estimate: "1h",
      files: ["a.ts", "  "],
      verify: "npm test",
      inputs: ["b.ts"],
      expectedOutput: ["", "out.ts"],
      observabilityImpact: "",
    },
  });

  const result = await executeTaskContract({ milestoneId: "M001", sliceId: "S01", taskId: "T04" }, basePath);
  const details = result.details as Record<string, unknown>;
  const unresendable = details["unresendableFields"] as Array<{ field: string; reason: string }>;
  const fields = unresendable.map((entry) => entry.field).sort();

  assert.deepEqual(fields, ["expectedOutput", "files"]);
  assert.ok(!fields.includes("inputs"), "inputs has no blank entry and must not be flagged");
  for (const entry of unresendable) {
    assert.match(entry.reason, /blank entry|blank entries/);
    assert.match(entry.reason, /non-empty strings/);
  }
}));

test("reports task and parent-slice status so a blocked write is visible before it is attempted", withProject(async (basePath) => {
  // `handleReplanTask` refuses a closed task before it reads the contract, so a
  // clean payload could still be unwritable.
  insertMilestone({ id: "M001", title: "Milestone", status: "in_progress" });
  insertSlice({ milestoneId: "M001", id: "S01", title: "Slice", status: "in_progress" });
  insertTask({
    milestoneId: "M001",
    sliceId: "S01",
    id: "T05",
    title: "Completed task",
    status: "complete",
    planning: {
      description: "Already done",
      estimate: "1h",
      files: ["a.ts"],
      verify: "npm test",
      inputs: ["b.ts"],
      expectedOutput: ["out.ts"],
      observabilityImpact: "",
    },
  });

  const result = await executeTaskContract({ milestoneId: "M001", sliceId: "S01", taskId: "T05" }, basePath);
  const details = result.details as Record<string, unknown>;

  assert.equal(details["status"], "complete");
  assert.equal(details["sliceStatus"], "in_progress");
  const caveats = details["caveats"] as Record<string, string>;
  assert.match(caveats["status"], /gsd_task_reopen/);
  // The contract itself is still accurate and still returned.
  assert.equal(details["verify"], "npm test");
  assert.deepEqual(details["unresendableFields"], []);
}));

test("a missing parent slice is reported, not treated as writable", withProject(async (basePath) => {
  // `handleReplanTask` throws `missing parent slice` before any other check, so
  // a task row orphaned by a slice-row loss is unwritable no matter how clean
  // its contract looks.
  insertMilestone({ id: "M001", title: "Milestone", status: "in_progress" });
  insertSlice({ milestoneId: "M001", id: "S01", title: "Slice", status: "in_progress" });
  insertTask({
    milestoneId: "M001",
    sliceId: "S01",
    id: "T06",
    title: "Orphaned task",
    status: "pending",
    planning: {
      description: "Fine contract",
      estimate: "1h",
      files: ["a.ts"],
      verify: "npm test",
      inputs: ["b.ts"],
      expectedOutput: ["out.ts"],
      observabilityImpact: "",
    },
  });
  // Foreign keys prevent orphaning a task through the normal API, so this
  // models the one path the reviewer named that can produce it: an FK-less
  // legacy import. Without the pragma the DELETE raises FOREIGN KEY constraint
  // failed -- which is itself worth knowing: under an FK-enforcing DB this
  // state is unreachable, and the executor's guard is purely defensive.
  const db = _getAdapter()!;
  db.prepare("PRAGMA foreign_keys=OFF").run({});
  db.prepare("DELETE FROM slices WHERE milestone_id = 'M001' AND id = 'S01'").run({});
  db.prepare("PRAGMA foreign_keys=ON").run({});

  const result = await executeTaskContract({ milestoneId: "M001", sliceId: "S01", taskId: "T06" }, basePath);
  const details = result.details as Record<string, unknown>;
  const caveats = details["caveats"] as Record<string, string>;

  assert.equal(details["sliceStatus"], null);
  assert.match(caveats["status"], /missing parent slice/);
  // The contract is still returned -- it is accurate, only the write is blocked.
  assert.equal(details["verify"], "npm test");
}));

test("an open task and slice carry no status caveat", withProject(async (basePath) => {
  seedTask();
  const result = await executeTaskContract({ milestoneId: "M001", sliceId: "S01", taskId: "T01" }, basePath);
  const details = result.details as Record<string, unknown>;
  const caveats = details["caveats"] as Record<string, string>;

  assert.equal(details["status"], "pending");
  // Both status sources are surfaced. NOTE: the wiring that reads
  // `canonicalStatus` from the lifecycle row is deliberately NOT fixture-pinned
  // -- a real `workflow_item_lifecycles` row needs a project_authority /
  // workflow_operations FK chain, which is disproportionate here. The DECISION
  // logic is fully covered by the pure describeReplanBlockers tests above; only
  // the one-line fetch is uncovered. Replacing it with `null` keeps this suite
  // green, so treat it as a known hole rather than assuming coverage.
  assert.ok("canonicalStatus" in details, "the canonical lifecycle status must be reported alongside the legacy one");
  assert.ok(!("status" in caveats), "no status caveat when nothing is closed");
}));

test("a whitespace-only authored plan is not reported as a staleness risk", withProject(async (basePath) => {
  seedTask();
  insertTask({
    milestoneId: "M001",
    sliceId: "S01",
    id: "T01",
    planning: {
      description: "Distinctive description",
      estimate: "2h",
      files: ["zeta.ts", "alpha.ts"],
      verify: "npm run distinctive-check",
      inputs: ["input-b.ts", "input-a.ts"],
      expectedOutput: ["out-b.ts", "out-a.ts"],
      observabilityImpact: "",
      fullPlanMd: "   \n  ",
    },
  });

  const result = await executeTaskContract({ milestoneId: "M001", sliceId: "S01", taskId: "T01" }, basePath);
  const details = result.details as Record<string, unknown>;

  // `markdown-renderer.ts` bypasses the per-task renderer on `.trim()`, so a
  // bare length check would warn about a staleness the renderer cannot produce.
  assert.equal(details["fullPlanMdPresent"], false);
  assert.ok((details["fullPlanMdLength"] as number) > 0, "the raw length is still reported");
  const caveats = details["caveats"] as Record<string, string>;
  assert.doesNotMatch(caveats["fullPlanMd"], /stale/i);
}));

test("the read matches what the row actually stores", withProject(async (basePath) => {
  seedTask();
  const stored = getTask("M001", "S01", "T01");
  assert.ok(stored);
  const result = await executeTaskContract({ milestoneId: "M001", sliceId: "S01", taskId: "T01" }, basePath);
  const details = result.details as Record<string, unknown>;

  // Guards against the read drifting to a different column, or to the PLAN.md
  // projection, which is exactly what the caller could not trust.
  assert.deepEqual(details["files"], stored.files);
  assert.deepEqual(details["inputs"], stored.inputs);
  assert.deepEqual(details["expectedOutput"], stored.expected_output);
  assert.equal(details["verify"], stored.verify);
}));
