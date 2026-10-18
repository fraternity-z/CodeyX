import { expect, test } from "@playwright/test";

async function open(page, theme = "light") {
  await page.goto(`/codey/tests/ui-browser.html?platform=windows&theme=${theme}`);
  await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "备份与恢复", exact: true }).click();
  await expect(page.getByRole("button", { name: "导出 JSON", exact: true })).toBeEnabled();
}

test("JSON 导出、导入预览、取消与确认恢复", async ({ page }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await open(page);
  await expect(page.getByText(/JSON 含线路 API Key/)).toBeVisible();
  await page.screenshot({ path: "output/playwright/backup.png" });
  const waiting = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 JSON", exact: true }).click();
  const download = await waiting;
  expect(download.suggestedFilename()).toMatch(/^CodeyX-backup-.*\.json$/);
  const chunks = []; for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  const buffer = Buffer.concat(chunks); const backup = JSON.parse(buffer.toString("utf8"));
  expect(backup.format).toBe("codeyx-config"); expect(backup.version).toBe(1);
  const input = page.getByLabel("选择 JSON 备份");
  await input.setInputFiles({ name: "backup.json", mimeType: "application/json", buffer });
  const dialog = page.getByRole("dialog", { name: "恢复这份配置备份？" });
  await expect(dialog).toContainText("backup.json");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toBeHidden();
  await input.setInputFiles({ name: "backup.json", mimeType: "application/json", buffer });
  await dialog.getByRole("button", { name: "确认恢复", exact: true }).click();
  await expect(page.getByText(/配置已恢复.*恢复前备份/)).toBeVisible();
  await expect(dialog).toBeHidden();
  await input.setInputFiles({ name: "invalid.json", mimeType: "application/json", buffer: Buffer.from("invalid") });
  await expect(page.getByRole("alert")).toContainText("有效的 JSON");
  expect(errors).toEqual([]);
});

test("深色界面校验 HTTP 授权，并在切页后保留未保存的连接草稿", async ({ page }) => {
  await open(page, "dark");
  await page.getByLabel("WebDAV 文件地址").fill("http://127.0.0.1/backup.json");
  await page.getByRole("button", { name: "保存 WebDAV 设置", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("明确允许未加密连接");
  await page.getByRole("button", { name: "基础功能", exact: true }).click();
  await page.getByRole("button", { name: "备份与恢复", exact: true }).click();
  await expect(page.getByLabel("WebDAV 文件地址")).toHaveValue("http://127.0.0.1/backup.json");
  await expect(page.getByLabel("WebDAV 文件地址")).toBeEnabled();
  await page.getByRole("checkbox", { name: /允许 HTTP/ }).check();
  await page.getByRole("button", { name: "保存 WebDAV 设置", exact: true }).click();
  await expect(page.getByText("WebDAV 设置已保存", { exact: true })).toBeVisible();
  await page.screenshot({ path: "output/playwright/backup-dark.png" });
});

test("窄屏 WebDAV 设置、缺失文件提示、覆盖确认与云端恢复预览", async ({ page }) => {
  await page.setViewportSize({ width: 620, height: 900 });
  await open(page);
  await expect(page.getByRole("button", { name: "备份到 WebDAV", exact: true })).toBeDisabled();
  await page.getByLabel("WebDAV 文件地址").fill("https://dav.example.com/backup.json");
  await page.getByLabel("WebDAV 用户名").fill("fixture-user");
  await page.getByLabel("WebDAV 密码", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "保存 WebDAV 设置", exact: true }).click();
  await expect(page.getByText("WebDAV 设置已保存", { exact: true })).toBeVisible();
  await expect(page.getByLabel("WebDAV 密码", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "从 WebDAV 恢复", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("不存在");
  await page.getByRole("button", { name: "备份到 WebDAV", exact: true }).click();
  const upload = page.getByRole("dialog", { name: "覆盖 WebDAV 云端备份？" });
  await upload.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "备份到 WebDAV", exact: true }).click();
  await upload.getByRole("button", { name: "确认上传", exact: true }).click();
  await expect(page.getByText("已备份到 WebDAV", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "从 WebDAV 恢复", exact: true }).click();
  const restore = page.getByRole("dialog", { name: "恢复这份配置备份？" });
  await expect(restore).toContainText("WebDAV 云端备份");
  await page.screenshot({ path: "output/playwright/backup-narrow.png" });
  await page.keyboard.press("Escape"); await expect(restore).toBeHidden();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
});
