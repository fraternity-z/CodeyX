import assert from "node:assert/strict";
import test from "node:test";
import { createControllerHarness, deferred, installControllerWindow } from "./helpers/controller-harness.mjs";
import { createModuleGraph } from "./helpers/jsx-tree.mjs";

const account = (id = "account-a", extra = {}) => ({ id, ...extra });
const snapshot = (accounts = [account()], extra = {}) => ({ accounts, ...extra });
const login = (loginId = "login-a") => ({ loginId, authUrl: "https://example.test/authorize", browserOpened: false });

function createAccountsHarness(overrides = {}) {
  const requests = [], remembered = [], loaded = [], applied = [], notices = [];
  const request = (command, args) => {
    const pending = deferred();
    requests.push({ command, args, ...pending });
    return pending.promise;
  };
  const options = {
    active: true, isBusy: false, onAccountsLoaded: value => loaded.push(value),
    onAccountsChanged: value => applied.push(value), onNotice: value => notices.push(value), ...overrides,
  };
  const h = createControllerHarness(
    new URL("../src/features/official-accounts/useOfficialAccountsController.ts", import.meta.url),
    "useOfficialAccountsController",
    {
      "../../api": { invoke: request },
      "../../officialAccountsRequests": {
        listOfficialAccounts: args => request("list_official_accounts", args),
        rememberOfficialAccounts: value => remembered.push(value),
      },
    },
  );
  return {
    ...h, render: () => h.render(options), options, requests, loaded, applied, notices, remembered,
    calls: command => requests.filter(request => request.command === command),
    async ready(accounts = [account()]) {
      h.render(options);
      requests.find(request => request.command === "list_official_accounts").resolve(snapshot(accounts));
      return h.flush();
    },
  };
}

test("账号请求适配保持命令、参数与登录类型对应", async () => {
  const calls = [];
  const { exports: { officialAccountsRequests: requests } } = createModuleGraph(
    new URL("../src/features/official-accounts/requests.ts", import.meta.url),
    { stubs: { "../../api": { invoke: (...args) => { calls.push(args); return Promise.resolve({}); } } } },
  );
  await requests.startLogin(); await requests.startSiwc("a");
  for (const kind of ["login", "siwc"]) {
    await requests.poll({ ...login(), kind }); await requests.cancel({ ...login(), kind });
  }
  await requests.importCurrent(); await requests.importCredential("fixture-credential");
  await requests.setDefault("a"); await requests.remove("a"); await requests.removeSiwc("a");
  assert.deepEqual(calls, [
    ["start_official_account_login"], ["start_official_account_siwc", { accountId: "a" }],
    ["poll_official_account_login", { loginId: "login-a" }], ["cancel_official_account_login", { loginId: "login-a" }],
    ["poll_official_account_siwc", { loginId: "login-a" }], ["cancel_official_account_siwc", { loginId: "login-a" }],
    ["import_current_codex_login"], ["import_official_account_credential", { credential: "fixture-credential" }],
    ["set_default_official_account", { accountId: "a" }], ["remove_official_account", { accountId: "a" }],
    ["remove_official_account_siwc", { accountId: "a" }],
  ]);
});

test("隐藏不读取，首次打开使用共享缓存，重开强制更新且忽略旧成功和错误", async t => {
  installControllerWindow(t);
  for (const failed of [false, true]) {
    const h = createAccountsHarness({ active: false });
    await h.render().refresh();
    assert.equal(h.requests.length, 0);
    h.options.active = true; h.render();
    assert.deepEqual(h.calls("list_official_accounts")[0].args, { force: false });
    h.options.active = false; h.render();
    h.options.active = true; h.render();
    assert.deepEqual(h.calls("list_official_accounts")[1].args, { force: true });
    const latest = snapshot([account("latest")]);
    h.calls("list_official_accounts")[1].resolve(latest);
    await h.flush();
    if (failed) h.calls("list_official_accounts")[0].reject(new Error("old failure"));
    else h.calls("list_official_accounts")[0].resolve(snapshot([account("old")]));
    const state = await h.flush();
    assert.deepEqual(state.accounts, latest.accounts);
    assert.equal(state.loadError, "");
    assert.deepEqual(h.loaded, [latest.accounts]);
    h.unmount();
  }
});

test("列表错误与格式错误可重新加载，回调变化不触发重复读取", async t => {
  installControllerWindow(t);
  for (const invalid of [false, true]) {
    const h = createAccountsHarness();
    h.render();
    if (invalid) h.requests[0].resolve({ accounts: {} });
    else h.requests[0].reject(new Error("offline"));
    let state = await h.flush();
    assert.match(state.loadError, invalid ? /列表格式无效/ : /offline/);
    assert.deepEqual(h.loaded, [null]);
    const received = [];
    h.options.onAccountsLoaded = value => received.push(value); h.render();
    assert.equal(h.calls("list_official_accounts").length, 1);
    const retry = state.refresh();
    h.calls("list_official_accounts")[1].resolve({}); await retry;
    state = await h.flush();
    assert.deepEqual(state.accounts, []); assert.equal(state.loadError, "");
    assert.deepEqual(received, [[]]);
    h.unmount();
  }
});

test("写入防止同一帧重复提交，并作废之前的列表读取", async t => {
  installControllerWindow(t);
  const h = createAccountsHarness();
  const state = await h.ready();
  const stale = state.refresh();
  const first = state.importCurrent();
  await state.importCurrent(); await state.startLogin(); await state.refresh();
  assert.equal(h.calls("import_current_codex_login").length, 1);
  assert.equal(h.calls("start_official_account_login").length, 0);
  assert.equal(h.render().pending, "import");
  h.calls("list_official_accounts")[1].resolve(snapshot([account("stale")])); await stale;
  assert.equal((await h.flush()).accounts[0].id, "account-a");
  const result = snapshot([account("new")]);
  h.calls("import_current_codex_login")[0].resolve(result); await first;
  assert.equal((await h.flush()).accounts[0].id, "new");
  assert.deepEqual(h.applied, [result]); assert.deepEqual(h.remembered, [result]);
  assert.match(h.notices[0].text, /已导入当前 Codex 登录/);
  assert.equal(h.render().pending, null);
  h.unmount();
});

test("首屏列表尚未返回时开始登录，登录失败后恢复被作废的列表读取", async t => {
  installControllerWindow(t);
  const h = createAccountsHarness(); h.render();
  const work = h.render().startLogin();
  h.calls("start_official_account_login")[0].reject(new Error("cannot start")); await work; await h.flush();
  assert.equal(h.calls("list_official_accounts").length, 2);
  h.calls("list_official_accounts")[0].resolve(snapshot([account("old")])); await h.flush();
  assert.equal(h.render().accounts, null);
  h.calls("list_official_accounts")[1].resolve(snapshot()); await h.flush();
  assert.equal(h.render().accounts[0].id, "account-a");
  assert.equal(h.render().pending, null);
  h.unmount();
});

test("写入时隐藏重开仍保持锁，结束后只重新读取，不自动重放", async t => {
  installControllerWindow(t);
  for (const failed of [false, true]) {
    const h = createAccountsHarness();
    const state = await h.ready();
    const work = state.importCurrent(); h.render();
    h.options.active = false; h.render();
    h.options.active = true; h.render();
    await h.render().importCurrent();
    assert.equal(h.calls("import_current_codex_login").length, 1);
    assert.equal(h.calls("list_official_accounts").length, 1);
    if (failed) h.calls("import_current_codex_login")[0].reject(new Error("late error"));
    else h.calls("import_current_codex_login")[0].resolve(snapshot([account("old")]));
    await work; await h.flush();
    assert.deepEqual(h.applied, []); assert.deepEqual(h.notices, []);
    assert.equal(h.calls("refresh_official_account_routes").length, 1);
    const result = snapshot([account("current")], { config: { marker: "current" } });
    h.calls("refresh_official_account_routes")[0].resolve(result);
    assert.equal((await h.flush()).accounts[0].id, "current");
    assert.deepEqual(h.applied, [result]);
    h.unmount();
  }
});

test("成功写入清除旧列表错误，同账号也重读额度且旧额度不能派生线路", async t => {
  installControllerWindow(t);
  const h = createAccountsHarness(); await h.ready();
  const read = h.render().refresh();
  h.calls("list_official_accounts")[1].reject(new Error("old list error")); await read; await h.flush();
  const work = h.render().setDefault(account()); h.render();
  h.calls("query_official_account_usage")[0].resolve({ status: "error", reason: "official_account_invalid" });
  await h.flush();
  assert.equal(h.calls("refresh_official_account_routes").length, 0);
  h.calls("set_default_official_account")[0].resolve(snapshot([account("account-a", { isDefault: true })]));
  await work; const state = await h.flush();
  assert.equal(state.loadError, "");
  assert.equal(h.calls("query_official_account_usage").length, 2);
  assert.equal(state.usagePending["account-a"], 1);
  h.unmount();
});

test("写入失败保留原账号、通知错误并读取实际状态，刷新失败不会重放操作", async t => {
  installControllerWindow(t);
  const h = createAccountsHarness();
  const state = await h.ready();
  const work = state.setDefault(account());
  h.calls("set_default_official_account")[0].reject(new Error("result uncertain")); await work;
  await h.flush();
  assert.equal(h.notices[0].tone, "error");
  assert.match(h.notices[0].text, /result uncertain/);
  h.calls("refresh_official_account_routes")[0].reject(new Error("refresh failed"));
  assert.equal((await h.flush()).loadError, "refresh failed");
  const retry = h.render().refresh();
  const latest = snapshot([account("account-a", { invalid: true })]);
  h.calls("refresh_official_account_routes")[1].resolve(latest); await retry;
  await h.flush();
  await h.render().setDefault(account()); await h.render().startSiwc(account());
  assert.equal(h.calls("set_default_official_account").length, 1);
  assert.equal(h.calls("start_official_account_siwc").length, 0);
  h.unmount();
});

test("默认账号切换、删除与直连停用保留运行生效和警告语义", async t => {
  installControllerWindow(t);
  for (const [method, command, extra, expected] of [
    ["setDefault", "set_default_official_account", {}, /本地路由已即时切换/],
    ["setDefault", "set_default_official_account", { restartRequired: true }, /重启后以该账号登录/],
    ["setDefault", "set_default_official_account", { warning: "fixture warning" }, /fixture warning/],
    ["executeRemove", "remove_official_account", {}, /官方账号已移除/],
    ["executeRemove", "remove_official_account", { warning: "fixture warning" }, /fixture warning/],
    ["executeRemoveSiwc", "remove_official_account_siwc", {}, /对话恢复默认通道/],
    ["executeRemoveSiwc", "remove_official_account_siwc", { warning: "fixture warning" }, /fixture warning/],
  ]) {
    const h = createAccountsHarness();
    const state = await h.ready([account("account-a", { siwcStatus: "active" })]);
    const work = state[method](account());
    h.calls(command)[0].resolve(snapshot([], extra)); await work;
    assert.deepEqual((await h.flush()).accounts, []);
    assert.match(h.notices[0].text, expected);
    assert.equal(h.notices[0].tone, extra.warning ? "info" : "success");
    await h.render()[method](account());
    assert.equal(h.calls(command).length, 1, "已移除的账号不能经旧确认回调继续写入");
    h.unmount();
  }
});

test("手动导入校验空输入、防重入、失败保留草稿，成功清除敏感输入", async t => {
  installControllerWindow(t);
  const h = createAccountsHarness();
  await h.ready();
  h.render().openManual(); await h.render().submitManual();
  assert.match(h.render().manualError, /请粘贴/);
  h.render().changeManualInput("  fixture-credential  ");
  const work = h.render().submitManual();
  h.render().closeManual(); h.render().changeManualInput("changed"); await h.render().submitManual();
  assert.equal(h.render().manualOpen, true);
  assert.equal(h.render().manualInput, "  fixture-credential  ");
  assert.equal(h.calls("import_official_account_credential").length, 1);
  assert.deepEqual(h.calls("import_official_account_credential")[0].args, { credential: "fixture-credential" });
  h.calls("import_official_account_credential")[0].reject(new Error("invalid fixture")); await work;
  let state = await h.flush();
  assert.equal(state.manualError, "invalid fixture"); assert.equal(state.manualOpen, true);
  h.calls("refresh_official_account_routes")[0].resolve(snapshot()); await h.flush();
  h.options.active = false; h.render(); h.options.active = true; h.render();
  assert.equal(h.render().manualInput, "  fixture-credential  ");
  const retry = h.render().submitManual();
  h.calls("import_official_account_credential")[1].resolve(snapshot([account("new")], { warning: "fixture warning" })); await retry;
  state = await h.flush();
  assert.equal(state.manualInput, ""); assert.equal(state.manualOpen, false);
  assert.equal(state.manualError, ""); assert.equal(h.notices[0].tone, "info");
  h.render().openManual(); h.render().changeManualInput("draft"); h.render().closeManual();
  assert.equal(h.render().manualInput, "");
  h.unmount();
});

test("全局忙碌、隐藏和过期确认均不触发账号写入", async t => {
  installControllerWindow(t);
  const h = createAccountsHarness();
  await h.ready([account("account-a", { isDefault: true }), account("invalid", { invalid: true })]);
  await h.render().setDefault(account()); await h.render().setDefault(account("invalid"));
  await h.render().executeRemove(account("missing")); await h.render().executeRemoveSiwc(account());
  for (const active of [false, true]) {
    h.options.active = active; h.options.isBusy = active;
    const state = h.render();
    await state.importCurrent(); await state.startLogin(); await state.startSiwc(account());
    state.openManual(); state.changeManualInput("fixture"); await h.render().submitManual();
    await state.executeRemove(account());
    assert.equal(h.render().manualOpen, false);
  }
  assert.equal(h.requests.filter(request => !["list_official_accounts", "query_official_account_usage"].includes(request.command)).length, 0);
  h.unmount();
});

test("隐藏期间手动导入成功后重开收起草稿，失败则保留且不会重复提交", async t => {
  installControllerWindow(t);
  for (const failed of [false, true]) {
    const h = createAccountsHarness(); await h.ready();
    h.render().openManual(); h.render().changeManualInput("fixture-credential");
    const work = h.render().submitManual();
    h.options.active = false; h.render();
    const request = h.calls("import_official_account_credential")[0];
    if (failed) request.reject(new Error("offline")); else request.resolve(snapshot());
    await work; await h.flush();
    assert.equal(h.render().manualInput, "fixture-credential");
    h.options.active = true; h.render();
    assert.equal(h.render().manualOpen, failed);
    assert.equal(h.render().manualInput, failed ? "fixture-credential" : "");
    assert.equal(h.calls("import_official_account_credential").length, 1);
    assert.deepEqual(h.notices, []);
    h.unmount();
  }
});

for (const kind of ["login", "siwc"]) {
  const start = kind === "login" ? "startLogin" : "startSiwc";
  const close = kind === "login" ? "closeLogin" : "closeSiwc";
  const stateKey = kind === "login" ? "login" : "siwcLogin";
  const errorKey = kind === "login" ? "loginError" : "siwcError";
  const startCommand = `start_official_account_${kind}`;
  const pollCommand = `poll_official_account_${kind}`;
  const cancelCommand = `cancel_official_account_${kind}`;

  async function begin(h) {
    await h.ready();
    const work = h.render()[start](account());
    h.calls(startCommand)[0].resolve(login()); await work; await h.flush();
  }

  test(`${kind} 授权轮询串行，隐藏暂停、重开恢复，成功提示与账号一致`, async t => {
    const browser = installControllerWindow(t);
    const h = createAccountsHarness();
    await begin(h);
    assert.equal(h.render()[stateKey].browserOpened, false);
    assert.equal(h.calls(pollCommand).length, 1);
    h.calls(pollCommand)[0].resolve({ status: "wait" }); await h.flush();
    assert.equal(browser.timers.size, 1);
    h.options.active = false; h.render();
    assert.equal(browser.timers.size, 0);
    browser.tick(); assert.equal(h.calls(pollCommand).length, 1);
    h.options.active = true; h.render();
    assert.equal(h.calls(pollCommand).length, 2);
    const result = snapshot([account("added")], { status: "ok", warning: "fixture warning" });
    h.calls(pollCommand)[1].resolve(result); await h.flush();
    assert.equal(h.render()[stateKey], null); assert.deepEqual(h.applied, [result]);
    assert.match(h.notices[0].text, /fixture warning/);
    assert.equal(h.notices[0].tone, kind === "login" ? "success" : "info");
    assert.equal(browser.timers.size, 0);
    h.unmount();
  });

  test(`${kind} 失败和过期允许显式重试，清理旧授权后忽略旧响应`, async t => {
    installControllerWindow(t);
    for (const result of [{ status: "failed" }, { status: "expired" }, { status: "failed", message: "fixture error" }, new Error("offline")]) {
      const h = createAccountsHarness(); await begin(h);
      if (result instanceof Error) h.calls(pollCommand)[0].reject(result);
      else h.calls(pollCommand)[0].resolve(result);
      await h.flush(); assert.ok(h.render()[errorKey]);
      const work = kind === "login" ? h.render().startLogin() : h.render().restartSiwc();
      assert.equal(h.calls(cancelCommand).length, 1);
      h.calls(cancelCommand)[0].reject(new Error("cancel failed"));
      h.calls(startCommand)[1].resolve(login("login-b")); await work; await h.flush();
      assert.equal(h.render()[stateKey].loginId, "login-b"); assert.equal(h.render()[errorKey], "");
      h.render()[close]();
      h.calls(pollCommand)[1].reject(new Error("late error")); await h.flush();
      assert.equal(h.render()[stateKey], null); assert.equal(h.render()[errorKey], "");
      assert.deepEqual(h.notices, []);
      h.unmount();
    }
  });

  test(`${kind} 开始失败释放锁，卸载或隐藏时迟到的新授权会被取消`, async t => {
    installControllerWindow(t);
    for (const mode of ["failed", "hidden", "unmounted", "closed"]) {
      const h = createAccountsHarness(); await h.ready();
      const work = h.render()[start](account());
      await h.render()[start](account());
      assert.equal(h.calls(startCommand).length, 1);
      if (mode === "failed") h.calls(startCommand)[0].reject(new Error("cannot start"));
      else {
        if (mode === "hidden") { h.options.active = false; h.render(); }
        if (mode === "unmounted") h.unmount();
        if (mode === "closed") h.render()[close]();
        h.calls(startCommand)[0].resolve(login());
      }
      await work; await h.flush();
      if (mode === "failed") assert.match(h.notices[0].text, /cannot start/);
      else { assert.equal(h.calls(cancelCommand).length, 1); assert.deepEqual(h.notices, []); }
      assert.equal(h.writesAfterUnmount, 0);
      if (mode !== "unmounted") { assert.equal(h.render()[stateKey], null); h.unmount(); }
    }
  });

  test(`${kind} 隐藏后旧轮询成功仅触发重新读取，不恢复旧授权或弹出成功提示`, async t => {
    installControllerWindow(t);
    const h = createAccountsHarness(); await begin(h);
    h.options.active = false; h.render();
    h.calls(pollCommand)[0].resolve(snapshot([account("old")], { status: "ok" })); await h.flush();
    assert.deepEqual(h.applied, []); assert.deepEqual(h.notices, []);
    assert.equal(h.calls("refresh_official_account_routes").length, 0);
    h.options.active = true; h.render();
    assert.equal(h.render()[stateKey], null);
    assert.equal(h.calls(pollCommand).length, 1);
    const result = snapshot([account("actual")]);
    h.calls("refresh_official_account_routes")[0].resolve(result); await h.flush();
    assert.deepEqual(h.applied, [result]);
    h.unmount();
  });

  test(`${kind} 卸载清理授权及定时器，迟到轮询不回写`, async t => {
    const browser = installControllerWindow(t);
    for (const failed of [false, true]) {
      const h = createAccountsHarness(); await begin(h); h.unmount();
      assert.equal(h.calls(cancelCommand).length, 1);
      if (failed) h.calls(pollCommand)[0].reject(new Error("late failure"));
      else h.calls(pollCommand)[0].resolve(snapshot([], { status: "ok" }));
      await h.flush();
      assert.equal(h.writesAfterUnmount, 0); assert.equal(browser.timers.size, 0);
      assert.deepEqual(h.applied, []); assert.deepEqual(h.notices, []);
    }
  });

  test(`${kind} 已取消授权的迟到成功不覆盖新授权，卸载清理轮询间隔`, async t => {
    const browser = installControllerWindow(t);
    const h = createAccountsHarness(); await begin(h);
    h.render()[close]();
    const work = h.render()[start](account());
    h.calls(startCommand)[1].resolve(login("login-b")); await work; await h.flush();
    h.calls(pollCommand)[0].resolve(snapshot([account("obsolete")], { status: "ok" })); await h.flush();
    assert.equal(h.render()[stateKey].loginId, "login-b");
    assert.deepEqual(h.applied, []);
    h.calls("refresh_official_account_routes")[0].resolve(snapshot()); await h.flush();
    h.calls(pollCommand)[1].resolve({ status: "wait" }); await h.flush();
    const callback = [...browser.timers.values()][0];
    assert.equal(typeof callback, "function");
    h.unmount();
    assert.equal(browser.timers.size, 0);
    callback(); await h.flush();
    assert.equal(h.calls(pollCommand).length, 2);
    assert.equal(h.writesAfterUnmount, 0);
  });
}

test("卸载后的列表和账号写入成功、失败均不回写", async t => {
  installControllerWindow(t);
  for (const writing of [false, true]) for (const failed of [false, true]) {
    const h = createAccountsHarness();
    let work;
    if (writing) { await h.ready(); work = h.render().importCurrent(); }
    else h.render();
    h.unmount();
    const request = h.calls(writing ? "import_current_codex_login" : "list_official_accounts")[0];
    if (failed) request.reject(new Error("late failure")); else request.resolve(snapshot());
    await work; await h.flush();
    assert.equal(h.writesAfterUnmount, 0); assert.deepEqual(h.applied, []); assert.deepEqual(h.notices, []);
  }
});
