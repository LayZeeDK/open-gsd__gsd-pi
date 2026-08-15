import assert from "node:assert/strict";
import test from "node:test";

import {
  _openManagedProjectionRootWithRetryForTest,
  _persistMutationForTest,
} from "../managed-projection-history.ts";

/**
 * The prose beside `os error N` is OS-localized, so a pattern written against
 * the English text would pass here on an English host and never match in
 * production on this one.
 *
 * 5 and 183 are the captured Danish messages, ASCII-folded (the real 5 reads
 * `Adgang naegtet` with an ae ligature; 183 is pure ASCII already). The 32 case is
 * CONSTRUCTED: the captured `ERROR_SHARING_VIOLATION` failures also carry the
 * English "sharing violation" token, which the predicate matches on its own, so
 * without this nothing pins the numeric branch for the code this ladder was
 * built for.
 */
const CONTROL_FILE_RACE_MESSAGES = {
  5: "projection root operation failed: Adgang naegtet. (os error 5)",
  32: "projection root operation failed: Filen bruges af en anden proces. (os error 32)",
  183: "projection root operation failed: En fil, som allerede findes, kan ikke oprettes. (os error 183)",
} as const;

/**
 * `os error 5` also prefixes 53 (`ERROR_BAD_NETPATH`), 55 and 59; `os error 32`
 * prefixes 321 and `os error 183` prefixes 1832. Without a right boundary each
 * of those becomes silently retryable -- the case a careless widening breaks.
 */
const PREFIX_COLLIDING_MESSAGES = {
  53: "projection root operation failed: netvaerksstien blev ikke fundet (os error 53)",
  321: "projection root operation failed: noget helt andet (os error 321)",
  1832: "projection root operation failed: noget helt tredje (os error 1832)",
} as const;

/** The native wrapper nests the real cause, so the predicate must walk it. */
function nativeFailure(message: string): Error {
  return new Error("native projection root identity locking failed", {
    cause: new Error(message),
  });
}

function attemptsUntilThrow(message: string): { attempts: number; waits: number[] } {
  // Assert on identity, as the pre-existing tests below do: a bare
  // `assert.throws` also passes when the seam throws before reaching the ladder.
  const failure = nativeFailure(message);
  const waits: number[] = [];
  let attempts = 0;

  assert.throws(
    () => _openManagedProjectionRootWithRetryForTest(
      () => {
        attempts++;
        throw failure;
      },
      (delay) => waits.push(delay),
    ),
    (error: unknown) => error === failure,
  );

  return { attempts, waits };
}

for (const [code, message] of Object.entries(CONTROL_FILE_RACE_MESSAGES)) {
  test(`a Windows control-file race (os error ${code}) is transient through a cause chain`, () => {
    const { attempts, waits } = attemptsUntilThrow(message);

    assert.equal(attempts, 5, "the full ladder is spent before the error surfaces");
    assert.deepEqual(waits, [5, 10, 20, 40]);
  });
}

for (const [code, message] of Object.entries(PREFIX_COLLIDING_MESSAGES)) {
  test(`os error ${code} shares a transient prefix but is not retried`, () => {
    const { attempts, waits } = attemptsUntilThrow(message);

    assert.equal(attempts, 1, "a permanent error must surface on the first attempt");
    assert.deepEqual(waits, []);
  });
}

test("persisting a projection mutation retries a transient control-file race", () => {
  // The observed failure is a write made while the lock is already HELD, which
  // the acquisition retry never covered. Real delays, so no seam has to be
  // threaded through production code for this; the ladder's timings are already
  // pinned four times through the seam above.
  const writes: [string, Buffer][] = [];

  _persistMutationForTest(
    {
      writeFile: (path: string, content: Buffer) => {
        writes.push([path, content]);
        if (writes.length < 3) throw nativeFailure(CONTROL_FILE_RACE_MESSAGES[5]);
      },
    },
    { journalPath: "/tmp/root/.gsd/migration/projection-mutations/entry.json" },
  );

  assert.equal(writes.length, 3, "the write is retried, not surfaced");
  // NOT asserted here: that every attempt presents identical bytes. `path` and
  // `content` are consts pushed by reference, so any such check compares a value
  // to itself and holds even if they were recomputed per attempt. The property is
  // real and load-bearing -- see `persistMutation` -- but it is structural, and a
  // test that cannot fail is worse than no test.
});

test("managed projection root acquisition retries transient lock failures with exponential backoff", () => {
  const waits: number[] = [];
  let attempts = 0;

  const result = _openManagedProjectionRootWithRetryForTest(
    () => {
      attempts++;
      if (attempts < 3) {
        throw new Error("native projection root identity locking failed", {
          cause: new Error("projection root operation failed: sharing violation (os error 32)"),
        });
      }
      return "acquired";
    },
    (delay) => waits.push(delay),
  );

  assert.equal(result, "acquired");
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [5, 10]);
});

test("managed projection root acquisition stops after the bounded retry budget", () => {
  const waits: number[] = [];
  let attempts = 0;
  const failure = new Error("native projection root identity locking failed", {
    cause: new Error("projection root is busy"),
  });

  assert.throws(
    () => _openManagedProjectionRootWithRetryForTest(
      () => {
        attempts++;
        throw failure;
      },
      (delay) => waits.push(delay),
    ),
    (error: unknown) => error === failure,
  );
  assert.equal(attempts, 5);
  assert.deepEqual(waits, [5, 10, 20, 40]);
});

test("managed projection root acquisition does not retry permanent identity failures", () => {
  const waits: number[] = [];
  let attempts = 0;
  const failure = new Error("native projection root identity locking failed", {
    cause: new Error("projection root identity changed"),
  });

  assert.throws(
    () => _openManagedProjectionRootWithRetryForTest(
      () => {
        attempts++;
        throw failure;
      },
      (delay) => waits.push(delay),
    ),
    (error: unknown) => error === failure,
  );
  assert.equal(attempts, 1);
  assert.deepEqual(waits, []);
});
