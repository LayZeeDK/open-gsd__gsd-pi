// Project/App: gsd-pi
// File Purpose: STATE.md is the whole-project projection, so no writer may
// rebuild it from a GSD_MILESTONE_LOCK derivation -- that derivation sees one
// milestone and would persist a truncated registry, and a scope-local blocker,
// as project state. Guards both writers: saveStateProjection (doctor.ts, used by
// rebuildState / updateStateFile / the guided-flow pre-dispatch rebuilds) and
// renderStateProjection (workflow-projections.ts, reached from
// complete-task/complete-slice on every unit in auto mode).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildStateMarkdown, saveStateProjection } from '../doctor.ts';
import { renderStateProjection } from '../workflow-projections.ts';
import { closeDatabase, insertMilestone, insertSlice, openDatabase } from '../gsd-db.ts';
import { invalidateStateCache } from '../state.ts';
import type { GSDState } from '../types.ts';

const SENTINEL = '# GSD State\n\nthis file is the unscoped project projection\n';

function createFixtureBase(options: { withStateFile?: boolean } = {}): string {
  const base = mkdtempSync(join(tmpdir(), 'gsd-scoped-state-'));
  mkdirSync(join(base, '.gsd', 'milestones'), { recursive: true });
  if (options.withStateFile !== false) {
    writeFileSync(join(base, '.gsd', 'STATE.md'), SENTINEL);
  }
  return base;
}

function readState(base: string): string {
  return readFileSync(join(base, '.gsd', 'STATE.md'), 'utf-8');
}

// A hand-built scoped state: what deriveState returns under
// GSD_MILESTONE_LOCK=M002 -- one registry entry, the rest of the project gone.
function scopedState(): GSDState {
  return {
    activeMilestone: { id: 'M002', title: 'Second' },
    activeSlice: null,
    activeTask: null,
    phase: 'pre-planning',
    recentDecisions: [],
    blockers: [],
    nextAction: 'Plan milestone M002.',
    registry: [{ id: 'M002', title: 'Second', status: 'active' }],
    requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
    progress: { milestones: { done: 0, total: 1 } },
  } as GSDState;
}

describe('state projection scoped-write guard', () => {
  test('saveStateProjection declines to write STATE.md under a milestone lock', async () => {
    const base = createFixtureBase();
    const prevLock = process.env.GSD_MILESTONE_LOCK;
    try {
      process.env.GSD_MILESTONE_LOCK = 'M002';

      const wrote = await saveStateProjection(base, scopedState());

      assert.equal(wrote, false, 'locked: reports the write was skipped');
      assert.equal(readState(base), SENTINEL, 'locked: STATE.md is byte-identical');
    } finally {
      if (prevLock === undefined) delete process.env.GSD_MILESTONE_LOCK;
      else process.env.GSD_MILESTONE_LOCK = prevLock;
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('saveStateProjection writes STATE.md with no milestone lock set', async () => {
    const base = createFixtureBase();
    const prevLock = process.env.GSD_MILESTONE_LOCK;
    try {
      delete process.env.GSD_MILESTONE_LOCK;

      const state = scopedState();
      const wrote = await saveStateProjection(base, state);

      assert.equal(wrote, true, 'unlocked: reports the write happened');
      assert.equal(readState(base), buildStateMarkdown(state), 'unlocked: STATE.md is the rendered state');
    } finally {
      if (prevLock === undefined) delete process.env.GSD_MILESTONE_LOCK;
      else process.env.GSD_MILESTONE_LOCK = prevLock;
      rmSync(base, { recursive: true, force: true });
    }
  });

  // An empty-string lock is what an unset-but-exported env var looks like;
  // getRequestedMilestoneLock treats it as absent, so the write must proceed.
  test('saveStateProjection treats an empty milestone lock as no lock', async () => {
    const base = createFixtureBase();
    const prevLock = process.env.GSD_MILESTONE_LOCK;
    try {
      process.env.GSD_MILESTONE_LOCK = '   ';

      const wrote = await saveStateProjection(base, scopedState());

      assert.equal(wrote, true, 'blank lock: the write proceeds');
      assert.notEqual(readState(base), SENTINEL, 'blank lock: STATE.md was rewritten');
    } finally {
      if (prevLock === undefined) delete process.env.GSD_MILESTONE_LOCK;
      else process.env.GSD_MILESTONE_LOCK = prevLock;
      rmSync(base, { recursive: true, force: true });
    }
  });

  // An absent STATE.md holds nothing worth protecting, and callers exist purely
  // to create it (doctor's state_file_missing fix, doctor-proactive's
  // pre-dispatch rebuild). Declining there would leave the file missing for a
  // whole scoped run, so the guard must be exists-conditional, not lock-only.
  test('saveStateProjection still creates an absent STATE.md under a milestone lock', async () => {
    const base = createFixtureBase({ withStateFile: false });
    const prevLock = process.env.GSD_MILESTONE_LOCK;
    try {
      process.env.GSD_MILESTONE_LOCK = 'M002';

      const state = scopedState();
      const wrote = await saveStateProjection(base, state);

      assert.equal(wrote, true, 'locked+absent: reports the write happened');
      assert.equal(readState(base), buildStateMarkdown(state), 'locked+absent: STATE.md was created');
    } finally {
      if (prevLock === undefined) delete process.env.GSD_MILESTONE_LOCK;
      else process.env.GSD_MILESTONE_LOCK = prevLock;
      rmSync(base, { recursive: true, force: true });
    }
  });

  // renderStateProjection derives internally, so the lock check has to sit ahead
  // of its DB probe. The DB and milestone rows are what make the suppression
  // load-bearing: without them the pre-guard code returned early at
  // `!isDbAvailable()` and wrote nothing either, so the sentinel assertion would
  // pass with or without the fix.
  test('renderStateProjection declines to write STATE.md under a milestone lock', async () => {
    const base = createFixtureBase();
    const prevLock = process.env.GSD_MILESTONE_LOCK;
    try {
      openDatabase(':memory:');
      insertMilestone({ id: 'M001', title: 'First', status: 'complete' });
      insertMilestone({ id: 'M002', title: 'Second', status: 'planned', depends_on: ['M001'] });
      insertSlice({ id: 'S01', milestoneId: 'M002', title: 'First Slice' });

      process.env.GSD_MILESTONE_LOCK = 'M002';
      invalidateStateCache();

      const result = await renderStateProjection(base);

      assert.deepStrictEqual(result, { stale: false }, 'locked: a deliberate skip is not staleness');
      assert.equal(readState(base), SENTINEL, 'locked: STATE.md is byte-identical');

      closeDatabase();
    } finally {
      if (prevLock === undefined) delete process.env.GSD_MILESTONE_LOCK;
      else process.env.GSD_MILESTONE_LOCK = prevLock;
      invalidateStateCache();
      closeDatabase();
      rmSync(base, { recursive: true, force: true });
    }
  });

  // The counterpart: with no lock the same fixture must still project, so the
  // guard above is proven to be the lock and not the fixture.
  test('renderStateProjection writes STATE.md with no milestone lock set', async () => {
    const base = createFixtureBase({ withStateFile: false });
    const prevLock = process.env.GSD_MILESTONE_LOCK;
    try {
      delete process.env.GSD_MILESTONE_LOCK;

      openDatabase(':memory:');
      insertMilestone({ id: 'M001', title: 'First', status: 'complete' });
      insertMilestone({ id: 'M002', title: 'Second', status: 'planned', depends_on: ['M001'] });
      insertSlice({ id: 'S01', milestoneId: 'M002', title: 'First Slice' });

      invalidateStateCache();

      const result = await renderStateProjection(base);

      assert.deepStrictEqual(result, { stale: false }, 'unlocked: projection rendered');
      assert.ok(existsSync(join(base, '.gsd', 'STATE.md')), 'unlocked: STATE.md was written');
      assert.ok(readState(base).includes('M001'), 'unlocked: the whole-project registry is present');

      closeDatabase();
    } finally {
      if (prevLock === undefined) delete process.env.GSD_MILESTONE_LOCK;
      else process.env.GSD_MILESTONE_LOCK = prevLock;
      invalidateStateCache();
      closeDatabase();
      rmSync(base, { recursive: true, force: true });
    }
  });
});
