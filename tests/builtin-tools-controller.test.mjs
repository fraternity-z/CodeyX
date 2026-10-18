import assert from "node:assert/strict";
import test from "node:test";
import { createControllerHarness, deferred, installControllerWindow } from "./helpers/controller-harness.mjs";
import { autoStubModule, collectElements, elementProps, elementType, textContent } from "./helpers/jsx-tree.mjs";

const ready = { installed: true, version: "test", projects: [], mcp: { id: "codey", enabled: false, managed: true, automatic: true }, job: null };
const enabled = { ...ready, mcp: { ...ready.mcp, enabled: true }, message: "已启用" };
function fixture(extra = {}, component = false) {
  const calls = [], changes = [], ui = autoStubModule("ui");
  const options = { active: true, config: { fastContextTools: false, retained: "draft" }, fastContextToolsStatus: { userConfigured: false, detectionFailed: false }, isBusy: false, onConfigChange: next => changes.push(next), ...extra };
  const h = createControllerHarness(new URL(component ? "../src/BuiltinToolsPage.tsx" : "../src/features/builtin-tools/useBuiltinToolsController.ts", import.meta.url), component ? "BuiltinToolsPage" : "useBuiltinToolsController", {
    "../../api": { invoke(command, args) {
      if (args.tool === "ponytail") return Promise.resolve({ installed: false, enabled: false, settings: { defaultMode: "full", revision: "missing" }, job: null });
      const call = { command, args, ...deferred() }; calls.push(call); return call.promise;
    } },
    "../../components/ui": ui, "./components/ui": ui, "@tabler/icons-react": autoStubModule("icons"),
  });
  return { ...h, calls, changes, ui, options, render: () => h.render(options) };
}

test("内置工具只在活动页轮询，保留共享草稿所有权和 FastCtx 配置保护", async t => {
  installControllerWindow(t);
  const h = fixture({ active: false }); h.render().changeFastContextTools(true); await h.render().setEnabled(true);
  assert.equal(h.calls.length, 0); assert.equal(h.changes.length, 0);
  h.options.active = true; h.render().changeFastContextTools(true);
  assert.deepEqual(h.changes, [{ fastContextTools: true, retained: "draft" }]);
  assert.equal(h.options.config.fastContextTools, false);
  for (const status of [{ userConfigured: true, detectionFailed: false, serverId: "user" }, { userConfigured: false, detectionFailed: true }]) {
    h.options.fastContextToolsStatus = status;
    h.options.config = { fastContextTools: true, retained: "newer" };
    const c = h.render(); c.changeFastContextTools(false);
    assert.equal(c.fastContextToolsEnabled, false); assert.equal(c.fastctxStatusBlocksEmbedded, true);
    assert.match(c.fastctxBlockedReason, status.detectionFailed ? /无法确认/ : /user/);
  }
  assert.equal(h.changes.length, 1); h.unmount();
});

test("检测中、全局忙碌、后台安装和用户自管状态禁止启停", async t => {
  installControllerWindow(t);
  for (const mode of ["loading", "busy", "job", "user"]) {
    const h = fixture({ isBusy: mode === "busy" }); h.render();
    if (mode !== "loading") {
      h.calls[0].resolve(mode === "user" ? { ...ready, mcp: { ...ready.mcp, managed: false } } : mode === "job" ? { ...ready, job: { phase: "running" } } : ready);
      await h.flush();
    }
    await h.render().setEnabled(true); assert.equal(h.calls.length, 1); h.unmount();
  }
});

test("启停防止重复提交和旧轮询覆盖，失败保留草稿并支持显式重试", async t => {
  const browser = installControllerWindow(t);
  const h = fixture(); h.render(); h.calls[0].resolve(ready); await h.flush();
  browser.tick(); const old = h.calls.at(-1);
  const c = h.render(); const work = c.setEnabled(true); await c.setEnabled(false); c.refresh();
  assert.deepEqual(h.calls.at(-1).args, { action: "set_enabled", enabled: true }); assert.equal(h.calls.length, 3);
  old.reject(new Error("old read")); await h.flush(); assert.equal(h.render().error, ""); assert.equal(h.render().busy, true);
  h.calls.at(-1).reject(new Error("write failed")); await work; await h.flush();
  h.calls.at(-1).resolve(ready); await h.flush();
  assert.equal(h.render().error, "write failed"); assert.equal(h.options.config.retained, "draft");
  const retry = h.render().setEnabled(true); h.calls.at(-1).resolve(enabled); await retry;
  const result = await h.flush(); assert.equal(result.notice, "已启用"); assert.equal(result.error, ""); assert.equal(result.status.mcp.enabled, true); h.unmount();
});

test("刷新作废旧读结果，当前读取失败停止轮询并可手动恢复", async t => {
  const browser = installControllerWindow(t);
  for (const failed of [false, true]) {
    const h = fixture(); h.render().refresh(); h.render();
    h.calls[1].reject(new Error("read failed")); await h.flush();
    if (failed) h.calls[0].reject(new Error("stale")); else h.calls[0].resolve(enabled);
    assert.equal((await h.flush()).error, "read failed"); assert.equal(browser.timers.size, 0);
    h.render().refresh(); h.render(); h.calls.at(-1).resolve(ready);
    assert.equal((await h.flush()).error, ""); assert.equal(browser.timers.size, 1); h.unmount();
  }
});

test("隐藏重开作废旧读取与写入，写入锁保持到完成，随后重新读取", async t => {
  installControllerWindow(t);
  for (const mutation of [false, true]) {
    for (const failed of [false, true]) {
      const h = fixture(); h.render();
      if (mutation) { h.calls[0].resolve(ready); await h.flush(); }
      const work = mutation ? h.render().setEnabled(true) : Promise.resolve(); const old = h.calls.at(-1);
      h.render(); h.options.active = false; h.render(); h.options.active = true; h.render();
      const count = h.calls.length; await h.render().setEnabled(true); assert.equal(h.calls.length, count);
      if (failed) old.reject(new Error("late")); else old.resolve(enabled);
      await work; const c = await h.flush();
      assert.equal(c.status?.mcp.enabled ?? false, false); assert.equal(c.notice, ""); assert.equal(c.error, "");
      h.calls.at(-1).resolve(enabled); assert.equal((await h.flush()).status.mcp.enabled, true); h.unmount();
    }
  }
});

test("卸载清理轮询，迟到成功、失败与 finally 不再写入", async t => {
  const browser = installControllerWindow(t);
  for (const mutation of [false, true]) {
    for (const failed of [false, true]) {
      const h = fixture(); h.render();
      if (mutation) { h.calls[0].resolve(ready); await h.flush(); }
      const work = mutation ? h.render().setEnabled(true) : Promise.resolve(); const count = h.calls.length;
      h.unmount(); assert.equal(browser.timers.size, 0);
      if (failed) h.calls.at(-1).reject(new Error("late")); else h.calls.at(-1).resolve(enabled);
      await work; await h.flush(); assert.equal(h.writesAfterUnmount, 0); assert.equal(h.calls.length, count);
    }
  }
});

test("内置工具视图接线保留开关状态、错误提示、重试和刷新行为", async t => {
  installControllerWindow(t);
  const h = fixture({}, true); h.render(); h.calls[0].resolve(ready); await h.flush();
  const find = (type, label) => collectElements(h.render(), node => elementType(node) === type && (elementProps(node)["aria-label"] === label || textContent(node) === label))[0];
  elementProps(find(h.ui.Switch, "启用 FastCtx 上下文工具")).onCheckedChange(true);
  assert.equal(h.changes[0].fastContextTools, true);
  elementProps(find(h.ui.Switch, "启用 CodeGraph 自动索引")).onCheckedChange(true);
  assert.equal(elementProps(find(h.ui.Switch, "启用 CodeGraph 自动索引")).disabled, true);
  h.calls.at(-1).resolve({ ...ready, job: { phase: "failed", message: "install failed" } }); await h.flush();
  elementProps(find(h.ui.Button, "重试启用")).onClick(); h.render(); h.calls.at(-1).reject(new Error("retry failed")); await h.flush();
  assert.match(textContent(h.render()), /retry failed/);
  elementProps(find(h.ui.Button, "刷新")).onClick(); h.render(); h.calls.at(-1).resolve(enabled); await h.flush();
  assert.doesNotMatch(textContent(h.render()), /retry failed/); assert.equal(elementProps(find(h.ui.Switch, "启用 CodeGraph 自动索引")).checked, true); h.unmount();
});
