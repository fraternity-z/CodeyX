import { expect, test } from "@playwright/test";

async function open(page) {
  await page.goto("/codey/tests/ui-browser.html?platform=windows");
  await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "会话管理", exact: true }).click();
  await expect(page.getByRole("checkbox").first()).toBeVisible();
}

test("管理面板会话选择、归档筛选、永久清理确认和重启提示", async ({ page }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await open(page);
  await page.screenshot({ path: "output/playwright/session-management.png" });
  await page.getByRole("combobox", { name: "会话范围" }).selectOption("archived");
  await page.getByRole("searchbox", { name: "搜索会话" }).fill("已归档的界面方案");
  await expect(page.getByRole("checkbox")).toHaveCount(1);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "清理所选", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "永久清理所选会话？" });
  await expect(dialog).toContainText("其中归档 1 个");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("checkbox")).toBeChecked();
  await page.getByRole("button", { name: "清理所选", exact: true }).click();
  await dialog.getByRole("button", { name: "确认永久清理", exact: true }).click();
  await expect(page.getByText("没有符合条件的会话。", { exact: true })).toBeVisible();
  await expect(page.getByText(/请通过 CodeyX 重启 Codex，完成剩余缓存清理/)).toBeVisible();
  await expect(page.getByRole("button", { name: "重启 Codex", exact: true }).last()).toBeEnabled();
  expect(errors).toEqual([]);
});

test("全部清理明确包含筛选外归档，窄屏可选择并显示空状态", async ({ page }) => {
  await page.setViewportSize({ width: 620, height: 820 });
  await open(page);
  await page.getByRole("combobox", { name: "会话范围" }).selectOption("active");
  await page.getByRole("button", { name: "清空全部（含归档）", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "清空全部本机会话？" });
  await expect(dialog).toContainText("25 个本机会话，其中归档 12 个");
  await expect(dialog).toContainText("包含当前筛选条件以外的全部会话");
  await dialog.getByRole("button", { name: "确认永久清理", exact: true }).click();
  await expect(page.getByText("暂无本机会话。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "清空全部（含归档）", exact: true })).toBeDisabled();
  await page.screenshot({ path: "output/playwright/session-management-narrow.png" });
});
