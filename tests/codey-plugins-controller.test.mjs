import assert from "node:assert/strict";
import { File } from "node:buffer";
import test from "node:test";
import { createControllerHarness, deferred, installControllerWindow } from "./helpers/controller-harness.mjs";
import { createModuleGraph } from "./helpers/jsx-tree.mjs";

const hash = "a".repeat(64);
const plugin = (patch = {}) => ({ id: "demo", name: "Demo", version: "1", status: "disabled", enabled: false,
  configPath: "demo/config.json", capabilities: ["request.lifecycle.v1"], ...patch });
const result = (plugins = [plugin()]) => ({ plugins, platform: "windows", arch: "x86_64" });
const preview = { path: "staged.codey-plugin", sha256: hash, manifest: { id: "new", name: "New", version: "1" } };
const configFile = { pluginId: "demo", version: "1", path: "demo/config.json", content: '{ "text": "saved" }', sha256: hash };

function fixture(extra = {}, config = false) {
  const calls = [], notices = [], changes = [], closed = [];
  const options = config
    ? { active: true, plugin: plugin(), onClose: () => closed.push(true), onChanged: next => changes.push(next), ...extra }
    : { active: true, onNotice: notice => notices.push(notice), ...extra };
  const name = config ? "usePluginConfigController" : "useCodeyPluginsController";
  const h = createControllerHarness(new URL(`../src/features/codey-plugins/${name}.ts`, import.meta.url), name, {
    "../../api": { invoke(command, args = {}) {
      const call = { command, args, ...deferred() }; calls.push(call);
      if (args.discardUpload) call.resolve({ status: "ok" });
      return call.promise;
    } },
  });
  return { ...h, calls, notices, changes, closed, options, render: () => h.render(options),
    async ready(value = config ? configFile : result()) { h.render(options); calls[0].resolve(value); return h.flush(); } };
}

test("插件筛选覆盖名称、ID、说明与能力，保留顺序和输入", () => {
  const { filterPlugins } = createModuleGraph(new URL("../src/features/codey-plugins/state.ts", import.meta.url)).exports;
  const plugins = [plugin({ description: "说明" }), plugin({ id: "other", name: "Other", capabilities: [] })];
  assert.equal(filterPlugins(plugins, "  "), plugins);
  for (const query of [" DEMO ", "说明", "LIFECYCLE"]) assert.deepEqual(filterPlugins(plugins, query), [plugins[0]]);
  assert.deepEqual(filterPlugins(plugins, "missing"), []);
  assert.deepEqual(filterPlugins([], "demo"), []);
  assert.equal(plugins.length, 2);
});

test("非活动插件页不读取、不操作，激活后校验列表再开放操作", async t => {
  installControllerWindow(t);
  const h = fixture({ active: false });
  const c = h.render(); c.openImport(); c.changeEnabled(plugin(), true); c.requestUninstall(plugin());
  c.requestClearLogs(plugin()); c.openConfig(plugin()); await c.openDirectory(plugin()); await c.selectPackage(); await c.refresh();
  assert.equal(h.calls.length, 0);
  h.options.active = true; h.render(); h.calls[0].resolve({ ...result(), plugins: [null] });
  assert.match((await h.flush()).error, /插件列表响应无效/);
  await h.render().changeEnabled(plugin(), false); assert.equal(h.calls.length, 1);
  const work = h.render().refresh(); h.calls[1].resolve(result()); await work;
  assert.equal((await h.flush()).blocked, false); h.unmount();
});

test("刷新作废旧成功、错误和 finally，隐藏重开保留筛选并按当前状态重读", async t => {
  installControllerWindow(t);
  for (const fail of [false, true]) {
    const h = fixture(); h.render().setSearchQuery("demo");
    const newer = h.render().refresh();
    if (fail) h.calls[0].reject(new Error("old")); else h.calls[0].resolve(result([]));
    await h.flush(); assert.equal(h.render().loading, true); assert.equal(h.render().error, "");
    h.calls[1].resolve(result()); await newer; await h.flush();
    const old = h.render().refresh();
    h.options.active = false; h.render(); h.options.active = true; h.render();
    assert.equal(h.calls.length, 4);
    h.calls[2].resolve(result([])); await old; await h.flush();
    assert.equal(h.render().loading, true); assert.equal(h.render().result.plugins.length, 1);
    h.calls[3].resolve(result([plugin({ name: "Newest" })])); await h.flush();
    assert.equal(h.render().searchQuery, "demo"); assert.equal(h.render().result.plugins[0].name, "Newest"); h.unmount();
  }
});

test("启用先确认，重复提交被锁住；失败刷新状态且不自动重放", async t => {
  installControllerWindow(t);
  const h = fixture(); await h.ready();
  h.render().changeEnabled(plugin(), true); assert.equal(h.calls.length, 1);
  const c = h.render(), work = c.confirmOperation(); await c.confirmOperation(); c.cancelConfirmation();
  assert.equal(h.calls.length, 2); assert.equal(h.render().confirm.kind, "enable");
  assert.deepEqual(h.calls[1].args, { pluginId: "demo", enabled: true });
  h.calls[1].reject(new Error("结果未知")); await h.flush();
  assert.equal(h.calls[2].command, "list_codey_plugins");
  h.calls[2].reject(new Error("读取失败")); await work; await h.flush();
  assert.equal(h.render().error, "结果未知"); assert.equal(h.render().known, false);
  await h.render().changeEnabled(plugin(), false); assert.equal(h.calls.length, 3);
  const refresh = h.render().refresh(); h.calls[3].resolve(result()); await refresh; await h.flush();
  h.render().changeEnabled(plugin(), true); const retry = h.render().confirmOperation();
  h.calls[4].resolve(result([plugin({ enabled: true })])); await retry; await h.flush();
  assert.equal(h.render().result.plugins[0].enabled, true); assert.equal(h.render().confirm, null);
  assert.equal(h.notices.length, 1); h.unmount();
});

test("写入跨隐藏重开保留锁，迟到结果只使列表重读并通知线路失效", async t => {
  installControllerWindow(t);
  for (const fail of [false, true]) {
    const h = fixture(); await h.ready(); let invalidations = 0;
    const listener = () => invalidations++;
    window.addEventListener("codey:plugin-routes-changed", listener);
    h.render().changeEnabled(plugin(), true); const work = h.render().confirmOperation();
    h.options.active = false; h.render(); h.options.active = true; h.render();
    await h.render().changeEnabled(plugin(), false); await h.render().refresh(); assert.equal(h.calls.length, 2);
    if (fail) h.calls[1].reject(new Error("late")); else h.calls[1].resolve(result([plugin({ enabled: true })]));
    await work; await h.flush();
    assert.equal(h.calls.length, 3); assert.equal(h.calls[2].command, "list_codey_plugins");
    assert.equal(h.render().result.plugins[0].enabled, false); assert.equal(h.render().error, "");
    assert.deepEqual(h.notices, []); assert.equal(invalidations, 1);
    h.calls[2].resolve(result([plugin({ enabled: true })])); await h.flush();
    assert.equal(h.render().result.plugins[0].enabled, true);
    window.removeEventListener("codey:plugin-routes-changed", listener); h.unmount();
  }
});

test("重新启用按停用、启用串行执行，切页后不继续第二次写入", async t => {
  installControllerWindow(t);
  for (const hide of [false, true]) {
    const h = fixture(); const enabled = plugin({ enabled: true, restartRequired: true }); await h.ready(result([enabled]));
    const work = h.render().restartPlugin(enabled);
    assert.equal(h.calls[1].args.enabled, false);
    if (hide) { h.options.active = false; h.render(); }
    h.calls[1].resolve(result()); await h.flush();
    if (hide) assert.equal(h.calls.length, 2);
    else { assert.equal(h.calls[2].args.enabled, true); h.calls[2].resolve(result([enabled])); }
    await work; await h.flush();
    assert.equal(h.notices.length, hide ? 0 : 1); h.unmount();
  }
  const h = fixture(); await h.ready(); const work = h.render().restartPlugin(plugin());
  h.calls[1].resolve(result()); await h.flush(); h.calls[2].reject(new Error("启用失败")); await h.flush();
  h.calls[3].resolve(result()); await work; await h.flush();
  assert.match(h.render().error, /重新启用失败/); assert.equal(h.render().result.plugins[0].enabled, false); h.unmount();
});

test("卸载默认保留数据，仅显式选择才删除，启用中的插件不能请求卸载", async t => {
  installControllerWindow(t);
  for (const removeData of [false, true]) {
    const h = fixture(); await h.ready();
    h.render().requestUninstall(plugin({ enabled: true })); assert.equal(h.render().confirm, null);
    h.render().requestUninstall(plugin()); h.render().setRemoveData(removeData);
    const work = h.render().confirmOperation();
    assert.deepEqual(h.calls[1].args, { pluginId: "demo", removeData });
    h.calls[1].resolve(result([])); await work; await h.flush();
    assert.equal(h.render().confirm, null); assert.equal(h.render().result.plugins.length, 0); h.unmount();
  }
});

test("目录与日志按插件 ID 请求，清日志必须确认，失败保留错误并允许显式重试", async t => {
  installControllerWindow(t);
  const h = fixture(); await h.ready();
  const directory = h.render().openDirectory(plugin()); await h.render().openDirectory(plugin());
  assert.equal(h.calls.length, 2); assert.deepEqual(h.calls[1].args, { pluginId: "demo" });
  h.calls[1].resolve({}); await directory; await h.flush();
  for (const status of ["ok", "already_open"]) {
    const work = h.render().openLogs(plugin()); h.calls.at(-1).resolve({ status }); await work; await h.flush();
    assert.equal(h.notices.at(-1).tone, status === "ok" ? "success" : "warning");
  }
  h.render().requestClearLogs(plugin()); const work = h.render().clearLogs();
  assert.deepEqual(h.calls.at(-1).args, { pluginId: "demo", confirmed: true });
  h.calls.at(-1).reject(new Error("文件占用")); await h.flush(); h.calls.at(-1).resolve(result()); await work; await h.flush();
  assert.equal(h.render().clearLogsError, "文件占用"); assert.equal(h.render().clearLogsPlugin.id, "demo");
  const retry = h.render().clearLogs(); h.calls.at(-1).resolve(result([plugin({ logSizeBytes: 0 })])); await retry;
  await h.flush(); assert.equal(h.render().clearLogsPlugin, null); assert.equal(h.render().result.plugins[0].logSizeBytes, 0); h.unmount();
});

test("配置保存使旧列表失效，关闭已保存编辑器不重复刷新", async t => {
  installControllerWindow(t);
  const h = fixture(); await h.ready(); h.render().openConfig(plugin());
  const read = h.render().refresh();
  h.render().configChanged(result([plugin({ restartRequired: true })])); h.render().closeConfig();
  h.calls[1].resolve(result()); await read; await h.flush();
  assert.equal(h.calls.length, 2); assert.equal(h.render().result.plugins[0].restartRequired, true);
  assert.equal(h.render().editing, undefined); assert.equal(h.notices.length, 1);
  h.render().openConfig(plugin()); h.render().closeConfig(); assert.equal(h.calls.length, 3); h.unmount();
});

test("隐藏期间返回的原生选择与路径检查不恢复旧预览", async t => {
  installControllerWindow(t);
  for (const select of [false, true]) {
    for (const fail of [false, true]) {
      const h = fixture(); await h.ready(); h.render().openImport();
      const work = select ? h.render().selectPackage() : h.render().inspectPath(" demo.codey-plugin ");
      h.options.active = false; h.render(); h.options.active = true; h.render();
      if (fail) h.calls[1].reject(new Error("late")); else h.calls[1].resolve(preview);
      await work; await h.flush();
      assert.equal(h.render().preview, null); assert.equal(h.render().importError, "");
      assert.equal(h.calls[2].command, "list_codey_plugins"); h.unmount();
    }
  }
});

test("上传时隐藏会释放迟到暂存，保留重试来源但不自动重试", async t => {
  installControllerWindow(t);
  const h = fixture(); await h.ready();
  const work = h.render().droppedFiles([new File(["bytes"], "demo.codey-plugin")]);
  await new Promise(resolve => setImmediate(resolve));
  const upload = h.calls[1]; assert.ok(upload.args.upload);
  h.options.active = false; h.render(); upload.resolve({ ...preview, uploadId: "staged-id" });
  await work; await h.flush();
  assert.equal(h.render().preview, null); assert.equal(h.render().importError, "");
  assert.equal(h.calls[2].args.discardUpload, "staged-id");
  h.options.active = true; h.render(); assert.equal(h.calls[3].command, "list_codey_plugins");
  assert.equal(h.calls.filter(call => call.args.upload).length, 1); assert.equal(h.render().canRetryImport, true); h.unmount();
});

test("安装途中卸载组件，暂存保留到请求结束，迟到结果不写 UI", async t => {
  installControllerWindow(t);
  for (const fail of [false, true]) {
    const h = fixture(); await h.ready();
    const upload = h.render().droppedFiles([new File(["bytes"], "demo.codey-plugin")]);
    await new Promise(resolve => setImmediate(resolve)); h.calls[1].resolve({ ...preview, uploadId: "staged-id" });
    await upload; await h.flush();
    const work = h.render().confirmImport(); h.unmount();
    assert.equal(h.calls.length, 3); assert.equal(h.calls[2].command, "install_codey_plugin");
    if (fail) h.calls[2].reject(new Error("late")); else h.calls[2].resolve(result());
    await work; await h.flush();
    assert.equal(h.calls[3].args.discardUpload, "staged-id");
    assert.equal(h.writesAfterUnmount, 0); assert.deepEqual(h.notices, []);
  }
});

test("安装结果未知后先刷新，发现同版本已安装则不重放导入", async t => {
  installControllerWindow(t);
  const h = fixture(); await h.ready();
  const inspection = h.render().inspectPath("demo.codey-plugin"); h.calls[1].resolve(preview); await inspection; await h.flush();
  const work = h.render().confirmImport(); h.calls[2].reject(new Error("超时")); await h.flush();
  h.calls[3].resolve(result([plugin({ id: "new" })])); await work; await h.flush();
  await h.render().retryImport(); assert.equal(h.calls.length, 4); assert.ok(h.render().importError); h.unmount();
});

test("读取与一般操作在卸载后的成功和失败均不再写入", async t => {
  installControllerWindow(t);
  for (const operation of ["read", "openDirectory", "openLogs", "disable", "clearLogs"]) {
    for (const fail of [false, true]) {
      const h = fixture(); h.render(); let work;
      if (operation !== "read") {
        h.calls[0].resolve(result()); await h.flush();
        if (operation === "disable") work = h.render().changeEnabled(plugin(), false);
        else if (operation === "clearLogs") { h.render().requestClearLogs(plugin()); work = h.render().clearLogs(); }
        else work = h.render()[operation](plugin());
      }
      const call = h.calls.at(-1), count = h.calls.length; h.unmount();
      if (fail) call.reject(new Error("late")); else call.resolve(operation === "openLogs" ? { status: "ok" } : result());
      await work; await h.flush();
      assert.equal(h.writesAfterUnmount, 0); assert.equal(h.calls.length, count); assert.deepEqual(h.notices, []);
    }
  }
});

test("配置响应校验插件身份、版本、路径、内容与摘要，错误时禁止保存", async () => {
  for (const patch of [{ pluginId: "other" }, { version: "2" }, { path: null }, { content: null }, { sha256: "bad" }, { sha256: null }]) {
    const h = fixture({}, true); await h.ready({ ...configFile, ...patch });
    assert.match(h.render().error, /配置文件响应无效/); assert.equal(h.render().canSave, false);
    await h.render().save(); assert.equal(h.calls.length, 1); h.unmount();
  }
});

test("配置草稿隐藏重开保留原摘要，迟到写入不关闭编辑器或覆盖当前结果", async () => {
  for (const fail of [false, true]) {
    const h = fixture({}, true); await h.ready();
    h.render().edit(h.render().document.entries[0], '"draft"');
    const work = h.render().save();
    h.options.active = false; h.render(); h.options.active = true; h.render();
    await h.render().save(); assert.equal(h.calls.length, 2);
    if (fail) h.calls[1].reject(new Error("late")); else h.calls[1].resolve(result());
    await work; await h.flush();
    assert.equal(h.calls.length, 2); assert.deepEqual([...h.render().edits.values()], ['"draft"']);
    assert.match(h.render().error, /重新加载配置确认结果/); assert.equal(h.render().file.sha256, hash);
    assert.deepEqual(h.changes, []); assert.deepEqual(h.closed, []);
    h.render().request("reload"); assert.equal(h.calls.length, 2);
    h.render().confirmDiscard(); assert.equal(h.calls.length, 3); h.unmount();
  }
});

test("配置页只在活动时读取，隐藏期间忽略旧读取，未改动时重开刷新", async () => {
  const h = fixture({ active: false }, true); h.render(); await h.render().save(); h.render().request("reload");
  assert.equal(h.calls.length, 0);
  h.options.active = true; h.render(); h.options.active = false; h.render();
  h.calls[0].resolve(configFile); await h.flush(); assert.equal(h.render().file, null);
  h.options.active = true; h.render(); h.calls[1].resolve(configFile); await h.flush();
  h.render().edit(h.render().document.entries[0], '"draft"');
  h.options.active = false; h.render(); h.options.active = true; h.render();
  assert.equal(h.calls.length, 2); assert.deepEqual([...h.render().edits.values()], ['"draft"']); h.unmount();
});
