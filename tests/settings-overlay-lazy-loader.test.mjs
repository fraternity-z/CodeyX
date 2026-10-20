import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { flushMicrotasks } from "./helpers/flush.mjs";
import vm from "node:vm";

const cdpSource = readFileSync(
  new URL("../backend/src/cdp.rs", import.meta.url),
  "utf8",
);
const loaderMatch = cdpSource.match(
  /fn lazy_settings_overlay_loader_script\(\) -> &'static str \{\s*r#"(.*?)"#\s*\}/s,
);
assert.ok(loaderMatch, "lazy settings overlay loader script must be discoverable");
const loaderScript = loaderMatch[1];

const flushPromises = flushMicrotasks;

test("settings overlay shares preloading with repeated clicks and opens once", async () => {
  let bridgeCalls = 0;
  let resolveLoad;
  const alerts = [];
  const realOverlay = {
    opened: 0,
    open() {
      this.opened += 1;
    },
    toggle() {
      throw new Error("open should be preferred");
    },
  };
  const window = {
    alert(message) {
      alerts.push(message);
    },
    __codexSessionDeleteBridge(path) {
      bridgeCalls += 1;
      assert.equal(path, "/internal/codey/settings-overlay/load");
      return new Promise((resolve) => {
        resolveLoad = () => {
          window.__codeySettingsOverlay = realOverlay;
          resolve({ status: "ok" });
        };
      });
    },
  };

  vm.runInNewContext(loaderScript, { Error, Promise, String, window });
  const proxy = window.__codeySettingsOverlay;
  assert.equal(proxy.__codeyLazyLoader, true);

  const preload = proxy.load();
  assert.equal(proxy.load(), preload);
  assert.equal(realOverlay.opened, 0);
  proxy.toggle();
  proxy.toggle();
  assert.equal(bridgeCalls, 1);
  resolveLoad();
  await flushPromises();

  assert.equal(window.__codeySettingsOverlay, realOverlay);
  assert.equal(realOverlay.opened, 1);
  assert.deepEqual(alerts, []);
});

test("settings overlay preloading does not open the panel before a click", async () => {
  let bridgeCalls = 0;
  const realOverlay = {
    opened: 0,
    open() { this.opened += 1; },
    toggle() {},
  };
  const window = {
    alert() { assert.fail("successful preload must not alert"); },
    async __codexSessionDeleteBridge() {
      bridgeCalls += 1;
      window.__codeySettingsOverlay = realOverlay;
      return { status: "ok" };
    },
  };
  vm.runInNewContext(loaderScript, { Error, Promise, String, window });
  const proxy = window.__codeySettingsOverlay;

  assert.equal(await proxy.load(), realOverlay);
  assert.equal(realOverlay.opened, 0);
  proxy.toggle();
  await flushPromises();

  assert.equal(bridgeCalls, 1);
  assert.equal(realOverlay.opened, 1);
});

test("settings overlay preload failures stay silent and allow clicking to retry", async () => {
  let bridgeCalls = 0;
  const alerts = [];
  const realOverlay = {
    opened: 0,
    open() { this.opened += 1; },
    toggle() {},
  };
  const window = {
    alert(message) { alerts.push(message); },
    async __codexSessionDeleteBridge() {
      bridgeCalls += 1;
      if (bridgeCalls === 1) throw new Error("preload failed");
      window.__codeySettingsOverlay = realOverlay;
      return { status: "ok" };
    },
  };
  vm.runInNewContext(loaderScript, { Error, Promise, String, window });
  const proxy = window.__codeySettingsOverlay;

  await assert.rejects(proxy.load(), /preload failed/);
  assert.deepEqual(alerts, []);
  proxy.toggle();
  await flushPromises();

  assert.equal(bridgeCalls, 2);
  assert.equal(realOverlay.opened, 1);
  assert.deepEqual(alerts, []);
});

test("settings overlay handles a missing bridge and synchronous bridge failures", async () => {
  for (const bridge of [undefined, () => { throw new Error("bridge threw"); }]) {
    const alerts = [];
    const window = {
      alert(message) { alerts.push(message); },
      __codexSessionDeleteBridge: bridge,
    };
    vm.runInNewContext(loaderScript, { Error, Promise, String, window });
    const proxy = window.__codeySettingsOverlay;
    await assert.rejects(proxy.load(), /bridge/);
    assert.deepEqual(alerts, []);

    proxy.toggle();
    await flushPromises();
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /bridge/);

    window.__codexSessionDeleteBridge = async () => {
      window.__codeySettingsOverlay = { toggle() {} };
      return { status: "ok" };
    };
    proxy.toggle();
    await flushPromises();
    assert.equal(alerts.length, 1);
    assert.notEqual(window.__codeySettingsOverlay, proxy);
  }
});

test("settings overlay loader reports a failure and permits a retry", async () => {
  let bridgeCalls = 0;
  const alerts = [];
  const realOverlay = {
    opened: 0,
    open() {
      this.opened += 1;
    },
    toggle() {},
  };
  const window = {
    alert(message) {
      alerts.push(message);
    },
    async __codexSessionDeleteBridge() {
      bridgeCalls += 1;
      if (bridgeCalls === 1) {
        return { status: "failed", message: "temporary failure" };
      }
      window.__codeySettingsOverlay = realOverlay;
      return { status: "ok" };
    },
  };

  vm.runInNewContext(loaderScript, { Error, Promise, String, window });
  const proxy = window.__codeySettingsOverlay;
  proxy.toggle();
  await flushPromises();

  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /temporary failure/);
  assert.equal(window.__codeySettingsOverlay, proxy);

  proxy.toggle();
  await flushPromises();

  assert.equal(bridgeCalls, 2);
  assert.equal(window.__codeySettingsOverlay, realOverlay);
  assert.equal(realOverlay.opened, 1);
});
