import assert from "node:assert/strict";
import test from "node:test";
import { createControllerHarness, deferred } from "./helpers/controller-harness.mjs";

const entry = { id: "cache", name: "fixture", sourcePath: "/fixture/cache", canRemove: true };
const cache = (revision = "r1", skills = [entry]) => ({ revision, skills, warnings: [] });

function harness(open = true) {
  const calls = [];
  const request = payload => {
    const pending = deferred();
    calls.push({ payload, ...pending, completed: false });
    return pending.promise;
  };
  const h = createControllerHarness(new URL("../src/features/codex-extensions/useSkillCacheController.ts", import.meta.url), "useSkillCacheController", {
    "../../api": { invoke: () => { throw new Error("测试不得访问真实后端"); } },
  });
  let visible = open;
  const render = value => { if (value !== undefined) visible = value; return h.render(visible, request); };
  render();
  const respond = async (action, result, error = false) => {
    const call = calls.find(call => !call.completed && call.payload.action === action);
    assert.ok(call, `缺少请求 ${action}`);
    call.completed = true;
    if (error) call.reject(result); else call.resolve(result);
    return h.flush();
  };
  return { ...h, render, calls, respond };
}

test("缓存列表失败可重试，查看只读内容，确认删除绑定版本且拒绝重复提交", async () => {
  const h = harness();
  await h.respond("list_skill_cache", new Error("读取失败"), true);
  assert.equal(h.render().error, "读取失败"); assert.equal(h.render().unavailable, true);
  h.render().askRemove(entry); assert.equal(h.render().confirmation, null);
  h.render().refresh(); await h.respond("list_skill_cache", cache());
  h.render().read(entry); await h.respond("read_skill_cache", { content: "# fixture" });
  assert.deepEqual(h.render().document, { name: "fixture", content: "# fixture" });
  h.render().askRemove({ ...entry, canRemove: false }); assert.equal(h.render().confirmation, null);
  h.render().askRemove(entry); h.render().cancelRemove(); assert.equal(h.render().confirmation, null);
  h.render().askRemove(entry);
  const removing = h.render().remove(); await h.render().remove();
  assert.deepEqual(h.calls.at(-1).payload, { action: "remove_skill_cache", id: "cache", revision: "r1", confirmed: true });
  assert.equal(h.calls.filter(call => call.payload.action === "remove_skill_cache").length, 1);
  await h.respond("remove_skill_cache", { cache: cache("r2", []), message: "缓存已删除" }); await removing;
  assert.equal(h.render().cache.skills.length, 0); assert.equal(h.render().document, null);
  assert.equal(h.render().confirmation, null); assert.equal(h.render().notice, "缓存已删除");
  assert.equal(h.render().blocked, false);
});

test("删除冲突保持阻塞，刷新失败不解锁，成功读取后可重新确认", async () => {
  const h = harness(); await h.respond("list_skill_cache", cache());
  h.render().askRemove(entry); const removing = h.render().remove();
  await h.respond("remove_skill_cache", new Error("版本已变化"), true); await removing;
  assert.equal(h.render().blocked, true); assert.equal(h.render().confirmation, null);
  h.render().askRemove(entry); await h.render().remove();
  assert.equal(h.calls.length, 2);
  h.render().refresh(); await h.respond("list_skill_cache", new Error("离线"), true);
  assert.equal(h.render().blocked, true);
  h.render().refresh(); await h.respond("list_skill_cache", cache("r2"));
  h.render().askRemove(entry); const retry = h.render().remove();
  assert.equal(h.calls.at(-1).payload.revision, "r2");
  await h.respond("remove_skill_cache", { cache: cache("r3", []), message: "已删除" }); await retry;
});

test("关闭重开作废旧读取的成功、错误和 finally，隐藏期间不发请求", async () => {
  for (const fail of [false, true]) {
    const h = harness();
    h.render(false); await h.render().refresh(); await h.render().read(entry);
    assert.equal(h.calls.length, 1);
    h.render(true);
    const old = h.calls[0], latest = h.calls[1];
    latest.completed = true; latest.resolve(cache("new")); await h.flush();
    old.completed = true;
    if (fail) old.reject(new Error("旧错误")); else old.resolve(cache("old"));
    await h.flush();
    assert.equal(h.render().cache.revision, "new");
    assert.equal(h.render().error, ""); assert.equal(h.render().busy, ""); assert.equal(h.render().blocked, false);
  }
});

test("删除在途关闭重开不释放锁，完成后重新读取且不回写旧提示", async () => {
  const h = harness(); await h.respond("list_skill_cache", cache());
  h.render().askRemove(entry); const removing = h.render().remove();
  h.render(false); h.render(true);
  assert.equal(h.render().busy, "remove");
  h.render().askRemove(entry); await h.render().remove();
  assert.equal(h.calls.length, 2);
  await h.respond("remove_skill_cache", { cache: cache("r2", []), message: "旧提示" }); await removing;
  assert.equal(h.render().busy, "list");
  await h.respond("list_skill_cache", cache("r2", []));
  assert.equal(h.render().cache.revision, "r2"); assert.equal(h.render().notice, "");
});

test("卸载后删除回调及 finally 不更新状态", async () => {
  const h = harness(); await h.respond("list_skill_cache", cache());
  h.render().askRemove(entry); const removing = h.render().remove();
  h.unmount();
  await h.respond("remove_skill_cache", { cache: cache("r2", []), message: "已删除" }); await removing;
  assert.equal(h.writesAfterUnmount, 0);
});

test("未打开的缓存 controller 不读取，也不接受残留动作", async () => {
  const h = harness(false);
  await h.render().refresh(); await h.render().read(entry); await h.render().remove();
  h.render().askRemove(entry);
  assert.equal(h.calls.length, 0); assert.equal(h.render().confirmation, null);
  h.unmount();
});

test("删除超时后等待刷新，关闭弹窗会跳过尚未发出的列表请求", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(); await h.respond("list_skill_cache", cache());
  h.render().askRemove(entry); const removing = h.render().remove();
  t.mock.timers.tick(15000); await h.flush(); await removing;
  assert.match(h.render().error, /结果尚不确定/);
  h.render(false); h.render(true); h.render(false);
  await h.respond("remove_skill_cache", { cache: cache("r2", []), message: "已删除" });
  assert.equal(h.calls.filter(call => call.payload.action === "list_skill_cache").length, 1);
  h.render(true); await h.respond("list_skill_cache", cache("r2", []));
  assert.equal(h.render().cache.revision, "r2");
});
