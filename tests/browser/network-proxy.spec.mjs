import { expect, test as base } from "@playwright/test";

const test = base.extend({ page: async ({ page }, use) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await use(page); expect(errors).toEqual([]);
} });
// The UI harness is entirely local. Inherited desktop proxy settings must not
// route its Vite module requests through an external service.
test.use({ launchOptions: { args: ["--no-proxy-server"] } });

test.beforeAll(async ({ browser, baseURL }) => {
  // Cold Windows Vite module transforms can take several minutes. Keep this
  // setup separate from the unchanged time budget for each interaction test.
  test.setTimeout(300_000);
  const page = await browser.newPage({ baseURL });
  try {
    await page.goto("/codey/tests/ui-browser.html?platform=windows", { waitUntil: "commit" });
    await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible({ timeout: 240_000 });
  } finally { await page.close(); }
});

async function openNetwork(page, theme = "light") {
  await page.goto(`/codey/tests/ui-browser.html?platform=windows&theme=${theme}`);
  await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "网络代理", exact: true }).click();
  await expect(page.getByRole("button", { name: "新增代理", exact: true })).toBeEnabled();
}

async function addProxy(page, name, authenticated = false, host = "proxy.example") {
  await page.getByRole("button", { name: "新增代理", exact: true }).click();
  await page.getByRole("textbox", { name: "代理名称", exact: true }).fill(name);
  await page.getByRole("textbox", { name: "代理主机", exact: true }).fill(host);
  if (authenticated) {
    await page.getByLabel("代理认证", { exact: true }).selectOption("replace");
    await page.getByLabel("代理用户名", { exact: true }).fill("fixture-user");
    await page.getByLabel("代理密码", { exact: true }).fill("fixture-password");
  }
  await page.getByRole("button", { name: "保存到代理池", exact: true }).click();
  await expect(page.getByRole("form", { name: "代理节点编辑" })).not.toBeVisible();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
}

test("代理池新增、测试和编辑保留旧启动代理草稿，凭据不回显", async ({ page }) => {
  await openNetwork(page);
  const launch = page.getByRole("textbox", { name: "Codex 启动代理", exact: true });
  await launch.fill("http://127.0.0.1:7890");
  await addProxy(page, "固定出口", true);
  await expect(launch).toHaveValue("http://127.0.0.1:7890");
  const saved = await page.evaluate(async () => (await window.__codexSessionDeleteBridge("/api/network_proxy_get", {})).config);
  expect(saved.codexLaunchProxy).toBe("");
  expect(saved.networkProxy.nodes[0].enabled).toBe(false);
  expect(JSON.stringify(saved.networkProxy)).not.toContain("fixture-password");
  expect(saved.networkProxy.nodes[0].credentialRef).toBeTruthy();
  await page.getByRole("button", { name: "测试 固定出口", exact: true }).click();
  await expect(page.getByText("观测出口：203.0.113.5", { exact: true })).toBeVisible();
  await expect(page.getByText("预览结果，未发出真实网络请求", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const bridge = window.__codexSessionDeleteBridge;
    window.__codexSessionDeleteBridge = async (path, args) => path.endsWith("/network_proxy_test")
      ? { status: "failed", message: "测试：无法读取代理凭据" } : bridge(path, args);
  });
  await page.getByRole("button", { name: "测试 固定出口", exact: true }).click();
  await expect(page.getByText(/未取得测试结果 ·/)).toBeVisible();
  await expect(page.getByText("观测出口：203.0.113.5", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "编辑 固定出口", exact: true }).click();
  await expect(page.getByLabel("代理认证", { exact: true })).toHaveValue("keep");
  await expect(page.getByLabel("代理密码", { exact: true })).toHaveCount(0);
  await page.getByRole("textbox", { name: "代理名称", exact: true }).fill("出口改名");
  await page.getByRole("button", { name: "基础功能", exact: true }).click();
  await page.getByRole("button", { name: "网络代理", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "代理名称", exact: true })).toHaveValue("出口改名");
  await page.getByRole("button", { name: "保存到代理池", exact: true }).click();
  await expect(page.getByText("出口改名", { exact: true })).toBeVisible();
  await expect(page.getByText(/配置已变化，请重新测试/)).toBeVisible();
  await launch.fill("");
  // Global settings intentionally mark every edit dirty, including undo by typing.
  await page.getByRole("button", { name: "保存更改", exact: true }).click();
  await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeVisible();
  const latest = await page.evaluate(async () => (await window.__codexSessionDeleteBridge("/api/network_proxy_get", {})).config);
  expect(latest.codexLaunchProxy).toBe("");
  expect(latest.networkProxy.nodes[0].name).toBe("出口改名");
  expect(latest.networkProxy.nodes[0].credentialRef).toBe(saved.networkProxy.nodes[0].credentialRef);
});

test("筛选、排序和批量管理只修改所选节点，删除需要明确确认", async ({ page }) => {
  await openNetwork(page);
  await addProxy(page, "Beta"); await addProxy(page, "Alpha");
  await page.getByLabel("代理排序", { exact: true }).selectOption("name");
  const list = page.getByRole("list", { name: "代理节点列表" });
  await expect(list.getByRole("listitem").first()).toContainText("Alpha");
  await page.getByRole("checkbox", { name: "选择代理 Alpha", exact: true }).check();
  await page.getByRole("checkbox", { name: "选择代理 Beta", exact: true }).check();
  await page.getByRole("button", { name: "批量启用", exact: true }).click();
  await expect(list.getByText("已启用", { exact: true })).toHaveCount(2);
  await page.getByRole("textbox", { name: "搜索代理", exact: true }).fill("Beta");
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await page.getByRole("checkbox", { name: "选择代理 Beta", exact: true }).check();
  await page.getByRole("button", { name: "批量删除", exact: true }).click();
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await page.getByRole("button", { name: "确认删除代理", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索代理", exact: true }).fill("");
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list).toContainText("Alpha");
});

test("窄屏深色页面的表单可用，保存失败保留草稿并要求刷新", async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 900 });
  await openNetwork(page, "dark");
  await page.evaluate(() => {
    const bridge = window.__codexSessionDeleteBridge;
    window.__codexSessionDeleteBridge = async (path, args) => path.endsWith("/network_proxy_save")
      ? { status: "failed", message: "测试：系统密钥库暂不可用" } : bridge(path, args);
  });
  await page.getByRole("button", { name: "新增代理", exact: true }).click();
  await page.getByLabel("代理名称", { exact: true }).fill("保留草稿");
  await page.getByLabel("代理主机", { exact: true }).fill("proxy.example");
  await page.getByRole("button", { name: "保存到代理池", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("系统密钥库暂不可用");
  await expect(page.getByLabel("代理名称", { exact: true })).toHaveValue("保留草稿");
  await expect(page.getByRole("button", { name: "保存到代理池", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "刷新代理池", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存到代理池", exact: true })).toBeEnabled();
  const editor = page.getByRole("form", { name: "代理节点编辑" });
  expect(await editor.locator("fieldset").evaluate(element => getComputedStyle(element).display)).toBe("grid");
  expect(await editor.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await editor.screenshot({ path: "output/playwright/network-proxy-editor-dark.png" });
  await page.getByRole("button", { name: "取消编辑", exact: true }).click();
});

for (const theme of ["light", "dark"]) test(`线路开关保留节点、失败草稿与默认网络，窄屏可用（${theme}）`, async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 900 });
  await openNetwork(page, theme);
  await expect(page.getByRole("heading", { name: "代理链路", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "出口策略", exact: true })).toHaveCount(0);
  await addProxy(page, "线路节点");
  const entry = page.getByRole("list", { name: "代理节点列表" }).getByRole("listitem");
  await entry.getByRole("button", { name: "启用", exact: true }).click();
  await expect(entry.getByText("已启用", { exact: true })).toBeVisible();
  const read = () => page.evaluate(async () => (await window.__codexSessionDeleteBridge("/api/network_proxy_get", {})).config);
  const before = await read();
  const profile = before.profiles.find(profile => !profile.pluginRouteSpec?.transport);
  const label = profile.name || profile.shortName || profile.id;
  const toggle = page.getByRole("switch", { name: `使用代理池 ${label}`, exact: true });
  const row = page.getByRole("list", { name: "线路出口列表" }).getByRole("listitem").filter({ has: toggle });
  await expect(toggle).not.toBeChecked();
  await row.getByText("使用代理池", { exact: true }).click();
  await expect(page.getByRole("button", { name: "保存线路代理", exact: true })).toBeDisabled();
  await page.getByLabel("线路代理节点", { exact: true }).selectOption(`node:${before.networkProxy.nodes[0].id}`);
  expect(await page.getByLabel("线路代理节点", { exact: true }).locator('option[value^="chain:"], option[value^="policy:"]').count()).toBe(0);
  await page.evaluate(() => {
    const bridge = window.__codexSessionDeleteBridge;
    window.__proxyOriginalBridge = bridge;
    window.__codexSessionDeleteBridge = async (path, args) => path.endsWith("/network_proxy_save")
      ? { status: "failed", message: "测试：保存暂不可用" } : bridge(path, args);
  });
  await page.getByRole("button", { name: "保存线路代理", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "保存暂不可用" })).toBeVisible();
  await expect(toggle).toBeChecked();
  await expect(page.getByLabel("线路代理节点", { exact: true })).toHaveValue(`node:${before.networkProxy.nodes[0].id}`);
  await page.evaluate(() => { window.__codexSessionDeleteBridge = window.__proxyOriginalBridge; });
  await page.getByRole("button", { name: "刷新代理池", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存线路代理", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "保存线路代理", exact: true }).click();
  await expect(page.getByRole("form", { name: "线路出口编辑" })).toHaveCount(0);
  await row.getByRole("button", { name: "测试所选出口", exact: true }).click();
  await expect(row).toContainText("观测出口：203.0.113.5");
  await toggle.focus(); await page.keyboard.press("Space");
  await expect(toggle).not.toBeChecked();
  await expect(page.getByLabel("线路代理节点", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "保存线路代理", exact: true }).click();
  await expect(row).toContainText("默认设置");
  const disabled = await read();
  expect(disabled.networkProxy.upstreamEnabledByProfile[profile.id]).toBe(false);
  expect(disabled.networkProxy.upstreamByProfile[profile.id]).toEqual({ kind: "node", id: before.networkProxy.nodes[0].id });
  expect(disabled.profiles).toEqual(before.profiles);
  await toggle.press("Space");
  await expect(page.getByLabel("线路代理节点", { exact: true })).toHaveValue(`node:${before.networkProxy.nodes[0].id}`);
  expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await row.screenshot({ path: `output/playwright/network-proxy-upstream-${theme}.png` });
  await page.getByRole("button", { name: "保存线路代理", exact: true }).click();
  await expect(page.getByRole("form", { name: "线路出口编辑" })).toHaveCount(0);
  await entry.getByRole("button", { name: "禁用", exact: true }).click();
  await expect(row).toContainText("出口节点已禁用，新请求将被阻断");
});

test("旧链路和策略选择明确提示，关闭后保留兼容数据", async ({ page }) => {
  await openNetwork(page);
  const original = await page.evaluate(async () => {
    const current = structuredClone((await window.__codexSessionDeleteBridge("/api/network_proxy_get", {})).config);
    const profile = current.profiles[0];
    current.networkProxy = { schemaVersion: 1, nodes: [], ...current.networkProxy, chains: [{ id: "old-chain", name: "旧链路", enabled: true, nodeIds: [] }],
      policies: [{ id: "old-policy", name: "旧策略", enabled: true, rules: [], defaultAction: { kind: "block" }, allowDirect: false }],
      upstreamByProfile: { [profile.id]: { kind: "chain", id: "old-chain" } }, processProxy: { kind: "policy", id: "old-policy" } };
    await window.__codexSessionDeleteBridge("/api/network_proxy_save", { settingsRevision: current.settingsRevision, config: current.networkProxy, credentials: [] });
    return { profile, pool: current.networkProxy };
  });
  await page.getByRole("button", { name: "刷新代理池", exact: true }).click();
  await expect(page.getByText(/原代理链路或策略已移除/)).toHaveCount(2);
  const label = original.profile.name || original.profile.shortName || original.profile.id;
  await page.getByRole("switch", { name: `使用代理池 ${label}`, exact: true }).press("Space");
  await page.getByRole("button", { name: "保存线路代理", exact: true }).click();
  await expect(page.getByRole("form", { name: "线路出口编辑" })).toHaveCount(0);
  const saved = await page.evaluate(async () => (await window.__codexSessionDeleteBridge("/api/network_proxy_get", {})).config.networkProxy);
  expect(saved.chains).toEqual(original.pool.chains); expect(saved.policies).toEqual(original.pool.policies);
  expect(saved.upstreamByProfile).toEqual(original.pool.upstreamByProfile);
  expect(saved.upstreamEnabledByProfile[original.profile.id]).toBe(false);
  await page.getByRole("switch", { name: "Codex 进程代理使用代理池", exact: true }).press("Space");
  await expect(page.getByRole("button", { name: "保存启动出口", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "保存启动出口", exact: true }).click();
  await expect(page.getByRole("form", { name: "Codex 启动出口编辑" })).toHaveCount(0);
});

for (const theme of ["light", "dark"]) test(`进程代理开关独立保存，失败与取消保留配置（${theme}）`, async ({ page }) => {
  await page.setViewportSize({ width: theme === "dark" ? 430 : 1100, height: 900 });
  await openNetwork(page, theme);
  const current = page.locator('[aria-label="Codex 启动出口配置"]');
  const toggle = page.getByRole("switch", { name: "Codex 进程代理使用代理池", exact: true });
  await expect(toggle).not.toBeChecked();
  await expect(page.getByRole("button", { name: "选择 Codex 启动出口", exact: true })).toHaveCount(0);
  await expect(current.getByText("下次启动设置", { exact: true })).toHaveCount(0);
  expect(await current.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await current.screenshot({ path: `output/playwright/network-proxy-process-off-${theme}.png` });
  await addProxy(page, "启动专用出口", true);
  const entry = page.getByRole("list", { name: "代理节点列表" }).getByRole("listitem");
  await entry.getByRole("button", { name: "启用", exact: true }).click();
  await expect(entry.getByText("已启用", { exact: true })).toBeVisible();
  const before = await page.evaluate(async () => (await window.__codexSessionDeleteBridge("/api/network_proxy_get", {})).config);
  await current.getByText("使用代理池", { exact: true }).click();
  await expect(toggle).toBeChecked();
  await expect(page.getByRole("button", { name: "保存启动出口", exact: true })).toBeDisabled();
  await expect(current.getByRole("alert")).toContainText("请选择代理池节点");
  await page.getByLabel("Codex 启动出口", { exact: true }).selectOption(`node:${before.networkProxy.nodes[0].id}`);
  await page.evaluate(() => {
    const bridge = window.__codexSessionDeleteBridge;
    window.__proxyOriginalBridge = bridge;
    window.__codexSessionDeleteBridge = async (path, args) => path.endsWith("/network_proxy_save")
      ? { status: "failed", message: "测试：进程代理保存失败" } : bridge(path, args);
  });
  await page.getByRole("button", { name: "保存启动出口", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "进程代理保存失败" })).toBeVisible();
  await expect(toggle).toBeChecked();
  await expect(page.getByLabel("Codex 启动出口", { exact: true })).toHaveValue(`node:${before.networkProxy.nodes[0].id}`);
  await page.evaluate(() => { window.__codexSessionDeleteBridge = window.__proxyOriginalBridge; });
  await page.getByRole("button", { name: "刷新代理池", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存启动出口", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "保存启动出口", exact: true }).click();
  await expect(page.getByRole("form", { name: "Codex 启动出口编辑" })).toHaveCount(0);
  await expect(page.getByText(/Codex 启动出口已保存，重启 Codex 后应用/)).toBeVisible();
  await expect(current).toContainText("启动专用出口");
  expect(await current.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await current.screenshot({ path: `output/playwright/network-proxy-process-on-${theme}.png` });
  const saved = await page.evaluate(async () => (await window.__codexSessionDeleteBridge("/api/network_proxy_get", {})).config);
  expect(saved.networkProxy.processProxy).toEqual({ kind: "node", id: before.networkProxy.nodes[0].id });
  expect(saved.networkProxy.upstreamByProfile).toEqual(before.networkProxy.upstreamByProfile);
  expect(saved.codexLaunchProxy).toBe(before.codexLaunchProxy);
  await entry.getByRole("button", { name: "禁用", exact: true }).click();
  await expect(current).toContainText("出口节点已禁用，新请求将被阻断");
  await entry.getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "仍被 Codex 启动出口引用" })).toBeVisible();
  await toggle.focus(); await page.keyboard.press("Space");
  await expect(toggle).not.toBeChecked();
  await expect(page.getByLabel("Codex 启动出口", { exact: true })).toHaveCount(0);
  await expect(current.getByText(/未配置手动地址时可能直连/)).toBeVisible();
  await page.getByRole("button", { name: "取消启动出口编辑", exact: true }).click();
  await expect(toggle).toBeChecked();
  await toggle.press("Space");
  await page.getByRole("button", { name: "保存启动出口", exact: true }).click();
  await expect(page.getByRole("form", { name: "Codex 启动出口编辑" })).toHaveCount(0);
  await expect(toggle).not.toBeChecked();
  await entry.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("button", { name: "确认删除代理", exact: true }).click();
  await expect(entry).toHaveCount(0);
});

for (const theme of ["light", "dark"]) test(`TCP 接管显式保存和关闭，键盘与窄屏可用（${theme}）`, async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 900 });
  await openNetwork(page, theme);
  await addProxy(page, "接管出口");
  const entry = page.getByRole("list", { name: "代理节点列表" }).getByRole("listitem");
  await entry.getByRole("button", { name: "启用", exact: true }).click();
  await expect(entry.getByText("已启用", { exact: true })).toBeVisible();
  const savedPool = async () => page.evaluate(async () => (await window.__codexSessionDeleteBridge("/api/network_proxy_get", {})).config.networkProxy);
  const before = await savedPool();
  await page.getByRole("switch", { name: "Codex 进程代理使用代理池", exact: true }).press("Space");
  const capture = page.getByRole("checkbox", { name: "启用实验性 TCP 流量接管", exact: true });
  await expect(capture).not.toBeChecked();
  await expect(capture).toBeDisabled();
  await page.getByLabel("Codex 启动出口", { exact: true }).selectOption(`node:${before.nodes[0].id}`);
  await capture.focus(); await page.keyboard.press("Space");
  await expect(capture).toBeChecked();
  expect((await savedPool()).processCapture).toBeUndefined();
  await expect(page.getByRole("status").filter({ hasText: "尚未找到接管组件" })).toBeVisible();
  const editor = page.getByRole("form", { name: "Codex 启动出口编辑" });
  expect(await editor.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await editor.screenshot({ path: `output/playwright/network-proxy-capture-${theme}.png` });
  await page.getByRole("button", { name: "保存启动出口", exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect((await savedPool()).processCapture).toBe(true);
  await page.getByRole("button", { name: "刷新代理池", exact: true }).click();
  await page.getByRole("button", { name: "更换进程代理节点", exact: true }).click();
  await expect(capture).toBeChecked();
  await capture.uncheck();
  await page.getByRole("button", { name: "保存启动出口", exact: true }).click();
  await expect(editor).toHaveCount(0);
  const after = await savedPool();
  expect(after.processCapture).toBeUndefined();
  expect(after.processProxy).toEqual({ kind: "node", id: before.nodes[0].id });
  expect(after.nodes).toEqual(before.nodes);
});
