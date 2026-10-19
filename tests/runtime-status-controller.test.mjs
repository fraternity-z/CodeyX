import assert from "node:assert/strict";
import test from "node:test";
import { createControllerHarness, deferred } from "./helpers/controller-harness.mjs";
import { createModuleGraph } from "./helpers/jsx-tree.mjs";
import { loadTypeScriptModule } from "./helpers/load-typescript-module.mjs";

const feature = new URL("../src/features/runtime-status/", import.meta.url);
const state = await loadTypeScriptModule(new URL("state.ts", feature));

function fixture(t, { active = true, embedded = false } = {}) {
  const previousWindow = globalThis.window;
  const events = new EventTarget();
  const timers = new Map();
  const requests = [];
  let now = 0, nextId = 0;
  t.mock.method(Date, "now", () => now);
  globalThis.window = Object.assign(events, {
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  const harness = createControllerHarness(new URL("useRuntimeStatusController.ts", feature), "useRuntimeStatusController", {
    "../../api": { invoke(command, args) {
      assert.equal(command, "runtime_status");
      const result = deferred();
      requests.push({ ...result, args });
      return result.promise;
    } },
  });
  let options = { active, embedded };
  const render = (next = {}) => { options = { ...options, ...next }; return harness.render(options); };
  t.after(() => {
    harness.unmount();
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  });
  render();
  return {
    ...harness, render, requests, timers, errors,
    dispatch(name) { events.dispatchEvent(new Event(name)); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id); now = timer.at; timer.callback();
        await harness.flush();
      }
      now = end;
      return harness.flush();
    },
    async settle(value = { running: true }, index = requests.length - 1) {
      requests[index].resolve(value);
      return harness.flush();
    },
    get writesAfterUnmount() { return harness.writesAfterUnmount; },
  };
}

test("运行状态请求合并普通读取，注入刷新在普通读取后仅排队一次", async t => {
  const h = fixture(t);
  assert.deepEqual(h.requests[0].args, { refreshInjectionStatus: true });
  const initial = h.render().refreshStatus();
  const initialLoad = h.render().refreshStatusForLoad();
  assert.equal(h.requests.length, 1);
  await h.settle();
  await Promise.all([initial, initialLoad]);

  const normal = h.render().refreshStatus();
  assert.equal(h.render().refreshStatus(), normal);
  const injection = h.render().refreshStatusForLoad();
  const repeatedLoad = h.render().refreshStatusForLoad();
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[1].args, { refreshInjectionStatus: false });
  await h.settle({ running: true, appVersion: "old" }, 1);
  assert.equal(h.requests.length, 3);
  assert.deepEqual(h.requests[2].args, { refreshInjectionStatus: true });
  await h.settle({ running: true, appVersion: "current" }, 2);
  await Promise.all([normal, injection, repeatedLoad]);
  assert.equal(h.render().status.appVersion, "current");
  assert.equal(h.timers.size, 0);
});

test("普通读取失败仍执行排队的注入刷新，失败不清空当前状态", async t => {
  const h = fixture(t);
  await h.settle({ running: true, appVersion: "saved" });
  const normal = h.render().refreshStatus();
  const failed = assert.rejects(normal, /offline/);
  const injection = h.render().refreshStatusForLoad();
  h.requests[1].reject(new Error("offline"));
  await failed;
  await h.flush();
  assert.equal(h.render().status.appVersion, "saved");
  assert.equal(h.requests.length, 3);
  await h.settle({ running: true, appVersion: "recovered" });
  await injection;
  assert.equal(h.render().status.appVersion, "recovered");
});

test("隐藏时不读取，早于 React 提交的打开事件由激活刷新接续", async t => {
  const h = fixture(t, { active: false, embedded: true });
  h.dispatch(state.SETTINGS_OPENED_EVENT);
  h.dispatch("codey-injection-status-changed");
  assert.equal(await h.render().refreshStatusForLoad(), null, "暂停读取不能把默认状态当作已确认状态");
  h.render().markRestartInProgress();
  assert.equal(h.requests.length, 0);
  assert.equal(h.timers.size, 0);
  h.render({ active: true });
  assert.equal(h.requests.length, 1);
  const load = h.render().refreshStatusForLoad();
  h.dispatch(state.SETTINGS_OPENED_EVENT);
  assert.equal(h.requests.length, 1);
  await h.settle({ running: true, appVersion: "visible" });
  await load;
  const nextLoad = h.render().refreshStatusForLoad();
  assert.deepEqual(h.requests[1].args, { refreshInjectionStatus: false });
  await h.settle();
  await nextLoad;
});

for (const outcome of ["success", "error"]) {
  test(`隐藏重开后旧 ${outcome} 与清理回调不覆盖新请求`, async t => {
    const h = fixture(t);
    await h.settle({ running: true, appVersion: "baseline" });
    const old = h.render().refreshStatus();
    const oldResult = old.catch(() => undefined);
    const queued = h.render().refreshStatusForLoad().catch(() => undefined);
    h.render({ active: false });
    assert.equal(h.timers.size, 0);
    h.dispatch(state.SETTINGS_OPENED_EVENT);
    assert.equal(h.requests.length, 2);
    h.render({ active: true });
    const fresh = h.render().refreshStatus();
    assert.equal(h.requests.length, 3);
    if (outcome === "success") h.requests[1].resolve({ running: false, appVersion: "stale" });
    else h.requests[1].reject(new Error("stale failure"));
    await Promise.all([oldResult, queued]);
    await h.flush();
    assert.equal(h.render().status.appVersion, "baseline");
    assert.equal(h.render().refreshStatus(), fresh, "旧 finally 不得清除当前 flight");
    assert.equal(h.requests.length, 3, "失效的排队刷新不得发出请求");
    await h.settle({ running: true, appVersion: "fresh" });
    await fresh;
    assert.equal(h.render().status.appVersion, "fresh");
    assert.deepEqual(h.errors, []);
  });
}

test("当前后台读取错误只输出固定提示，过期错误保持静默", async t => {
  const h = fixture(t);
  h.requests[0].reject(new Error("mock-private-value"));
  await h.flush();
  assert.deepEqual(h.errors, [["Codey 运行状态刷新失败，请重新查询"]]);
  h.errors.length = 0;
  h.dispatch("codey-injection-status-changed");
  h.render({ active: false });
  h.requests[1].reject(new Error("stale"));
  await h.flush();
  assert.deepEqual(h.errors, []);
});

for (const outcome of ["success", "error"]) {
  test(`加载调用不向应用返回隐藏期间迟到的 ${outcome}`, async t => {
    const h = fixture(t);
    const oldLoad = h.render().refreshStatusForLoad();
    h.render({ active: false });
    if (outcome === "success") h.requests[0].resolve({ running: true, startupError: "旧启动错误" });
    else h.requests[0].reject(new Error("旧查询错误"));
    assert.equal(await oldLoad, null);
    assert.deepEqual(h.errors, []);
    h.render({ active: true });
    const currentLoad = h.render().refreshStatusForLoad();
    await h.settle({ running: true, appVersion: "fresh" });
    assert.deepEqual(await currentLoad, { running: true, appVersion: "fresh" });
  });
}

test("当前加载错误保留原有失败语义并可再次读取", async t => {
  const h = fixture(t);
  const failed = assert.rejects(h.render().refreshStatusForLoad(), /当前查询失败/);
  h.requests[0].reject(new Error("当前查询失败"));
  await failed;
  const retry = h.render().refreshStatusForLoad();
  await h.settle();
  assert.deepEqual(await retry, { running: true });
  assert.equal(h.timers.size, 0);
});

test("查询超时可重试，迟到响应不能改写重试结果", async t => {
  const h = fixture(t);
  await h.settle({ running: true, appVersion: "baseline" });
  const pending = h.render().refreshStatus();
  const rejected = assert.rejects(pending, /运行状态查询超时/);
  await h.advance(10_000);
  await rejected;
  assert.equal(h.timers.size, 0);
  const retry = h.render().refreshStatus();
  await h.settle({ running: true, appVersion: "retry" });
  await retry;
  await h.settle({ running: false, appVersion: "late" }, 1);
  assert.equal(h.render().status.appVersion, "retry");
});

test("卸载清理监听与所有定时器，迟到响应和保留的动作不会回写", async t => {
  const h = fixture(t);
  const actions = h.render();
  actions.setStatus({ running: true, restartInProgress: true });
  h.render();
  assert.ok(h.timers.size > 0);
  h.unmount();
  assert.equal(h.timers.size, 0);
  h.dispatch(state.SETTINGS_OPENED_EVENT);
  h.dispatch("codey-injection-status-changed");
  await actions.refreshStatus();
  actions.markRestartInProgress();
  await h.settle({ running: false });
  assert.equal(h.requests.length, 1);
  assert.equal(h.writesAfterUnmount, 0);
  assert.deepEqual(h.errors, []);
});

test("重启轮询在有界失败后提示未知，手动查询恢复确认且重复标记可继续轮询", async t => {
  const h = fixture(t);
  await h.settle();
  h.render().markRestartInProgress();
  h.render().markRestartInProgress();
  h.render();
  for (const delay of [500, 1000, 2000, 4000, 5000]) {
    await h.advance(delay);
    h.requests.at(-1).reject(new Error("disconnected"));
    await h.flush();
  }
  assert.equal(h.requests.length, 6);
  assert.match(h.render().restartStatusError, /重新查询状态/);
  assert.equal(h.render().status.restartInProgress, true);
  assert.equal(h.timers.size, 0);
  const retry = h.render().refreshStatus();
  await h.settle({ running: true, restartInProgress: false });
  await retry;
  assert.equal(h.render().restartStatusError, null);
  assert.equal(h.render().status.restartInProgress, false);
});

test("内置注入与重启探测共享轮询，完成后清理，重开仍待确认时继续探测", async t => {
  const h = fixture(t);
  const pending = { running: true, restartInProgress: true,
    injectionScripts: [{ source: "builtin", status: "executed" }] };
  await h.settle(pending);
  await h.advance(500);
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[1].args, { refreshInjectionStatus: true });
  h.render({ active: false });
  assert.equal(h.timers.size, 0);
  h.render({ active: true });
  await h.settle(pending);
  await h.advance(500);
  assert.equal(h.requests.length, 4);
  await h.settle({ running: true, restartInProgress: false,
    injectionScripts: [{ source: "builtin", status: "effective" }] });
  await h.settle(pending, 1);
  assert.equal(h.render().status.restartInProgress, false);
  assert.equal(h.timers.size, 0);
});

test("纯探测规则忽略用户脚本与已结束状态，任务时间由调用方传入", () => {
  assert.equal(state.hasPendingBuiltinInjection({ running: false }), false);
  assert.equal(state.hasPendingBuiltinInjection({ injectionScripts: [] }), false);
  assert.equal(state.hasPendingBuiltinInjection({ injectionScripts: [{ source: "user", status: "executed" }] }), false);
  for (const status of ["effective", "failed", "unknown"]) {
    assert.equal(state.hasPendingBuiltinInjection({ injectionScripts: [{ source: "builtin", status }] }), false);
  }
  assert.equal(state.hasPendingBuiltinInjection({ injectionScripts: [{ source: "builtin", status: "executed" }] }), true);
  const task = state.createStatusPollTask({ kind: "restart", delays: [500], pending: () => true, refreshesInjectionStatus: false }, 1000, 25);
  assert.deepEqual([task.deadline, task.nextAt, task.delayIndex, task.errors], [1025, 525, 0, 0]);
});

test("旧 hook 入口保持兼容，功能公开入口不暴露内部调度或请求", () => {
  const graph = createModuleGraph(new URL("index.ts", feature));
  assert.deepEqual(Object.keys(graph.exports).sort(), ["SETTINGS_OPENED_EVENT", "useRuntimeStatusController"]);
  const legacy = createModuleGraph(new URL("../src/useRuntimeStatus.ts", import.meta.url));
  assert.equal(typeof legacy.exports.useRuntimeStatus, "function");
  assert.equal(legacy.exports.SETTINGS_OPENED_EVENT, state.SETTINGS_OPENED_EVENT);
});

test("后台配置应用复用状态轮询，旧读取不会提前结束，新版本完成后停止", async t => {
  const h = fixture(t); await h.settle();
  const application = { settingsRevision: 2, phase: "pending" };
  h.render().setStatus({ running: true, configApply: application, restartRequired: false }); h.render();
  await h.advance(500);
  await h.settle({ running: true, configApply: { settingsRevision: 1, phase: "restart_required" }, restartRequired: true });
  assert.deepEqual(h.render().status.configApply, application);
  assert.equal(h.render().status.restartRequired, false);
  await h.advance(1_000);
  assert.equal(h.requests.length, 3);
  await h.settle({ running: true, configApply: { settingsRevision: 2, phase: "applying" } });
  h.render({ active: false }); assert.equal(h.timers.size, 0);
  h.render({ active: true });
  await h.settle({ running: true, configApply: { settingsRevision: 2, phase: "failed", applyError: "测试" } });
  assert.equal(h.timers.size, 0);
  assert.equal(h.render().status.configApply.phase, "failed");
});

test("配置状态不接受同版本倒退，轮询失败有界并保留已保存状态", async t => {
  const settled = { running: true, configApply: { settingsRevision: 2, phase: "applied" } };
  assert.deepEqual(state.reconcileRuntimeStatus(settled, { running: true, configApply: { settingsRevision: 2, phase: "pending" } }).configApply, settled.configApply);
  const h = fixture(t);
  await h.settle({ running: true, configApply: { settingsRevision: 3, phase: "pending" } });
  for (const delay of [500, 1_000, 2_000, 2_000, 2_000]) {
    await h.advance(delay); h.requests.at(-1).reject(new Error("offline")); await h.flush();
  }
  assert.match(h.render().restartStatusError, /配置已保存.*无法确认/);
  assert.equal(h.render().status.configApply.settingsRevision, 3);
  assert.equal(h.timers.size, 0);
  const retry = h.render().refreshStatus();
  await h.settle({ running: true, configApply: { settingsRevision: 3, phase: "applying" } }); await retry;
  assert.equal(h.render().restartStatusError, null);
  await h.advance(500);
  await h.settle({ running: true, configApply: { settingsRevision: 3, phase: "applied" } });
  assert.equal(h.timers.size, 0);
});
