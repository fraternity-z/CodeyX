import assert from "node:assert/strict";
import test from "node:test";
import { createControllerHarness } from "./helpers/controller-harness.mjs";

function fixture() {
  return createControllerHarness(new URL("../src/useOperationScope.ts", import.meta.url), "useOperationScope", {});
}

test("operation scopes invalidate reads and keep writes locked across hide/reopen", () => {
  const h = fixture();
  const scope = h.render(true);
  const read = scope.read();
  assert.equal(read(), true);
  scope.invalidateReads();
  assert.equal(read(), false);
  const operation = scope.begin();
  assert.equal(operation.current(), true);
  assert.equal(scope.read()(), false);
  assert.equal(scope.begin(), null);
  h.render(false);
  assert.equal(operation.current(), false);
  assert.equal(scope.begin(), null);
  assert.equal(h.render(true), scope);
  assert.equal(scope.pending, true);
  assert.equal(operation.current(), false);
  assert.equal(operation.finish(), true);
  assert.equal(operation.current(), false);
  const next = scope.begin();
  assert.equal(operation.finish(), false);
  assert.equal(scope.pending, true);
  assert.equal(next.current(), true);
  h.unmount();
  assert.equal(next.current(), false);
  assert.equal(next.finish(), false);
  assert.equal(scope.begin(), null);
  assert.equal(scope.read()(), false);
});

test("inactive scopes cannot read or write until activated", () => {
  const h = fixture();
  const scope = h.render(false);
  const old = scope.read();
  assert.equal(old(), false);
  assert.equal(scope.begin(), null);
  h.render(true);
  assert.equal(old(), false);
  assert.equal(scope.read()(), true);
  h.unmount();
});
