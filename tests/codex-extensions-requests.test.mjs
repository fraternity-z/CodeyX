import assert from "node:assert/strict";
import test from "node:test";
import { createModuleGraph } from "./helpers/jsx-tree.mjs";
const calls = [];
const { readInventory, invalidateInventory, withTimeout, executeExtensionAction, extensionRequest, readMcpSharingStatus } = createModuleGraph(
  new URL("../src/features/codex-extensions/requests.ts", import.meta.url),
  { stubs: { "../../api": { invoke: async (...args) => { calls.push(args); return { ok: true }; } } } },
).exports;
const scope = { kind: "user" };
test("扩展命令由请求层适配作用域和草稿版本", async () => {
  assert.deepEqual(await executeExtensionAction(extensionRequest, scope, "inventory", {
    action: "save_skill", id: "demo", revision: "draft", content: "fixture",
  }), { ok: true });
  assert.deepEqual(calls[0], ["codex_extensions", { request: {
    scope, revision: "draft", action: "save_skill", id: "demo", content: "fixture",
  } }]);
});

test("跨页面写入不能重复提交，读取等待实际写入完成", async () => {
  let finish;
  const actions = [];
  const request = payload => {
    actions.push(payload.action);
    return payload.action === "save_skill" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ revision: "new" });
  };
  const saving = executeExtensionAction(request, scope, "old", { action: "save_skill" });
  await assert.rejects(executeExtensionAction(request, scope, "old", { action: "save_skill" }), /仍在执行/);
  const refreshing = readInventory(request, scope, true);
  assert.deepEqual(actions, ["save_skill"]);
  finish({ inventory: { revision: "new" } });
  await saving;
  assert.equal((await refreshing).revision, "new");
  assert.deepEqual(actions, ["save_skill", "list"]);
});

test("写入超时仍持有传输锁，刷新只在后台实际结束后确认", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish;
  let reads = 0;
  const request = payload => payload.action === "save_mcp" ? new Promise(resolve => { finish = resolve; })
    : (reads++, Promise.resolve({ revision: "confirmed" }));
  const saving = executeExtensionAction(request, scope, "old", { action: "save_mcp" });
  const timeout = assert.rejects(saving, /结果尚不确定/);
  t.mock.timers.tick(45000);
  await timeout;
  await assert.rejects(executeExtensionAction(request, scope, "old", { action: "save_mcp" }), /仍在执行/);
  const refresh = readInventory(request, scope, true);
  assert.equal(reads, 0);
  finish({ inventory: { revision: "confirmed" } });
  assert.equal((await refresh).revision, "confirmed");
  assert.equal(reads, 1);
});
test("concurrent inventory reads and short-lived cache share one request", async () => {
  let calls = 0;
  const request = async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { revision: String(calls) };
  };
  const [first, second] = await Promise.all([
    readInventory(request, scope),
    readInventory(request, scope),
  ]);
  assert.equal(first, second);
  assert.equal(calls, 1);
  assert.equal(await readInventory(request, scope), first);
  assert.equal(calls, 1);
  await readInventory(request, scope, true);
  assert.equal(calls, 2);
  invalidateInventory(request, scope);
  await readInventory(request, scope);
  assert.equal(calls, 3);
});
test("scope caches are isolated and failed reads can retry", async () => {
  let calls = 0;
  const request = async () => {
    if (++calls === 1) throw new Error("offline");
    return { revision: String(calls) };
  };
  await assert.rejects(readInventory(request, scope), /offline/);
  await readInventory(request, scope);
  await readInventory(request, {
    kind: "project",
    projectPath: "/tmp/project",
  });
  assert.equal(calls, 3);
});
test("shared user configuration changes invalidate every scope", async () => {
  let calls = 0;
  const request = async () => ({ revision: String(++calls) });
  const project = { kind: "project", projectPath: "/tmp/shared-config" };
  await readInventory(request, scope);
  await readInventory(request, project);
  invalidateInventory(request);
  await readInventory(request, scope);
  await readInventory(request, project);
  assert.equal(calls, 4);
});
test("invalidation prevents a pending old read from repopulating cache", async () => {
  let release,
    calls = 0;
  const request = () =>
    ++calls === 1
      ? new Promise((resolve) => {
          release = resolve;
        })
      : Promise.resolve({ revision: "new" });
  const pending = readInventory(request, scope);
  invalidateInventory(request, scope);
  const latest = await readInventory(request, scope);
  release({ revision: "old" });
  await pending;
  assert.equal(await readInventory(request, scope), latest);
});
test("timeouts describe uncertain mutations without claiming cancellation", async () => {
  let completed = false;
  const operation = new Promise((resolve) =>
    setTimeout(() => {
      completed = true;
      resolve("saved");
    }, 15),
  );
  await assert.rejects(withTimeout(operation, true, 1), /结果尚不确定/);
  assert.equal(await operation, "saved");
  assert.equal(completed, true);
  await assert.rejects(
    withTimeout(new Promise(() => {}), false, 1),
    /读取超时/,
  );
});

test("共享状态缺失启用标志不能被当作已关闭", async () => {
  for (const status of [null, {}, { pools: [] }, { enabled: false }, { enabled: "false", pools: [] }]) {
    await assert.rejects(readMcpSharingStatus(async () => status, scope), /共享运行状态无效/);
  }
  assert.deepEqual(await readMcpSharingStatus(async payload => {
    assert.deepEqual(payload, { action: "mcp_sharing_status", scope });
    return { enabled: false, pools: [] };
  }, scope), { enabled: false, pools: [] });
});
