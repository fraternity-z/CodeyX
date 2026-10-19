import assert from "node:assert/strict";
import test from "node:test";
import { createControllerHarness, deferred, installControllerWindow } from "./helpers/controller-harness.mjs";
import { autoStubModule, collectElements, createModuleGraph, elementProps, elementType, textContent } from "./helpers/jsx-tree.mjs";

const state = createModuleGraph(new URL("../src/features/notifications/state.ts", import.meta.url)).exports;
const channel = (patch = {}) => ({ ...state.createNotificationChannel("feishu", "channel-1"), url: "https://notify.example.com/hook", ...patch });
const config = (patch = {}) => ({ settingsRevision: 1, profiles: [], activeProfileId: "", retained: "shared draft", webhook: { channels: [] }, ...patch });

function notifications(extra = {}) {
  const calls = [], notices = [], adopted = [];
  let busy = null, confirmation;
  const owner = createControllerHarness(new URL("../src/useDraftConfig.ts", import.meta.url), "useDraftConfig");
  owner.render().setPersistedConfig(config()); owner.render();
  const options = { active: true, config: owner.render().config, isBusy: false,
    setBusy(value) { busy = typeof value === "function" ? value(busy) : value; },
    setNotice: value => notices.push(value), setConfirmation: value => { confirmation = value; },
    onSaved(result, submitted) {
      const c = owner.render();
      const merged = submitted ? c.adoptSavedConfig(result.config, submitted) : c.adoptRouteConfig(result.config);
      if (!merged) return false;
      c.setDirty(merged.dirty); adopted.push(result); return true;
    }, ...extra };
  const h = createControllerHarness(new URL("../src/features/notifications/useNotificationsController.ts", import.meta.url), "useNotificationsController", {
    "../../api": { invoke(command, args) { const call = { command, args, ...deferred() }; calls.push(call); return call.promise; } },
  });
  return { ...h, owner, options, calls, notices, adopted,
    get busy() { return busy; }, get confirmation() { return confirmation; },
    render() { options.config = owner.render().config; return h.render(options); },
    saveResult(index = calls.length - 1, patch = {}) { const result = { config: { ...calls[index].args.config, settingsRevision: 2, ...patch } }; calls[index].resolve(result); return result; },
  };
}

function dialog(extra = {}, component = false) {
  const calls = [], saves = [], feedback = [], opened = [];
  const ui = autoStubModule("ui");
  const options = { active: true, open: true, editingChannel: channel(), isBusy: false,
    onOpenChange: value => opened.push(value), onSave(value) { const work = { channel: value, ...deferred() }; saves.push(work); return work.promise; },
    onFeedback: value => feedback.push(value), ...extra };
  const h = createControllerHarness(new URL(component ? "../src/features/notifications/NotificationChannelDialog.tsx" : "../src/features/notifications/useNotificationChannelController.ts", import.meta.url),
    component ? "NotificationChannelDialog" : "useNotificationChannelController", {
      "../../api": { invoke(command, args) { const call = { command, args, ...deferred() }; calls.push(call); return call.promise; } },
      "../../components/ui": ui, "@tabler/icons-react": autoStubModule("icons"),
      "@heroui/react": { toast: { success: text => feedback.push({ tone: "success", text }), danger: text => feedback.push({ tone: "error", text }) } },
    });
  return { ...h, options, calls, saves, feedback, opened, ui, render: () => h.render(options) };
}

test("通知纯规则覆盖全部渠道、已保存凭据、清除标记与过期绑定", () => {
  for (const kind of ["feishu", "wecom", "telegram", "ntfy", "wechatClaw"]) {
    const empty = state.createNotificationChannel(kind, "new-id");
    assert.equal(empty.kind, kind); assert.equal(empty.id, "new-id"); assert.equal(empty.enabled, true);
    assert.equal(state.isChannelConfigured(empty), false);
    const saved = { ...empty, urlConfigured: true, botTokenConfigured: true, contextTokenConfigured: true, chatId: "recipient" };
    assert.equal(state.isChannelConfigured(saved), true);
    if (kind !== "telegram") assert.equal(state.isChannelConfigured({ ...saved, clearUrl: true }), false);
    if (["telegram", "wechatClaw"].includes(kind)) assert.equal(state.isChannelConfigured({ ...saved, clearBotToken: true }), false);
    if (["telegram", "ntfy", "wechatClaw"].includes(kind)) assert.equal(state.isChannelConfigured({ ...saved, chatId: "  " }), false);
    if (kind === "wechatClaw") {
      assert.equal(state.isChannelConfigured({ ...saved, clearContextToken: true }), false);
      assert.equal(state.isChannelConfigured({ ...saved, sessionStatus: "expired" }), false);
      assert.equal(state.isChannelConfigured({ ...saved, contextToken: "test-context", clearContextToken: true }), true);
    }
  }
  assert.equal(state.isChannelConfigured(channel({ kind: "unknown" })), false);
  assert.equal(state.isChannelConfigured(channel({ url: "  " })), false);
  assert.equal(state.isChannelConfigured(channel({ clearUrl: true })), true);
});

test("渠道保存经请求层提交最新配置，同步防重并保留保存期间的新草稿", async t => {
  installControllerWindow(t);
  const h = notifications(); const c = h.render();
  h.owner.render().editConfig(config({ retained: "already edited" })); h.render();
  const work = c.addNotificationChannel(channel());
  assert.equal(await c.addNotificationChannel(channel()), false);
  assert.equal(h.calls.length, 1); assert.equal(h.busy, "save-notification-channel");
  assert.equal(h.calls[0].command, "save_codey_config"); assert.equal(h.calls[0].args.config.retained, "already edited");
  assert.deepEqual(h.calls[0].args.config.webhook.channels, [channel()]);
  h.owner.render().editConfig(config({ retained: "newer draft" })); h.render();
  h.saveResult(); assert.equal(await work, true);
  const owner = h.owner.render();
  assert.equal(owner.config.retained, "newer draft"); assert.equal(owner.dirty, true);
  assert.equal(owner.persistedConfigRef.current.retained, "already edited");
  assert.deepEqual(owner.config.webhook.channels, [channel()]);
  assert.equal(h.busy, null); assert.match(h.notices[0].text, /已保存，自动通知已生效/); h.unmount();
});

test("渠道更新固定身份，删除确认使用最新配置且失败保留草稿", async t => {
  installControllerWindow(t);
  const h = notifications(); h.owner.render().setPersistedConfig(config({ webhook: { channels: [channel()] } }));
  const c = h.render();
  const update = c.updateNotificationChannel("channel-1", { id: "wrong", kind: "ntfy", enabled: false });
  assert.deepEqual(h.calls[0].args.config.webhook.channels, [channel({ enabled: false })]);
  h.calls[0].reject(new Error("保存失败")); assert.equal(await update, false);
  assert.equal(h.owner.render().config.webhook.channels[0].enabled, true); assert.equal(h.notices.at(-1).text, "保存失败");
  c.askRemoveNotificationChannel(channel()); assert.match(h.confirmation.title, /删除飞书/);
  h.owner.render().editConfig(config({ retained: "latest", webhook: { channels: [channel(), channel({ id: "kept" })] } })); h.render();
  h.confirmation.run(); assert.deepEqual(h.calls[1].args.config.webhook.channels.map(item => item.id), ["kept"]);
  assert.equal(h.calls[1].args.config.retained, "latest");
  h.saveResult(); await h.flush(); assert.equal(h.notices.at(-1).text, "通知渠道已删除");
  assert.equal(h.owner.render().dirty, false); h.unmount();
});

test("通知保存返回后台应用状态时释放表单，不提前宣称通知已生效", async t => {
  installControllerWindow(t);
  const h = notifications();
  const work = h.render().addNotificationChannel(channel());
  h.calls[0].resolve({ config: { ...h.calls[0].args.config, settingsRevision: 2 },
    configApply: { settingsRevision: 2, phase: "pending" } });
  assert.equal(await work, true);
  assert.equal(h.busy, null);
  assert.equal(h.owner.render().dirty, false);
  assert.deepEqual(h.notices.at(-1), { tone: "info", text: "通知设置已保存，正在后台应用" });
  h.unmount();
});

test("无效、重复、超限和缺失渠道不提交，隐藏及忙碌时不执行动作", async t => {
  installControllerWindow(t);
  for (const mode of ["hidden", "busy", "duplicate", "limit", "invalid"]) {
    const h = notifications({ active: mode !== "hidden", isBusy: mode === "busy" });
    if (mode === "duplicate") h.owner.render().setPersistedConfig(config({ webhook: { channels: [channel()] } }));
    if (mode === "limit") h.owner.render().setPersistedConfig(config({ webhook: { channels: Array.from({ length: 32 }, (_, i) => channel({ id: `c-${i}` })) } }));
    const c = h.render(); await c.addNotificationChannel(channel(mode === "invalid" ? { url: "" } : {}));
    await c.updateNotificationChannel("missing", {}); c.askRemoveNotificationChannel(channel({ id: "missing" }));
    assert.equal(h.calls.length, 0, mode); assert.equal(h.confirmation, undefined); h.unmount();
  }
  const h = notifications(); h.owner.render().setPersistedConfig(config({ webhook: { channels: [channel()] } }));
  const c = h.render(); await c.updateNotificationChannel("channel-1", { url: "" });
  c.askRemoveNotificationChannel(channel()); h.options.active = false; h.render(); h.options.active = true; h.render(); h.confirmation.run();
  assert.equal(h.calls.length, 0); h.unmount();
});

test("旧版本保存不能覆盖较新共享状态，也不能显示成功", async t => {
  installControllerWindow(t); const h = notifications(); const work = h.render().addNotificationChannel(channel());
  h.owner.render().setPersistedConfig(config({ settingsRevision: 5, retained: "newest" })); h.render();
  h.saveResult(); assert.equal(await work, false); assert.equal(h.adopted.length, 0);
  assert.equal(h.owner.render().config.retained, "newest"); assert.deepEqual(h.notices, []); h.unmount();
});

test("隐藏作废保存响应，重开只重新读取结果，失败不丢失未保存配置", async t => {
  installControllerWindow(t);
  for (const failed of [false, true]) {
    const h = notifications(); h.owner.render().editConfig(config({ retained: "unsaved" }));
    const work = h.render().addNotificationChannel(channel());
    h.options.active = false; h.render(); h.options.active = true; h.render();
    assert.equal(await h.render().addNotificationChannel(channel()), false); assert.equal(h.calls.length, 1);
    if (failed) h.calls[0].reject(new Error("stale failure")); else h.saveResult();
    assert.equal(await work, false); await h.flush();
    assert.equal(h.calls.length, 2); assert.equal(h.calls[1].command, "load_codey_config");
    assert.deepEqual(h.adopted, []); assert.deepEqual(h.notices, []);
    h.calls[1].resolve({ config: failed ? config() : config({ settingsRevision: 2, retained: "unsaved", webhook: { channels: [channel()] } }) });
    await h.flush(); assert.equal(h.adopted.length, 1);
    assert.equal(h.owner.render().config.retained, "unsaved"); assert.equal(h.owner.render().dirty, failed);
    assert.equal(h.calls.filter(call => call.command === "save_codey_config").length, 1); h.unmount();
  }
});

test("卸载后保存的成功、失败与 finally 不回写或清除其他操作状态", async t => {
  installControllerWindow(t);
  for (const failed of [false, true]) {
    const h = notifications(); const work = h.render().addNotificationChannel(channel()); h.unmount();
    if (failed) h.calls[0].reject(new Error("late")); else h.saveResult();
    await work; await h.flush(); assert.equal(h.writesAfterUnmount, 0); assert.deepEqual(h.adopted, []); assert.deepEqual(h.notices, []);
    assert.equal(h.busy, "save-notification-channel");
  }
});

test("保存后的旧刷新被作废，刷新失败保留草稿与写入锁，重开确认后恢复", async t => {
  installControllerWindow(t); const h = notifications();
  const work = h.render().addNotificationChannel(channel()); h.options.active = false; h.render();
  h.saveResult(); await work; await h.flush(); assert.equal(h.calls.length, 1);
  h.options.active = true; h.render(); assert.equal(h.calls[1].command, "load_codey_config");
  h.options.active = false; h.render(); h.options.active = true; h.render();
  assert.equal(h.calls[2].command, "load_codey_config");
  h.calls[1].resolve({ config: config({ settingsRevision: 2, retained: "stale read" }) }); await h.flush();
  assert.deepEqual(h.adopted, []);
  h.calls[2].reject(new Error("读取失败")); await h.flush(); assert.match(h.notices.at(-1).text, /未能重新读取/);
  await h.render().addNotificationChannel(channel()); assert.equal(h.calls.length, 3);
  h.options.active = false; h.render(); h.options.active = true; h.render();
  h.calls[3].resolve({ config: config({ settingsRevision: 2, webhook: { channels: [channel()] } }) }); await h.flush();
  assert.equal(h.adopted.length, 1); const update = h.render().updateNotificationChannel("channel-1", { enabled: false });
  h.saveResult(4, { settingsRevision: 3 }); assert.equal(await update, true); h.unmount();
});

test("通知表单统一校验并锁住保存和测试，成功保存后才关闭", async t => {
  installControllerWindow(t); const h = dialog(); const c = h.render();
  const work = c.saveChannel(); await c.saveChannel(); await c.testChannel(); c.closeDialog();
  assert.equal(h.saves.length, 1); assert.deepEqual(h.opened, []); assert.equal(h.render().isSaving, true);
  h.saves[0].resolve(false); await work; assert.deepEqual(h.opened, []); assert.equal(h.render().draft.url, channel().url);
  const success = h.render().saveChannel(); h.saves[1].resolve(true); await success;
  assert.deepEqual(h.opened, [false]); h.unmount();
});

test("保存异常保留表单，测试发送携带草稿并区分微信的已接受提示", async t => {
  installControllerWindow(t);
  for (const kind of ["feishu", "wechatClaw"]) {
    const h = dialog({ editingChannel: channel({ kind, chatId: "test-recipient", botTokenConfigured: true, contextTokenConfigured: true }) });
    const c = h.render(); c.updateDraft({ enabled: false, id: "ignored", kind: "ntfy" }); h.render();
    const work = c.testChannel(); await c.saveChannel(); assert.equal(h.saves.length, 0);
    assert.equal(h.calls[0].command, "test_notification_channel"); assert.equal(h.calls[0].args.channel.enabled, false);
    assert.equal(h.calls[0].args.channel.kind, kind); assert.equal(h.calls[0].args.channel.id, "channel-1");
    h.calls[0].resolve(); await work; assert.match(h.feedback.at(-1).text, kind === "wechatClaw" ? /iLink 已接受/ : /测试发送成功/);
    const save = h.render().saveChannel(); h.saves[0].reject(new Error("save failed")); await save;
    assert.equal(h.feedback.at(-1).text, "save failed"); assert.equal(h.render().draft.enabled, false); assert.deepEqual(h.opened, []); h.unmount();
  }
});

test("表单切换渠道与隐藏重开保留草稿，关闭后重新打开才重置", async t => {
  installControllerWindow(t); const h = dialog({ editingChannel: null }); const c = h.render();
  assert.equal(c.canSave, false); await c.saveChannel(); await c.testChannel(); assert.equal(h.saves.length + h.calls.length, 0);
  const original = c.draft.id; c.selectChannel("ntfy"); const next = h.render(); assert.notEqual(next.draft.id, original);
  next.updateDraft({ url: "https://ntfy.example.com", chatId: "topic" }); assert.equal(h.render().canSave, true);
  const draft = h.render().draft; h.options.active = false; h.render(); c.updateDraft({ chatId: "ignored" }); await c.testChannel();
  h.options.active = true; h.render(); assert.equal(h.render().draft, draft);
  h.options.open = false; h.render(); h.options.open = true; assert.equal(h.render().draft.kind, "feishu");
  h.options.isBusy = true; h.render(); c.selectChannel("telegram"); c.updateDraft({ url: "ignored" }); c.closeDialog();
  await c.saveChannel(); await c.testChannel(); assert.deepEqual(h.opened, []); assert.equal(h.calls.length, 0); h.unmount();
});

test("过期测试或保存响应不会关闭新表单、显示提示或解除新操作的锁", async t => {
  installControllerWindow(t);
  for (const kind of ["saveChannel", "testChannel"]) for (const failed of [false, true]) {
    const h = dialog(); const work = h.render()[kind]();
    h.options.active = false; h.render(); h.options.active = true; h.render();
    h.options.editingChannel = channel({ id: "other" }); h.render(); await h.render()[kind]();
    const request = kind === "saveChannel" ? h.saves[0] : h.calls[0];
    if (failed) request.reject(new Error("stale")); else request.resolve(true);
    await work; assert.deepEqual(h.feedback, []); assert.deepEqual(h.opened, []);
    assert.equal(h.render().draft.id, "other"); assert.equal(h.saves.length + h.calls.length, 1);
    const next = h.render()[kind](); assert.equal(h.render().formBusy, true);
    (kind === "saveChannel" ? h.saves[1] : h.calls[1]).resolve(true); await next; h.unmount();
  }
});

test("发送超时保留后台锁且不自动重放，结束后显式测试不受旧结果影响", async t => {
  const browser = installControllerWindow(t); const h = dialog(); const work = h.render().testChannel();
  browser.tick(); assert.match(h.feedback[0].text, /发送结果尚未确认/);
  await h.render().testChannel(); await h.render().saveChannel(); h.render().closeDialog();
  assert.equal(h.calls.length, 1); assert.equal(h.render().isTesting, true); assert.deepEqual(h.opened, []);
  h.calls[0].resolve(); await work; assert.equal(h.feedback.length, 1); assert.equal(h.render().isTesting, false);
  const retry = h.render().testChannel(); h.calls[1].reject(new Error("explicit failure")); await retry;
  assert.equal(h.feedback.at(-1).text, "explicit failure"); assert.equal(browser.timers.size, 0); h.unmount();
});

test("表单卸载清理计时器，迟到成功、错误与 finally 不更新状态", async t => {
  const browser = installControllerWindow(t);
  for (const kind of ["saveChannel", "testChannel"]) for (const failed of [false, true]) {
    const h = dialog(); const work = h.render()[kind](); h.unmount(); assert.equal(browser.timers.size, 0);
    const request = kind === "saveChannel" ? h.saves[0] : h.calls[0];
    if (failed) request.reject(new Error("late")); else request.resolve(true);
    await work; assert.deepEqual(h.feedback, []); assert.deepEqual(h.opened, []); assert.equal(h.writesAfterUnmount, 0);
  }
});

test("通知视图接线保留测试、保存、忙碌阻止关闭和隐藏状态", async t => {
  installControllerWindow(t); const h = dialog({}, true);
  const find = (type, label) => collectElements(h.render(), node => elementType(node) === type && (!label || textContent(node) === label))[0];
  const testButton = () => find(h.ui.Button, "测试发送");
  elementProps(testButton()).onClick(); assert.equal(h.calls[0].command, "test_notification_channel");
  assert.equal(elementProps(find(h.ui.Button, "保存配置")).disabled, true);
  let prevented = false; elementProps(find(h.ui.DialogContent)).onEscapeKeyDown({ preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  h.calls[0].resolve(); await h.flush(); assert.equal(h.feedback[0].text, "测试发送成功");
  elementProps(find(h.ui.Button, "保存配置")).onClick(); h.saves[0].resolve(true); await h.flush(); assert.deepEqual(h.opened, [false]);
  h.options.active = false; assert.equal(elementProps(find(h.ui.Dialog)).open, false); h.unmount();
});
