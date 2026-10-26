import { expect, test as base } from "@playwright/test";

const test = base.extend({ page: async ({ page }, use) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await use(page); expect(errors).toEqual([]);
} });
test.use({ launchOptions: { args: ["--no-proxy-server"] } });

test.beforeAll(async ({ browser, baseURL }) => {
  test.setTimeout(300_000);
  const page = await browser.newPage({ baseURL });
  try {
    await page.goto("/codey/tests/ui-browser.html?platform=windows", { waitUntil: "commit" });
    await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible({ timeout: 240_000 });
  } finally { await page.close(); }
});

for (const theme of ["light", "dark"]) test(`手动代理不校验即可保存和清空，窄屏可用（${theme}）`, async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 900 });
  await page.goto(`/codey/tests/ui-browser.html?platform=windows&theme=${theme}`);
  await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible({ timeout: 60_000 });
  const commands = [];
  await page.exposeFunction("recordProxyCommand", path => commands.push(path));
  await page.evaluate(() => {
    const bridge = window.__codexSessionDeleteBridge;
    window.__codexSessionDeleteBridge = async (path, args) => { await window.recordProxyCommand(path); return bridge(path, args); };
  });
  await page.getByRole("button", { name: "网络代理", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Codex 启动代理", exact: true });
  await expect(input).toBeVisible();
  await expect(page.getByRole("button", { name: "新增代理", exact: true })).toHaveCount(0);
  await expect(page.getByRole("switch", { name: /代理池/ })).toHaveCount(0);
  await input.fill("invalid proxy address");
  await expect(input).not.toHaveAttribute("aria-invalid", "true");
  await page.getByRole("button", { name: "保存更改", exact: true }).click();
  await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible();
  expect((await page.evaluate(() => window.__codexSessionDeleteBridge("/api/load_codey_config", {}))).config.codexLaunchProxy).toBe("invalid proxy address");
  const section = page.locator('[aria-labelledby="network-proxy-title"]');
  expect(await section.locator(".launch-proxy-card").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await section.screenshot({ path: `output/playwright/network-proxy-manual-${theme}.png` });
  await page.getByRole("button", { name: "清空代理设置", exact: true }).focus();
  await page.keyboard.press("Space");
  await expect(input).toHaveValue("");
  await page.getByRole("button", { name: "保存更改", exact: true }).click();
  await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible();
  expect(commands.some(command => /network_proxy_(get|save|test)/.test(command))).toBe(false);
});

test("已运行时显示代理降级提示，普通成功状态不会盖住提示", async ({ page }) => {
  const warning = "Codex 启动代理无法应用，已沿用原有网络环境继续启动";
  await page.addInitScript(value => {
    let bridge;
    Object.defineProperty(window, "__codexSessionDeleteBridge", {
      configurable: true, get: () => bridge,
      set(next) { bridge = async (path, args) => {
        if (path.endsWith("/update_install_report")) return null;
        const result = await next(path, args);
        return path.endsWith("/runtime_status") ? { ...result, startupWarning: value } : result;
      }; },
    });
  }, warning);
  await page.goto("/codey/tests/ui-browser.html?platform=windows");
  await expect(page.getByText(warning, { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible();
  await page.screenshot({ path: "output/playwright/network-proxy-startup-warning.png" });
});
