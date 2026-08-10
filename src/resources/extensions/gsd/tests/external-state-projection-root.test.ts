// Project/App: gsd-pi
// File Purpose: Projection-root and fence walks stop at an external-state store
// instead of escaping to the global gsd home.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { projectionDatabasePathForTest } from "../database-maintenance-fence.ts";
import { managedProjectionTargetForTest } from "../managed-projection-history.ts";

interface ExternalStateFixture {
  root: string;
  stateDir: string;
  storeDir: string;
  projectRoot: string;
  gsdHomeDir: string;
}

/**
 * Build the external-state layout: the project's `.gsd` is a link into
 * `<GSD_STATE_DIR>/projects/<hash>/`, which is where gsd.db actually lives.
 */
function makeExternalStateProject(t: { after: (fn: () => void) => void }): ExternalStateFixture {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "gsd-external-state-")));
  const previousStateDir = process.env.GSD_STATE_DIR;
  const previousHome = process.env.GSD_HOME;
  // The store lives under GSD_STATE_DIR; GSD_HOME is the separate global home
  // that the walk must never mistake for a project projection root.
  const stateDir = join(root, "state");
  const gsdHomeDir = join(root, "home", ".gsd");
  const storeDir = join(stateDir, "projects", "abc123");
  const projectRoot = join(root, "repo");

  mkdirSync(storeDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(storeDir, "gsd.db"), "");
  // A `.gsd` only anchors path resolution once it looks bootstrapped
  // (worktree-root.ts hasGsdBootstrapArtifacts); a real store always is.
  writeFileSync(join(storeDir, "PREFERENCES.md"), "# Preferences\n");
  writeFileSync(
    join(storeDir, "repo-meta.json"),
    JSON.stringify({
      version: 1,
      hash: "abc123",
      gitRoot: projectRoot,
      remoteUrl: "https://example.invalid/repo.git",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  // Windows resolves a directory junction without elevation; POSIX takes the
  // plain symlink branch.
  symlinkSync(storeDir, join(projectRoot, ".gsd"), "junction");

  mkdirSync(gsdHomeDir, { recursive: true });
  process.env.GSD_STATE_DIR = stateDir;
  process.env.GSD_HOME = gsdHomeDir;
  t.after(() => {
    if (previousStateDir === undefined) delete process.env.GSD_STATE_DIR;
    else process.env.GSD_STATE_DIR = previousStateDir;
    if (previousHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  });

  return { root, stateDir, storeDir, projectRoot, gsdHomeDir };
}

// The walk looks for a path segment literally named ".gsd". Inside the store
// the segments are `<state>/projects/abc123/...`, so it never matches and keeps
// climbing to the GLOBAL gsd home, whose parent is the user profile. The create
// path then tries to lock the profile and fails with OS error 32 — every time,
// because the profile always has open handles.
test("resolves a projection inside an external-state store to the project root", (t) => {
  const { storeDir, projectRoot } = makeExternalStateProject(t);
  const projection = join(storeDir, "phases", "01-requirements", "01-PLAN.md");

  const target = managedProjectionTargetForTest(projection);

  assert.notEqual(target, null, "a projection inside the store must resolve to a managed target");
  assert.equal(target!.targetRoot, projectRoot);
});

// projectionDatabasePath never throws, so this one fails silently: the fence
// ends up guarding <gsdHome>/gsd.db, which means it cannot block writes to the
// real database AND every external-state project on the machine collapses onto
// a single shared claim key.
test("keys the maintenance fence on the store's own database", (t) => {
  const { storeDir } = makeExternalStateProject(t);
  const projection = join(storeDir, "phases", "01-requirements", "01-PLAN.md");

  assert.equal(projectionDatabasePathForTest(projection), join(storeDir, "gsd.db"));
});

// The boundary is anchored on the resolved projects root, not on the basename
// "projects" — otherwise any unrelated `<anything>/projects/<x>` would be
// treated as a store and stop the walk at the wrong directory.
test("does not treat an unrelated projects directory as a store", (t) => {
  const { root } = makeExternalStateProject(t);
  const impostorStore = join(root, "elsewhere", "projects", "abc123");
  mkdirSync(join(impostorStore, "phases"), { recursive: true });
  writeFileSync(join(impostorStore, "gsd.db"), "");

  assert.equal(projectionDatabasePathForTest(join(impostorStore, "phases", "01-PLAN.md")), null);
  assert.equal(managedProjectionTargetForTest(join(impostorStore, "phases", "01-PLAN.md")), null);
});

// repo-meta.json is advisory, never authoritative. If <gitRoot>/.gsd no longer
// resolves back to this store the repo was moved or copied, and guessing would
// point the projection-root lock at an unrelated directory.
test("refuses a store whose repo-meta no longer round-trips to it", (t) => {
  const { storeDir, projectRoot } = makeExternalStateProject(t);
  const otherStore = join(dirname(storeDir), "def456");
  mkdirSync(otherStore, { recursive: true });
  writeFileSync(join(otherStore, "gsd.db"), "");
  // Points at a project whose .gsd resolves to a DIFFERENT store.
  writeFileSync(
    join(otherStore, "repo-meta.json"),
    JSON.stringify({
      version: 1,
      hash: "def456",
      gitRoot: projectRoot,
      remoteUrl: "https://example.invalid/repo.git",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  );

  assert.equal(managedProjectionTargetForTest(join(otherStore, "phases", "01-PLAN.md")), null);
});

// Safety net for the create path: the global gsd home is not a project
// projection root. Its parent is the user profile, which can never be locked
// exclusively on Windows.
test("never treats the global gsd home as a project projection root", (t) => {
  const { gsdHomeDir } = makeExternalStateProject(t);
  writeFileSync(join(gsdHomeDir, "gsd.db"), "");

  const target = managedProjectionTargetForTest(join(gsdHomeDir, "phases", "01-PLAN.md"));

  assert.equal(
    target,
    null,
    `the gsd home's PARENT (${dirname(gsdHomeDir)}) must never become a projection target root`,
  );
});
