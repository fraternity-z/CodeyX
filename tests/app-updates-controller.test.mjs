import assert from "node:assert/strict";
import test from "node:test";
import { createControllerHarness, deferred, installControllerWindow } from "./helpers/controller-harness.mjs";
import { createModuleGraph } from "./helpers/jsx-tree.mjs";

const state = createModuleGraph(new URL("../src/features/app-updates/state.ts", import.meta.url)).exports;
const asset = { platform: "windows", arch: "x64", packageType: "exe", fileName: "setup.exe", size: 1024,
  url: "https://example.test/setup.exe", sha256: "a".repeat(64) };
const update = { currentVersion: "1.0.0", latestVersion: "1.0.1", updateAvailable: true, releaseId: "42", selectedAsset: asset };
const downloaded = { latestVersion: "1.0.1", releaseId: "42", asset, filePath: "/updates/setup.exe", ...asset };

function updates(t, extra = {}) {
  const browser = installControllerWindow(t), calls = [], reports = [], notices = [], confirmations = [];
  let busy = null, confirmation = null;
  const options = { active: true, embedded: true, configLoaded: true, codeyUpdatePolicy: "stable", isBusy: false,
    config: { codeyUpdatePolicy: "stable", retained: "draft" },
    onConfigChange: value => { options.config = value; }, beforeInstall: async () => {},
    setBusy(value) { busy = typeof value === "function" ? value(busy) : value; options.isBusy = busy !== null; },
    setNotice: value => notices.push(value),
    setConfirmation(value) { confirmation = typeof value === "function" ? value(confirmation) : value; confirmations.push(confirmation); },
    ...extra };
  const h = createControllerHarness(new URL("../src/features/app-updates/useAppUpdatesController.ts", import.meta.url), "useAppUpdatesController", {
    "../../api": { invoke(command, args) {
      const call = { command, args, ...deferred() };
      (command === "update_install_report" ? reports : calls).push(call);
      return call.promise;
    } },
  });
  return { ...h, browser, calls, reports, notices, confirmations, options,
    get busy() { return busy; }, set busy(value) { options.setBusy(value); },
    get confirmation() { return confirmation; }, render: () => h.render(options) };
}

test("更新纯规则区分策略、缺少安装包和完整公告，匹配下载身份的所有字段", () => {
  assert.equal(state.updateAvailable(null), false); assert.equal(state.updateAvailable(update), true);
  for (const policy of ["stable", "off", "experimental"]) {
    for (const candidate of [{ ...update, prerelease: true }, { ...update, latestVersion: "1.0.1-beta.1" }]) {
      assert.equal(state.updateVersionAllowed(candidate, policy), policy === "experimental");
    }
    assert.equal(state.updateVersionAllowed({ ...update, latestVersion: "1.0.1+build-test" }, policy), true);
  }
  assert.match(state.updateCheckText(update), /发现 v1.0.1/);
  assert.match(state.updateCheckText({ ...update, selectedAsset: undefined }), /暂无可安装包/);
  assert.match(state.updateCheckText({ ...update, updateAvailable: false }), /当前已是最新/);
  assert.equal(state.updateResultTone(update), "success");
  assert.equal(state.updateResultTone({ ...update, selectedAsset: undefined }), "error");
  assert.deepEqual(state.releaseAnnouncement(), { releaseNotes: undefined, releaseTitle: undefined, releaseUrl: undefined });
  const notes = { releaseNotes: "  ## 原文\n", releaseTitle: "公告", releaseUrl: "https://example.test/release" };
  assert.deepEqual(state.releaseAnnouncement({ ...update, ...notes }), notes);
  assert.match(state.updateInstallReportText({ version: "1.0.1", message: "" }), /请重试/);
  assert.match(state.updateInstallReportText({ version: "1.0.1", message: "安装失败" }), /安装失败/);
  assert.equal(state.updatePromptKey(update), "1.0.1");
  assert.equal(state.matchesDownloadedUpdate(downloaded, update), true);
  assert.equal(state.matchesDownloadedUpdate(null, update), false);
  assert.equal(state.matchesDownloadedUpdate(downloaded, { ...update, selectedAsset: undefined }), false);
  for (const patch of [{ latestVersion: "2.0.0" }, { releaseId: "43" }, { prerelease: true },
    { asset: { ...asset, url: "https://example.test/other" } }, { fileName: "other.exe" }, { sha256: "b".repeat(64) }, { size: 2048 }]) {
    assert.equal(state.matchesDownloadedUpdate({ ...downloaded, ...patch }, update), false);
  }
});

test("初始隐藏暂停读取和事件，重开接收待展示公告且不重复消费安装报告", async t => {
  const h = updates(t, { active: false }); h.render(); assert.equal(h.reports.length, 0);
  window.__codeyPendingUpdatePrompt = update;
  window.__codeyUpdateAvailability = update;
  h.browser.dispatch("codey-update-prompt");
  assert.equal(h.render().updateCheck, null); assert.equal(h.confirmation, null);
  h.options.active = true; h.render(); assert.equal(h.reports.length, 1);
  assert.equal(h.confirmation.action, "download-update"); assert.equal(window.__codeyPendingUpdatePrompt, null);
  h.options.active = false; h.render();
  h.reports[0].resolve({ version: "1.0.1", status: "failed", message: "未能完成" }); await h.flush();
  assert.deepEqual(h.notices, []);
  h.options.active = true; h.render(); assert.equal(h.notices.length, 1); assert.match(h.notices[0].text, /未能完成/);
  h.options.active = false; h.render(); h.options.active = true; h.render();
  assert.equal(h.reports.length, 1); assert.equal(h.notices.length, 1); h.unmount();
});

test("手动检查同步防重，隐藏作废成功、失败及 finally，重开可以重新检查", async t => {
  for (const failed of [false, true]) {
    const h = updates(t), c = h.render(); const first = c.checkForUpdates(); await c.checkForUpdates();
    assert.equal(h.calls.length, 1); h.options.active = false; h.render();
    assert.equal(h.busy, null); assert.equal(h.browser.timers.size, 0);
    h.options.active = true; const second = h.render().checkForUpdates(); assert.equal(h.calls.length, 2);
    if (failed) h.calls[0].reject(new Error("旧错误")); else h.calls[0].resolve(update);
    await first; assert.equal(h.busy, "check-update"); assert.deepEqual(h.notices, []);
    h.calls[1].resolve({ ...update, latestVersion: "1.0.2" }); await second;
    assert.equal(h.render().updateCheck.latestVersion, "1.0.2"); assert.equal(h.busy, null); h.unmount();
  }
});

test("检查超时提示错误，迟到结果不回写也不释放新的忙碌状态", async t => {
  const h = updates(t); const first = h.render().checkForUpdates(); h.browser.tick(); await first;
  assert.match(h.notices.at(-1).text, /检查更新超时/);
  const second = h.render().checkForUpdates(); h.calls[0].resolve(update); await h.flush();
  assert.equal(h.render().updateCheck, null); assert.equal(h.busy, "check-update");
  h.busy = "another-operation"; h.calls[1].reject(new Error("网络不可用")); await second;
  assert.equal(h.busy, "another-operation"); assert.equal(h.notices.at(-1).text, "网络不可用"); h.unmount();
});

test("查询期间忽略可用版本广播，查询完成后继续接收新的后台版本", async t => {
  const h = updates(t); const work = h.render().checkForUpdates();
  window.dispatchEvent(new CustomEvent("codey-update-availability-changed", { detail: update }));
  assert.equal(h.render().updateCheck, null);
  h.calls[0].resolve(update); await work; h.render();
  const next = { ...update, latestVersion: "1.0.2" };
  window.dispatchEvent(new CustomEvent("codey-update-availability-changed", { detail: next }));
  assert.equal(h.render().updateCheck, next); assert.equal(h.calls.length, 1); h.unmount();
});

test("自动检查隐藏后清理计时器，重开立即刷新且旧响应不能覆盖", async t => {
  const h = updates(t, { embedded: false }); h.render(); assert.equal(h.calls.length, 1);
  h.options.active = false; h.render(); assert.equal(h.browser.timers.size, 0);
  h.options.active = true; h.render(); assert.equal(h.calls.length, 2);
  h.calls[0].resolve(update); await h.flush(); assert.equal(h.render().updateCheck, null);
  h.calls[1].resolve({ ...update, updateAvailable: false }); await h.flush();
  assert.equal(h.browser.timers.size, 1); h.unmount(); assert.equal(h.browser.timers.size, 0);
});

test("下载超时保留后台锁，迟到成功或错误不提示安装且不自动重放", async t => {
  for (const failed of [false, true]) {
    const h = updates(t), c = h.render(); const work = c.downloadUpdate(update);
    await c.downloadUpdate(update); await c.checkForUpdates(); assert.equal(h.calls.length, 1);
    h.browser.tick(); assert.match(h.notices[0].text, /后台结果尚未确认/); assert.equal(h.busy, "download-update");
    await h.render().downloadUpdate(update); assert.equal(h.calls.length, 1);
    if (failed) h.calls[0].reject(new Error("迟到错误")); else h.calls[0].resolve(downloaded);
    await work; assert.equal(h.busy, null); assert.equal(h.notices.length, 1); assert.equal(h.confirmation, null);
    assert.equal(h.render().downloadedUpdate, null);
    const retry = h.render().downloadUpdate(update); assert.equal(h.calls.length, 2);
    h.calls[1].resolve(downloaded); await retry; assert.equal(h.confirmation.action, "install-update"); h.unmount();
  }
});

test("下载在隐藏或策略变化后返回时保持防重，不采纳旧结果", async t => {
  for (const mode of ["hidden", "policy"]) for (const failed of [false, true]) {
    const h = updates(t); const work = h.render().downloadUpdate(update);
    if (mode === "hidden") { h.options.active = false; h.render(); h.options.active = true; }
    else h.options.codeyUpdatePolicy = "experimental";
    await h.render().downloadUpdate(update); assert.equal(h.calls.length, 1);
    if (failed) h.calls[0].reject(new Error("旧下载失败")); else h.calls[0].resolve(downloaded);
    await work; assert.equal(h.busy, null); assert.deepEqual(h.notices, []);
    assert.equal(h.render().downloadedUpdate, null); assert.equal(h.confirmation, null); h.unmount();
  }
});

test("过期下载与安装确认在隐藏重开、策略变化和重新检查后失效", async t => {
  for (const kind of ["download", "install"]) for (const mode of ["hidden", "policy", "check"]) {
    const h = updates(t); const c = h.render();
    if (kind === "download") c.askDownloadUpdate(update); else c.askInstallDownloadedUpdate(downloaded, update);
    const confirmation = h.confirmation;
    if (mode === "hidden") { h.options.active = false; h.render(); h.options.active = true; h.render(); }
    else if (mode === "policy") { h.options.codeyUpdatePolicy = "experimental"; h.render(); }
    else { const work = c.checkForUpdates(); h.calls[0].resolve({ ...update, updateAvailable: false }); await work; h.render(); }
    confirmation.run(); confirmation.onDismiss(); await h.flush();
    assert.equal(h.calls.length, mode === "check" ? 1 : 0); h.unmount();
  }
});

test("安装使用最新保存回调且同步防重，保存失败不启动安装器", async t => {
  const saved = deferred(); const h = updates(t); h.render().askInstallDownloadedUpdate(downloaded, update);
  let saves = 0; h.options.beforeInstall = () => { saves++; return saved.promise; }; h.render();
  const confirmation = h.confirmation; confirmation.run(); confirmation.run(); await h.flush();
  assert.equal(saves, 1); assert.equal(h.calls.length, 0); assert.equal(h.busy, "install-update");
  saved.reject(new Error("草稿保存失败")); await h.flush(); assert.equal(h.calls.length, 0);
  assert.match(h.notices.at(-1).text, /草稿保存失败/); assert.equal(h.busy, null);
  h.options.beforeInstall = async () => { saves++; }; h.render().askInstallDownloadedUpdate(downloaded, update);
  h.confirmation.run(); await h.flush(); assert.equal(h.calls[0].command, "install_downloaded_update");
  assert.deepEqual(h.calls[0].args, { filePath: downloaded.filePath });
  h.calls[0].resolve(); await h.flush(); assert.equal(h.busy, "install-update");
  await h.render().checkForUpdates(); assert.equal(h.calls.length, 1); h.unmount();
});

test("等待保存时隐藏或切换策略，不再继续启动安装器", async t => {
  for (const mode of ["hidden", "policy"]) {
    const saved = deferred(); const h = updates(t, { beforeInstall: () => saved.promise });
    h.render().askInstallDownloadedUpdate(downloaded); h.confirmation.run();
    if (mode === "hidden") h.options.active = false; else h.options.codeyUpdatePolicy = "experimental";
    h.render(); saved.resolve(); await h.flush(); assert.equal(h.calls.length, 0); assert.equal(h.busy, null); h.unmount();
  }
});

test("安装前保存预期策略仍可安装符合策略的版本，稳定版草稿禁止实验版", async t => {
  for (const prerelease of [false, true]) {
    const h = updates(t, { codeyUpdatePolicy: prerelease ? "experimental" : "stable",
      config: { codeyUpdatePolicy: prerelease ? "stable" : "off", retained: "draft" } });
    h.options.beforeInstall = async () => { h.options.codeyUpdatePolicy = h.options.config.codeyUpdatePolicy; h.render(); };
    h.render().askInstallDownloadedUpdate({ ...downloaded, prerelease });
    h.confirmation.run(); await h.flush();
    if (prerelease) {
      assert.equal(h.calls.length, 0); assert.equal(h.busy, null); assert.match(h.notices.at(-1).text, /不允许安装/);
    } else {
      assert.equal(h.calls[0].command, "install_downloaded_update"); h.calls[0].resolve(); await h.flush();
      assert.equal(h.busy, "install-update");
    }
    h.unmount();
  }
});

test("安装失败保留已下载文件并允许显式重试", async t => {
  const h = updates(t); const work = h.render().downloadUpdate(update); h.calls[0].resolve(downloaded); await work;
  h.render(); h.confirmation.run(); await h.flush(); h.calls[1].reject(new Error("启动失败")); await h.flush();
  assert.equal(h.busy, null); assert.equal(h.render().downloadedUpdate, downloaded); assert.match(h.notices.at(-1).text, /启动失败/);
  h.render().askInstallDownloadedUpdate(); assert.equal(h.confirmation.action, "install-update"); h.unmount();
});

test("策略确认使用最新共享草稿，隐藏或忙碌时不修改配置", async t => {
  const h = updates(t); const c = h.render(); c.changeUpdatePolicy("experimental");
  h.options.config = { ...h.options.config, retained: "new draft" }; h.render(); h.confirmation.run();
  assert.deepEqual(h.options.config, { codeyUpdatePolicy: "experimental", retained: "new draft" });
  c.changeUpdatePolicy("stable"); assert.equal(h.options.config.codeyUpdatePolicy, "stable");
  h.render().changeUpdatePolicy("experimental"); const confirmation = h.confirmation;
  h.options.active = false; h.render(); h.options.active = true; h.render(); confirmation.run();
  assert.equal(h.options.config.codeyUpdatePolicy, "stable");
  h.busy = "save"; h.render().changeUpdatePolicy("off"); assert.equal(h.options.config.codeyUpdatePolicy, "stable"); h.unmount();
});

test("卸载清理监听和全部计时器，迟到成功、错误与 finally 不回写", async t => {
  for (const action of ["check", "download", "install"]) for (const failed of [false, true]) {
    const h = updates(t), c = h.render();
    let work;
    if (action === "check") work = c.checkForUpdates();
    else if (action === "download") work = c.downloadUpdate(update);
    else { c.askInstallDownloadedUpdate(downloaded); h.confirmation.run(); await h.flush(); }
    h.unmount(); assert.equal(h.browser.timers.size, 0); const noticeCount = h.notices.length;
    h.reports[0].resolve({ version: "1.0.1", status: "failed", message: "迟到报告" });
    window.__codeyPendingUpdatePrompt = update; h.browser.dispatch("codey-update-prompt");
    window.dispatchEvent(new CustomEvent("codey-update-availability-changed", { detail: update }));
    if (failed) h.calls[0].reject(new Error("迟到异常")); else h.calls[0].resolve(action === "check" ? update : downloaded);
    await work; await h.flush(); assert.equal(h.writesAfterUnmount, 0); assert.equal(h.notices.length, noticeCount);
    assert.equal(h.busy, `${action}-update`); assert.equal(window.__codeyPendingUpdatePrompt, update);
  }
});
