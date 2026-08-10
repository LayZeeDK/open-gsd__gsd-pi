import { readdirSync } from "node:fs";

import { milestonesDir } from "./paths.js";

/** Matches both classic `M001` and unique `M001-abc123` formats (anchored). */
export const MILESTONE_ID_RE = /^M\d{3}(?:-[a-z0-9]{6})?$/;

/** Extract the trailing sequential number from a milestone ID. Returns 0 for non-matches. */
export function extractMilestoneSeq(id: string): number {
  const match = id.match(/^M(\d{3})(?:-[a-z0-9]{6})?$/);
  return match ? parseInt(match[1], 10) : 0;
}

/** Comparator for sorting milestone IDs by sequential number. */
export function milestoneIdSort(a: string, b: string): number {
  return extractMilestoneSeq(a) - extractMilestoneSeq(b);
}

export function findMilestoneIds(basePath: string): string[] {
  const dir = milestonesDir(basePath);
  try {
    // Deduplicated: two phase directories can map to one milestone id
    // (`01-a` and `1-b` both yield M001), and a duplicate entry would be
    // reported twice in "Available:" and make consumers that index the array
    // (files.ts `sorted.indexOf(mid)`) resolve to whichever came first.
    return [...new Set(readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        // Legacy layout: milestones/M001-slug/
        const legacyMatch = entry.name.match(/^(M\d+(?:-[a-z0-9]{6})?)/);
        if (legacyMatch) return legacyMatch[1];
        // Flat-phase layout: phases/NN-slug/. milestonesDir() returns phases/
        // for these projects, so without this branch the raw directory name
        // leaks out as if it were a milestone id and `/gsd next M003` reports
        // "Milestone M003 does not exist. Available: 01-requirements, 03-...".
        // The phase number maps 1:1 to the milestone number — this is the
        // inverse of layout-policy.ts milestoneIdToPhaseNum. Bounded at three
        // digits because MILESTONE_ID_RE accepts exactly three: a `0001-x`
        // directory would otherwise yield `M0001`, an id that fails the very
        // regex every consumer validates against.
        const phaseMatch = entry.name.match(/^(\d{1,3})-/);
        if (phaseMatch) return `M${phaseMatch[1].padStart(3, "0")}`;

        return entry.name;
      }))]
      .sort(milestoneIdSort);
  } catch {
    return [];
  }
}
