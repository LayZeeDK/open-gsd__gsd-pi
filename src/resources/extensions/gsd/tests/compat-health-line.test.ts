// Project/App: gsd-pi
// File Purpose: Unit tests for formatCompatHealthLine (doctor compat output).
// Covers the per-section "no baseline" signal introduced to fix COMMENT:3449128458.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { formatCompatHealthLine } from "../commands-handlers.ts";
import { computeProjectionSha, writeCompatMarker } from "../compat/compat-marker.ts";

const tmpDirs: string[] = [];
function makeTmpBase(): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-chl-${randomUUID()}`));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  tmpDirs.push(base);
  return base;
}
afterEach(() => {
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  tmpDirs.length = 0;
});

test("returns unified no-baseline when projections empty and planning inactive", async () => {
  const base = makeTmpBase();
  // No marker written → EMPTY_MARKER → projections={}, planning.active=false
  const line = await formatCompatHealthLine(base);
  assert.ok(line.includes("no baseline"), `expected no-baseline, got: ${line}`);
  // Should be the unified single line, not separate .gsd/.planning sections.
  assert.ok(!line.includes("(.gsd)"), `expected unified line, got: ${line}`);
});

test("returns per-section no-baseline for .gsd when planning active but gsd projections empty", async () => {
  // Regression: COMMENT:3449128458 — after auto-activation, marker has
  // planning.active=true but marker.projections={} (no .gsd/ baseline yet).
  // Old code reported ".gsd: OK" (misleading). New code: per-section no-baseline.
  const base = makeTmpBase();
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "",
    projections: {},
    planning: { active: true, layout: "flat-phases", projections: {}, passthrough: {} },
    piVersion: "1.4.0",
  });

  const line = await formatCompatHealthLine(base);
  // Both sections should show no-baseline.
  const gsdLine = line.split("\n").find((l) => l.includes("(.gsd)"));
  const planningLine = line.split("\n").find((l) => l.includes("(.planning)"));
  assert.ok(gsdLine, "expected a (.gsd) line");
  assert.ok(planningLine, "expected a (.planning) line");
  assert.ok(gsdLine!.includes("no baseline"), `(.gsd) should say no baseline, got: ${gsdLine}`);
  assert.ok(planningLine!.includes("no baseline"), `(.planning) should say no baseline, got: ${planningLine}`);
});

test("returns no-baseline for .planning section when active but planning projections empty", async () => {
  // Mixed: .gsd/ has a baseline but .planning/ has been auto-activated with
  // empty projections (sync ran for .gsd but not yet for .planning/).
  const base = makeTmpBase();
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-06-21T00:00:00.000Z",
    projections: {
      "milestones/M001/M001-ROADMAP.md": { sha: "abc123", entities: ["M001"] },
    },
    planning: { active: true, layout: "flat-phases", projections: {}, passthrough: {} },
    piVersion: "1.4.0",
  });

  const line = await formatCompatHealthLine(base);
  const gsdLine = line.split("\n").find((l) => l.includes("(.gsd)"));
  const planningLine = line.split("\n").find((l) => l.includes("(.planning)"));
  assert.ok(gsdLine, "expected a (.gsd) line");
  assert.ok(planningLine, "expected a (.planning) line");
  // .gsd/ has a baseline (1 entry), file is absent → 0 drift → OK
  assert.ok(gsdLine!.includes("OK"), `(.gsd) should say OK, got: ${gsdLine}`);
  // .planning/ has no SHAs at all → no baseline
  assert.ok(planningLine!.includes("no baseline"), `(.planning) should say no baseline, got: ${planningLine}`);
});

test("reports not-active for .planning when planning is inactive", async () => {
  const base = makeTmpBase();
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-06-21T00:00:00.000Z",
    projections: {
      "milestones/M001/M001-ROADMAP.md": { sha: "abc123", entities: ["M001"] },
    },
    planning: { active: false, layout: null, projections: {}, passthrough: {} },
    piVersion: "1.4.0",
  });

  const line = await formatCompatHealthLine(base);
  const planningLine = line.split("\n").find((l) => l.includes("(.planning)"));
  assert.ok(planningLine, "expected a (.planning) line");
  assert.ok(planningLine!.includes("not active"), `(.planning) should say not active, got: ${planningLine}`);
});

// The compat-health line hashes the same bytes the drift detector does, so it
// must make the same stamp-insensitive judgement for the .gsd map -- otherwise
// `gsd doctor` reports "N file(s) drifted" for projections reconcile considers
// clean.
test("does not count a stamp-only difference as .gsd drift", async () => {
  const base = makeTmpBase();
  const rel = "milestones/M001/M001-ROADMAP.md";
  const logical = "# Roadmap\n\n- [x] S1 done\n";
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", rel),
    `${logical}<!-- gsd:state-version=7:1750000000000 -->\n`,
    "utf-8",
  );
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-06-21T00:00:00.000Z",
    projections: { [rel]: { sha: computeProjectionSha(logical), entities: ["M001"] } },
    planning: { active: false, layout: null, projections: {}, passthrough: {} },
    piVersion: "1.4.0",
  });

  const gsdLine = (await formatCompatHealthLine(base)).split("\n").find((l) => l.includes("(.gsd)"));
  assert.ok(gsdLine, "expected a (.gsd) line");
  assert.ok(gsdLine!.includes("OK"), `stamp-only difference must not count as drift, got: ${gsdLine}`);
});

test("still counts a real .gsd content edit as drift", async () => {
  const base = makeTmpBase();
  const rel = "milestones/M001/M001-ROADMAP.md";
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(base, ".gsd", rel), "# Roadmap\n\n- [ ] S1 reopened\n", "utf-8");
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-06-21T00:00:00.000Z",
    projections: {
      [rel]: { sha: computeProjectionSha("# Roadmap\n\n- [x] S1 done\n"), entities: ["M001"] },
    },
    planning: { active: false, layout: null, projections: {}, passthrough: {} },
    piVersion: "1.4.0",
  });

  const gsdLine = (await formatCompatHealthLine(base)).split("\n").find((l) => l.includes("(.gsd)"));
  assert.ok(gsdLine!.includes("drifted"), `expected drift, got: ${gsdLine}`);
});

// Every marker entry written before the baseline became stamp-insensitive
// holds the sha of STAMPED bytes, which stripping can never reproduce. Doctor
// would then report every stamped projection as drifted on a completely
// healthy repo, immediately after upgrading, with no DB fallback here to
// self-heal against as the reconcile detector has.
test("accepts a legacy stamped .gsd baseline as unchanged", async () => {
  const base = makeTmpBase();
  const rel = "milestones/M001/M001-ROADMAP.md";
  const logical = "# Roadmap\n\n- [x] S1 done\n";
  const stamped = `${logical}<!-- gsd:state-version=7:1750000000000 -->\n`;
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(base, ".gsd", rel), stamped, "utf-8");
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-06-21T00:00:00.000Z",
    // The pre-change baseline: the sha of the stamped bytes.
    projections: { [rel]: { sha: computeProjectionSha(stamped), entities: ["M001"] } },
    planning: { active: false, layout: null, projections: {}, passthrough: {} },
    piVersion: "1.4.0",
  });

  const gsdLine = (await formatCompatHealthLine(base)).split("\n").find((l) => l.includes("(.gsd)"));
  assert.ok(gsdLine!.includes("OK"), `a legacy stamped baseline must not read as drift, got: ${gsdLine}`);
});

// The counterweight: accepting the raw sha must not make the check toothless.
// Edited content matches the baseline neither stripped nor raw.
test("still counts a real edit as drift against a legacy stamped baseline", async () => {
  const base = makeTmpBase();
  const rel = "milestones/M001/M001-ROADMAP.md";
  const stamped = "# Roadmap\n\n- [x] S1 done\n<!-- gsd:state-version=7:1750000000000 -->\n";
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(base, ".gsd", rel), "# Roadmap\n\n- [ ] S1 reopened\n", "utf-8");
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-06-21T00:00:00.000Z",
    projections: { [rel]: { sha: computeProjectionSha(stamped), entities: ["M001"] } },
    planning: { active: false, layout: null, projections: {}, passthrough: {} },
    piVersion: "1.4.0",
  });

  const gsdLine = (await formatCompatHealthLine(base)).split("\n").find((l) => l.includes("(.gsd)"));
  assert.ok(gsdLine!.includes("drifted"), `expected drift, got: ${gsdLine}`);
});

// .planning projections are NEVER stamped, and their sha is written and read
// raw everywhere else (planning-compat.ts, external-planning-edit.ts). Its
// passthrough entries are arbitrary user files too, where a trailing
// stamp-shaped line would be real content. Stripping here would make doctor
// disagree with the reconcile detector.
test("does not strip stamps for the .planning map", async () => {
  const base = makeTmpBase();
  const rel = "phases/01-requirements/PLAN.md";
  const logical = "# Plan\n\n- [x] T1\n";
  mkdirSync(join(base, ".planning", "phases", "01-requirements"), { recursive: true });
  writeFileSync(
    join(base, ".planning", rel),
    `${logical}<!-- gsd:state-version=7:1750000000000 -->\n`,
    "utf-8",
  );
  writeCompatMarker(base, {
    schema: 2,
    lastWriter: "gsd-pi",
    lastProjectedAt: "2026-06-21T00:00:00.000Z",
    projections: {},
    planning: {
      active: true,
      layout: "flat-phases",
      projections: { [rel]: { sha: computeProjectionSha(logical), entities: ["M001"] } },
      passthrough: {},
    },
    piVersion: "1.4.0",
  });

  const planningLine = (await formatCompatHealthLine(base))
    .split("\n")
    .find((l) => l.includes("(.planning)"));
  assert.ok(
    planningLine!.includes("drifted"),
    `.planning must stay stamp-sensitive, got: ${planningLine}`,
  );
});
