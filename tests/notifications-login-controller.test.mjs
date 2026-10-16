import assert from "node:assert/strict";
import test from "node:test";
import { createControllerHarness, deferred, installControllerWindow } from "./helpers/controller-harness.mjs";
import { autoStubModule, collectElements, createModuleGraph, elementProps, elementType, textContent } from "./helpers/jsx-tree.mjs";

const state = createModuleGraph(new URL("../src/features/notifications/state.ts", import.meta.url)).exports;
const confirmed = { status: "confirmed", baseUrl: " https://ilink.example.com ", botToken: " test-only-token ",
  contextToken: " test-only-context ", recipientId: " test-recipient ", getUpdatesBuf: " test-cursor " };

function fixture(extra = {}, component = false) {
  const calls = [], patches = [], ui = autoStubModule("ui");
  const options = { active: true, disabled: false, channel: state.createNotificationChannel("wechatClaw", "first"),
    onChange: patch => patches.push(patch), ...extra };
  const h = createControllerHarness(new URL(component ? "../src/features/notifications/WechatClawChannelEditor.tsx" : "../src/features/notifications/useWechatClawLoginController.ts", import.meta.url),
    component ? "WechatClawChannelEditor" : "useWechatClawLoginController", {
      "../../api": { invoke(command, args) { const work = { command, args, ...deferred() }; calls.push(work); return work.promise; } },
      "../../components/ui": ui, "@tabler/icons-react": autoStubModule("icons"),
    });
  return { ...h, calls, patches, options, ui, render: () => h.render(options),
    async start(loginId = "login-one") {
      const work = h.render(options).startLogin();
      calls.at(-1).resolve({ status: "wait", loginId, qrCodeImageUrl: "data:image/svg+xml;base64,PHN2Zy8+" });
      await work; await h.flush();
    },
  };
}

test("微信激活凭据仅完整确认时变成渠道草稿，不完整响应不泄露凭据", () => {
  const patch = state.wechatBindingPatch(confirmed);
  assert.equal(patch.botToken, "test-only-token"); assert.equal(patch.contextToken, "test-only-context");
  assert.equal(patch.url, "https://ilink.example.com"); assert.equal(patch.chatId, "test-recipient"); assert.equal(patch.getUpdatesBuf, "test-cursor");
  assert.equal(patch.sessionStatus, "active"); assert.equal(patch.clearBotToken, false); assert.equal(patch.clearContextToken, false);
  assert.equal(state.wechatBindingPatch({ ...confirmed, getUpdatesBuf: undefined }).getUpdatesBuf, "");
  for (const key of ["baseUrl", "botToken", "contextToken", "recipientId"]) {
    for (const value of [undefined, "", "   "]) assert.throws(() => state.wechatBindingPatch({ ...confirmed, [key]: value }), /没有返回完整的激活凭据/);
  }
  assert.throws(() => state.wechatBindingPatch({ ...confirmed, status: "activating" }), /没有返回完整的激活凭据/);
});

test("扫码启动防重，等待、扫描和激活阶段串行轮询，确认只提交一次草稿", async t => {
  const browser = installControllerWindow(t); const h = fixture(); const c = h.render();
  const work = c.startLogin(); await c.startLogin(); assert.equal(h.calls.length, 1); assert.equal(h.render().isStarting, true);
  assert.equal(h.calls[0].command, "start_wechat_claw_login");
  h.calls[0].resolve({ status: "wait", loginId: "login-one", qrCodeImageUrl: "data:test" }); await work; await h.flush();
  assert.equal(h.calls[1].command, "poll_wechat_claw_login"); assert.deepEqual(h.calls[1].args, { loginId: "login-one" });
  for (const [status, phase, hint] of [["wait", "waiting", /扫描二维码/], ["scanned", "scanned", /确认授权/], ["activating", "activating", /发送一条消息/]]) {
    const count = h.calls.length; browser.tick(); assert.equal(h.calls.length, count);
    h.calls.at(-1).resolve({ status }); await h.flush();
    assert.equal(h.render().login.phase, phase); assert.match(h.render().login.message, hint); assert.equal(browser.timers.size, 1);
    browser.tick(); assert.equal(h.calls.length, count + 1);
  }
  h.calls.at(-1).resolve(confirmed); await h.flush(); assert.equal(h.render().login.phase, "confirmed");
  assert.deepEqual(h.patches, [state.wechatBindingPatch(confirmed)]); assert.equal(browser.timers.size, 0);
  h.render().failQrCode("login-one"); assert.equal(h.render().login.phase, "confirmed");
  const count = h.calls.length; browser.tick(); assert.equal(h.calls.length, count); h.unmount();
});

test("登录终态、网络错误和缺失凭据停止轮询并保留已有绑定", async t => {
  const browser = installControllerWindow(t);
  for (const response of [{ status: "expired" }, { status: "failed", message: "需重新扫码" }, { ...confirmed, contextToken: "" }, new Error("network failed")]) {
    const h = fixture(); await h.start();
    if (response instanceof Error) h.calls[1].reject(response); else h.calls[1].resolve(response);
    await h.flush(); assert.ok(["expired", "failed"].includes(h.render().login.phase));
    assert.deepEqual(h.patches, []); assert.equal(browser.timers.size, 0);
    browser.tick(); assert.equal(h.calls.length, 2); h.unmount();
  }
});

test("隐藏、禁用和未挂载状态不启动登录，启动失败可以显式重试", async t => {
  installControllerWindow(t);
  for (const extra of [{ active: false }, { disabled: true }]) {
    const h = fixture(extra); await h.render().startLogin(); assert.equal(h.calls.length, 0); h.unmount();
  }
  const h = fixture(); const c = h.render(); const work = c.startLogin(); h.calls[0].reject(new Error("启动失败")); await work;
  assert.equal(h.render().login.message, "启动失败"); assert.equal(h.render().isStarting, false);
  await h.start("retry"); assert.equal(h.calls[2].args.loginId, "retry"); h.unmount();
  await c.startLogin(); assert.equal(h.calls.length, 3); h.calls[2].resolve({ status: "wait" }); await h.flush(); assert.equal(h.writesAfterUnmount, 0);
});

test("隐藏或切换渠道使旧扫码启动失效，不自动重放生成请求", async t => {
  installControllerWindow(t);
  for (const mode of ["hidden", "channel"]) for (const failed of [false, true]) {
    const h = fixture(); const work = h.render().startLogin();
    if (mode === "hidden") { h.options.active = false; h.render(); h.options.active = true; h.render(); }
    else { h.options.channel = { ...h.options.channel, id: "second" }; h.render(); }
    await h.render().startLogin(); assert.equal(h.calls.length, 1);
    if (failed) h.calls[0].reject(new Error("stale")); else h.calls[0].resolve({ loginId: "obsolete", status: "wait" });
    await work; await h.flush(); assert.equal(h.render().login, null); assert.equal(h.render().isStarting, false);
    assert.equal(h.calls.length, 1); assert.deepEqual(h.patches, []); h.unmount();
  }
});

test("隐藏重开等待旧长轮询结束再查询，旧成功及错误不能写入绑定", async t => {
  const browser = installControllerWindow(t);
  for (const failed of [false, true]) {
    const h = fixture(); await h.start();
    h.options.active = false; h.render(); assert.equal(browser.timers.size, 0);
    h.options.active = true; h.render(); assert.equal(h.calls.length, 2);
    if (failed) h.calls[1].reject(new Error("stale failure")); else h.calls[1].resolve(confirmed);
    await h.flush(); assert.equal(h.calls.length, 3); assert.equal(h.calls[2].args.loginId, "login-one");
    assert.deepEqual(h.patches, []); assert.equal(h.render().login.phase, "waiting");
    // 后端在确认后移除临时会话；被作废的确认不能恢复，重读提示重新扫码。
    h.calls[2].resolve({ status: "expired" }); await h.flush(); assert.equal(h.render().login.phase, "expired"); h.unmount();
  }
});

test("隐藏期间暂停定时轮询，禁用结束后恢复当前登录", async t => {
  const browser = installControllerWindow(t); const h = fixture(); await h.start();
  h.calls[1].resolve({ status: "scanned", message: "custom hint" }); await h.flush(); assert.equal(h.render().login.message, "custom hint");
  h.options.active = false; h.render(); assert.equal(browser.timers.size, 0); browser.tick(); assert.equal(h.calls.length, 2);
  h.options.active = true; h.options.disabled = true; h.render(); assert.equal(h.calls.length, 2);
  h.options.disabled = false; h.render(); assert.equal(h.calls.length, 3);
  h.calls[2].resolve(confirmed); await h.flush(); assert.equal(h.patches.length, 1); h.unmount();
});

test("切换渠道与重新扫码不会串用旧轮询结果，旧 finally 只释放自身读取锁", async t => {
  installControllerWindow(t);
  for (const mode of ["channel", "restart"]) {
    const h = fixture(); await h.start();
    if (mode === "channel") { h.options.channel = { ...h.options.channel, id: "second" }; h.render(); assert.equal(h.render().login, null); }
    await h.start("login-two"); assert.equal(h.calls.length, 3); assert.equal(h.calls[2].command, "start_wechat_claw_login");
    h.calls[1].resolve(confirmed); await h.flush();
    assert.equal(h.calls.length, 4); assert.deepEqual(h.calls[3].args, { loginId: "login-two" }); assert.deepEqual(h.patches, []);
    h.calls[3].resolve(confirmed); await h.flush(); assert.equal(h.patches.length, 1); assert.equal(h.render().login.loginId, "login-two"); h.unmount();
  }
});

test("二维码失败停止采用当前轮询，旧图片错误不影响新扫码", async t => {
  const browser = installControllerWindow(t); const h = fixture(); await h.start();
  h.render().failQrCode("wrong-id"); assert.equal(h.render().login.phase, "waiting");
  h.render().failQrCode("login-one"); h.calls[1].resolve(confirmed); await h.flush();
  assert.match(h.render().login.message, /二维码加载失败/); assert.equal(browser.timers.size, 0); assert.deepEqual(h.patches, []);
  await h.start("login-two"); h.render().failQrCode("login-one"); assert.equal(h.render().login.phase, "waiting");
  h.calls.at(-1).resolve({ status: "wait" }); await h.flush(); h.unmount(); assert.equal(browser.timers.size, 0);
});

test("卸载清理轮询计时器，启动和轮询迟到成功、错误均不更新状态", async t => {
  const browser = installControllerWindow(t);
  for (const phase of ["start", "poll", "timer"]) for (const failed of [false, true]) {
    const h = fixture(); let work;
    if (phase === "start") work = h.render().startLogin(); else await h.start();
    if (phase === "timer") { h.calls[1].resolve({ status: "wait" }); await h.flush(); }
    h.unmount(); assert.equal(browser.timers.size, 0);
    if (phase !== "timer") {
      if (failed) h.calls.at(-1).reject(new Error("late")); else h.calls.at(-1).resolve(phase === "start" ? { loginId: "late" } : confirmed);
    }
    await work; await h.flush(); assert.equal(h.writesAfterUnmount, 0); assert.deepEqual(h.patches, []);
  }
});

test("扫码视图连接启动按钮、二维码加载错误与只读用户 ID", async t => {
  installControllerWindow(t); const h = fixture({}, true);
  const find = type => collectElements(h.render(), node => elementType(node) === type)[0];
  assert.match(textContent(h.render()), /扫码绑定/); assert.equal(elementProps(find(h.ui.Input)).readOnly, true);
  elementProps(find(h.ui.Button)).onClick(); assert.equal(elementProps(find(h.ui.Button)).disabled, true);
  h.calls[0].resolve({ loginId: "visible", status: "wait", qrCodeImageUrl: "data:test" }); await h.flush();
  assert.equal(elementProps(find("img")).alt, "微信 ClawBot 登录二维码"); elementProps(find("img")).onError();
  assert.match(textContent(h.render()), /二维码加载失败/); h.calls[1].resolve(confirmed); await h.flush(); assert.deepEqual(h.patches, []); h.unmount();
});
