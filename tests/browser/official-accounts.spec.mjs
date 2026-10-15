import { expect, test as base } from "@playwright/test";

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await use(page);
    expect(errors).toEqual([]);
  },
});

async function openAccounts(page) {
  await page.goto("/codey/tests/ui-browser.html?platform=windows");
  await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible({ timeout: 60_000 });
  await page.evaluate(() => {
    const bridge = window.__codexSessionDeleteBridge;
    const state = window.accountBehavior = { calls: [], deferImport: false, loginPolls: [] };
    window.__codexSessionDeleteBridge = async (path, args) => {
      // 仅记录命令名称；不保留凭据输入。
      state.calls.push(path.split("/").at(-1));
      if (path.endsWith("/import_official_account_credential") && state.deferImport) {
        await new Promise(resolve => { state.releaseImport = resolve; });
      }
      if (path.endsWith("/poll_official_account_login") && state.deferLogin) {
        return new Promise(resolve => state.loginPolls.push(resolve));
      }
      return bridge(path, args);
    };
  });
  await page.getByRole("button", { name: "线路与模型", exact: true }).click();
  await expect(page.locator(".official-account-item")).toHaveCount(3);
}

test("手动导入失败保留输入，重试等待期间禁用重复提交，成功清空草稿", async ({ page }) => {
  await openAccounts(page);
  await page.getByRole("button", { name: "手动输入", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "手动添加官方账号" });
  const input = dialog.getByRole("textbox", { name: "Refresh Token 或 OAuth JSON" });
  const submit = dialog.getByRole("button", { name: "添加", exact: true });
  await expect(submit).toBeDisabled();
  await input.fill("invalid-fixture");
  await submit.click();
  await expect(dialog.getByText("Refresh Token 已被拒绝，请确认令牌仍然有效", { exact: true })).toBeVisible();
  await expect(input).toHaveValue("invalid-fixture");
  await input.fill("fixture-credential");
  await page.evaluate(() => { window.accountBehavior.deferImport = true; });
  await submit.click();
  await expect(submit).toBeDisabled(); await expect(input).toBeDisabled();
  await dialog.press("Escape"); await expect(dialog).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.accountBehavior.calls.filter(command => command === "import_official_account_credential").length)).toBe(2);
  await page.evaluate(() => window.accountBehavior.releaseImport());
  await expect(dialog).not.toBeVisible();
  await expect(page.locator(".official-account-item")).toHaveCount(4);
  await page.getByRole("button", { name: "手动输入", exact: true }).click();
  await expect(input).toHaveValue("");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "基础功能", exact: true }).click();
  await page.getByRole("button", { name: "线路与模型", exact: true }).click();
  await expect(page.locator(".official-account-item")).toHaveCount(4);
});

test("键盘切换默认账号、停用直连和删除账号经过确认并更新卡片", async ({ page }) => {
  await openAccounts(page);
  const backup = page.locator(".official-account-item").filter({ hasText: "backup@example.com" });
  await backup.focus(); await backup.press("Enter");
  const switchDialog = page.getByRole("dialog", { name: "切换默认官方账号为「backup@example.com」？" });
  await switchDialog.getByRole("button", { name: "设为默认", exact: true }).click();
  await expect(backup).toHaveClass(/is-default/);
  const primary = page.locator(".official-account-item").filter({ hasText: "preview@example.com" });
  await primary.locator('button[aria-label="停用官方直连"]').click();
  const siwcDialog = page.getByRole("dialog", { name: "停用「preview@example.com」的官方直连？" });
  await siwcDialog.getByRole("button", { name: "停用直连", exact: true }).click();
  await expect(primary.locator('button[aria-label="启用官方直连"]')).toBeVisible();
  await primary.locator('button[aria-label="移除官方账号 preview@example.com"]').click();
  const removeDialog = page.getByRole("dialog", { name: "移除官方账号「preview@example.com」？" });
  await removeDialog.getByRole("button", { name: "移除账号", exact: true }).click();
  await expect(page.locator(".official-account-item")).toHaveCount(2);
  await expect(backup).toHaveClass(/is-default/);
});

test("取消登录后旧响应不打开弹窗，新登录只处理自己的轮询", async ({ page }) => {
  await openAccounts(page);
  await page.evaluate(() => { window.accountBehavior.deferLogin = true; });
  const add = page.getByRole("button", { name: "添加账号", exact: true });
  const dialog = page.getByRole("dialog", { name: "添加官方账号", exact: true });
  await add.click(); await expect(dialog).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.accountBehavior.loginPolls.length)).toBe(1);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await add.click(); await expect(dialog).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.accountBehavior.loginPolls.length)).toBe(2);
  await page.evaluate(() => window.accountBehavior.loginPolls[0]({ status: "failed", message: "过期轮询错误" }));
  await expect(dialog.getByText("过期轮询错误", { exact: true })).not.toBeVisible();
  await page.evaluate(() => window.accountBehavior.loginPolls[1]({ status: "expired" }));
  await expect(dialog.getByText("登录已过期，请重新开始", { exact: true })).toBeVisible();
  await dialog.press("Escape"); await expect(dialog).not.toBeVisible();
});
