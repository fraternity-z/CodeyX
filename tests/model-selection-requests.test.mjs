import assert from "node:assert/strict";
import test from "node:test";
import { createModuleGraph } from "./helpers/jsx-tree.mjs";

const input = (patch = {}) => ({ routeId: null, officialRoute: false, officialModels: ["official"],
  thirdPartyModels: ["third"], manualThirdPartyModels: ["third"], deletedThirdPartyModels: ["deleted"], supportsAutoReview: false, ...patch });
function fixture(invoke) {
  return createModuleGraph(new URL("../src/features/model-selection/requests.ts", import.meta.url), {
    stubs: { "../../api": { invoke } },
  }).exports.modelSelectionRequests;
}

test("普通模型请求区分默认线路、显式线路和清空设置", async () => {
  const calls = [];
  const result = { config: { settingsRevision: 2 }, modelHotReloadError: "未生效", warning: "保留提示" };
  const requests = fixture(async (command, args) => { calls.push({ command, args }); return result; });
  assert.equal(await requests.save(input()), result);
  assert.deepEqual(calls[0], { command: "save_selected_models", args: { officialModels: ["official"], thirdPartyModels: ["third"],
    manualThirdPartyModels: ["third"], deletedThirdPartyModels: ["deleted"], supportsAutoReview: false } });
  await requests.save(input({ routeId: "route", modelContexts: {}, reasoningEfforts: {} }));
  assert.deepEqual(calls[1].args, { ...calls[0].args, routeId: "route", modelContexts: {}, reasoningEfforts: {} });
});

test("官方命令只提交官方模型和显式预算，失败原样传播且不重试", async () => {
  const calls = [];
  const failure = new Error("执行结果未确认");
  const requests = fixture(async (command, args) => { calls.push({ command, args }); throw failure; });
  await assert.rejects(requests.save(input({ officialRoute: true, routeId: "official", modelContexts: {}, reasoningEfforts: {} })), error => error === failure);
  assert.deepEqual(calls, [{ command: "save_official_route_models", args: { routeId: "official", models: ["official"], modelContexts: {} } }]);
});
