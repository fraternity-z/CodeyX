import { expect, test as base } from "@playwright/test";

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await use(page);
    expect(errors, "插件页不应出现未捕获异常").toEqual([]);
  },
});

async function openPlugins(page, installed = true) {
  await page.goto(`/codey/tests/ui-browser.html?platform=windows${installed ? "&plugins=installed" : ""}`);
  await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible({ timeout: 60_000 });
  await page.evaluate(() => {
    const bridge = window.__codexSessionDeleteBridge;
    const state = window.pluginBehavior = { calls: [], pending: [], defer: "", failNext: "" };
    window.__codexSessionDeleteBridge = async (path, args = {}) => {
      const command = path.split("/").at(-1);
      if (!command.includes("codey_plugin")) return bridge(path, args);
      state.calls.push({ command, pluginId: args.pluginId, enabled: args.enabled, removeData: args.removeData, expectedSha256: args.expectedSha256 });
      if (state.defer === command) await new Promise(resolve => state.pending.push(resolve));
      if (state.failNext === command) { state.failNext = ""; throw new Error("测试：配置文件已被其他程序修改"); }
      return bridge(path, args);
    };
  });
  await page.getByRole("button", { name: "CodeyX 插件", exact: true }).click();
  await expect(page.getByRole("button", { name: "刷新插件列表", exact: true })).toBeEnabled();
}

async function enablePlugin(page) {
  await togglePlugin(page, "启用插件 请求头示例");
  const dialog = page.getByRole("dialog", { name: "信任并启用插件", exact: true });
  await expect(dialog).toContainText("与 CodeyX 相同的系统运行权限");
  await dialog.getByRole("button", { name: "信任并启用", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("switch", { name: "停用插件 请求头示例", exact: true })).toBeChecked();
}

async function togglePlugin(page, name) {
  const control = page.getByRole("switch", { name, exact: true });
  await control.focus();
  await control.press("Space");
}

test("检查插件包后确认导入，启停和卸载保留确认与默认保留数据", async ({ page }) => {
  await openPlugins(page, false);
  await page.getByRole("button", { name: "导入插件包", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "导入插件包", exact: true });
  await dialog.getByRole("button", { name: "选择文件", exact: true }).click();
  const confirm = dialog.getByRole("button", { name: "确认导入", exact: true });
  await expect(confirm).toBeEnabled();
  expect(await page.evaluate(() => window.pluginBehavior.calls.some(call => call.command === "install_codey_plugin"))).toBe(false);
  await confirm.click(); await expect(dialog).not.toBeVisible();
  await expect(page.locator(".codey-plugins-section article")).toHaveCount(1);
  await enablePlugin(page);
  await togglePlugin(page, "停用插件 请求头示例");
  await expect(page.getByRole("switch", { name: "启用插件 请求头示例", exact: true })).not.toBeChecked();
  await page.locator('button[aria-label="卸载 请求头示例"]').click();
  const uninstall = page.getByRole("dialog", { name: "确认卸载插件", exact: true });
  await expect(uninstall.getByRole("checkbox")).not.toBeChecked();
  await uninstall.getByRole("button", { name: "确认卸载", exact: true }).click();
  await expect(uninstall).not.toBeVisible();
  await expect(page.locator(".codey-plugins-section article")).toHaveCount(0);
  expect(await page.evaluate(() => window.pluginBehavior.calls.find(call => call.command === "uninstall_codey_plugin").removeData)).toBe(false);
});

test("配置保存失败保留草稿，键盘重试携带摘要，清日志需确认", async ({ page }) => {
  await openPlugins(page);
  await page.locator('button[aria-label="配置 请求头示例"]').click();
  const dialog = page.getByRole("dialog", { name: "请求头示例 · 配置", exact: true });
  const value = dialog.getByRole("textbox", { name: "value", exact: true });
  await expect(value).toHaveValue('"demo"');
  await value.fill('"fixture-draft"');
  await page.evaluate(() => { window.pluginBehavior.failNext = "save_codey_plugin_config_file"; });
  await dialog.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("测试：配置文件已被其他程序修改");
  await expect(value).toHaveValue('"fixture-draft"');
  await value.press("Control+s"); await expect(dialog).not.toBeVisible();
  const saves = await page.evaluate(() => window.pluginBehavior.calls.filter(call => call.command === "save_codey_plugin_config_file"));
  expect(saves).toHaveLength(2); expect(saves[0].expectedSha256).toMatch(/^[a-f0-9]{64}$/); expect(saves[1].expectedSha256).toBe(saves[0].expectedSha256);
  await page.getByRole("button", { name: "清除 请求头示例 的运行日志", exact: true }).click();
  const clear = page.getByRole("dialog", { name: "确认清除运行日志", exact: true });
  await clear.getByRole("button", { name: "确认清除", exact: true }).click();
  await expect(clear).not.toBeVisible();
  await expect(page.locator(".codey-plugins-section article")).toContainText("日志 0 B");
});

test("切页重开保留筛选和在途写入锁，旧操作完成后只刷新列表", async ({ page }) => {
  await openPlugins(page); await enablePlugin(page);
  await page.getByRole("textbox", { name: "搜索插件", exact: true }).fill("请求");
  await page.evaluate(() => { window.pluginBehavior.defer = "set_codey_plugin_enabled"; });
  await togglePlugin(page, "停用插件 请求头示例");
  await expect.poll(() => page.evaluate(() => window.pluginBehavior.pending.length)).toBe(1);
  await page.getByRole("button", { name: "基础功能", exact: true }).click();
  await page.getByRole("button", { name: "CodeyX 插件", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "搜索插件", exact: true })).toHaveValue("请求");
  await expect(page.getByRole("switch", { name: "停用插件 请求头示例", exact: true })).toBeDisabled();
  await page.evaluate(() => { window.pluginBehavior.defer = ""; window.pluginBehavior.pending[0](); });
  await expect(page.getByRole("switch", { name: "启用插件 请求头示例", exact: true })).toBeEnabled();
  await expect(page.getByText("插件「请求头示例」已停用", { exact: true })).not.toBeVisible();
  expect(await page.evaluate(() => window.pluginBehavior.calls.filter(call => call.command === "set_codey_plugin_enabled").length)).toBe(2);
});
