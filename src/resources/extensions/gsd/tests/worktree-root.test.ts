import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeWorktreePathForCompare, resolveWorktreeProjectRoot } from "../worktree-root.ts";

/**
 * A temp directory reachable by two spellings that only `realpathSync.native`
 * unifies — on Windows, an 8.3 short component (`LARSGY~1`) vs its long form.
 *
 * Returns null when the host offers no such divergence (POSIX, or an NTFS
 * volume with 8.3 name creation disabled), so the tests that need it skip
 * instead of asserting something the platform cannot express.
 */
function shortAndLongSpellings(prefix: string): { short: string; long: string } | null {
  const short = mkdtempSync(join(tmpdir(), prefix));
  const long = realpathSync.native(short);

  return long === short ? null : { short, long };
}

test("resolveWorktreeProjectRoot: explicit non-worktree cwd beats stale GSD_PROJECT_ROOT", (t) => {
  const previous = process.env.GSD_PROJECT_ROOT;
  const dir = mkdtempSync(join(tmpdir(), "gsd-root-"));
  const projectDir = join(dir, "project");
  mkdirSync(projectDir);
  process.env.GSD_PROJECT_ROOT = "/Users/example";

  t.after(() => {
    if (previous === undefined) {
      delete process.env.GSD_PROJECT_ROOT;
    } else {
      process.env.GSD_PROJECT_ROOT = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(resolveWorktreeProjectRoot(projectDir), projectDir);
});

test("resolveWorktreeProjectRoot: external GSD home is not treated as a project root", (t) => {
  const previous = process.env.GSD_HOME;
  const dir = mkdtempSync(join(tmpdir(), "gsd-root-"));
  const fakeHome = join(dir, "home");
  const projectDir = join(fakeHome, "work", "project");
  mkdirSync(join(fakeHome, ".gsd"), { recursive: true });
  mkdirSync(join(fakeHome, ".git"), { recursive: true });
  writeFileSync(join(fakeHome, ".gsd", "PREFERENCES.md"), "---\n---\n", "utf-8");
  mkdirSync(projectDir, { recursive: true });
  process.env.GSD_HOME = join(fakeHome, ".gsd");

  t.after(() => {
    if (previous === undefined) {
      delete process.env.GSD_HOME;
    } else {
      process.env.GSD_HOME = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(resolveWorktreeProjectRoot(projectDir), projectDir);
});

test("resolveWorktreeProjectRoot: GSD_PROJECT_ROOT still anchors auto-worktree paths", (t) => {
  const previous = process.env.GSD_PROJECT_ROOT;
  const dir = mkdtempSync(join(tmpdir(), "gsd-root-"));
  const projectDir = join(dir, "project");
  const worktreeDir = join(projectDir, ".gsd", "worktrees", "M001");
  mkdirSync(worktreeDir, { recursive: true });
  process.env.GSD_PROJECT_ROOT = projectDir;

  t.after(() => {
    if (previous === undefined) {
      delete process.env.GSD_PROJECT_ROOT;
    } else {
      process.env.GSD_PROJECT_ROOT = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(resolveWorktreeProjectRoot(worktreeDir), projectDir);
});

test("normalizeWorktreePathForCompare unifies short and long spellings of one directory", (t) => {
  const spellings = shortAndLongSpellings("gsd-root-spelling-");
  if (!spellings) {
    t.skip("host offers no short-vs-long path divergence to compare");

    return;
  }

  t.after(() => rmSync(spellings.short, { recursive: true, force: true }));

  assert.equal(
    normalizeWorktreePathForCompare(spellings.short),
    normalizeWorktreePathForCompare(spellings.long),
    "both spellings address one directory, so the comparison form must agree",
  );
});

test("resolveWorktreeProjectRoot: external GSD home is not treated as a project root when the walk arrives by a short path", (t) => {
  // The sibling test above spells GSD_HOME and the project the same way, so its
  // guard compares like with like. Here GSD_HOME is the LONG spelling while the
  // walk starts from the SHORT one — the real asymmetry on Windows, where
  // gsdHome() derives from homedir() (long, via USERPROFILE) but a cwd under
  // os.tmpdir() carries an 8.3 component. A comparison form that does not
  // expand short names never matches, so the walk climbs past the home, finds
  // its bootstrapped .gsd, and hands back the HOME as the project root.
  const spellings = shortAndLongSpellings("gsd-root-escape-");
  if (!spellings) {
    t.skip("host offers no short-vs-long path divergence to compare");

    return;
  }

  const previous = process.env.GSD_HOME;
  const fakeHomeLong = join(spellings.long, "home");
  const fakeHomeShort = join(spellings.short, "home");
  mkdirSync(join(fakeHomeLong, ".gsd"), { recursive: true });
  mkdirSync(join(fakeHomeLong, ".git"), { recursive: true });
  writeFileSync(join(fakeHomeLong, ".gsd", "PREFERENCES.md"), "---\n---\n", "utf-8");
  mkdirSync(join(fakeHomeLong, "work", "project"), { recursive: true });
  process.env.GSD_HOME = join(fakeHomeLong, ".gsd");

  t.after(() => {
    if (previous === undefined) {
      delete process.env.GSD_HOME;
    } else {
      process.env.GSD_HOME = previous;
    }
    rmSync(spellings.short, { recursive: true, force: true });
  });

  const projectDir = join(fakeHomeShort, "work", "project");

  assert.equal(
    resolveWorktreeProjectRoot(projectDir),
    projectDir,
    "the GSD home must not be adopted as the project root just because the walk spelled it differently",
  );
});
