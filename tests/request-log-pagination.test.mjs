import assert from "node:assert/strict";
import test from "node:test";
import { deferred, installControllerWindow } from "./helpers/controller-harness.mjs";
import { catalog, createLogHarness, logPage } from "./helpers/request-logs-harness.mjs";

test("跳到未访问页按页码查询，下一页复用游标", async (t) => {
  installControllerWindow(t);
  const cursor = { timestampUnixMs: 900, requestId: "last" };
  const h = createLogHarness({ query_route_request_logs: ({ page }) => logPage(`page-${page}`, cursor) });
  h.render(catalog, true);
  await h.flush();
  h.render().goToPage(419);
  h.render(); await h.flush();
  h.render().goToPage(420);
  h.render(); await h.flush();
  const requests = h.requests("query_route_request_logs");
  assert.deepEqual(requests.map(({ page, cursorMode }) => [page, cursorMode]), [[1, true], [419, false], [420, true]]);
  assert.deepEqual(requests[2].cursor, cursor);
  assert.equal(h.render().result.items[0].requestId, "page-420");
});

test("连续跳页保持有效边界，筛选与每页数量变化重置页码和游标", async (t) => {
  installControllerWindow(t);
  const h = createLogHarness();
  h.render(catalog, true); await h.flush();
  for (const page of [419, 200, 1]) { h.render().goToPage(page); h.render(); await h.flush(); }
  assert.deepEqual(h.requests("query_route_request_logs").map(({ page }) => page), [1, 419, 200, 1]);
  for (const page of [0, -1, 501, 1.5, NaN, Infinity]) h.render().goToPage(page);
  assert.equal(h.render().page, 1);
  h.render().goToPage(2); h.render(); await h.flush();
  h.render().changeFilter("provider", "new-provider"); h.render(); await h.flush();
  assert.equal(h.render().page, 1);
  assert.deepEqual(h.requests("query_route_request_logs").at(-1).cursor, null);
  assert.equal(h.requests("query_route_request_logs").at(-1).provider, "new-provider");
  h.render().changePageSize(50); h.render(); await h.flush();
  h.render().changePageSize(0); h.render();
  assert.equal(h.render().pageSize, 50);
  for (const text of ["0", "1.5", "-1", "1e2", "", "99999999999999999999"]) {
    h.render().setPageJumpInput(text); assert.equal(h.render().validJumpPage, false);
  }
});

test("旧查询不能覆盖新筛选的结果、错误或游标，队列跳过中间查询", async (t) => {
  installControllerWindow(t);
  const old = deferred();
  const h = createLogHarness({ query_route_request_logs: ({ provider }) => !provider ? old.promise : logPage(provider) });
  h.render(catalog, true); await h.flush();
  h.render().changeFilter("provider", "skipped"); h.render();
  h.render().changeFilter("provider", "latest"); h.render();
  old.reject(new Error("stale failure")); await h.flush();
  assert.deepEqual(h.requests("query_route_request_logs").map(({ provider }) => provider), [undefined, "latest"]);
  assert.equal(h.render().result.items[0].requestId, "latest");
  assert.equal(h.render().error, "");
  assert.equal(h.render().loading, false);
});

test("隐藏重开保留筛选但更新时间窗口，不能带入旧页码与游标", async (t) => {
  installControllerWindow(t);
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const h = createLogHarness({ query_route_request_logs: () => logPage("row", { timestampUnixMs: 800, requestId: "old" }) });
  h.render(catalog, true); await h.flush();
  h.render().changeFilter("status", "failed"); h.render(); await h.flush();
  h.render().goToPage(2); h.render(); await h.flush();
  h.render(catalog, false); await h.flush();
  const count = h.calls.length;
  h.render().refresh(); h.render(); await h.flush();
  assert.equal(h.calls.length, count);
  now += 10_000;
  h.render(catalog, true); await h.flush();
  const query = h.requests("query_route_request_logs").at(-1);
  assert.equal(query.page, 1);
  assert.equal(query.cursor, null);
  assert.equal(query.status, "failed");
  assert.equal(query.toUnixMs, now);
});
