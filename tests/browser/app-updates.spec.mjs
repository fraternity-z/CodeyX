import { expect, test as base } from "@playwright/test";

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await use(page);
    expect(errors, "更新流程不应出现未捕获异常").toEqual([]);
  },
});

async function openSettings(page) {
  await page.goto("/codey/tests/ui-browser.html?platform=windows");
  await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible({ timeout: 60_000 });
  await page.evaluate(() => {
    const bridge = window.__codexSessionDeleteBridge;
    const asset = { platform: "windows", arch: "x64", packageType: "exe", fileName: "setup.exe", size: 1024,
      url: "https://example.test/setup.exe", sha256: "a".repeat(64) };
    const update = { currentVersion: "1.0.0", latestVersion: "1.0.1", updateAvailable: true, releaseId: "42", selectedAsset: asset,
      releaseNotes: "## 更新测试\n\n完整的发布公告。" };
    const state = window.updateBehavior = { calls: [], update, deferDownload: false };
    window.__codexSessionDeleteBridge = async (path, args) => {
      const command = path.split("/").at(-1);
      if (["check_for_updates", "download_update", "install_downloaded_update", "save_codey_config"].includes(command)) state.calls.push({ command, args });
      if (command === "check_for_updates") return update;
      if (command === "download_update") {
        if (state.deferDownload) await new Promise(resolve => { state.finishDownload = resolve; });
        return { latestVersion: update.latestVersion, releaseId: update.releaseId, asset, ...asset, filePath: "/updates/setup.exe" };
      }
      if (command === "install_downloaded_update") return {};
      return bridge(path, args);
    };
  });
}

test("手动检查、下载与安装分别确认，下载锁定操作，安装前保存最新草稿", async ({ page }) => {
  await openSettings(page);
  await page.getByRole("button", { name: "检查 CodeyX 在线更新", exact: true }).click();
  const download = page.getByRole("dialog", { name: "发现 CodeyX 新版本 v1.0.1", exact: true });
  await expect(download).toBeVisible();
  await expect(download.getByText("完整的发布公告。", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.updateBehavior.calls.map(call => call.command))).toEqual(["check_for_updates"]);
  await page.evaluate(() => { window.updateBehavior.deferDownload = true; });
  await download.getByRole("button", { name: "立即更新", exact: true }).click();
  await expect(page.getByRole("button", { name: "关闭配置", exact: true })).toBeDisabled();
  await expect.poll(() => page.evaluate(() => typeof window.updateBehavior.finishDownload)).toBe("function");
  await page.evaluate(() => window.updateBehavior.finishDownload());
  const install = page.getByRole("dialog", { name: "安装更新", exact: true });
  await expect(install).toBeVisible();
  await install.getByRole("button", { name: "稍后", exact: true }).click();

  await page.getByRole("button", { name: "系统设置与偏好", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "系统设置与偏好", exact: true });
  await settings.getByRole("switch", { name: "CodeyX 自动更新", exact: true }).press("Space");
  await settings.press("Escape");
  await expect(page.getByRole("button", { name: "保存更改", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "新版本 v1.0.1 已下载，点击检查更新并安装", exact: true }).click();
  await expect(install).toBeVisible();
  await install.getByRole("button", { name: "安装并重启", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.updateBehavior.calls.map(call => call.command))).toEqual([
    "check_for_updates", "download_update", "check_for_updates", "save_codey_config", "install_downloaded_update",
  ]);
  expect(await page.evaluate(() => window.updateBehavior.calls.find(call => call.command === "save_codey_config").args.config.codeyUpdatePolicy)).toBe("off");
});

test("隐藏配置时后台公告保持待处理，重新打开后只展示一次", async ({ page }) => {
  await openSettings(page);
  await page.getByRole("button", { name: "关闭配置", exact: true }).click();
  await expect(page.getByRole("button", { name: "打开内嵌设置", exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.__codeyPendingUpdatePrompt = window.updateBehavior.update;
    window.dispatchEvent(new Event("codey-update-prompt"));
  });
  const download = page.getByRole("dialog", { name: "发现 CodeyX 新版本 v1.0.1", exact: true });
  await expect(download).not.toBeVisible();
  expect(await page.evaluate(() => window.__codeyPendingUpdatePrompt.latestVersion)).toBe("1.0.1");
  await page.getByRole("button", { name: "打开内嵌设置", exact: true }).click();
  await expect(download).toBeVisible();
  expect(await page.evaluate(() => window.__codeyPendingUpdatePrompt)).toBeNull();
  await download.getByRole("button", { name: "稍后", exact: true }).click();
  await page.getByRole("button", { name: "关闭配置", exact: true }).click();
  await page.getByRole("button", { name: "打开内嵌设置", exact: true }).click();
  await expect(download).not.toBeVisible();
  expect(await page.evaluate(() => window.updateBehavior.calls)).toEqual([]);
});

test("更新开关只有更新和不更新，关闭后仍需保存", async ({ page }) => {
  await openSettings(page);
  await page.getByRole("button", { name: "系统设置与偏好", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "系统设置与偏好", exact: true });
  await expect(settings.getByText("实验版", { exact: true })).toHaveCount(0);
  const toggle = settings.getByRole("switch", { name: "CodeyX 自动更新", exact: true });
  await expect(toggle).toBeChecked();
  await toggle.locator("xpath=ancestor::label").click();
  await expect(toggle).not.toBeChecked();
  await expect(settings.getByText("不更新", { exact: true })).toBeVisible();
  await settings.press("Escape");
  await expect(page.getByRole("button", { name: "保存更改", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.updateBehavior.calls)).toEqual([]);
});

test("下载源关闭自动更新后仍可选择，草稿和保存值在重开后保留", async ({ page }) => {
  await openSettings(page);
  const trigger = page.getByRole("button", { name: "系统设置与偏好", exact: true });
  await trigger.click();
  const settings = page.getByRole("dialog", { name: "系统设置与偏好", exact: true });
  const source = settings.getByRole("button", { name: /更新下载源$/ });
  await expect(source).toContainText("GitHub 官方");
  await settings.getByRole("switch", { name: "CodeyX 自动更新", exact: true }).press("Space");
  await expect(source).toBeEnabled();
  await source.click();
  await page.getByRole("option", { name: "GH-Proxy 加速", exact: true }).click();
  await expect(source).toContainText("GH-Proxy 加速");
  await expect(settings.getByText("保存后生效。GH-Proxy 仅代理安装包下载，失败时自动回退 GitHub 官方源。", { exact: true })).toBeVisible();
  await settings.press("Escape"); await trigger.click();
  await expect(source).toContainText("GH-Proxy 加速");
  await expect(settings.locator('[data-slot="toast"]')).toHaveCount(0);
  await settings.screenshot({ path: "output/playwright/ghproxy-settings-light.png" });
  await settings.press("Escape");
  await page.getByRole("button", { name: "保存更改", exact: true }).click();
  await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.updateBehavior.calls.filter(call => call.command === "save_codey_config").map(call => ({
    source: call.args.config.codeyUpdateDownloadSource, policy: call.args.config.codeyUpdatePolicy,
  })))).toEqual([{ source: "ghProxy", policy: "off" }]);
  await page.getByRole("button", { name: "关闭配置", exact: true }).click();
  await page.getByRole("button", { name: "打开内嵌设置", exact: true }).click(); await trigger.click();
  await expect(source).toContainText("GH-Proxy 加速");
  await expect(settings.getByRole("switch", { name: "CodeyX 自动更新", exact: true })).not.toBeChecked();
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await settings.screenshot({ path: "output/playwright/ghproxy-settings-dark.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(source).toBeVisible();
  const bounds = await settings.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await settings.screenshot({ path: "output/playwright/ghproxy-settings-narrow.png" });
});
