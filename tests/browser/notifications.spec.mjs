import { expect, test as base } from "@playwright/test";

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await use(page);
    expect(errors, "通知管理不应出现未捕获异常").toEqual([]);
  },
});

async function openSettings(page) {
  await page.goto("/codey/tests/ui-browser.html?platform=windows");
  await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible({ timeout: 60_000 });
  await page.evaluate(() => {
    const bridge = window.__codexSessionDeleteBridge;
    const state = window.notificationBehavior = { commands: [], tests: [], polls: [], failSave: false };
    window.__codexSessionDeleteBridge = (path, args) => {
      state.commands.push(path.split("/").at(-1));
      if (path.endsWith("/test_notification_channel")) return new Promise(resolve => state.tests.push(resolve));
      if (path.endsWith("/poll_wechat_claw_login")) return new Promise(resolve => state.polls.push(resolve));
      if (path.endsWith("/save_codey_config") && state.failSave) {
        state.failSave = false;
        return { status: "failed", message: "测试：通知渠道保存失败" };
      }
      return bridge(path, args);
    };
  });
}

test("编辑渠道测试期间防重，保存失败保留表单，重试和确认删除更新列表", async ({ page }) => {
  await openSettings(page);
  const edit = page.locator('button[aria-label="编辑飞书机器人 Webhook通知渠道"]');
  await edit.click();
  const dialog = page.getByRole("dialog", { name: "编辑飞书渠道", exact: true });
  const url = dialog.getByRole("textbox", { name: "Webhook 地址", exact: true });
  await url.fill("https://notify.example.com/new-hook");
  await dialog.getByRole("button", { name: "测试发送", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "正在测试", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "保存配置", exact: true })).toBeDisabled();
  await dialog.press("Escape"); await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => window.notificationBehavior.tests.length)).toBe(1);
  await page.evaluate(() => window.notificationBehavior.tests[0]({ status: "ok" }));
  await expect(page.getByText("测试发送成功", { exact: true })).toBeVisible();
  await page.evaluate(() => { window.notificationBehavior.failSave = true; });
  await dialog.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(page.getByText("测试：通知渠道保存失败", { exact: true })).toBeVisible();
  await expect(url).toHaveValue("https://notify.example.com/new-hook");
  await dialog.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeDisabled();
  await edit.click();
  await expect(url).toHaveValue("https://notify.example.com/new-hook");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.locator('button[aria-label="删除飞书通知渠道"]').click();
  await page.getByRole("dialog", { name: "删除飞书通知渠道？", exact: true }).getByRole("button", { name: "删除渠道", exact: true }).click();
  await expect(edit).toHaveCount(0);
});

test("微信扫码关闭后旧激活结果不写入新渠道，当前扫码完成后才允许保存", async ({ page }) => {
  await openSettings(page);
  const dialog = page.getByRole("dialog", { name: "添加通知渠道", exact: true });
  async function startLogin() {
    await page.getByRole("button", { name: "添加渠道", exact: true }).click();
    await dialog.getByRole("button", { name: /发送渠道/ }).click();
    await page.getByRole("option", { name: "微信 ClawBot", exact: true }).click();
    await dialog.getByRole("button", { name: "扫码绑定", exact: true }).click();
    await expect(dialog.getByRole("img", { name: "微信 ClawBot 登录二维码" })).toBeVisible();
  }
  await startLogin();
  await expect.poll(() => page.evaluate(() => window.notificationBehavior.polls.length)).toBe(1);
  await dialog.getByRole("button", { name: "取消", exact: true }).click(); await expect(dialog).not.toBeVisible();
  await startLogin();
  await expect.poll(() => page.evaluate(() => window.notificationBehavior.polls.length)).toBe(2);
  const userId = dialog.getByRole("textbox", { name: "iLink 用户 ID", exact: true });
  async function confirm(index, recipientId) {
    await page.evaluate(({ index, recipientId }) => window.notificationBehavior.polls[index]({ status: "confirmed",
      baseUrl: "https://ilinkai.weixin.qq.com", botToken: "test-only-token", contextToken: "test-only-context", recipientId }), { index, recipientId });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  await confirm(0, "obsolete-user"); await expect(userId).toHaveValue("");
  await expect(dialog.getByRole("button", { name: "添加渠道", exact: true })).toBeDisabled();
  await confirm(1, "current-user"); await expect(userId).toHaveValue("current-user");
  await expect(dialog.getByText("绑定并激活成功，保存后即可接收通知。", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "添加渠道", exact: true }).click(); await expect(dialog).not.toBeVisible();
  await expect(page.locator('button[aria-label="编辑微信 ClawBot 通知通知渠道"]')).toBeVisible();
});
