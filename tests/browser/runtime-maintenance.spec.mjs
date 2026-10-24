import { expect, test as base } from "@playwright/test";

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await use(page);
    expect(errors, "运行维护不应出现未捕获异常").toEqual([]);
  },
});

async function openSettings(page, command, platform = "windows", injection = "node_options") {
  await page.goto(`/codey/tests/ui-browser.html?platform=${platform}&injection=${injection}`);
  await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible({ timeout: 60_000 });
  await page.evaluate(command => {
    const bridge = window.__codexSessionDeleteBridge;
    const state = window.maintenanceBehavior = { calls: [], saves: 0 };
    window.__codexSessionDeleteBridge = async (path, args) => {
      if (path.endsWith("/save_codey_config")) state.saves++;
      if (!path.endsWith(`/${command}`)) return bridge(path, args);
      state.calls.push(args);
      const overrides = await new Promise(resolve => { state.complete = resolve; });
      const result = await bridge(path, args);
      return { ...result, ...overrides };
    };
  }, command);
}

for (const mode of ["inspector", "cli"]) {
  test(`主进程修复先确认风险，取消不写入，重启后${mode === "inspector" ? "确认 Inspector 成功" : "CLI 仍提示未确认"}`, async ({ page }) => {
    await openSettings(page, "repair_main_process_injection", "windows", "cli");
    await page.evaluate(mode => {
      const bridge = window.__codexSessionDeleteBridge;
      window.__codexSessionDeleteBridge = async (path, args) => {
        const result = await bridge(path, args);
        return path.endsWith("/runtime_status") && window.maintenanceBehavior.finished
          ? { ...result, restartInProgress: false, maintenance: { ...result.maintenance, startupInjectionMode: mode } }
          : result;
      };
    }, mode);
    await page.getByRole("button", { name: /^系统优化（/ }).click();
    const repair = page.getByRole("button", { name: "修复主进程注入", exact: true }).and(page.locator("button"));
    await expect(repair).toBeEnabled();
    await repair.click();
    const confirmation = page.getByRole("dialog", { name: "修复主进程注入？", exact: true });
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toContainText("退出并重启 Codex");
    await expect(confirmation).toContainText("先备份运行时");
    await expect(confirmation).toContainText("原厂签名失效");
    await expect(confirmation).toContainText("可使用备份回滚");
    expect(await page.evaluate(() => [window.maintenanceBehavior.calls.length, window.maintenanceBehavior.saves])).toEqual([0, 0]);
    await confirmation.getByRole("button", { name: "取消", exact: true }).click();
    await expect(confirmation).not.toBeVisible();
    expect(await page.evaluate(() => [window.maintenanceBehavior.calls.length, window.maintenanceBehavior.saves])).toEqual([0, 0]);
    await repair.click();
    await confirmation.getByRole("button", { name: "备份并修复", exact: true }).click();
    await expect(repair).toBeDisabled();
    await expect.poll(() => page.evaluate(() => window.maintenanceBehavior.calls.length)).toBe(1);
    await page.evaluate(() => {
      window.maintenanceBehavior.finished = true;
      window.maintenanceBehavior.complete({ status: "restarting" });
    });
    await expect(page.getByText(mode === "inspector"
      ? "主进程注入已修复，Codex 已自动重启"
      : "尚未确认主进程注入修复成功，请查看运行状态或失败提示", { exact: true }).first()).toBeVisible();
    if (mode === "cli") await expect(page.getByText("主进程注入已修复，Codex 已自动重启", { exact: true })).not.toBeVisible();
    else await expect(repair).toBeDisabled();
    expect(await page.evaluate(() => window.maintenanceBehavior.calls.length)).toBe(1);
  });
}

test("非 Windows CLI 回退不提供主进程修复", async ({ page }) => {
  await openSettings(page, "repair_main_process_injection", "macos", "cli");
  await page.getByRole("button", { name: /^系统优化（/ }).click();
  await expect(page.getByRole("button", { name: "修复主进程注入", exact: true }).and(page.locator("button"))).toBeDisabled();
  expect(await page.evaluate(() => window.maintenanceBehavior.calls.length)).toBe(0);
});

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

for (const platform of ["windows", "macos"]) {
  test(`${platform} 显示 Crashpad 保护与清理入口，并使用正确的诊断目标`, async ({ page }) => {
    await openSettings(page, "clear_diagnostic_storage", platform);
    const protection = page.getByRole("switch", { name: "启用 Codex Crashpad 磁盘保护", exact: true });
    await expect(protection).toBeChecked();
    expect(await page.evaluate(async () => (
      await window.__codexSessionDeleteBridge("/api/runtime_status", {})
    ).crashpadDiskProtectionActive)).toBe(true);

    const cleanup = page.getByRole("button", { name: "分析并清理 Crashpad 报告", exact: true });
    await cleanup.click();
    await expect(cleanup).toBeDisabled();
    expect(await page.evaluate(() => window.maintenanceBehavior.calls)).toEqual([{ target: "crashpad" }]);
    await page.evaluate(() => window.maintenanceBehavior.complete({ status: "ok", errors: [] }));
    await expect(cleanup).toBeEnabled();
    await expect(page.getByText("Crashpad：分析并清理完成", { exact: true })).toBeVisible();
  });
}

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

test("重新选择 Codex 目录失败或取消保留原路径，成功后保存新路径", async ({ page }) => {
  await openSettings(page, "unused");
  await page.evaluate(() => {
    const bridge = window.__codexSessionDeleteBridge;
    window.directorySelection = { calls: 0, result: null, error: null, saved: null };
    window.__codexSessionDeleteBridge = async (path, args) => {
      const state = window.directorySelection;
      if (path.endsWith("/select_codex_app_directory")) {
        state.calls++;
        await new Promise(resolve => { state.complete = resolve; });
        if (state.error) throw new Error(state.error);
        return state.result;
      }
      if (path.endsWith("/save_codey_config")) state.saved = args.config;
      return bridge(path, args);
    };
  });
  await page.getByRole("button", { name: "系统设置与偏好", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "系统设置与偏好", exact: true });
  const directory = settings.locator("code");
  const previous = await directory.innerText();
  const select = settings.getByRole("button", { name: "重新选择 Codex 目录", exact: true });
  for (const error of ["所选目录不是 Codex 桌面应用", null]) {
    await page.evaluate(error => { window.directorySelection.error = error; }, error);
    await select.click();
    await expect(select).toBeDisabled();
    await page.evaluate(() => window.directorySelection.complete());
    await expect(select).toBeEnabled();
    await expect(directory).toHaveText(previous);
    if (error) await expect(settings.getByRole("status")).toContainText("已保留原目录");
  }
  await page.evaluate(() => { window.directorySelection.result = "D:\\Apps\\Codex"; });
  await select.click();
  await page.evaluate(() => window.directorySelection.complete());
  await expect(directory).toHaveText("D:\\Apps\\Codex");
  await expect(settings.getByRole("status")).toContainText("保存后");
  await settings.getByRole("button", { name: "完成", exact: true }).click();
  await page.getByRole("button", { name: "保存更改", exact: true }).click();
  await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.directorySelection.saved.codexAppPath)).toBe("D:\\Apps\\Codex");
  expect(await page.evaluate(() => window.directorySelection.calls)).toBe(3);
});
