import assert from "node:assert/strict";
import test from "node:test";
import { createControllerHarness, installControllerWindow } from "./helpers/controller-harness.mjs";

for (const operation of ["repair", "restart"]) {
test(`starting ${operation} discards older status flights and queued injection refreshes`, async t => {
  let harness;
  t.after(() => harness?.unmount());
  installControllerWindow(t);
  const requests = [];
  harness = createControllerHarness(new URL("../src/features/runtime-status/useRuntimeStatusController.ts", import.meta.url), "useRuntimeStatusController", {
    "../../api": { invoke: () => new Promise((resolve) => requests.push(resolve)) },
  });
  harness.render({ active: true, embedded: false });
  requests.shift()({ running: true });
  const hook = await harness.flush();
  const oldFlight = hook.refreshStatus();
  const queuedRefresh = hook.refreshStatusForLoad();
  if (operation === "repair") {
    hook.markRestartInProgress();
  } else {
    const calls = [];
    let confirmation;
    const maintenance = createControllerHarness(new URL("../src/features/runtime-maintenance/useRuntimeMaintenanceController.ts", import.meta.url), "useRuntimeMaintenanceController", {
      "../../api": { invoke: async command => { calls.push(command); } },
    });
    maintenance.render({
      active: true, config: {}, dirty: false, isBusy: false, status: { running: true }, restartStatusError: null,
      setBusy: () => {}, setNotice: () => {}, setConfirmation: next => { confirmation = next; },
      setRestartStatusError: () => assert.fail("restart unexpectedly failed"),
      markRestartInProgress: hook.markRestartInProgress,
    }).askRestartCodex();
    confirmation.run();
    await maintenance.flush();
    assert.deepEqual(calls, ["restart_codey"]);
    maintenance.unmount();
  }
  assert.equal(harness.render().status.restartInProgress, true);
  const freshFlight = hook.refreshStatus();
  assert.equal(requests.length, 2);
  requests[0]({ running: true, restartInProgress: false });
  await Promise.all([oldFlight, queuedRefresh]);
  assert.equal(harness.render().status.restartInProgress, true, "old response must not end the repair");
  assert.equal(requests.length, 2, "stale queued refresh must not start");
  requests[1]({ running: true, restartInProgress: false, startupError: "修复失败，已恢复启动" });
  await freshFlight;
  const current = await harness.flush();
  assert.equal(current.status.restartInProgress, false);
  assert.equal(current.status.startupError, "修复失败，已恢复启动");
});
}
