import assert from "node:assert/strict";
import test from "node:test";
import { createModuleGraph } from "./helpers/jsx-tree.mjs";
import { createControllerHarness, deferred } from "./helpers/controller-harness.mjs";

const { accountForRoute, nativeRoute, officialModelCatalog, visibleRoutes, routeModelGroups, officialRouteModelDraft } = createModuleGraph(new URL("../src/features/routes/catalog.ts", import.meta.url)).exports;
const custom = { id: "custom", name: "", shortName: "主", baseUrl: "https://example.com/v1", apiKey: "fixture-only", authMode: "apiKey" };
const official = { id: "official", name: "官方", authMode: "officialAccount", sourceProviderId: "openai" };
const config = { localRouterEnabled: true, profiles: [custom, official], defaultModel: "custom/a", selectedModelsByProvider: { custom: ["A", "b"] }, declaredOfficialModelsByProvider: { custom: ["a", "c"] } };
const state = { officialModels: [{ slug: "alpha", displayName: "Alpha", supported: true }, { slug: "beta", supported: false }], officialModelIds: ["ALPHA"], thirdPartyModels: ["native"], defaultModel: "native" };

test("线路目录保留存储账号及禁用线路，乐观排序不改原始配置", () => {
  const stored = { ...official, id: "stored", officialAccountId: "account" }, disabled = { ...official, id: "disabled", enabled: false };
  const current = { ...config, profiles: [disabled, official, custom, stored] };
  assert.deepEqual(visibleRoutes(current, null, false, null).map(item => item.id), ["custom", "stored", "disabled"]);
  assert.deepEqual(visibleRoutes(current, null, true, { id: "custom", enabled: false }).map(item => item.id), ["official", "stored", "disabled", "custom"]);
  assert.equal(custom.enabled, undefined);
});

test("原生线路沿用空名称且不回传密钥，禁用或无 provider 时为空", () => {
  assert.equal(nativeRoute([], null), null);
  const provider = { id: "custom", name: "Other", baseUrl: "", official: false };
  const native = nativeRoute([custom], provider);
  assert.equal(native.name, ""); assert.equal(native.apiKey, "");
  assert.equal(native.baseUrl, custom.baseUrl);
  assert.equal(nativeRoute([{ ...custom, enabled: false }], provider), null);
  assert.deepEqual(visibleRoutes({ ...config, localRouterEnabled: false }, provider, false, null), [native]);
  assert.equal(nativeRoute([], { id: "openai", name: " ", official: true }).upstreamProtocol, "official");
});

test("目录按模式选模型，保持顺序、大小写去重和官方支持性回退", () => {
  const catalog = officialModelCatalog(state);
  assert.deepEqual(catalog, ["ALPHA", "beta"]);
  const groups = routeModelGroups(config, state, [custom, official, { ...custom, enabled: false }], catalog);
  assert.deepEqual(groups.map(group => group.models), [["A", "b", "c"], catalog]);
  assert.equal(groups[0].defaultModel, "A");
  const native = routeModelGroups({ ...config, localRouterEnabled: false }, state, [custom, official], catalog);
  assert.deepEqual(native.map(group => group.models), [["native"], ["alpha"]]);
  assert.equal(native[1].defaultModel, "native");
  assert.deepEqual(routeModelGroups({ ...config, localRouterEnabled: false }, { ...state, officialModels: [] }, [official], catalog)[0].models, ["ALPHA"]);
  assert.deepEqual(officialRouteModelDraft({ ...config, selectedModelsByProvider: { openai: ["BETA", "removed"] } }, official, catalog), ["BETA"]);
  assert.deepEqual(officialRouteModelDraft(config, official, catalog), catalog);
});

test("账号归属明确指定时不退回默认账号", () => {
  const accounts = [{ id: "default", isDefault: true }, { id: "other" }];
  assert.equal(accountForRoute(null, accounts), null);
  assert.equal(accountForRoute(custom, null), null);
  assert.equal(accountForRoute(official, accounts), accounts[0]);
  assert.equal(accountForRoute({ ...official, officialAccountId: "other" }, accounts), accounts[1]);
  assert.equal(accountForRoute({ ...official, officialAccountId: "missing" }, accounts), null);
});

test("线路开关防重入、失败恢复排序，隐藏重开不接受旧错误", async t => {
  const writes = [], notices = [];
  const h = createControllerHarness(new URL("../src/features/routes/useRouteCatalogController.ts", import.meta.url), "useRouteCatalogController");
  t.after(() => h.unmount());
  const options = { active: true, config, modelState: state, currentProvider: null, officialAccountAvailable: true, isBusy: false, dirty: false,
    onSetRouteEnabled: (...args) => { const pending = deferred(); writes.push({ ...pending, args }); return pending.promise; }, onNotice: value => notices.push(value) };
  h.render(options);
  let save = h.render().handleToggleRouteEnabled(custom, false);
  await h.render().handleToggleRouteEnabled(custom, false);
  assert.equal(writes.length, 1);
  assert.equal(h.render().visibleProfiles.at(-1).id, "custom");
  writes[0].reject(new Error("保存失败")); await save;
  assert.equal(h.render().visibleProfiles[0].id, "custom");
  assert.equal(notices.length, 1);
  for (const changed of [{ dirty: true }, { isBusy: true }, { active: false }, { config: { ...config, localRouterEnabled: false } }]) {
    h.render({ ...options, ...changed });
    await h.render().handleToggleRouteEnabled(custom, false);
    assert.equal(writes.length, 1);
  }
  h.render(options);
  save = h.render().handleToggleRouteEnabled(custom, false);
  h.render({ ...options, active: false }); h.render(options);
  await h.render().handleToggleRouteEnabled(custom, false);
  assert.equal(writes.length, 2);
  writes[1].reject(new Error("旧错误")); await save;
  assert.equal(notices.length, 1);
  assert.equal(h.render().pendingRouteToggle, null);
  save = h.render().handleToggleRouteEnabled(custom, false);
  h.unmount(); writes[2].resolve(true); await save;
  assert.equal(h.writesAfterUnmount, 0);
});
