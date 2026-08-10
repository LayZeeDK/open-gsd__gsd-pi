// Project/App: gsd-pi
// File Purpose: Recognize external-state store directories so projection-root
// walks stop at the store instead of escaping to the global gsd home.
//
// In the external-state layout a project's `.gsd` is a link into
// `<GSD_STATE_DIR|~/.gsd>/projects/<hash>/`. A directory walk that looks for a
// path segment literally named `.gsd` never matches that store, so it keeps
// climbing until it reaches the GLOBAL `~/.gsd` — whose parent is the user
// profile. Everything downstream then targets the wrong root.
//
// Kept dependency-light on purpose: this is imported by
// database-maintenance-fence.ts, which sits on the projection-write hot path,
// so it must not drag in the logging/audit graph.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { gsdHome } from "./gsd-home.js";
import type { RepoMeta } from "./repo-identity.js";

/**
 * Compare two paths as the same filesystem location.
 *
 * realpath FIRST, matching every sibling guard in this codebase (repo-identity
 * normalizeForGuard, paths normCacheKey). A plain resolve() does not expand
 * Windows 8.3 short names (C:\Users\LARSGY~1) or fold case on case-insensitive
 * volumes, either of which would silently defeat the comparison.
 */
export function isSameFilesystemPath(a: string, b: string): boolean {
  const normalize = (path: string): string => {
    let resolved: string;
    try {
      resolved = realpathSync.native(path);
    } catch {
      resolved = resolve(path);
    }
    const unified = resolved.replaceAll("\\", "/").replace(/\/+$/, "");

    return process.platform === "win32" ? unified.toLocaleLowerCase("en-US") : unified;
  };

  return normalize(a) === normalize(b);
}

/**
 * True when `directory` is an external-state store.
 *
 * A directory sitting directly under the REAL projects root IS a store, by
 * construction. Anchored on the resolved root rather than on the basename
 * "projects", so an unrelated `<anything>/projects/<x>` cannot impersonate one.
 */
export function isExternalStateStore(directory: string): boolean {
  const projectsRoot = join(process.env.GSD_STATE_DIR || gsdHome(), "projects");

  return isSameFilesystemPath(dirname(directory), projectsRoot);
}

/**
 * Recover the project root that an external-state store belongs to, or null.
 *
 * The store's own `repo-meta.json` records the git root, but it is treated as
 * ADVISORY: the answer is accepted only if `<gitRoot>/.gsd` resolves back to
 * this very store. A stale, copied, moved, or remotely-changed repo therefore
 * yields null instead of pointing the lock and write root somewhere else — or
 * throwing ENOENT out of a caller that has no try/catch anywhere up its chain.
 */
export function externalStateProjectRoot(directory: string): string | null {
  if (!existsSync(join(directory, "gsd.db"))) return null;

  let meta: Partial<RepoMeta> | null;
  try {
    meta = JSON.parse(readFileSync(join(directory, "repo-meta.json"), "utf-8")) as Partial<RepoMeta>;
  } catch {
    return null;
  }

  if (typeof meta?.gitRoot !== "string" || !isAbsolute(meta.gitRoot)) return null;

  let resolved: string;
  try {
    resolved = realpathSync.native(join(meta.gitRoot, ".gsd"));
  } catch {
    return null;
  }

  return isSameFilesystemPath(resolved, directory) ? meta.gitRoot : null;
}
