import { expect, test as base } from "@playwright/test";

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await use(page);
    expect(errors, "用量分析不应出现未捕获异常").toEqual([]);
  },
});

async function openUsage(page) {
  await page.goto("/codey/tests/ui-browser.html?platform=windows");
  await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible({ timeout: 60_000 });
  await page.evaluate(() => {
    const bridge = window.__codexSessionDeleteBridge;
    const state = window.usageBehavior = { calls: [], pending: [] };
    window.__codexSessionDeleteBridge = (path, args) => {
      if (!path.endsWith("/query_route_request_log_stats")) return bridge(path, args);
      state.calls.push(structuredClone(args));
      return new Promise((resolve, reject) => state.pending.push({ resolve, reject }))
        .then(async () => bridge(path, args));
    };
  });
  await page.getByRole("button", { name: "线路与模型", exact: true }).click();
  await page.getByRole("button", { name: "用量分析", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.usageBehavior.calls.length)).toBe(1);
}

async function complete(page, index, error) {
  await page.evaluate(({ index, error }) => {
    const pending = window.usageBehavior.pending[index];
    if (error) pending.reject(new Error(error)); else pending.resolve();
  }, { index, error });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function changeRange(page, label) {
  await page.locator(".usage-controls button").click();
  await page.getByRole("option", { name: label, exact: true }).click();
}

test("范围切换忽略旧结果，失败可重试，刷新与图表接线保持正常", async ({ page }) => {
  await openUsage(page);
  await expect(page.getByRole("heading", { name: "用量分析", exact: true })).toBeFocused();
  await changeRange(page, "近 30 天");
  await expect.poll(() => page.evaluate(() => window.usageBehavior.calls.length)).toBe(2);
  const query = await page.evaluate(() => window.usageBehavior.calls[1]);
  expect(query.toUnixMs - query.fromUnixMs).toBe(30 * 86_400_000);
  await complete(page, 0);
  await expect(page.getByText("正在统计用量…", { exact: true })).toBeVisible();
  await complete(page, 1, "测试：统计服务暂不可用");
  await expect(page.getByRole("alert")).toContainText("测试：统计服务暂不可用");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.usageBehavior.calls.length)).toBe(3);
  await complete(page, 2);
  await expect(page.getByRole("heading", { name: "模型用量占比", exact: true })).toBeVisible();
  await expect(page.locator(".usage-heatmap")).toBeVisible();
  await page.getByRole("button", { name: "直方图", exact: true }).click();
  await expect(page.locator(".usage-trend-chart")).toBeVisible();
  await page.getByRole("button", { name: "热力图", exact: true }).click();
  await expect(page.locator(".usage-heatmap")).toBeVisible();
  expect(await page.evaluate(() => window.usageBehavior.calls.length)).toBe(3);
  await changeRange(page, "全部历史");
  await expect.poll(() => page.evaluate(() => window.usageBehavior.calls.length)).toBe(4);
  expect(await page.evaluate(() => window.usageBehavior.calls[3])).toEqual({
    groupBy: "model", groupSort: "tokens", includeDailyTrend: true, allTime: true,
  });
  await complete(page, 3);
  const refresh = page.getByRole("button", { name: "刷新", exact: true });
  await refresh.click(); await expect(refresh).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.usageBehavior.calls.length)).toBe(5);
  await complete(page, 4); await expect(refresh).toBeEnabled();
  await page.getByRole("button", { name: "返回线路与模型", exact: true }).click();
  await expect(page.getByRole("button", { name: "用量分析", exact: true })).toBeFocused();
});

test("关闭设置后迟到错误不显示，重新进入用量分析只采用新请求", async ({ page }) => {
  await openUsage(page);
  await page.getByRole("button", { name: "关闭配置", exact: true }).click();
  await complete(page, 0, "测试：过期统计错误");
  await expect(page.getByText("测试：过期统计错误", { exact: true })).not.toBeVisible();
  await page.getByRole("button", { name: "打开内嵌设置", exact: true }).click();
  await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.usageBehavior.calls.length)).toBe(1);
  await page.getByRole("button", { name: "线路与模型", exact: true }).click();
  await page.getByRole("button", { name: "用量分析", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.usageBehavior.calls.length)).toBe(2);
  await complete(page, 1);
  await expect(page.getByRole("heading", { name: "模型用量占比", exact: true })).toBeVisible();
  await expect(page.getByText("测试：过期统计错误", { exact: true })).not.toBeVisible();
});
