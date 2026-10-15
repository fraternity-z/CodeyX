async (page) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.getByRole("heading", { name: "请求日志", exact: true }).waitFor();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await page.getByText("第 2 / 3 页", { exact: true }).waitFor();

  await page.getByRole("textbox", { name: "搜索请求 ID、会话 ID、供应商、模型或上游" }).fill("preview-request-0001");
  await page.getByText("共 1 条", { exact: true }).waitFor();
  await page.getByText("第 1 / 1 页", { exact: true }).waitFor();
  await page.getByRole("row").nth(1).click();
  await page.getByRole("dialog", { name: "请求详情", exact: true }).waitFor();
  await page.getByRole("button", { name: "关闭详情", exact: true }).click();
  await page.getByRole("button", { name: "清除筛选 (1)", exact: true }).click();
  await page.getByText("共 47 条", { exact: true }).waitFor();

  await page.getByRole("button", { name: "展开概览", exact: true }).last().click();
  await page.getByText("所选范围 Token 消耗", { exact: true }).waitFor();
  await page.getByRole("button", { name: "收起概览", exact: true }).last().click();
  await page.setViewportSize({ width: 760, height: 860 });
  await page.screenshot({ path: "output/playwright/architecture-request-logs-light.png", fullPage: true, animations: "disabled" });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.style.colorScheme = "dark";
  });
  await page.screenshot({ path: "output/playwright/architecture-request-logs-dark.png", fullPage: true, animations: "disabled" });

  // 本脚本只在 ui-browser.html?view=logs 的模拟后端上执行。
  if (!page.url().includes("/tests/ui-browser.html?view=logs")) throw new Error("删除回归必须使用日志模拟页面");
  await page.getByRole("button", { name: "删除请求日志", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "删除全部请求日志？", exact: true });
  await dialog.getByRole("button", { name: "确认删除全部日志", exact: true }).click();
  await page.getByText("请求日志已全部删除。", { exact: true }).waitFor();
  await page.getByText("暂无请求日志", { exact: true }).waitFor();
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("PASS: 日志翻页、搜索重置分页、详情、概览、明暗窄屏和删除确认。");
}
