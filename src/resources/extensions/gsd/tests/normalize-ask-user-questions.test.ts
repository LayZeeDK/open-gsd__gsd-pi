// Project/App: gsd-pi
// File Purpose: ask_user_questions payloads that are not arrays must not throw.
//
// Reported as:
//   Extension ".../gsd/index.js" error: questions.find is not a function
//     at extractGateQuestionId (.../gsd/bootstrap/register-hooks.js:630:29)
// which aborts the extension and with it the whole /gsd workflow. The stack's
// caller is the `event.args` site, i.e. the external-engine relay path.

import assert from "node:assert/strict";
import test from "node:test";

import { normalizeAskUserQuestions, selectAskUserQuestions } from "../bootstrap/register-hooks.ts";

test("passes an array through unchanged", () => {
  const questions = [{ id: "Q3", question: "Ship it?" }];

  assert.equal(normalizeAskUserQuestions(questions), questions);
});

test("treats nullish as no questions", () => {
  assert.deepEqual(normalizeAskUserQuestions(null), []);
  assert.deepEqual(normalizeAskUserQuestions(undefined), []);
});

// The likeliest source of a non-array: an engine relaying the tool-call
// arguments without parsing them.
test("recovers a JSON string that decodes to an array", () => {
  const questions = [{ id: "Q3", question: "Ship it?" }];

  assert.deepEqual(normalizeAskUserQuestions(JSON.stringify(questions)), questions);
});

test("returns no questions for shapes that cannot be recovered", () => {
  for (const value of ["not json", '{"id":"Q3"}', { id: "Q3" }, 42, true]) {
    assert.deepEqual(
      normalizeAskUserQuestions(value),
      [],
      `expected [] for ${JSON.stringify(value)}`,
    );
  }
});

test("takes the first candidate that carries questions", () => {
  const questions = [{ id: "Q3", question: "Ship it?" }];

  assert.deepEqual(selectAskUserQuestions(questions, [{ id: "Q9" }]), questions);
  assert.deepEqual(selectAskUserQuestions(null, undefined, questions), questions);
  assert.deepEqual(selectAskUserQuestions(null, undefined, undefined), []);
});

// The same `??`-catches-nullish-only trap as the crash below, one layer up: a
// non-array on the FIRST candidate must not consume the fallbacks. `?? `-ing
// the raw values before normalizing would stop at `{ id: "Q3" }` and hand back
// [], discarding the valid payload behind it.
test("a non-array candidate does not consume the later ones", () => {
  const questions = [{ id: "Q3", question: "Ship it?" }];

  for (const unusable of ["not json", '{"id":"Q3"}', { id: "Q3" }, 42, true]) {
    assert.deepEqual(
      selectAskUserQuestions(unusable, questions),
      questions,
      `expected the fallback to survive ${JSON.stringify(unusable)}`,
    );
  }
});

// The actual crash: `?? []` catches nullish only, so anything else reached
// .find() / for...of.
test("the downstream array operations are safe for every shape", () => {
  for (const value of [null, undefined, "not json", '{"id":"Q3"}', { id: "Q3" }, 42, true]) {
    const questions = normalizeAskUserQuestions(value);
    assert.doesNotThrow(() => questions.find((q) => typeof q?.id === "string"));
    assert.doesNotThrow(() => {
      for (const _ of questions) { /* iteration must not throw */ }
    });
  }
});
