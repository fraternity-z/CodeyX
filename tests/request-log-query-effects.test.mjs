import assert from "node:assert/strict";
import test from "node:test";
import { deferred, installControllerWindow } from "./helpers/controller-harness.mjs";
import { catalog, createLogHarness, logPage } from "./helpers/request-logs-harness.mjs";

test("候选模型按需分页读取，统计独立请求，列表与统计共享筛选", async (t) => {
  installControllerWindow(t);
  const h = createLogHarness({ query_route_request_log_models: ({ afterModel }) => afterModel
    ? { queryable: true, models: ["model-z"], nextCursor: null }
    : { queryable: true, models: ["model-a"], nextCursor: "model-a" } });
  h.render(catalog, true); await h.flush();
  assert.equal(h.requests("query_route_request_log_models").length, 0);
  h.render().changeFilter("provider", "provider-a");
  h.render().changeFilter("officialAccount", "account-a");
  h.render().requestModelCatalog(); h.render(); await h.flush();
  assert.deepEqual(h.render().modelOptions.map(({ value }) => value), ["all", "model-a", "model-z"]);
  const models = h.requests("query_route_request_log_models");
  assert.equal(models.length, 2);
  assert.equal(models[0].provider, "provider-a");
  assert.equal(models[0].officialAccountId, "account-a");
  assert.equal(h.requests("query_route_request_log_stats").length, 2);
  const { page, pageSize, cursor, ...list } = h.requests("query_route_request_logs").at(-1);
  const { groupBy, ...stats } = h.requests("query_route_request_log_stats").at(-1);
  assert.deepEqual(list, stats);
});

test("搜索防抖、精确查询与无效时间范围由 controller 管理", async (t) => {
  const clock = installControllerWindow(t);
  const h = createLogHarness(); h.render(catalog, true); await h.flush();
  assert.equal(clock.timers.size, 0, "挂载不能重置已有分页");
  h.render().setSearchInput("  request-1  "); h.render();
  h.render().setSearchInput("  request-2  "); h.render();
  assert.equal(clock.timers.size, 1);
  h.render().changeFilter("searchMode", "requestId"); h.render();
  clock.tick(); h.render(); await h.flush();
  assert.equal(h.requests("query_route_request_logs").at(-1).requestId, "request-2");
  assert.equal(h.requests("query_route_request_logs").at(-1).search, undefined);
  h.render().changeFilter("timeRange", "custom"); h.render(); await h.flush();
  const count = h.calls.length;
  assert.match(h.render().error, /有效的开始与结束时间/);
  h.render().changeFilter("customFrom", "2020-01-01");
  h.render().changeFilter("customTo", "2022-01-01"); h.render(); await h.flush();
  assert.equal(h.calls.length, count);
  h.render().resetFilters(); h.render(); await h.flush();
  assert.equal(h.render().hasFilters, false);
  assert.equal(h.render().searchInput, "");
  assert.equal(h.render().error, "");
});

test("隐藏与卸载作废列表、统计和模型响应，失败可刷新恢复", async (t) => {
  installControllerWindow(t);
  const list = deferred(), stats = deferred(), models = deferred();
  const h = createLogHarness({ query_route_request_logs: () => list.promise,
    query_route_request_log_stats: () => stats.promise, query_route_request_log_models: () => models.promise });
  h.render(catalog, true); h.render().requestModelCatalog(); h.render(); await h.flush();
  h.render(catalog, false);
  list.resolve(logPage("stale")); stats.reject(new Error("stale stats")); models.reject(new Error("stale models"));
  await h.flush();
  assert.equal(h.render().result, null);
  assert.equal(h.render().statsError, "");
  assert.equal(h.render().error, "");
  assert.equal(h.render().loading, false);
  h.unmount(); await h.flush(); assert.equal(h.writesAfterUnmount, 0);

  let fail = true;
  const retry = createLogHarness({ query_route_request_logs: () => { if (fail) throw new Error("读取失败"); return logPage(); } });
  retry.render(catalog, true); await retry.flush();
  assert.equal(retry.render().error, "读取失败");
  fail = false; retry.render().refresh(); retry.render(); await retry.flush();
  assert.equal(retry.render().error, "");
  assert.equal(retry.render().result.items[0].requestId, "current");
});

test("删除防重复提交并作废在途读取，失败显示错误，卸载不回写", async (t) => {
  installControllerWindow(t);
  const clear = deferred(), old = deferred();
  let reads = 0;
  const h = createLogHarness({ clear_route_request_logs: () => clear.promise,
    query_route_request_logs: () => ++reads === 1 ? old.promise : logPage("after-clear") });
  h.render(catalog, true); await h.flush();
  const first = h.render().clearRequestLogs(), duplicate = h.render().clearRequestLogs();
  h.render(); await duplicate;
  assert.equal(h.requests("clear_route_request_logs").length, 1);
  old.resolve(logPage("deleted")); await h.flush();
  assert.equal(h.render().result, null);
  clear.resolve({ status: "ok", removedFileCount: 1 }); await first; await h.flush();
  assert.equal(h.render().actionNotice.tone, "success");
  assert.equal(h.render().result.items[0].requestId, "after-clear");
  assert.equal(h.render().clearing, false);

  const failure = createLogHarness({ clear_route_request_logs: () => ({ status: "failed", message: "存储忙" }) });
  failure.render(catalog, true); await failure.flush(); await failure.render().clearRequestLogs();
  assert.equal(failure.render().actionNotice.text, "存储忙");
  const pending = deferred();
  const disposed = createLogHarness({ clear_route_request_logs: () => pending.promise });
  disposed.render(catalog, true); await disposed.flush();
  const deleting = disposed.render().clearRequestLogs(); disposed.unmount();
  pending.resolve({ status: "ok", removedFileCount: 1 }); await deleting; await disposed.flush();
  assert.equal(disposed.writesAfterUnmount, 0);
});

test("官方线路缺失启动标志仍读取账号，标签脱敏且失败可降级", async (t) => {
  installControllerWindow(t);
  const h = createLogHarness({ list_official_accounts: () => ({ accounts: [{ id: "a", email: "person@example.com", isDefault: true }] }) });
  h.render({ ...catalog, profiles: [{ id: "official", officialAccountId: "a", name: "官方", shortName: "官" }] }, true); await h.flush();
  assert.equal(h.requests("list_official_accounts").length, 1);
  assert.notEqual(h.render().officialAccountLabel("a"), "person@example.com");
  assert.match(h.render().officialAccountOptions[1].label, /默认/);
  const failure = createLogHarness({ list_official_accounts: () => { throw new Error("offline"); } });
  failure.render({ ...catalog, officialAccountAvailable: true }, true); await failure.flush();
  assert.deepEqual(failure.render().officialAccounts, []);
});
