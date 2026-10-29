import assert from "node:assert/strict";
import test from "node:test";
import { createModuleGraph } from "./helpers/jsx-tree.mjs";

const { canRepairMainProcessInjection, isMainProcessInjectionConfirmed } = createModuleGraph(
  new URL("../src/runtimeStatusPresentation.ts", import.meta.url),
).exports;
const failed = { running: true, clientPlatform: "windows", maintenance: { startupInjectionMode: "cli" } };

test("binary repair is offered only for a running Windows CLI fallback", () => {
  assert.equal(canRepairMainProcessInjection(failed), true);
  for (const mode of ["node_options", "inspector", "", undefined, "unknown"]) {
    assert.equal(canRepairMainProcessInjection({ ...failed, maintenance: { startupInjectionMode: mode } }), false, String(mode));
  }
  for (const patch of [{ running: false }, { clientPlatform: "macos" }, { clientPlatform: "linux" }, { clientPlatform: undefined }, { restartInProgress: true }, { maintenance: undefined }]) {
    assert.equal(canRepairMainProcessInjection({ ...failed, ...patch }), false);
  }
});

test("repair completion requires a running main-process injection marker", () => {
  for (const mode of ["node_options", "inspector"]) {
    assert.equal(isMainProcessInjectionConfirmed({ running: true, maintenance: { startupInjectionMode: mode } }), true);
    assert.equal(isMainProcessInjectionConfirmed({ running: false, maintenance: { startupInjectionMode: mode } }), false);
  }
  assert.equal(isMainProcessInjectionConfirmed(failed), false);
  assert.equal(isMainProcessInjectionConfirmed({ running: true }), false);
});
