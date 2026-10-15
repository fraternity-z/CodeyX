import assert from "node:assert/strict";
import test from "node:test";
import { createControllerHarness, deferred, installControllerWindow } from "./helpers/controller-harness.mjs";

const account = (id = "account-a", extra = {}) => ({ id, ...extra });
const usage = (planType = "plus") => ({ status: "ok", planType });
const invalid = { status: "error", reason: "official_account_invalid", message: "expired" };

function createUsageHarness(overrides = {}) {
  const reads = [], routes = [], applied = [], errors = [];
  const options = {
    active: true, accounts: [account()],
    onAccountsChanged: (result) => applied.push(result), onError: (message) => errors.push(message),
    ...overrides,
  };
  const harness = createControllerHarness(
    new URL("../src/features/official-accounts/useOfficialAccountUsageController.ts", import.meta.url),
    "useOfficialAccountUsageController",
    { "../../api": { invoke(command, args) {
      const pending = deferred();
      if (command === "query_official_account_usage") reads.push({ ...pending, args });
      else if (command === "refresh_official_account_routes") routes.push(pending);
      else throw new Error(`unexpected command: ${command}`);
      return pending.promise;
    } } },
  );
  return { ...harness, render: () => harness.render(options), options, reads, routes, applied, errors };
}

test("额度只查询当前活动页的有效账号，恢复有效后重新读取", async (t) => {
  installControllerWindow(t);
  const h = createUsageHarness({ active: false });
  await h.render().refreshUsage("account-a", true);
  assert.equal(h.reads.length, 0);
  h.options.active = true;
  h.options.accounts = null;
  await h.render().refreshUsage("missing", true);
  h.options.accounts = [account("account-a", { invalid: true, invalidReason: "expired" }), account("account-b", { invalid: true })];
  const state = h.render();
  assert.equal(state.usages["account-a"].message, "expired");
  assert.match(state.usages["account-b"].message, /账号已失效/);
  await state.refreshUsage("account-a", true);
  assert.equal(h.reads.length, 0);
  h.options.accounts = [account()];
  h.render();
  assert.deepEqual(h.reads[0].args, { accountId: "account-a", forceRefresh: false });
  h.reads[0].resolve(usage());
  assert.equal((await h.flush()).usages["account-a"].planType, "plus");
});

test("多账号串行并间隔查询，同内容重渲染不重复查询", async (t) => {
  const browser = installControllerWindow(t);
  const h = createUsageHarness({ accounts: [account(), account("account-b")] });
  h.render();
  assert.equal(h.reads.length, 1);
  h.reads[0].resolve(usage());
  await h.flush();
  assert.equal(browser.timers.size, 1);
  assert.equal(h.reads.length, 1);
  h.options.accounts = [account(), account("account-b")];
  h.render();
  assert.equal(h.reads.length, 1);
  browser.tick();
  assert.equal(h.reads.length, 2);
  assert.equal(h.reads[1].args.accountId, "account-b");
  h.reads[1].resolve(usage("pro"));
  const state = await h.flush();
  assert.deepEqual(state.usagePending, { "account-a": 0, "account-b": 0 });
  assert.equal(browser.timers.size, 0);
});

test("页面隐藏后，迟到成功和错误不回写，也不触发线路刷新或下一账号查询", async (t) => {
  const browser = installControllerWindow(t);
  for (const failed of [false, true]) {
    const h = createUsageHarness({ accounts: [account(), account("account-b")] });
    h.render();
    h.options.active = false;
    const hidden = h.render();
    if (failed) h.reads[0].reject(new Error("late failure"));
    else h.reads[0].resolve(invalid);
    const state = await h.flush();
    assert.equal(state.usages, hidden.usages);
    assert.equal(state.usagePending, hidden.usagePending);
    assert.deepEqual(state.usagePending, {});
    assert.equal(h.routes.length, 0);
    assert.equal(h.reads.length, 1);
    assert.equal(browser.timers.size, 0);
  }
});

test("隐藏重开后，旧请求的成功、失败和 finally 不影响新查询", async (t) => {
  installControllerWindow(t);
  for (const failed of [false, true]) {
    for (const oldFirst of [false, true]) {
      const h = createUsageHarness();
      h.render();
      h.options.active = false; h.render();
      h.options.active = true; h.render();
      assert.equal(h.reads.length, 2);
      const finishOld = async () => {
        if (failed) h.reads[0].reject(new Error("old failure"));
        else h.reads[0].resolve(invalid);
        await h.flush();
      };
      if (oldFirst) {
        await finishOld();
        assert.equal(h.render().usagePending["account-a"], 1);
      }
      h.reads[1].resolve(usage("pro"));
      await h.flush();
      if (!oldFirst) await finishOld();
      assert.equal(h.render().usages["account-a"].planType, "pro");
      assert.equal(h.render().usagePending["account-a"], 0);
      assert.equal(h.routes.length, 0);
    }
  }
});

test("手动刷新取代同账号自动读取，旧结果不能清除新加载态", async (t) => {
  installControllerWindow(t);
  const h = createUsageHarness();
  const manual = h.render().refreshUsage("account-a", true);
  assert.equal(h.reads[1].args.forceRefresh, true);
  h.reads[0].resolve(invalid);
  await h.flush();
  assert.equal(h.render().usagePending["account-a"], 1);
  assert.equal(h.routes.length, 0);
  h.reads[1].resolve(usage("pro"));
  await manual;
  assert.equal((await h.flush()).usages["account-a"].planType, "pro");
});

test("额度失败显示错误并结束加载，重试成功保留当前套餐", async (t) => {
  installControllerWindow(t);
  const h = createUsageHarness();
  h.render();
  h.reads[0].reject(new Error("offline"));
  let state = await h.flush();
  assert.equal(state.usages["account-a"].message, "offline");
  assert.equal(state.usagePending["account-a"], 0);
  const retry = state.refreshUsage("account-a", true);
  h.reads[1].resolve(usage("plus"));
  await retry;
  state = await h.flush();
  assert.deepEqual(state.usages["account-a"], usage("plus"));
  assert.equal(state.usagePending["account-a"], 0);
});

test("账号删除或失效使旧额度无效，不能重新启动派生线路刷新", async (t) => {
  installControllerWindow(t);
  for (const accounts of [[], [account("account-a", { invalid: true, invalidReason: "removed credentials" })]]) {
    const h = createUsageHarness();
    h.render();
    h.options.accounts = accounts;
    const changed = h.render();
    h.reads[0].resolve(invalid);
    const state = await h.flush();
    assert.equal(state.usages, changed.usages);
    assert.equal(state.usagePending, changed.usagePending);
    assert.equal(h.routes.length, 0);
  }
});

test("隐藏与卸载清理账号间隔定时器，旧回调不能继续读取", async (t) => {
  const browser = installControllerWindow(t);
  for (const unmount of [false, true]) {
    const h = createUsageHarness({ accounts: [account(), account("account-b")] });
    h.render();
    h.reads[0].resolve(usage());
    await h.flush();
    const callback = [...browser.timers.values()][0];
    assert.equal(typeof callback, "function");
    if (unmount) h.unmount();
    else { h.options.active = false; h.render(); }
    assert.equal(browser.timers.size, 0);
    callback();
    await h.flush();
    assert.equal(h.reads.length, 1);
    assert.equal(h.writesAfterUnmount, 0);
  }
});

test("卸载后额度请求的成功和失败均不回写状态", async (t) => {
  installControllerWindow(t);
  for (const failed of [false, true]) {
    const h = createUsageHarness();
    h.render();
    h.unmount();
    if (failed) h.reads[0].reject(new Error("late failure"));
    else h.reads[0].resolve(invalid);
    await h.flush();
    assert.equal(h.writesAfterUnmount, 0);
    assert.equal(h.routes.length, 0);
  }
});

test("有效额度确认失效时同步线路，刷新失败保留额度并报告错误", async (t) => {
  installControllerWindow(t);
  for (const failed of [false, true]) {
    const h = createUsageHarness();
    h.render();
    h.reads[0].resolve(invalid);
    await h.flush();
    assert.equal(h.routes.length, 1);
    const result = { accounts: [account("account-a", { invalid: true })] };
    if (failed) h.routes[0].reject(new Error("route failure"));
    else h.routes[0].resolve(result);
    const state = await h.flush();
    assert.equal(state.usages["account-a"], invalid);
    assert.deepEqual(h.applied, failed ? [] : [result]);
    assert.deepEqual(h.errors, failed ? ["route failure"] : [""]);
  }
});

test("隐藏或卸载后，已发出的线路刷新的成功和错误均不采纳", async (t) => {
  installControllerWindow(t);
  for (const unmount of [false, true]) {
    for (const failed of [false, true]) {
      const h = createUsageHarness();
      h.render();
      h.reads[0].resolve(invalid);
      await h.flush();
      if (unmount) h.unmount();
      else { h.options.active = false; h.render(); h.options.active = true; h.render(); }
      if (failed) h.routes[0].reject(new Error("late route failure"));
      else h.routes[0].resolve({ accounts: [] });
      await h.flush();
      assert.deepEqual(h.applied, []);
      assert.deepEqual(h.errors, []);
      assert.equal(h.writesAfterUnmount, 0);
    }
  }
});

test("多账号触发的线路刷新只采纳最新结果", async (t) => {
  const browser = installControllerWindow(t);
  const h = createUsageHarness({ accounts: [account(), account("account-b")] });
  h.render();
  h.reads[0].resolve(invalid);
  await h.flush();
  browser.tick();
  h.reads[1].resolve(invalid);
  await h.flush();
  assert.equal(h.routes.length, 2);
  const current = { accounts: [] };
  h.routes[1].resolve(current);
  await h.flush();
  h.routes[0].resolve({ accounts: [account()] });
  await h.flush();
  assert.deepEqual(h.applied, [current]);
});
