import { expect, test } from "@playwright/test";

test("Ponytail 官方安装、模式保存、失败草稿与窄屏交互", async ({ page }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/codey/tests/ui-browser.html?platform=windows");
  await page.getByRole("button", { name: "内置工具", exact: true }).click();
  const card = page.getByRole("article", { name: "Ponytail", exact: true });
  const toggle = card.getByRole("switch", { name: "启用 Ponytail", exact: true });
  await expect(toggle).toBeEnabled(); await expect(toggle).not.toBeChecked();
  await toggle.locator("xpath=ancestor::label").click();
  await expect(card.getByRole("status").filter({ hasText: "正在通过 Codex" })).toBeVisible();
  await expect(toggle).toBeDisabled();
  await page.getByRole("button", { name: "基础功能", exact: true }).click();
  await page.getByRole("button", { name: "内置工具", exact: true }).click();
  await expect(toggle).toBeChecked(); await expect(card.getByText("v5.3.2", { exact: true })).toBeVisible();
  const mode = card.getByRole("button", { name: /Ponytail 默认模式/ });
  await mode.click(); await page.getByRole("option", { name: "Ultra · 强化", exact: true }).click();
  await card.getByRole("button", { name: "保存 Ponytail 参数" }).click();
  await expect(card.getByRole("status").filter({ hasText: "默认模式已保存" })).toBeVisible();
  await expect(card.getByRole("button", { name: "保存 Ponytail 参数" })).toBeDisabled();
  await page.evaluate(() => {
    const bridge = window.__codexSessionDeleteBridge;
    let failed = false;
    window.__codexSessionDeleteBridge = (path, args) => {
      if (path.endsWith("/builtin_tools") && args.tool === "ponytail" && args.action === "save_settings" && !failed) {
        failed = true; return Promise.reject(new Error("测试：配置已被修改"));
      }
      return bridge(path, args);
    };
  });
  await mode.click(); await page.getByRole("option", { name: "Lite · 轻量", exact: true }).click();
  await card.getByRole("button", { name: "保存 Ponytail 参数" }).click();
  await expect(card.getByRole("alert")).toContainText("配置已被修改");
  await expect(mode).toContainText("Lite");
  await card.getByRole("button", { name: "保存 Ponytail 参数" }).click();
  await expect(card.getByRole("alert")).toHaveCount(0);
  await expect(toggle).toBeEnabled();
  await toggle.focus(); await toggle.press("Space"); await expect(toggle).not.toBeChecked();
  await expect(card.getByText("v5.3.2", { exact: true })).toBeVisible(); await expect(mode).toContainText("Lite");
  for (const theme of ["light", "dark"]) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; document.documentElement.style.colorScheme = value; }, theme);
    await card.scrollIntoViewIfNeeded(); await page.screenshot({ path: `output/playwright/ponytail-${theme}.png` });
  }
  await page.setViewportSize({ width: 420, height: 900 }); await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "output/playwright/ponytail-narrow.png" });
  expect(await card.evaluate(element => element.scrollWidth > element.clientWidth + 1)).toBe(false);
  expect(errors).toEqual([]);
});
