import assert from "node:assert/strict";
import test from "node:test";
import { createControllerHarness, deferred } from "./helpers/controller-harness.mjs";

const config = (patch = {}) => ({ settingsRevision: 1, localRouterEnabled: true,
  activeProfileId: "route", profiles: [{ id: "route", authMode: "apiKey" }],
  selectedModelsByProvider: { route: ["m1"] }, streamMaxRetries: 2, ...patch });
const models = (patch = {}) => ({ officialModels: [], officialModelIds: [], thirdPartyModels: ["m1"],
  manualThirdPartyModels: [], upstreamModels: ["m1"], defaultModel: "m1", ...patch });

function fixture(t) {
  const calls = [], notices = [];
  let status = {};
  const owner = createControllerHarness(new URL("../src/useDraftConfig.ts", import.meta.url), "useDraftConfig");
  owner.render().setPersistedConfig(config());
  const h = createControllerHarness(new URL("../src/useModelSelection.ts", import.meta.url), "useModelSelection", {
    "./api": { invoke(command, args) { const call = { command, args, ...deferred() }; calls.push(call); return call.promise; } },
    "./subagentModels": { buildSubagentModelOptions: () => [] },
  });
  const render = () => {
    const draft = owner.render();
    return h.render({ config: draft.config, adoptRouteConfig: draft.adoptRouteConfig, setDirty: draft.setDirty,
      currentProvider: null, officialAccountAvailable: false, runOperation: async (_name, action) => action(),
      setStatus(update) { status = update(status); }, setNotice: notice => notices.push(notice) });
  };
  render().openModelPicker(models(), "", "route");
  t.after(() => { h.unmount(); owner.unmount(); });
  return { ...h, render, owner, calls, notices, get status() { return status; },
    resolve(patch = {}) { calls.at(-1).resolve({ config: config({ settingsRevision: 2 }), modelState: models(), ...patch }); } };
}

test("模型保存拒绝旧版本及其模型、运行状态和提示", async t => {
  const h = fixture(t);
  const work = h.render().saveModelSelection();
  h.owner.render().adoptRouteConfig(config({ settingsRevision: 5 }));
  h.resolve({ modelState: models({ defaultModel: "old" }), restartRequired: true });
  await work;
  assert.equal(h.owner.render().config.settingsRevision, 5);
  assert.notEqual(h.render().modelState.defaultModel, "old");
  assert.deepEqual(h.status, {});
  assert.deepEqual(h.notices, []);
  assert.equal(h.render().modelPickerVisible, true);
});

test("模型保存合并等待期间的新草稿，同一渲染内编辑也不会丢失", async t => {
  const h = fixture(t);
  const work = h.render().saveModelSelection();
  const draft = h.owner.render();
  draft.editConfig({ ...draft.config, streamMaxRetries: 9 });
  h.resolve({ restartRequired: true });
  await work;
  assert.equal(h.owner.render().config.streamMaxRetries, 9);
  assert.equal(h.owner.render().config.settingsRevision, 2);
  assert.equal(h.owner.render().dirty, true);
  assert.equal(h.owner.render().persistedConfigRef.current.streamMaxRetries, 2);
  assert.equal(h.status.restartRequired, true);
  assert.equal(h.render().modelPickerVisible, false);
});

test("模型保存防重复，失败保留选择并允许重试", async t => {
  const h = fixture(t);
  const actions = h.render();
  const work = actions.saveModelSelection();
  await actions.saveModelSelection();
  assert.equal(h.calls.length, 1);
  h.calls[0].reject(new Error("保存失败"));
  await assert.rejects(work, /保存失败/);
  assert.equal(h.render().modelPickerVisible, true);
  assert.equal(h.owner.render().config.settingsRevision, 1);
  const retry = h.render().saveModelSelection();
  h.resolve(); await retry;
  assert.equal(h.calls.length, 2);
});

test("旧保存完成不能关闭重开的选择器，卸载后也不回写", async t => {
  const h = fixture(t);
  const work = h.render().saveModelSelection();
  h.render().setModelPickerVisible(false);
  h.render().beginModelPickerLoad("route");
  h.resolve(); await work;
  assert.equal(h.render().modelPickerVisible, true);
  assert.equal(h.render().modelPickerLoading, true);
  assert.deepEqual(h.notices, []);
  const next = h.render().saveModelSelection();
  h.unmount();
  h.resolve({ config: config({ settingsRevision: 3 }) }); await next;
  assert.equal(h.writesAfterUnmount, 0);
  assert.equal(h.owner.render().config.settingsRevision, 2);
});

test("过期同步只结束对应加载，不能打断新一轮模型同步", t => {
  const h = fixture(t);
  const old = h.render().beginModelPickerLoad("route");
  const current = h.render().beginModelPickerLoad("route");
  h.render().cancelModelPickerLoad(old);
  assert.equal(h.render().modelPickerLoading, true);
  h.render().cancelModelPickerLoad(current);
  assert.equal(h.render().modelPickerLoading, false);
  assert.match(h.render().modelSyncWarning, /配置已更新/);
});

test("关闭或卸载后的模型保存错误不会交给全局提示", async t => {
  for (const unmount of [false, true]) {
    const h = fixture(t);
    const work = h.render().saveModelSelection();
    if (unmount) h.unmount(); else h.render().setModelPickerVisible(false);
    h.calls.at(-1).reject(new Error("过期错误"));
    await work;
    assert.deepEqual(h.notices, []);
    assert.equal(h.writesAfterUnmount, 0);
  }
});
