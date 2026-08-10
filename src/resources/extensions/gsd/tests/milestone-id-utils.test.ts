// Project/App: gsd-pi
// File Purpose: findMilestoneIds maps flat-phase directories to milestone ids.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { findMilestoneIds } from "../milestone-id-utils.ts";

// A `.gsd` directory only anchors path resolution once it looks bootstrapped
// (worktree-root.ts hasGsdBootstrapArtifacts). Without the marker the project
// root walk escapes to the global ~/.gsd and every lookup reads the wrong tree.
function makeProject(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-milestone-id-utils-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), "# Preferences\n");

  return base;
}

function makeFlatPhaseProject(phaseDirs: string[]): string {
  const base = makeProject();
  for (const name of phaseDirs) {
    mkdirSync(join(base, ".gsd", "phases", name), { recursive: true });
  }

  return base;
}

// milestonesDir() resolves to `phases/` for a flat-phase project, so
// findMilestoneIds reads `NN-slug` directory names. It only recognised the
// legacy `M001-slug` shape and fell through to the raw directory name for
// everything else, so `/gsd next M003` failed with "Milestone M003 does not
// exist. Available: 01-requirements, 03-architecture-guardrails".
test("maps a flat-phase directory to its milestone id", (t) => {
  const base = makeFlatPhaseProject(["03-architecture-guardrails"]);
  t.after(() => rmSync(base, { recursive: true, force: true }));

  assert.deepEqual(findMilestoneIds(base), ["M003"]);
});

// The phase number maps 1:1 to the milestone number — this is the inverse of
// layout-policy.ts milestoneIdToPhaseNum, which reads M012 back as 12.
test("zero-pads flat-phase numbers to three digits and sorts numerically", (t) => {
  const base = makeFlatPhaseProject(["10-release", "01-requirements", "03-guardrails"]);
  t.after(() => rmSync(base, { recursive: true, force: true }));

  assert.deepEqual(findMilestoneIds(base), ["M001", "M003", "M010"]);
});

// Two phase directories can carry the same number. Emitting the id twice would
// list it twice in "Available:" and make consumers that index the returned
// array (files.ts `sorted.indexOf(mid)`) silently resolve to the first one.
test("emits one id when two phase directories share a number", (t) => {
  const base = makeFlatPhaseProject(["01-requirements", "1-requirements-redo"]);
  t.after(() => rmSync(base, { recursive: true, force: true }));

  assert.deepEqual(findMilestoneIds(base), ["M001"]);
});

// MILESTONE_ID_RE accepts exactly three digits, so a four-digit directory must
// not be rewritten into an `M0001` that fails the regex every consumer checks.
test("leaves a four-digit directory name untouched", (t) => {
  const base = makeFlatPhaseProject(["0001-requirements"]);
  t.after(() => rmSync(base, { recursive: true, force: true }));

  assert.deepEqual(findMilestoneIds(base), ["0001-requirements"]);
});

test("keeps the legacy milestone id layout working", (t) => {
  const base = makeProject();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const legacy = join(base, ".gsd", "milestones", "M001-abc123-first-milestone");
  mkdirSync(legacy, { recursive: true });
  // A milestones/<MID>/ directory only counts as legacy layout when it carries
  // content files, so give it a ROADMAP.
  writeFileSync(join(legacy, "M001-abc123-ROADMAP.md"), "# Roadmap\n");

  assert.deepEqual(findMilestoneIds(base), ["M001-abc123"]);
});

// A directory that is neither shape must not be silently rewritten into a
// milestone id — the raw name is still the most honest answer for it.
test("leaves an unrecognised directory name untouched", (t) => {
  const base = makeFlatPhaseProject(["scratch"]);
  t.after(() => rmSync(base, { recursive: true, force: true }));

  assert.deepEqual(findMilestoneIds(base), ["scratch"]);
});

test("returns an empty list when the directory does not exist", (t) => {
  const base = makeProject();
  t.after(() => rmSync(base, { recursive: true, force: true }));

  assert.deepEqual(findMilestoneIds(base), []);
});
