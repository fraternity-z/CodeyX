import assert from "node:assert/strict";
import test from "node:test";
import { createControllerHarness, deferred } from "./helpers/controller-harness.mjs";
import { createModuleGraph } from "./helpers/jsx-tree.mjs";

const state = createModuleGraph(new URL("../src/features/codex-extensions/state.ts", import.meta.url)).exports;
const entry = { id: "fixture", sourcePath: "/fixture/config.toml", transport: "stdio", readOnly: false, sharing: { enabled: true, maxInstances: 4, registrationId: "registered" } };

test("共享状态按注册汇总隔离池，未启动为零，后端错误仅作异常标记", () => {
  const pool = { registrationId: "registered", id: entry.id, sourcePath: entry.sourcePath, instances: 1, running: 1, queued: 2 };
  const status = { pools: [pool, { ...pool, instances: 2, error: "sensitive detail" }, { ...pool, registrationId: "other", instances: 100 }] };
  assert.deepEqual(state.mcpSharingSummary(entry, status), { instances: 3, running: 2, queued: 4, error: true });
  assert.deepEqual(state.mcpSharingSummary(entry, { pools: [] }), { instances: 0, running: 0, queued: 0, error: false });
  assert.equal(state.mcpSharingSummary({ ...entry, sharing: undefined }, status).instances, 103);
  for (const patch of [{ transport: "http" }, { transport: "unknown" }, { readOnly: true }, { canEdit: false }, { configurationStatus: "invalid" }]) {
    assert.equal(state.canShareMcp({ ...entry, ...patch }), false);
  }
});

test("共享能力缺省兼容旧清单，宿主拒绝共享仍允许恢复直连", () => {
  assert.equal(state.canShareMcp({ ...entry, sharing: undefined }), true);
  assert.equal(state.canShareMcp(entry), true);
  const rejected = { ...entry, sharing: { ...entry.sharing, canShare: false, reason: "内置服务不支持共享" } };
  assert.equal(state.canShareMcp(rejected), false);
  assert.equal(state.canShareMcp(rejected, false), true);
});

test("共享状态仅在活动页轮询，范围切换、隐藏和卸载拒绝旧响应", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  const h = createControllerHarness(new URL("../src/features/codex-extensions/useMcpSharingController.ts", import.meta.url), "useMcpSharingController", {
    "./requests": { readMcpSharingStatus: (_request, scope) => { const call = { ...deferred(), scope }; calls.push(call); return call.promise; } },
  });
  const request = () => {};
  const user = { kind: "user" }, project = { kind: "project", projectPath: "/project" };
  h.render(request, user, true, "r1");
  h.render(request, project, true, "r1");
  calls[0].resolve({ pools: [{ id: "old" }] }); await h.flush();
  assert.equal(h.render().status, null);
  calls[1].resolve({ pools: [] }); await h.flush();
  assert.deepEqual(h.render().status, { pools: [] });
  t.mock.timers.tick(4999); assert.equal(calls.length, 2);
  t.mock.timers.tick(1); assert.equal(calls.length, 3);
  h.render(request, project, false, "r1");
  calls[2].reject(new Error("secret token")); await h.flush();
  assert.equal(h.render().error, "");
  t.mock.timers.tick(10000); assert.equal(calls.length, 3);
  h.render(request, project, true, "r2");
  calls[3].reject(new Error("secret token")); await h.flush();
  assert.equal(h.render().status, null);
  assert.equal(h.render().error, "未能读取共享运行状态，请刷新后重试。");
  t.mock.timers.tick(5000); h.unmount();
  calls[4].resolve({ pools: [] }); await h.flush();
  assert.equal(h.writesAfterUnmount, 0);
  t.mock.timers.tick(10000); assert.equal(calls.length, 5);
});
