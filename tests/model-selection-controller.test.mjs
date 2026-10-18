import assert from "node:assert/strict";
import test from "node:test";
import { createControllerHarness, deferred } from "./helpers/controller-harness.mjs";

const config = (patch = {}) => ({ settingsRevision: 1, localRouterEnabled: true,
  activeProfileId: "route", profiles: [{ id: "route", authMode: "apiKey" }],
  selectedModelsByProvider: { route: ["m1"] }, streamMaxRetries: 2, ...patch });
const models = (patch = {}) => ({ officialModels: [], officialModelIds: [], thirdPartyModels: ["m1"],
  manualThirdPartyModels: [], upstreamModels: ["m1"], defaultModel: "m1", ...patch });

function fixture(t, overrides = {}) {
  const calls = [], notices = [];
  let status = {};
  const owner = createControllerHarness(new URL("../src/useDraftConfig.ts", import.meta.url), "useDraftConfig");
  owner.render().setPersistedConfig(config());
  const h = createControllerHarness(new URL("../src/features/model-selection/useModelSelectionController.ts", import.meta.url), "useModelSelectionController", {
    "../../api": { invoke(command, args) { const call = { command, args, ...deferred() }; calls.push(call); return call.promise; } },
    "../../subagentModels": { buildSubagentModelOptions: () => [] },
  });
  const options = { active: true, ...overrides };
  const render = () => {
    const draft = owner.render();
    return h.render({ config: draft.config, adoptRouteConfig: draft.adoptRouteConfig, setDirty: draft.setDirty,
      currentProvider: null, officialAccountAvailable: false, runOperation: async (_name, action) => action(),
      setStatus(update) { status = update(status); }, setNotice: notice => notices.push(notice), ...options });
  };
  render().openModelPicker(models(), "", "route");
  t.after(() => { h.unmount(); owner.unmount(); });
  return { ...h, render, owner, calls, notices, options, get status() { return status; },
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

test("隐藏使目录响应失效，保留草稿；重开只接纳新一轮目录", async t => {
  const h = fixture(t);
  const old = h.render().beginModelPickerLoad("route");
  h.render().toggleDraftModel("draft", true);
  h.render().updateCustomModelInput("unfinished");
  h.options.active = false;
  let state = h.render();
  state.completeModelPickerLoad(old, models({ thirdPartyModels: ["stale"] }), "old warning", "route");
  await state.saveModelSelection();
  assert.equal(h.calls.length, 0);
  assert.equal(h.render().modelPickerLoading, false);
  assert.equal(h.render().modelPickerVisible, false);
  assert.deepEqual([...h.render().draftModelSet], ["draft"]);
  assert.equal(h.render().customModelInput, "unfinished");

  h.options.active = true;
  const current = h.render().beginModelPickerLoad("route");
  state = h.render();
  state.completeModelPickerLoad(old, models({ thirdPartyModels: ["stale"] }), "old warning", "route");
  state.cancelModelPickerLoad(old);
  assert.equal(h.render().modelPickerLoading, true);
  state.completeModelPickerLoad(current, models({ thirdPartyModels: ["fresh"] }), "new warning", "route", true);
  assert.equal(h.render().modelPickerLoading, false);
  assert.deepEqual([...h.render().draftModelSet], ["fresh"]);
  assert.equal(h.render().draftAutoReviewSupported, true);
  assert.equal(h.render().modelSyncWarning, "new warning");
});

test("卸载后目录回调与新操作均不回写", async t => {
  const h = fixture(t);
  const session = h.render().beginModelPickerLoad("route");
  const actions = h.render();
  h.unmount();
  actions.completeModelPickerLoad(session, models());
  actions.cancelModelPickerLoad(session);
  actions.beginModelPickerLoad("route");
  actions.openModelPicker(models());
  actions.setModelPickerVisible(true);
  await actions.saveModelSelection();
  assert.equal(h.writesAfterUnmount, 0);
  assert.equal(h.calls.length, 0);
});

test("隐藏期间写入保持防重，完成后合并基线但不覆盖新弹窗草稿", async t => {
  const h = fixture(t);
  const work = h.render().saveModelSelection();
  h.options.active = false;
  h.render();
  h.options.active = true;
  h.render().openModelPicker(models({ thirdPartyModels: ["draft"] }), "", "route");
  await h.render().saveModelSelection();
  assert.equal(h.calls.length, 1);
  h.resolve(); await work;
  assert.equal(h.owner.render().config.settingsRevision, 2);
  assert.deepEqual([...h.render().draftModelSet], ["draft"]);
  assert.equal(h.render().modelPickerVisible, true);
  assert.deepEqual(h.notices, []);
});

test("隐藏重开后的旧保存错误不污染当前提示，也不会自动重试", async t => {
  const h = fixture(t);
  const work = h.render().saveModelSelection();
  h.options.active = false; h.render();
  h.options.active = true; h.render();
  h.calls[0].reject(new Error("旧错误"));
  await work;
  assert.equal(h.calls.length, 1);
  assert.equal(h.owner.render().config.settingsRevision, 1);
  assert.deepEqual(h.notices, []);
});

test("排队保存开始前失效时跳过请求，并释放防重锁", async t => {
  let resume;
  const gate = deferred();
  const h = fixture(t, { runOperation: async (_name, action) => { resume = action; await gate.promise; await action(); } });
  const work = h.render().saveModelSelection();
  assert.equal(typeof resume, "function");
  h.render().setModelPickerVisible(false);
  gate.resolve(); await work;
  assert.equal(h.calls.length, 0);
  h.options.runOperation = async (_name, action) => action();
  h.render().openModelPicker(models(), "", "route");
  const next = h.render().saveModelSelection();
  h.resolve(); await next;
  assert.equal(h.calls.length, 1);
});

test("手动模型校验、删除和重新添加保持请求中的来源和删除语义", async t => {
  const h = fixture(t);
  h.render().openModelPicker(models({ thirdPartyModels: ["saved"], manualThirdPartyModels: ["saved"] }), "", "route");
  h.render().updateCustomModelInput("codex-auto-review");
  h.render().addCustomModel();
  assert.match(h.render().modelInputError, /线路能力/);
  h.render().updateCustomModelInput(" new ");
  assert.equal(h.render().modelInputError, "");
  h.render().addCustomModel();
  h.render().updateDraftReasoningEffort("new", [{ level: "high", value: "high" }]);
  h.render().deleteDraftThirdPartyModel("new");
  assert.equal(h.render().draftReasoningEfforts.new, undefined);
  h.render().deleteDraftThirdPartyModel("m1");
  h.render().deleteDraftThirdPartyModel(" SAVED ");
  let work = h.render().saveModelSelection();
  assert.deepEqual(h.calls[0].args.deletedThirdPartyModels, ["SAVED"]);
  assert.deepEqual(h.calls[0].args.manualThirdPartyModels, []);
  h.calls[0].reject(new Error("暂时失败"));
  await assert.rejects(work, /暂时失败/);
  h.render().updateCustomModelInput("saved");
  h.render().addCustomModel();
  work = h.render().saveModelSelection();
  assert.deepEqual(h.calls[1].args.deletedThirdPartyModels, []);
  assert.deepEqual(h.calls[1].args.manualThirdPartyModels, ["saved"]);
  h.resolve(); await work;
});

test("成功响应缺少模型目录时保留有效目录，并保留部分成功提示", async t => {
  const h = fixture(t);
  h.render().setModelState(models({ defaultModel: "retained" }));
  const work = h.render().saveModelSelection();
  h.resolve({ modelState: undefined, modelHotReloadError: "目录未刷新" });
  await work;
  assert.equal(h.render().modelState.defaultModel, "retained");
  assert.equal(h.notices[0].tone, "info");
  assert.match(h.notices[0].text, /模型刷新失败/);
});
