import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";

import { verifyExpectedArtifact } from "../auto-recovery.ts";
import { BLOCKER_PLACEHOLDER_SLICE_ID } from "../artifact-verification.ts";
import { openDatabase, closeDatabase, insertMilestone, insertSlice } from "../gsd-db.ts";

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-plan-milestone-artifact-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}

function writeRoadmap(base: string, milestoneId: string, content: string): void {
  const milestoneDir = join(base, ".gsd", "milestones", milestoneId);
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(join(milestoneDir, `${milestoneId}-ROADMAP.md`), content, "utf-8");
}

function writeLegacyRoadmap(base: string, milestoneId: string, content: string): void {
  const milestoneDir = join(base, ".gsd", "milestones", milestoneId);
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(join(milestoneDir, "ROADMAP.md"), content, "utf-8");
}

test("#3405: plan-milestone roadmap stub does not count as a verified artifact", () => {
  const base = createFixtureBase();
  try {
    writeRoadmap(base, "M001", [
      "# M001: Placeholder",
      "",
      "**Vision:** Stub only.",
      "",
      "## Slices",
      "",
      "_TBD_",
      "",
    ].join("\n"));

    const result = verifyExpectedArtifact("plan-milestone", "M001", base);
    assert.equal(result, false, "zero-slice roadmap stubs must fail verification");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("#3405: plan-milestone roadmap with real slices still passes artifact verification", () => {
  const base = createFixtureBase();
  try {
    writeRoadmap(base, "M001", [
      "# M001: Real roadmap",
      "",
      "**Vision:** Real work.",
      "",
      "## Slices",
      "",
      "- [ ] **S01: First slice** `risk:low` `depends:[]`",
      "  > After this: a real slice exists.",
      "",
    ].join("\n"));

    const result = verifyExpectedArtifact("plan-milestone", "M001", base);
    assert.equal(result, true, "real roadmap slices should keep passing verification");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("plan-milestone verification accepts legacy ROADMAP.md via shared resolver", () => {
  const base = createFixtureBase();
  try {
    writeLegacyRoadmap(base, "M001", [
      "# M001: Legacy roadmap",
      "",
      "## Slices",
      "",
      "- [ ] **S01: First slice** `risk:low` `depends:[]`",
      "  > After this: a real slice exists.",
      "",
    ].join("\n"));

    const result = verifyExpectedArtifact("plan-milestone", "M001", base);
    assert.equal(result, true, "legacy unprefixed ROADMAP.md should resolve");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// The four cases above open no DB, so `hasPlannedMilestoneSliceRows` falls soft
// and only the projection is checked. The cases below open one, so they must
// close it in `t.after` or they would change the meaning of whatever runs next.
const REAL_ROADMAP = [
  "# M001: Real roadmap",
  "",
  "**Vision:** Real work.",
  "",
  "## Slices",
  "",
  "- [ ] **S01: First slice** `risk:low` `depends:[]`",
  "  > After this: a real slice exists.",
  "",
].join("\n");

function openFixtureDb(base: string): void {
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Real roadmap", status: "active" });
}

function cleanupFixture(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

test("plan-milestone verification passes when the roadmap and real slice rows agree", (t) => {
  const base = createFixtureBase();
  t.after(() => cleanupFixture(base));
  openFixtureDb(base);
  insertSlice({ id: "S01", milestoneId: "M001", title: "First slice", status: "pending", sequence: 1 });
  writeRoadmap(base, "M001", REAL_ROADMAP);

  assert.equal(verifyExpectedArtifact("plan-milestone", "M001", base), true);
});

// The reported incident: blocked on its own orchestrator's lease, the agent
// hand-wrote a slices-bearing ROADMAP.md against its own prompt, and file-only
// verification accepted the forgery as proof of planning.
test("plan-milestone verification rejects a slices-bearing roadmap with no slice rows", (t) => {
  const base = createFixtureBase();
  t.after(() => cleanupFixture(base));
  openFixtureDb(base);
  writeRoadmap(base, "M001", REAL_ROADMAP);

  assert.equal(verifyExpectedArtifact("plan-milestone", "M001", base), false,
    "the DB is the authority; a hand-written roadmap is not a plan");
});

// Counting the fabricated row would mean that after any blocker placeholder, a
// later hand-written roadmap verifies as planned forever -- the incident again.
test("plan-milestone verification rejects a roadmap backed only by the blocker placeholder row", (t) => {
  const base = createFixtureBase();
  t.after(() => cleanupFixture(base));
  openFixtureDb(base);
  insertSlice({
    id: BLOCKER_PLACEHOLDER_SLICE_ID,
    milestoneId: "M001",
    title: "Blocker placeholder — planning failed",
    status: "complete",
    sequence: 0,
  });
  writeRoadmap(base, "M001", REAL_ROADMAP);

  assert.equal(verifyExpectedArtifact("plan-milestone", "M001", base), false);
});

// The DB handle is process-global. If the open one belongs to a different
// project, a zero-row read says nothing about this base, so the check must fall
// soft rather than hard-block a genuinely planned milestone.
// Pins the NORMALIZATION, portably. The cases above only catch a regression to a
// bare `===` on Windows, where `tmpdir()` is an 8.3 short path so the raw open
// path and the realpath-resolved expected path differ by accident. On Linux/macOS
// CI there is no short-name divergence, a de-normalized compare still matches,
// and the bug would ship green. So open the DB via an equivalent-but-textually
// different path -- a redundant `.` segment, built by concatenation because
// `join`/`resolve` would collapse it -- and assert the check still bites.
test("plan-milestone verification compares DB paths by identity, not by string", (t) => {
  const base = createFixtureBase();
  t.after(() => cleanupFixture(base));

  const denormalized = `${base}${sep}.${sep}.gsd${sep}gsd.db`;
  assert.notEqual(denormalized, join(base, ".gsd", "gsd.db"), "fixture must be textually different");
  openDatabase(denormalized);
  insertMilestone({ id: "M001", title: "Real roadmap", status: "active" });
  writeRoadmap(base, "M001", REAL_ROADMAP);

  assert.equal(verifyExpectedArtifact("plan-milestone", "M001", base), false,
    "a de-normalized open path must still resolve to this base's DB, so the zero-row check applies");
});

test("plan-milestone verification falls soft when the open DB belongs to another project", (t) => {
  const subject = createFixtureBase();
  const other = createFixtureBase();
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    try { rmSync(subject, { recursive: true, force: true }); } catch { /* noop */ }
    try { rmSync(other, { recursive: true, force: true }); } catch { /* noop */ }
  });

  // DB open for `other`, which knows nothing about M001.
  openDatabase(join(other, ".gsd", "gsd.db"));
  writeRoadmap(subject, "M001", REAL_ROADMAP);

  assert.equal(verifyExpectedArtifact("plan-milestone", "M001", subject), true,
    "a foreign open DB must not turn a real roadmap into a verification failure");
});

test("plan-milestone verification still rejects a zero-slice roadmap that has real slice rows", (t) => {
  const base = createFixtureBase();
  t.after(() => cleanupFixture(base));
  openFixtureDb(base);
  insertSlice({ id: "S01", milestoneId: "M001", title: "First slice", status: "pending", sequence: 1 });
  writeRoadmap(base, "M001", "# M001: Placeholder\n\n**Vision:** Stub only.\n\n## Slices\n\n_TBD_\n");

  assert.equal(verifyExpectedArtifact("plan-milestone", "M001", base), false,
    "both authorities must agree; the projection check still bites");
});

test("discuss-milestone verification accepts legacy CONTEXT.md via shared resolver", () => {
  const base = createFixtureBase();
  try {
    const milestoneDir = join(base, ".gsd", "milestones", "M001");
    mkdirSync(milestoneDir, { recursive: true });
    writeFileSync(join(milestoneDir, "CONTEXT.md"), "# M001 Context\n", "utf-8");

    const result = verifyExpectedArtifact("discuss-milestone", "M001", base);
    assert.equal(result, true, "legacy unprefixed CONTEXT.md should resolve");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
