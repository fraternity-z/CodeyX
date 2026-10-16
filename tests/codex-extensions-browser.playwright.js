async (page, { baseURL = new URL(page.url()).origin } = {}) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${baseURL}/codey/tests/ui-browser.html?platform=windows`);
  await page.getByRole("button", { name: "MCP 管理", exact: true }).waitFor();
  await page.evaluate(() => {
    const bridge = window.__codexSessionDeleteBridge;
    const behavior = window.extensionsBehavior = { calls: [], failNext: "", defer: "", release: null };
    window.__codexSessionDeleteBridge = async (path, args) => {
      if (path.endsWith("/codex_extensions")) {
        const request = args.request;
        behavior.calls.push({ action: request.action, id: request.id, revision: request.revision, confirmed: request.confirmed });
        if (behavior.defer === request.action) await new Promise(resolve => { behavior.release = resolve; });
        if (behavior.failNext === request.action) {
          behavior.failNext = "";
          throw new Error("测试：版本已变化，请刷新确认");
        }
      }
      return bridge(path, args);
    };
  });
  await page.getByRole("button", { name: "MCP 管理", exact: true }).click();
  const region = page.getByRole("region", { name: "MCP 管理", exact: true });
  await region.getByRole("button", { name: "新增 MCP", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "新增 MCP", exact: true });
  await editor.getByRole("textbox", { name: "服务标识", exact: true }).fill("migration-fixture");
  await editor.getByRole("textbox", { name: "服务配置 JSON", exact: true }).fill('{"command":"fixture-command","args":[]}');
  await page.evaluate(() => { window.extensionsBehavior.failNext = "save_mcp"; });
  await editor.getByRole("button", { name: "校验并保存", exact: true }).click();
  await editor.getByText("测试：版本已变化，请刷新确认", { exact: true }).waitFor();
  if (await editor.getByRole("textbox", { name: "服务标识", exact: true }).inputValue() !== "migration-fixture") throw new Error("保存失败丢失草稿");
  await editor.getByRole("button", { name: "校验并保存", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  await region.getByRole("heading", { name: "migration-fixture", exact: true }).waitFor();

  await region.locator('button[aria-label="编辑 migration-fixture"]').click();
  const editing = page.getByRole("dialog", { name: "编辑 MCP", exact: true });
  await editing.getByRole("textbox", { name: "服务配置 JSON", exact: true }).fill('{"command":"changed-fixture"}');
  await editing.getByRole("button", { name: "校验并保存", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "保存 MCP 配置", exact: true });
  await confirmation.waitFor();
  if (await page.evaluate(() => window.extensionsBehavior.calls.filter(call => call.action === "save_mcp").length) !== 2) throw new Error("确认前发送了保存请求");
  await confirmation.getByRole("button", { name: "确认", exact: true }).click();
  await editing.waitFor({ state: "hidden" });

  await region.getByRole("searchbox", { name: "搜索 MCP", exact: true }).fill("migration-fixture");
  await page.evaluate(() => { window.extensionsBehavior.defer = "set_mcp_enabled"; });
  const toggle = region.getByRole("switch", { name: "禁用 migration-fixture", exact: true });
  await toggle.focus(); await toggle.press("Space");
  await page.waitForFunction(() => typeof window.extensionsBehavior.release === "function");
  await page.getByRole("button", { name: "基础功能", exact: true }).click();
  await page.getByRole("button", { name: "MCP 管理", exact: true }).click();
  if (await region.getByRole("searchbox", { name: "搜索 MCP", exact: true }).inputValue() !== "migration-fixture") throw new Error("重开丢失筛选");
  if (!await toggle.isDisabled()) throw new Error("重开提前释放写入锁");
  await page.evaluate(() => { window.extensionsBehavior.defer = ""; window.extensionsBehavior.release(); });
  const enable = region.getByRole("switch", { name: "启用 migration-fixture", exact: true });
  await enable.waitFor();
  if (await page.evaluate(() => window.extensionsBehavior.calls.filter(call => call.action === "set_mcp_enabled").length) !== 1) throw new Error("重放了启停写入");

  await page.getByRole("button", { name: "Skill 管理", exact: true }).click();
  await page.getByRole("button", { name: "缓存 Skill 管理", exact: true }).click();
  const cache = page.getByRole("dialog", { name: "缓存 Skill 管理", exact: true });
  await cache.getByRole("button", { name: "查看", exact: true }).first().click();
  const content = cache.getByRole("textbox", { name: "缓存 SKILL.md 内容", exact: true });
  await content.waitFor();
  if (await content.getAttribute("readonly") === null) throw new Error("缓存内容必须只读");
  await page.evaluate(() => { window.extensionsBehavior.failNext = "remove_skill_cache"; });
  await cache.getByRole("button", { name: "删除", exact: true }).first().click();
  let remove = page.getByRole("dialog", { name: /^删除缓存 Skill/ });
  await remove.getByRole("button", { name: "确认", exact: true }).click();
  await remove.waitFor({ state: "hidden" });
  await cache.getByText("测试：版本已变化，请刷新确认", { exact: true }).waitFor();
  if (!await cache.getByRole("button", { name: "删除", exact: true }).first().isDisabled()) throw new Error("冲突后没有阻止继续删除");
  await cache.getByRole("button", { name: "刷新缓存", exact: true }).click();
  await cache.getByRole("button", { name: "删除", exact: true }).first().click();
  remove = page.getByRole("dialog", { name: /^删除缓存 Skill/ });
  await remove.getByRole("button", { name: "确认", exact: true }).click();
  await cache.getByText("暂无缓存 Skill。", { exact: true }).waitFor();
  await page.screenshot({ path: "output/playwright/codex-extensions.png", fullPage: true });
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("PASS: MCP 保存失败保留草稿、编辑确认、隐藏重开写入锁、筛选保留、缓存只读与删除冲突恢复。");
}
