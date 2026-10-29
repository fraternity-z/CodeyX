import assert from "node:assert/strict";
import test from "node:test";
import { createControllerHarness, deferred, installControllerWindow } from "./helpers/controller-harness.mjs";
import { autoStubModule, collectElements, elementProps, elementType, textContent } from "./helpers/jsx-tree.mjs";

const dayMs = 86_400_000;
const stats = (total = 7) => ({ queryable: true, total, totalTokensSum: 100, totalTokensKnownCount: total,
  groups: [{ key: "test-model", totalTokensSum: 100, total }], groupsTruncated: false,
  fromUnixMs: 0, toUnixMs: dayMs, bucketMs: dayMs, trend: [], dailyTrend: [] });

function fixture({ active = true, component = false, invoke } = {}) {
  const calls = [], ui = autoStubModule("ui");
  let backCalls = 0;
  const props = { active, onBack: () => backCalls++ };
  const h = createControllerHarness(new URL(component ? "../src/UsageAnalysisPanel.tsx"
    : "../src/features/usage-analysis/useUsageAnalysisController.ts", import.meta.url),
  component ? "UsageAnalysisPanel" : "useUsageAnalysisController", {
    "../../api": { invoke(command, args) {
      const call = { command, args, ...deferred() }; calls.push(call);
      return invoke ? invoke(command, args) : call.promise;
    } },
    "../../components/ui": ui, "@tabler/icons-react": autoStubModule("icons"), "@heroui/react": autoStubModule("heroui"),
  });
  return { ...h, calls, ui, props, get backCalls() { return backCalls; },
    render: () => h.render(component ? props : props.active) };
}

test("统计请求固定当前时间快照，重复刷新合并，全部历史不携带窗口或游标", async t => {
  const browser = installControllerWindow(t);
  let now = 2_000_000_000_000;
  t.mock.method(Date, "now", () => now);
  const h = fixture();
  assert.deepEqual(h.render().state, { loading: true, data: null, error: "" });
  now++;
  await h.flush();
  assert.equal(h.calls[0].command, "query_route_request_log_stats");
  assert.deepEqual(h.calls[0].args, { groupBy: "model", groupSort: "tokens", includeDailyTrend: true,
    fromUnixMs: now - 1 - 7 * dayMs, toUnixMs: now - 1 });
  h.render().reload(); await h.flush(); assert.equal(h.calls.length, 1);
  h.calls[0].resolve(stats()); await h.flush(); assert.equal(browser.timers.size, 0);
  const c = h.render(); c.reload(); c.reload(); await h.flush();
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].args.toUnixMs, now);
  assert.deepEqual(h.render().state, { loading: true, data: null, error: "" });
  h.calls[1].resolve(stats(30)); await h.flush();
  h.render().changeRange("all"); await h.flush();
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.calls[2].args, { groupBy: "model", groupSort: "tokens", includeDailyTrend: true, allTime: true });
  h.calls[2].resolve(stats(100)); await h.flush();
  for (const range of ["all", "invalid", "", 30, null]) h.render().changeRange(range);
  await h.flush(); assert.equal(h.calls.length, 3); assert.equal(h.render().range, "all");
  h.unmount(); assert.equal(browser.timers.size, 0);
});

test("切换范围清空旧结果，过期成功、错误和 finally 不覆盖当前读取", async t => {
  const browser = installControllerWindow(t);
  for (const failed of [false, true]) {
    const h = fixture(); h.render(); await h.flush();
    h.render().changeRange("30d"); await h.flush();
    assert.equal(h.calls.length, 1);
    assert.equal(browser.timers.size, 1);
    assert.deepEqual(h.render().state, { loading: true, data: null, error: "" });
    if (failed) h.calls[0].reject(new Error("旧范围失败")); else h.calls[0].resolve(stats(7));
    await h.flush();
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1].args.toUnixMs - h.calls[1].args.fromUnixMs, 30 * dayMs);
    assert.deepEqual(h.render().state, { loading: true, data: null, error: "" });
    h.render().reload(); await h.flush(); assert.equal(h.calls.length, 2);
    h.calls[1].resolve(stats(30)); await h.flush();
    assert.deepEqual(h.render().state, { loading: false, data: stats(30), error: "" });
    h.unmount(); assert.equal(browser.timers.size, 0);
  }
});

test("连续切换仅串行执行在途和最新范围，跳过其余待执行读取", async t => {
  const browser = installControllerWindow(t);
  const h = fixture(); h.render(); await h.flush();
  for (const range of ["30d", "all", "7d", "30d", "all"]) {
    h.render().changeRange(range); await h.flush();
    assert.equal(h.calls.length, 1);
  }
  h.calls[0].resolve(stats(7)); await h.flush();
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1].args, { groupBy: "model", groupSort: "tokens", includeDailyTrend: true, allTime: true });
  h.calls[1].resolve(stats(100)); await h.flush();
  assert.deepEqual(h.render().state, { loading: false, data: stats(100), error: "" });
  assert.equal(h.calls.length, 2); assert.equal(browser.timers.size, 0); h.unmount();
});

test("未开始的过期任务不发请求，隐藏禁用动作，重开保留范围并更新窗口", async t => {
  const browser = installControllerWindow(t);
  let now = 2_000_000_000_000;
  t.mock.method(Date, "now", () => now);
  const h = fixture({ active: false });
  const initial = h.render(); initial.reload(); initial.changeRange("all"); await h.flush();
  assert.equal(initial.state.loading, false); assert.equal(h.calls.length, 0);
  h.props.active = true; h.render().changeRange("30d"); h.render();
  h.props.active = false; h.render(); await h.flush();
  assert.equal(h.calls.length, 0); assert.equal(browser.timers.size, 0); assert.equal(h.render().range, "30d");
  now += dayMs; h.props.active = true; h.render(); await h.flush();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].args.toUnixMs, now);
  assert.equal(h.calls[0].args.fromUnixMs, now - 30 * dayMs);
  h.calls[0].resolve(stats()); await h.flush();
  h.unmount(); assert.equal(browser.timers.size, 0);
});

test("隐藏作废在途响应并保留队列超时，重开后旧请求不能结束新的加载", async t => {
  const browser = installControllerWindow(t);
  for (const failed of [false, true]) {
    const h = fixture(); h.render(); await h.flush();
    h.props.active = false; const hidden = h.render();
    assert.equal(browser.timers.size, 1); assert.equal(hidden.state.loading, false);
    hidden.changeRange("all"); hidden.reload(); await h.flush(); assert.equal(h.calls.length, 1);
    h.props.active = true; h.render(); await h.flush(); assert.equal(h.calls.length, 1);
    if (failed) h.calls[0].reject("隐藏后的失败"); else h.calls[0].resolve(stats(99));
    await h.flush(); assert.deepEqual(h.render().state, { loading: true, data: null, error: "" });
    assert.equal(h.calls.length, 2);
    h.render().reload(); await h.flush(); assert.equal(h.calls.length, 2);
    h.calls[1].resolve(stats(8)); await h.flush();
    assert.deepEqual(h.render().state, { loading: false, data: stats(8), error: "" });
    h.unmount(); assert.equal(browser.timers.size, 0);
  }
});

test("在途请求悬挂时，超时释放队列并只执行最新范围，迟到结果不回写", async t => {
  const browser = installControllerWindow(t);
  const h = fixture(); h.render(); await h.flush();
  h.render().changeRange("30d"); await h.flush();
  h.render().changeRange("all"); await h.flush();
  assert.equal(h.calls.length, 1); assert.equal(browser.timers.size, 1);
  browser.tick(); await h.flush();
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1].args, { groupBy: "model", groupSort: "tokens", includeDailyTrend: true, allTime: true });
  h.calls[1].resolve(stats(100)); await h.flush();
  h.calls[0].resolve(stats(7)); await h.flush();
  assert.deepEqual(h.render().state, { loading: false, data: stats(100), error: "" });
  assert.equal(h.calls.length, 2); assert.equal(browser.timers.size, 0); h.unmount();
});

test("超时停止加载并允许显式重试，迟到响应不能覆盖新请求或释放其防重锁", async t => {
  const browser = installControllerWindow(t);
  for (const failed of [false, true]) {
    const h = fixture(); h.render(); await h.flush(); browser.tick(); await h.flush();
    assert.deepEqual(h.render().state, { loading: false, data: null, error: "统计请求超时，请稍后重试。" });
    assert.equal(h.calls.length, 1); assert.equal(browser.timers.size, 0);
    const c = h.render(); c.reload(); c.reload(); await h.flush(); assert.equal(h.calls.length, 2);
    if (failed) h.calls[0].reject(new Error("迟到失败")); else h.calls[0].resolve(stats(99));
    await h.flush(); assert.equal(h.render().state.loading, true);
    h.render().reload(); await h.flush(); assert.equal(h.calls.length, 2);
    h.calls[1].resolve(stats(8)); await h.flush();
    assert.deepEqual(h.render().state, { loading: false, data: stats(8), error: "" });
    h.unmount(); assert.equal(browser.timers.size, 0);
  }
});

test("同步异常和异步失败均可重试，不可查询结果保留原因，错误不自动重发", async t => {
  const browser = installControllerWindow(t);
  for (const sync of [false, true]) {
    let fail = true;
    const h = fixture({ invoke() {
      if (!fail) return Promise.resolve({ queryable: false, reason: "ndjson_not_queryable" });
      if (sync) throw new Error("统计调用失败");
      return Promise.reject("统计调用失败");
    } });
    h.render(); await h.flush();
    assert.deepEqual(h.render().state, { loading: false, data: null, error: "统计调用失败" });
    assert.equal(h.calls.length, 1); assert.equal(browser.timers.size, 0);
    fail = false; h.render().reload(); await h.flush();
    assert.deepEqual(h.render().state, { loading: false, data: { queryable: false, reason: "ndjson_not_queryable" }, error: "" });
    assert.equal(h.calls.length, 2); assert.equal(browser.timers.size, 0); h.unmount();
  }
});

test("卸载清理定时器，保存的动作和迟到结果都不能回写；未发出的请求被跳过", async t => {
  const browser = installControllerWindow(t);
  for (const failed of [false, true]) {
    const h = fixture(); const c = h.render(); await h.flush();
    c.changeRange("30d"); await h.flush(); h.unmount();
    assert.equal(browser.timers.size, 0); c.reload(); c.changeRange("all");
    if (failed) h.calls[0].reject(new Error("卸载后失败")); else h.calls[0].resolve(stats(99));
    await h.flush(); assert.equal(h.writesAfterUnmount, 0); assert.equal(h.calls.length, 1);
  }
  const h = fixture(); h.render(); h.unmount(); await h.flush();
  assert.equal(h.calls.length, 0); assert.equal(browser.timers.size, 0); assert.equal(h.writesAfterUnmount, 0);
});

test("视图连接范围、刷新、重试与返回，图表选择只影响展示", async t => {
  installControllerWindow(t);
  const h = fixture({ component: true });
  const find = (type, predicate = () => true) => collectElements(h.render(), node => elementType(node) === type && predicate(elementProps(node), node))[0];
  const button = text => find(h.ui.Button, (_, node) => textContent(node).includes(text));
  assert.match(textContent(h.render()), /正在统计用量/); await h.flush();
  h.calls[0].resolve(stats(0)); await h.flush(); assert.match(textContent(h.render()), /所选范围暂无请求日志/);
  elementProps(find(h.ui.Select)).onChange("30d"); await h.flush();
  assert.equal(h.calls[1].args.toUnixMs - h.calls[1].args.fromUnixMs, 30 * dayMs);
  h.calls[1].reject(new Error("测试统计失败")); await h.flush();
  assert.match(textContent(h.render()), /用量分析加载失败.*测试统计失败/);
  const retry = elementProps(button("重试")).onClick; retry(); retry(); await h.flush(); assert.equal(h.calls.length, 3);
  h.calls[2].resolve({ queryable: false, reason: "ndjson_not_queryable" }); await h.flush();
  assert.match(textContent(h.render()), /当前日志暂不可统计.*当前日志格式不支持在线统计/);
  elementProps(button("刷新")).onClick(); await h.flush(); h.calls[3].resolve(stats()); await h.flush();
  assert.match(textContent(h.render()), /模型用量占比/);
  elementProps(button("直方图")).onPress(); assert.equal(elementProps(button("直方图"))["aria-pressed"], true);
  elementProps(button("热力图")).onPress(); assert.equal(elementProps(button("热力图"))["aria-pressed"], true);
  await h.flush(); assert.equal(h.calls.length, 4);
  elementProps(button("返回线路与模型")).onClick(); assert.equal(h.backCalls, 1); h.unmount();
});
