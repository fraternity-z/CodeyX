import assert from "node:assert/strict";
import test from "node:test";
import { createControllerHarness, deferred, installControllerWindow } from "./helpers/controller-harness.mjs";
import { loadTypeScriptModule } from "./helpers/load-typescript-module.mjs";

const { remoteStartOptions, adoptRemoteStatus } = await loadTypeScriptModule(new URL("../src/features/remote-control/state.ts", import.meta.url));
const stopped = { running: false, urls: [], devices: [] };
const url = "https://remote.example.test";
const running = { running: true, urls: [url], devices: [{ id: "phone", name: "手机" }] };
const pairing = { url: `${url}/#pair=fixture`, qrCode: "fixture", expiresIn: 600 };

function fixture() {
  const calls = [];
  const options = { active: true, remote: false };
  const h = createControllerHarness(new URL("../src/features/remote-control/useRemoteControlController.ts", import.meta.url), "useRemoteControlController", {
    "../../api": { invoke(command, args) { const call = { command, args, ...deferred() }; calls.push(call); return call.promise; } },
  });
  return { ...h, calls, options, render: () => h.render(options.active, options.remote) };
}

test("远程启动校验端口边界并按连接方式适配参数", () => {
  const draft = { bindAddress: "127.0.0.1", port: "1", publicUrl: url, connection: "lan" };
  for (const port of ["1", "65535"]) assert.equal(remoteStartOptions({ ...draft, port }).port, Number(port));
  for (const port of ["0", "65536", "1.5", "", "no", "Infinity"]) assert.throws(() => remoteStartOptions({ ...draft, port }), /1–65535/);
  for (const connection of ["lan", "tunnel", "custom"]) {
    assert.deepEqual(remoteStartOptions({ ...draft, connection }), { bindAddress: draft.bindAddress, port: 1, publicUrl: connection === "custom" ? url : "", tunnel: connection === "tunnel" });
  }
  assert.throws(() => remoteStartOptions({ ...draft, connection: "custom", publicUrl: "  " }), /HTTPS/);
});

test("状态采纳保留有效地址和配对，服务关闭或地址消失作废二维码", () => {
  const previous = { status: running, url, pairing };
  assert.deepEqual(adoptRemoteStatus(previous, running), previous);
  assert.equal(adoptRemoteStatus(previous, stopped).pairing, null);
  assert.equal(adoptRemoteStatus(previous, { ...running, urls: ["http://localhost"] }).url, "http://localhost");
  assert.equal(adoptRemoteStatus(previous, { ...running, urls: ["http://localhost"], tunnel: { status: "starting" } }).url, "");
  assert.equal(adoptRemoteStatus({ ...previous, url: "http://localhost" }, { ...running, urls: [url, "http://localhost"] }).url, "http://localhost");
});

test("后台与手机页面禁止请求和写入；轮询串行并在隐藏时清理", async t => {
  const browser = installControllerWindow(t);
  for (const mode of ["inactive", "remote"]) {
    const h = fixture();
    if (mode === "inactive") h.options.active = false;
    else h.options.remote = true;
    const c = h.render();
    await c.start(); await c.refresh(); await c.stop(); await c.pair(); await c.revoke("phone");
    c.changeDraft("port", "1234"); c.selectUrl(url);
    assert.equal(h.calls.length, 0);
    assert.equal(h.render().draft.port, "43129");
    h.unmount();
  }
  const h = fixture(); h.render();
  browser.tick(); assert.equal(h.calls.length, 1);
  h.calls[0].resolve(stopped); await h.flush();
  const callback = [...browser.timers.values()][0];
  assert.equal(typeof callback, "function");
  h.options.active = false; h.render();
  assert.equal(browser.timers.size, 0);
  callback(); assert.equal(h.calls.length, 1);
});

test("隐藏重开保留草稿，旧轮询成功与失败都不能覆盖当前状态", async t => {
  installControllerWindow(t);
  for (const failed of [false, true]) {
    const h = fixture(); h.render().changeDraft("port", "43210");
    h.options.active = false; h.render(); h.options.active = true; h.render();
    h.calls[1].resolve(running); await h.flush();
    if (failed) h.calls[0].reject(new Error("old")); else h.calls[0].resolve(stopped);
    const c = await h.flush();
    assert.equal(c.status.running, true); assert.equal(c.error, ""); assert.equal(c.draft.port, "43210");
    h.unmount();
  }
});

test("写入立即锁定重复提交并作废旧轮询，失败保留草稿且允许显式重试", async t => {
  installControllerWindow(t);
  const h = fixture(); const c = h.render();
  const work = c.start(); await c.start(); await c.refresh();
  assert.equal(h.calls.filter(call => call.command === "start_remote_control").length, 1);
  h.calls[0].reject(new Error("old poll")); await h.flush();
  assert.equal(h.render().error, ""); assert.equal(h.render().busy, "start");
  h.calls[1].reject(new Error("start failed")); await work;
  assert.equal((await h.flush()).error, "start failed");
  h.calls.at(-1).resolve(stopped); await h.flush();
  assert.equal(h.render().error, "start failed", "自动读取不能掩盖写入错误");
  const retry = h.render().start(); h.calls.at(-1).resolve(running); await retry;
  assert.equal((await h.flush()).status.running, true);
  assert.equal(h.render().error, ""); h.unmount();
});

test("写入隐藏重开期间保持锁，旧结果不回写，完成后只重新读取而不重放", async t => {
  installControllerWindow(t);
  for (const failed of [false, true]) {
    const h = fixture(); h.render(); h.calls[0].resolve(stopped); await h.flush();
    const work = h.render().start(); h.render();
    h.options.active = false; h.render(); h.options.active = true; h.render();
    await h.render().start(); assert.equal(h.calls.length, 2);
    if (failed) h.calls[1].reject(new Error("late")); else h.calls[1].resolve(running);
    await work; const c = await h.flush();
    assert.equal(c.status.running, false); assert.equal(c.error, ""); assert.equal(c.busy, null);
    assert.equal(h.calls.at(-1).command, "remote_control_status");
    h.calls.at(-1).resolve(running); assert.equal((await h.flush()).status.running, true);
    assert.equal(h.calls.filter(call => call.command === "start_remote_control").length, 1); h.unmount();
  }
});

test("卸载后所有业务动作的成功、失败和 finally 都不回写或追加刷新", async t => {
  installControllerWindow(t);
  for (const name of ["start", "stop", "pair", "revoke", "refresh"]) {
    for (const failed of [false, true]) {
      const h = fixture(); h.render(); h.calls[0].resolve(name === "start" ? stopped : running); await h.flush();
      const work = h.render()[name]("phone"); const count = h.calls.length; h.unmount();
      if (failed) h.calls.at(-1).reject(new Error("late")); else h.calls.at(-1).resolve(name === "pair" ? pairing : running);
      await work; await h.flush();
      assert.equal(h.writesAfterUnmount, 0); assert.equal(h.calls.length, count);
    }
  }
});

test("同步校验失败后仍继续轮询，读取失败也可刷新恢复", async t => {
  const browser = installControllerWindow(t);
  const h = fixture(); h.render(); h.calls[0].resolve(stopped); await h.flush();
  h.render().changeDraft("port", "bad"); await h.render().start(); await h.flush();
  assert.match(h.render().error, /1–65535/); assert.equal(h.calls.at(-1).command, "remote_control_status");
  h.calls.at(-1).reject(new Error("read failed")); await h.flush();
  assert.equal(browser.timers.size, 1);
  const refresh = h.render().refresh(); h.calls.at(-1).resolve(stopped); await refresh; await h.flush();
  assert.equal(h.render().error, ""); h.unmount();
});
