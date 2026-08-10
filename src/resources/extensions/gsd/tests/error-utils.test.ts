import test from "node:test";
import assert from "node:assert/strict";

import { getErrorMessage, getErrorMessageChain } from "../error-utils.ts";

test("getErrorMessageChain returns a lone message unchanged", () => {
  assert.equal(getErrorMessageChain(new Error("only layer")), "only layer");
});

test("getErrorMessageChain appends each cause layer in order", () => {
  const error = new Error("native projection root identity locking failed", {
    cause: new Error("os error 32 at createInitialProjectionDirectory"),
  });

  assert.equal(
    getErrorMessageChain(error),
    "native projection root identity locking failed: os error 32 at createInitialProjectionDirectory",
  );
});

test("getErrorMessageChain handles non-Error values at both ends", () => {
  assert.equal(getErrorMessageChain("plain string"), "plain string");
  assert.equal(getErrorMessage(42), "42");
  // A non-Error cause has no further `.cause` to walk, so it terminates the chain.
  assert.equal(getErrorMessageChain(new Error("wrapper", { cause: "raw reason" })), "wrapper: raw reason");
});

test("getErrorMessageChain ignores a nullish cause rather than printing it", () => {
  assert.equal(getErrorMessageChain(new Error("wrapper", { cause: undefined })), "wrapper");
  assert.equal(getErrorMessageChain(new Error("wrapper", { cause: null })), "wrapper");
});

test("getErrorMessageChain stops at maxDepth", () => {
  // 12 nested layers against the default cap of 8.
  let error = new Error("layer-11");
  for (let i = 10; i >= 0; i--) {
    error = new Error(`layer-${i}`, { cause: error });
  }

  assert.equal(
    getErrorMessageChain(error),
    "layer-0: layer-1: layer-2: layer-3: layer-4: layer-5: layer-6: layer-7",
  );
  assert.equal(getErrorMessageChain(error, 2), "layer-0: layer-1");
});

test("getErrorMessageChain terminates on a cyclic cause", () => {
  // `cause` is an ordinary writable property, so a cycle is reachable. Without
  // the seen-set this loops until maxDepth and repeats the same two layers.
  const inner = new Error("inner");
  const outer = new Error("outer", { cause: inner });
  (inner as { cause?: unknown }).cause = outer;

  assert.equal(getErrorMessageChain(outer), "outer: inner");
});
