import assert from "node:assert/strict";
import test from "node:test";
import { createModuleGraph } from "./helpers/jsx-tree.mjs";

const { emptyModelState, modelPickerDraft, thirdPartyOptions, customModelError, modelSelectionInput } =
  createModuleGraph(new URL("../src/features/model-selection/state.ts", import.meta.url)).exports;
const efforts = (...levels) => levels.map(level => ({ level, value: level }));
const policy = { contextWindowTokens: 128_000 };

test("空目录独立初始化，候选去重且排除官方模型、删除项与线路能力", () => {
  const first = emptyModelState();
  first.thirdPartyModels.push("local");
  assert.deepEqual(emptyModelState().thirdPartyModels, []);
  const state = { ...emptyModelState(), upstreamModels: [" B ", "a", "A", "", "codex-auto-review", "official", "deleted"], thirdPartyModels: ["b", "manual"] };
  assert.deepEqual(thirdPartyOptions(state, ["Draft", "B"], new Set(["official"]), new Set(["deleted"]), false), ["B", "a", "manual", "Draft"]);
  assert.deepEqual(thirdPartyOptions(state, ["Draft"], new Set(), new Set(), true), []);
});

test("自定义模型校验覆盖空白、官方限制、字节上限和数量上限", () => {
  const validate = (input, selected = [], official = [], routeId = null, onlyOfficial = false) =>
    customModelError(input, selected, official, routeId, onlyOfficial);
  assert.match(validate("m", [], [], null, true), /官方线路只能/);
  assert.match(validate(" \t "), /请输入/);
  assert.match(validate(" CODEX-AUTO-REVIEW "), /线路能力/);
  assert.equal(validate("a".repeat(512)), "");
  assert.match(validate("a".repeat(513)), /512 字节/);
  assert.equal(validate("模".repeat(170) + "ab"), "");
  assert.match(validate("模".repeat(171)), /512 字节/);
  const full = Array.from({ length: 10_000 }, (_, i) => `m${i}`);
  assert.match(validate("new", full), /10000 个/);
  assert.equal(validate(" M9999 ", full), "");
  assert.equal(validate("new", full.slice(1)), "");
  assert.match(validate("official", [], ["Official"]), /Official 已在上方/);
  assert.equal(validate("official", [], ["Official"], "third-party-route"), "");
});

test("草稿按线路 provider 读取顺序、预算和能力，且不修改保存配置", () => {
  const config = {
    activeProfileId: "route", profiles: [{ id: "route", sourceProviderId: "provider", pluginOwnerId: "plugin",
      pluginRouteSpec: { modelReasoningEfforts: { THIRD: ["low", "high"] } } }],
    selectedModelsByProvider: { provider: ["THIRD", "official"] },
    modelContextByProvider: { provider: { third: policy } },
    modelReasoningEffortsByProvider: { provider: { Third: efforts("high") } },
  };
  const state = { ...emptyModelState(),
    officialModels: [{ slug: "official", supported: true }, { slug: "unavailable", supported: false }],
    thirdPartyModels: ["third", "codex-auto-review"], upstreamModels: ["third", "THIRD", "no-template"],
    thirdPartyModelMetadata: [{ slug: "third", autoSupportedReasoningEfforts: ["low", "high", "ultra"] }],
  };
  const before = structuredClone({ config, state });
  const draft = modelPickerDraft(state, config, { id: "unrelated" }, "route");
  assert.deepEqual(draft.models, ["third", "official"]);
  assert.deepEqual(draft.contexts, { third: policy });
  assert.deepEqual(draft.autoEfforts.third, efforts("low", "high"));
  assert.deepEqual(draft.efforts.third, efforts("high"));
  assert.deepEqual(draft.autoEfforts["no-template"], efforts("low", "medium", "high", "xhigh"));
  assert.deepEqual({ config, state }, before);
  assert.deepEqual(modelPickerDraft(emptyModelState(), null, null, null).models, []);
  const current = modelPickerDraft(state, config, { id: "provider" }, null);
  assert.deepEqual(current.models, draft.models);
  const fallback = modelPickerDraft(state, config, null, null);
  assert.deepEqual(fallback.models, draft.models);
});

const selection = (patch = {}) => ({
  routeId: "route", officialRoute: false, officialOnly: false, localRouterEnabled: true,
  models: [" Official ", "a", "A", "b", ""], officialKeys: new Set(["official"]), officialModelIds: ["official"],
  thirdPartyModelOptions: ["a", "b", "unselected"], manualModels: ["A", "removed"], deletedModels: ["removed"], supportsAutoReview: true,
  contexts: { OFFICIAL: policy, a: policy, unselected: policy, removed: policy },
  efforts: { a: efforts("high"), b: efforts("low"), unknown: efforts("ultra") },
  autoEfforts: { a: efforts("high"), b: efforts("low", "high") }, ...patch,
});

test("提交转换保留首个拼写与顺序，过滤手动来源、预算和默认档位", () => {
  const draft = selection();
  const before = structuredClone(draft);
  assert.deepEqual(modelSelectionInput(draft), {
    routeId: "route", officialRoute: false, officialModels: ["Official"], thirdPartyModels: ["a", "b"],
    manualThirdPartyModels: ["A"], deletedThirdPartyModels: ["removed"], supportsAutoReview: true,
    modelContexts: { OFFICIAL: policy, a: policy, unselected: policy }, reasoningEfforts: { b: efforts("low") },
  });
  assert.deepEqual(draft, before);
});

test("官方和原生模式分别保留预算范围及省略语义，空声明保留显式清除", () => {
  const official = modelSelectionInput(selection({ officialRoute: true, officialOnly: true }));
  assert.deepEqual(official.modelContexts, { OFFICIAL: policy });
  assert.equal(Object.hasOwn(official, "reasoningEfforts"), false);
  const native = modelSelectionInput(selection({ localRouterEnabled: false }));
  assert.equal(Object.hasOwn(native, "modelContexts"), false);
  assert.equal(Object.hasOwn(native, "reasoningEfforts"), false);
  const cleared = modelSelectionInput(selection({ contexts: {}, efforts: { b: [] } }));
  assert.deepEqual(cleared.modelContexts, {});
  assert.deepEqual(cleared.reasoningEfforts, { b: [] });
  assert.deepEqual(modelSelectionInput(selection({ efforts: {} })).reasoningEfforts, {});
});
