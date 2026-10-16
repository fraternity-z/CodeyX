import assert from "node:assert/strict";
import test from "node:test";

import { createModuleGraph } from "./helpers/jsx-tree.mjs";

// useExtensionsController 用极简 hooks 桩驱动：挂载 effect、状态更新后手动重渲，
// 用来断言读写序号互不作废与 run 的三态返回值，而不是匹配源码。
const controllerUrl = new URL(
  "../src/features/codex-extensions/useExtensionsController.ts",
  import.meta.url,
);

const settle = async () => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

function createHarness() {
  const reads = [];
  const writes = [];
  const effects = [];
  const hooks = [];
  let cursor = 0;

  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks))
        hooks[index] = typeof initial === "function" ? initial() : initial;
      return [
        hooks[index],
        (next) => {
          hooks[index] = typeof next === "function" ? next(hooks[index]) : next;
        },
      ];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { current: initial };
      return hooks[index];
    },
    useCallback(callback, deps) {
      const index = cursor++;
      const previous = hooks[index];
      // 依赖变化时必须换新闭包，否则挂载 effect 不会因 scope 变化而重跑。
      if (
        previous &&
        deps?.every((value, i) => Object.is(value, previous.deps[i]))
      )
        return previous.value;
      hooks[index] = { deps, value: callback };
      return callback;
    },
    useEffect(effect, deps) {
      const index = cursor++;
      const previous = hooks[index];
      if (previous && deps.every((value, i) => Object.is(value, previous.deps[i])))
        return;
      effects.push(() => {
        previous?.cleanup?.();
        hooks[index] = { deps, cleanup: effect() };
      });
    },
  };

  const graph = createModuleGraph(controllerUrl, {
    stubs: {
      react,
      "./requests": {
        readInventory: (_request, scope, force) =>
          new Promise((resolve, reject) => reads.push({ force, reject, resolve, scope })),
        executeExtensionAction: (request, scope, revision, action) => request({ scope, revision, ...action }),
        isExtensionMutation: action => !["get_mcp", "read_skill", "export_skill", "pick_project", "pick_skill", "test_mcp", "validate_skill"].includes(action),
        waitForExtensionMutation: () => undefined,
      },
      "./state": {
        causeText: (cause) =>
          cause instanceof Error ? cause.message : String(cause),
      },
    },
  });

  const request = (payload) =>
    new Promise((resolve, reject) => writes.push({ payload, reject, resolve }));

  const render = (active = true) => {
    cursor = 0;
    const controller = graph.exports.useExtensionsController(request, active);
    effects.splice(0).forEach((effect) => effect());
    return controller;
  };

  return { reads, render, writes };
}

test("提交不会作废在飞的清单刷新，加载态由刷新生命周期管理", async () => {
  const h = createHarness();
  const mounted = h.render();
  assert.equal(h.reads.length, 1, "挂载即开始读取清单");

  const saving = mounted.mutate({ action: "save_mcp" });
  assert.equal(h.writes.length, 1);
  assert.equal(h.render().loading, true, "提交不得清掉刷新中的加载态");

  h.reads[0].resolve({ revision: "r1" });
  await settle();
  assert.deepEqual(h.render().inventory, { revision: "r1" }, "提交不得作废在飞的清单");

  h.writes[0].resolve({ inventory: { revision: "r2" }, message: "已保存" });
  assert.equal(await saving, "ok");
  const settled = h.render();
  assert.equal(settled.loading, false);
  assert.deepEqual(settled.inventory, { revision: "r2" });
  assert.match(settled.notice, /已保存/);
});

test("提交被抢占返回 superseded，不把旧操作提示写入新范围", async () => {
  const h = createHarness();
  let controller = h.render();
  h.reads[0].resolve({ revision: "r1" });
  await settle();
  controller = h.render();

  const saving = controller.mutate({ action: "save_mcp" });
  controller.setScope({ kind: "project", projectPath: "/tmp/demo" });
  controller = h.render();
  assert.equal(h.reads.length, 2, "切换范围必须重新读取");
  h.reads[1].resolve({ revision: "r2" });
  await settle();

  h.writes[0].resolve({ inventory: { revision: "r2" }, message: "已保存" });
  assert.equal(await saving, "superseded", "落库但被抢占必须与失败区分开");
  controller = h.render();
  assert.deepEqual(controller.inventory, { revision: "r2" });
  assert.equal(controller.notice, "");
});

test("提交失败返回 failed 并保留错误，单飞与不确定状态仍然拦截 mutation", async () => {
  const h = createHarness();
  let controller = h.render();
  h.reads[0].resolve({ revision: "r1" });
  await settle();
  controller = h.render();

  const first = controller.run({ action: "save_mcp" });
  assert.equal(await controller.run({ action: "save_mcp" }), "failed");
  assert.equal(h.writes.length, 1, "同一时刻只允许一次操作");

  h.writes[0].reject(new Error("上次操作结果尚不确定，请刷新确认。"));
  assert.equal(await first, "failed");
  controller = h.render();
  assert.match(controller.error, /结果尚不确定/);
  assert.equal(controller.uncertain, true);

  assert.equal(await controller.run({ action: "save_mcp" }), "failed");
  assert.equal(h.writes.length, 1, "结果不确定时不得继续提交修改");
  controller.run({ action: "get_mcp", id: "demo" });
  assert.equal(h.writes.length, 2, "只读操作不受不确定状态阻塞");
});

test("保存提示按 applyStatus 区分，重启提示不重复后端消息", async () => {
  const h = createHarness();
  let controller = h.render();
  h.reads[0].resolve({ revision: "r1" });
  await settle();
  controller = h.render();

  const saving = controller.mutate({ action: "save_skill" });
  h.writes[0].resolve({
    inventory: { revision: "r2" },
    applyStatus: "restart-required",
    message: "配置已保存。",
  });
  assert.equal(await saving, "ok");
  controller = h.render();
  assert.equal(
    controller.notice,
    "配置已保存，重启 Codex 后生效。",
  );
  assert.equal(controller.noticeSeq, 1);

  // 自动刷新成功的状态直接使用后端说明，不追加重启提示。
  const applying = controller.mutate({ action: "save_mcp" });
  controller = h.render();
  h.writes[1].resolve({
    inventory: { revision: "r3" },
    applyStatus: "applied",
    message: "配置已保存，下一轮对话生效。",
  });
  assert.equal(await applying, "ok");
  controller = h.render();
  assert.equal(
    controller.notice,
    "配置已保存，下一轮对话生效。",
  );
  assert.equal(controller.noticeSeq, 2);
});

test("版本冲突保留当前清单，显式刷新后使用新版本重新提交", async () => {
  const h = createHarness();
  h.render();
  h.reads[0].resolve({ revision: "r1", mcps: [{ id: "demo", enabled: false }] });
  await settle();
  const before = h.render().inventory;

  const saving = h.render().mutate({ action: "set_mcp_enabled", id: "demo", enabled: true });
  assert.equal(h.writes[0].payload.revision, "r1");
  h.writes[0].reject(new Error("配置已变化，请刷新后重新提交"));
  assert.equal(await saving, "failed");
  assert.deepEqual(h.render().inventory, before);
  assert.equal(h.render().busy, false);
  assert.match(h.render().error, /配置已变化/);
  assert.equal(h.writes.length, 1, "冲突不能自动重放写入");

  const refreshing = h.render().refresh();
  h.reads[1].resolve({ revision: "r2", mcps: [{ id: "demo", enabled: false }] });
  await refreshing;
  const retrying = h.render().mutate({ action: "set_mcp_enabled", id: "demo", enabled: true });
  assert.deepEqual(h.writes[1].payload.scope, { kind: "user" });
  assert.equal(h.writes[1].payload.revision, "r2");
  h.writes[1].resolve({ inventory: { revision: "r3", mcps: [{ id: "demo", enabled: true }] }, message: "已保存" });
  assert.equal(await retrying, "ok");
  assert.equal(h.render().inventory.mcps[0].enabled, true);
  assert.equal(h.render().error, "");
});

test("写入结果不确定时刷新失败仍阻止提交，刷新确认后恢复写入", async () => {
  const h = createHarness();
  h.render();
  h.reads[0].resolve({ revision: "r1" });
  await settle();
  const saving = h.render().mutate({ action: "save_mcp", id: "demo" });
  h.writes[0].reject(new Error("操作等待超时，后台可能仍在执行，结果尚不确定。"));
  assert.equal(await saving, "failed");

  const failedRefresh = h.render().refresh();
  h.reads[1].reject(new Error("连接暂时不可用"));
  assert.equal(await failedRefresh, null);
  assert.equal(h.render().uncertain, true);
  assert.equal(h.render().loading, false);
  assert.equal(await h.render().mutate({ action: "save_mcp", id: "demo" }), "failed");
  assert.equal(h.writes.length, 1);

  const confirmedRefresh = h.render().refresh();
  h.reads[2].resolve({ revision: "r2" });
  await confirmedRefresh;
  assert.equal(h.render().uncertain, false);
  const retrying = h.render().mutate({ action: "save_mcp", id: "demo" });
  assert.equal(h.writes[1].payload.revision, "r2");
  h.writes[1].resolve({ inventory: { revision: "r3" }, message: "已保存" });
  assert.equal(await retrying, "ok");
});

test("迟到的旧刷新不能解除写入不确定状态或覆盖最新清单", async () => {
  const h = createHarness();
  h.render();
  h.reads[0].resolve({ revision: "r1" });
  await settle();
  const saving = h.render().mutate({ action: "save_mcp" });
  h.writes[0].reject(new Error("写入结果尚不确定"));
  await saving;

  const oldRefresh = h.render().refresh();
  const currentRefresh = h.render().refresh();
  h.reads[2].reject(new Error("最新刷新失败"));
  await currentRefresh;
  h.reads[1].resolve({ revision: "old" });
  assert.equal(await oldRefresh, null);
  assert.equal(h.render().inventory.revision, "r1");
  assert.equal(h.render().uncertain, true);
  assert.equal(h.render().error, "最新刷新失败");

  const staleRefresh = h.render().refresh();
  const confirmedRefresh = h.render().refresh();
  h.reads[4].resolve({ revision: "r2" });
  await confirmedRefresh;
  h.reads[3].reject(new Error("过期的网络错误"));
  assert.equal(await staleRefresh, null);
  assert.equal(h.render().inventory.revision, "r2");
  assert.equal(h.render().uncertain, false);
  assert.equal(h.render().error, "");
  assert.equal(h.writes.length, 1, "刷新只能读取，不得偷偷重试超时写入");
});

test("保存成功作废先前的列表读取，旧成功和错误均不能覆盖新清单", async () => {
  for (const fail of [false, true]) {
    const h = createHarness();
    h.render();
    h.reads[0].resolve({ revision: "r1" });
    await settle();
    const oldRefresh = h.render().refresh();
    const saving = h.render().mutate({ action: "save_mcp" });
    h.writes[0].resolve({ inventory: { revision: "r2" }, message: "已保存" });
    assert.equal(await saving, "ok");
    if (fail) h.reads[1].reject(new Error("旧错误"));
    else h.reads[1].resolve({ revision: "old" });
    assert.equal(await oldRefresh, null);
    assert.equal(h.render().inventory.revision, "r2");
    assert.equal(h.render().error, "");
    assert.equal(h.render().loading, false);
  }
});

test("写入前开始的刷新不能解除后续超时的不确定状态", async () => {
  const h = createHarness();
  h.render();
  h.reads[0].resolve({ revision: "r1" });
  await settle();
  const oldRefresh = h.render().refresh();
  const saving = h.render().mutate({ action: "save_mcp" });
  h.writes[0].reject(new Error("操作结果尚不确定"));
  await saving;
  h.reads[1].resolve({ revision: "r1" });
  assert.equal(await oldRefresh, null);
  assert.equal(h.render().uncertain, true);
  assert.equal(await h.render().mutate({ action: "save_mcp" }), "failed");
  assert.equal(h.writes.length, 1);
});
