import { expect, test as base } from "@playwright/test";

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await use(page);
    expect(errors, "运行维护不应出现未捕获异常").toEqual([]);
  },
});

async function openSettings(page, command) {
  await page.goto("/codey/tests/ui-browser.html?platform=windows");
  await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible({ timeout: 60_000 });
  await page.evaluate(command => {
    const bridge = window.__codexSessionDeleteBridge;
    const state = window.maintenanceBehavior = { calls: [] };
    window.__codexSessionDeleteBridge = async (path, args) => {
      if (!path.endsWith(`/${command}`)) return bridge(path, args);
      state.calls.push(args);
      const overrides = await new Promise(resolve => { state.complete = resolve; });
      const result = await bridge(path, args);
      return { ...result, ...overrides };
    };
  }, command);
}

test("诊断清理接线保留忙碌锁，结果替换进行提示，关闭重开不复活旧提示", async ({ page }) => {
  await openSettings(page, "clear_diagnostic_storage");
  const button = page.getByRole("button", { name: "分析并清理 Trace 日志", exact: true });
  await button.click();
  await expect(button).toBeDisabled();
  await expect(page.getByRole("button", { name: "关闭配置", exact: true })).toBeDisabled();
  await expect(page.getByText("Trace 日志：正在分析并清理", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.maintenanceBehavior.calls)).toEqual([{ target: "trace" }]);
  await page.evaluate(() => window.maintenanceBehavior.complete({
    status: "partial", errors: ["测试：日志库被占用"], traceLogWriteProtectionActive: true,
    traceCleanup: null, traceLogStats: { capturedAt: 0 },
  }));
  await expect(page.getByText("Trace 日志：部分项目未完成", { exact: true })).toBeVisible();
  await expect(page.getByText("Trace 日志：正在分析并清理", { exact: true })).not.toBeVisible();
  await expect(button).toBeEnabled();
  await page.getByRole("button", { name: "关闭配置", exact: true }).click();
  await page.getByRole("button", { name: "打开内嵌设置", exact: true }).click();
  await expect(button).toBeVisible();
  await expect(page.getByText("Trace 日志：部分项目未完成", { exact: true })).not.toBeVisible();
  expect(await page.evaluate(() => window.maintenanceBehavior.calls.length)).toBe(1);
});

test("系统设置修复须确认，执行时锁定按钮，完成后显示备份与重启提示", async ({ page }) => {
  await openSettings(page, "repair_codex_config");
  await page.getByRole("button", { name: "系统设置与偏好", exact: true }).click();
  await page.getByRole("button", { name: "修复", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "修复 Codex 配置？" });
  await expect(confirmation).toBeVisible();
  expect(await page.evaluate(() => window.maintenanceBehavior.calls.length)).toBe(0);
  await confirmation.getByRole("button", { name: "确认修复", exact: true }).click();
  await expect(page.getByRole("button", { name: "修复中…", exact: true })).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.maintenanceBehavior.calls.length)).toBe(1);
  await page.evaluate(() => window.maintenanceBehavior.complete({
    repaired: true, message: "测试配置修复完成", configPath: "test/config.toml", backupPath: "test/backup.toml",
  }));
  await expect(page.getByRole("button", { name: "修复", exact: true })).toBeEnabled();
  await expect(page.getByText(/修复成功，请从 CodeyX 重启 Codex 使修改生效。/).first()).toBeVisible();
  await expect(page.getByText(/备份文件：test\/backup.toml/).first()).toBeVisible();
});
