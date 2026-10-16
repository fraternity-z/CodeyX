import { expect, test as base } from "@playwright/test";

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await use(page);
    expect(errors, "运行状态刷新不应出现未捕获异常").toEqual([]);
  },
});

for (const outcome of ["success", "error"]) {
  test(`设置隐藏时暂停读取，重开刷新后丢弃旧 ${outcome}`, async ({ page }) => {
    await page.goto("/codey/tests/ui-browser.html?platform=windows");
    const close = page.getByRole("button", { name: "关闭配置", exact: true });
    await expect(close).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: "重启 Codex", exact: true })).toBeEnabled();
    await page.evaluate(() => {
      const bridge = window.__codexSessionDeleteBridge;
      const state = window.runtimeStatusBehavior = { requests: [] };
      window.__codexSessionDeleteBridge = async (path, args) => {
        const result = await bridge(path, args);
        if (!path.endsWith("/runtime_status")) return result;
        return new Promise((resolve, reject) => state.requests.push({
          args, complete: (overrides) => resolve({ ...result, ...overrides }), fail: reject,
        }));
      };
      window.dispatchEvent(new Event("codey-injection-status-changed"));
    });
    await expect.poll(() => page.evaluate(() => window.runtimeStatusBehavior.requests.length)).toBe(1);
    await close.click();
    await expect(close).not.toBeVisible();
    await page.evaluate(() => {
      window.dispatchEvent(new Event("codey-injection-status-changed"));
      window.dispatchEvent(new Event("codey-settings-opened"));
    });
    expect(await page.evaluate(() => window.runtimeStatusBehavior.requests.length)).toBe(1);

    await page.getByRole("button", { name: "打开内嵌设置", exact: true }).click();
    await expect(close).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.runtimeStatusBehavior.requests.length)).toBe(2);
    expect(await page.evaluate(() => window.runtimeStatusBehavior.requests[1].args)).toEqual({ refreshInjectionStatus: true });
    await page.evaluate(() => window.runtimeStatusBehavior.requests[1].complete({ running: true, appVersion: "9.0.2" }));
    await expect(page.getByText("v9.0.2", { exact: true })).toBeVisible();

    await page.evaluate(outcome => {
      const old = window.runtimeStatusBehavior.requests[0];
      if (outcome === "success") old.complete({ running: false, appVersion: "0.0.1" });
      else old.fail(new Error("测试：过期状态读取失败"));
    }, outcome);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.getByText("v9.0.2", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "重启 Codex", exact: true })).toBeEnabled();
    expect(await page.evaluate(() => window.runtimeStatusBehavior.requests.length)).toBe(2);
  });
}
