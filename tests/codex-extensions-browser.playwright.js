async (page, { baseURL = new URL(page.url()).origin } = {}) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${baseURL}/codey/tests/ui-browser.html?platform=windows`);
  await page.getByRole("button", { name: "MCP 管理", exact: true }).waitFor();
  await page.evaluate(() => {
    const bridge = window.__codexSessionDeleteBridge;
    const behavior = window.extensionsBehavior = { calls: [], failNext: "", defer: "", release: null, sharing: {}, enabled: false, released: false };
    window.__codexSessionDeleteBridge = async (path, args) => {
      if (path.endsWith("/codex_extensions")) {
        const request = args.request;
        behavior.calls.push({ action: request.action, id: request.id, revision: request.revision, confirmed: request.confirmed, enabled: request.enabled });
        if (behavior.defer === request.action) await new Promise(resolve => { behavior.release = resolve; });
        if (behavior.failNext === request.action) {
          behavior.failNext = "";
          throw new Error("测试：版本已变化，请刷新确认");
        }
        if (request.action === "mcp_sharing_status") return { enabled: behavior.enabled, pools: behavior.enabled ? [{ registrationId: "fixture-sharing", id: "migration-fixture", sourcePath: "", instances: 2, running: 1, queued: behavior.released ? 0 : 3 }] : [] };
        if (request.action === "set_mcp_scheduler_enabled") {
          behavior.enabled = request.enabled;
          const inventory = await bridge(path, { request: { action: "list", scope: request.scope } });
          inventory.mcps = inventory.mcps.map(entry => ({ ...entry, sharing: behavior.sharing[entry.id] }));
          return { inventory, message: "共享器设置已保存；内置工具请重启 Codex 后确认。", applyStatus: "applied" };
        }
        if (request.action === "release_mcp_idle") {
          behavior.released = true;
          return { status: "success", message: "空闲实例已释放，忙碌请求继续执行。" };
        }
        if (request.action === "set_mcp_sharing") {
          behavior.sharing[request.id] = { enabled: request.enabled, maxInstances: request.maxInstances, registrationId: "fixture-sharing" };
          const inventory = await bridge(path, { request: { action: "list", scope: request.scope } });
          inventory.mcps = inventory.mcps.map(entry => ({ ...entry, sharing: behavior.sharing[entry.id] }));
          return { inventory, message: "共享设置已保存", applyStatus: "applied" };
        }
      }
      const result = await bridge(path, args);
      if (path.endsWith("/codex_extensions") && args.request.action === "list") {
        result.mcps = result.mcps.map(entry => ({ ...entry, sharing: behavior.sharing[entry.id] }));
      }
      return result;
    };
  });
  await page.getByRole("button", { name: "MCP 管理", exact: true }).click();
  const region = page.getByRole("region", { name: "MCP 管理", exact: true });
  const scheduler = region.getByRole("switch", { name: "启用共享器", exact: true });
  await scheduler.waitFor();
  if (await scheduler.isChecked()) throw new Error("总开关未读取持久关闭状态");
  await page.evaluate(() => { window.extensionsBehavior.failNext = "set_mcp_scheduler_enabled"; });
  await scheduler.focus(); await scheduler.press("Space");
  await region.getByText("测试：版本已变化，请刷新确认", { exact: true }).waitFor();
  if (await scheduler.isChecked()) throw new Error("保存失败翻转了总开关");
  await page.evaluate(() => { window.extensionsBehavior.defer = "set_mcp_scheduler_enabled"; });
  await scheduler.focus(); await scheduler.press("Space");
  await page.waitForFunction(() => typeof window.extensionsBehavior.release === "function");
  if (!await scheduler.isDisabled()) throw new Error("保存中总开关没有禁止重复提交");
  await page.evaluate(() => { window.extensionsBehavior.defer = ""; window.extensionsBehavior.release(); });
  await region.getByText("已开启 · 全局", { exact: true }).waitFor();
  if (!await scheduler.isChecked() || await scheduler.isDisabled()) throw new Error("开启后的总开关状态不正确");
  await scheduler.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "output/playwright/mcp-scheduler-light.png", fullPage: true });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await page.waitForTimeout(200);
  await page.screenshot({ path: "output/playwright/mcp-scheduler-dark.png", fullPage: true });
  await page.setViewportSize({ width: 460, height: 900 });
  await scheduler.scrollIntoViewIfNeeded();
  const panel = region.locator('[aria-label="MCP 共享器"]');
  if (await panel.evaluate(element => element.scrollWidth > element.clientWidth)) throw new Error("共享器卡片窄屏横向溢出");
  await page.screenshot({ path: "output/playwright/mcp-scheduler-narrow.png", fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
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

  const share = region.getByRole("switch", { name: "共享 migration-fixture 实例", exact: true });
  await share.focus(); await share.press("Space");
  const sharingConfirmation = page.getByRole("dialog", { name: "共享 migration-fixture 实例", exact: true });
  await sharingConfirmation.getByText(/仅适合已确认无会话状态/).waitFor();
  if (await page.evaluate(() => window.extensionsBehavior.calls.some(call => call.action === "set_mcp_sharing"))) throw new Error("确认前启用了共享");
  await sharingConfirmation.getByRole("button", { name: "确认", exact: true }).click();
  await region.getByText("执行 1 · 排队 3", { exact: true }).waitFor();
  await page.screenshot({ path: "output/playwright/mcp-sharing-light.png", fullPage: true });
  await region.getByRole("button", { name: "释放空闲实例", exact: true }).click();
  await region.getByText("执行 1 · 排队 0", { exact: true }).waitFor();
  await scheduler.focus(); await scheduler.press("Space");
  await region.getByText("共享器已关闭，当前直连；共享选择已保留。", { exact: true }).waitFor();
  if (!await share.isChecked()) throw new Error("关闭总开关丢失了服务共享选择");
  await scheduler.focus(); await scheduler.press("Space");
  await region.getByText("执行 1 · 排队 0", { exact: true }).waitFor();
  const limit = region.getByRole("button", { name: /migration-fixture 每池实例上限$/ });
  await limit.click();
  await page.getByRole("option", { name: "8 个", exact: true }).click();
  await page.waitForFunction(() => window.extensionsBehavior.sharing["migration-fixture"].maxInstances === 8);
  await page.getByRole("listbox").waitFor({ state: "hidden" });
  await page.waitForTimeout(300);
  await page.waitForFunction(input => !input.disabled, await share.elementHandle());
  await page.evaluate(() => { window.extensionsBehavior.failNext = "set_mcp_sharing"; });
  await share.focus(); await share.press("Space");
  await region.getByText("测试：版本已变化，请刷新确认", { exact: true }).waitFor();
  if (!await share.isChecked()) throw new Error("保存失败改变了共享配置");
  await share.focus(); await share.press("Space");
  await page.waitForFunction(() => window.extensionsBehavior.sharing["migration-fixture"].enabled === false);

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
  const sharingReads = await page.evaluate(() => window.extensionsBehavior.calls.filter(call => call.action === "mcp_sharing_status").length);
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
  if (await page.evaluate(() => window.extensionsBehavior.calls.filter(call => call.action === "mcp_sharing_status").length) !== sharingReads) throw new Error("Skill 页面仍轮询共享状态");
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("PASS: 共享器持久状态、保存失败与防重复、总开关保留服务选择、空闲释放刷新、明暗及窄屏、非 MCP 页暂停轮询、MCP 草稿与缓存删除回归。");
}
