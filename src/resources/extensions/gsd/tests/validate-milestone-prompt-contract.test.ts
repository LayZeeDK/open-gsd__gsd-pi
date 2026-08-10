// Project/App: gsd-pi
// File Purpose: the validate-milestone prompt must describe the payload the
// gsd_validate_milestone tool actually accepts.
//
// The shipped prompt told the agent to put its verification results in a
// markdown table under `verificationClasses`. When planning declared any
// verification class, tools/validate-milestone.ts rejects exactly that:
//
//   planned <class> verification requires current structured database
//   evidence; verificationClasses prose cannot authorize Milestone validation
//
// It requires a structured `verificationEvidence[]` whose `testedSourceRevision`
// matches the current source revision, and the prompt named neither field. The
// agent could not satisfy the tool no matter how carefully it followed the
// instructions, so milestone validation could not complete.
//
// This is a contract test between two shipped artifacts -- the prompt and the
// tool's accepted payload -- so it asserts on the rendered prompt rather than
// on behaviour. It executes the real prompt loader, and it fails if either side
// drifts away from the other.

import assert from "node:assert/strict";
import test from "node:test";

import { loadPrompt } from "../prompt-loader.ts";

// loadPrompt refuses to render with an unsubstituted placeholder, so supply
// every variable the template declares. The values are irrelevant here.
const prompt = (): string => loadPrompt("validate-milestone", {
  milestoneId: "M001",
  milestoneTitle: "Test milestone",
  workingDirectory: "/tmp/project",
  remediationRound: "0",
  inlinedContext: "",
  gatesToEvaluate: "",
  roadmapPath: "/tmp/project/.gsd/phases/01-test/ROADMAP.md",
  validationPath: "/tmp/project/.gsd/phases/01-test/VALIDATION.md",
});

// Every field the tool requires when planning declared verification classes.
// The list is the non-Optional members of the verificationEvidence entry schema
// in bootstrap/db-tools.ts, which is `additionalProperties: false`: naming only
// some of them is how the prompt drifted while this test stayed green.
for (const field of [
  "verificationEvidence",
  "verificationClass",
  "evidenceClass",
  "rationale",
  "commandOrTool",
  "workingDirectory",
  "startedAt",
  "endedAt",
  "observation",
  "durableOutputRef",
  "testedSourceRevision",
  "environment",
]) {
  test(`instructs the agent to supply ${field}`, () => {
    assert.ok(
      prompt().includes(field),
      `validate-milestone.md must document \`${field}\`; the tool rejects the call without it`,
    );
  });
}

// The prose table is still accepted as a narrative companion, so the prompt
// should keep asking for it -- it just cannot be the authorization.
test("still asks for the verificationClasses table", () => {
  assert.ok(prompt().includes("verificationClasses"));
});

// The trap the prompt previously set: presenting the prose table as sufficient.
test("does not present the prose table as sufficient authorization", () => {
  const text = prompt();
  const claimsProseAuthorizes = /verificationClasses[^.]*\b(is|are) (?:all|sufficient|enough)\b/i.test(text);
  assert.equal(claimsProseAuthorizes, false, "the prose table must not be described as sufficient");
});

// The entry schema is `additionalProperties: false`, so the other half of the
// contract is what the prompt must NOT ask for. An invented field fails the
// call exactly as hard as a missing one, and reads far more plausibly: the
// prompt previously asked for a `summary` the tool has never accepted.
test("does not instruct a field the entry schema rejects", () => {
  const evidenceFields = new Set([
    "verificationClass", "sliceId", "evidenceClass", "rationale", "commandOrTool",
    "workingDirectory", "startedAt", "endedAt", "exitCode", "observation",
    "durableOutputRef", "testedSourceRevision", "environment",
  ]);
  // Keys of the JSON example the prompt gives for a verificationEvidence entry.
  // Parsed rather than regex-scanned so nested values (environment's own keys)
  // are not mistaken for entry fields.
  const text = prompt();
  const open = text.indexOf("```json");
  const body = text.slice(open + "```json".length, text.indexOf("```", open + 7));
  const entries = JSON.parse(body) as Array<Record<string, unknown>>;
  const keys = Object.keys(entries[0] ?? {});
  assert.ok(keys.length > 0, "expected a JSON evidence example in the prompt");

  const rejected = keys.filter((k) => !evidenceFields.has(k));
  assert.deepEqual(rejected, [], `the tool rejects these keys: ${rejected.join(", ")}`);
});

// Evidence must be captured BEFORE the reviewers are dispatched: it pins the
// source revision the tool compares against, and a revision captured after a
// long reviewer pass can already be stale.
test("orders evidence capture before reviewer dispatch", () => {
  const text = prompt();
  const evidenceAt = text.indexOf("verificationEvidence");
  const reviewerAt = text.search(/Reviewer A/);
  assert.ok(evidenceAt >= 0, "expected the prompt to mention verificationEvidence");
  assert.ok(reviewerAt >= 0, "expected the prompt to mention Reviewer A");
  assert.ok(
    evidenceAt < reviewerAt,
    "evidence capture must be described before reviewer dispatch, not after",
  );
});
