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

test("链路按指定顺序保存和测试，引用保护与删除只作用于链路", async ({ page }) => {
  await openNetwork(page);
  await addProxy(page, "本地入口", false, "127.0.0.1"); await addProxy(page, "海外出口", false, "exit.example");
  const nodes = await page.evaluate(async () => (await window.__codexSessionDeleteBridge("/api/network_proxy_get", {})).config.networkProxy.nodes);
  await page.getByRole("button", { name: "新增链路", exact: true }).click();
  await page.getByRole("textbox", { name: "链路名称", exact: true }).fill("固定双跳");
  await page.getByRole("button", { name: "添加一跳", exact: true }).click();
  await page.getByLabel("第 1 跳节点", { exact: true }).selectOption(nodes[0].id);
  await page.getByRole("button", { name: "添加一跳", exact: true }).click();
  await page.getByLabel("第 2 跳节点", { exact: true }).selectOption(nodes[1].id);
  await page.getByRole("button", { name: "上移第 2 跳", exact: true }).click();
  await expect(page.getByText(/回环代理只能作为第一跳/)).toBeVisible();
  await expect(page.getByRole("button", { name: "保存链路", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "下移第 1 跳", exact: true }).click();
  await page.getByRole("button", { name: "保存链路", exact: true }).click();
  await expect(page.getByRole("form", { name: "代理链路编辑" })).toHaveCount(0);
  const list = page.getByRole("list", { name: "代理链路列表" });
  await expect(list).toContainText("CodeyX → 本地入口 → 海外出口 → 目标服务");
  await page.getByRole("button", { name: "测试链路 固定双跳", exact: true }).click();
  await expect(list).toContainText("链路出口：203.0.113.8");
  const entry = page.getByRole("list", { name: "代理节点列表" }).getByRole("listitem").filter({ has: page.getByText("海外出口", { exact: true }) });
  await entry.getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("仍被代理链路引用");
  await page.getByRole("button", { name: "编辑 海外出口", exact: true }).click();
  await page.getByLabel("代理端口", { exact: true }).fill("1081");
  await page.getByRole("button", { name: "保存到代理池", exact: true }).click();
  await expect(list).toContainText("链路或节点已变化，请重新测试");
  await list.getByRole("button", { name: "删除链路", exact: true }).click();
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await page.getByRole("button", { name: "确认删除链路", exact: true }).click();
  await expect(list.getByRole("listitem")).toHaveCount(0);
  const saved = await page.evaluate(async () => (await window.__codexSessionDeleteBridge("/api/network_proxy_get", {})).config.networkProxy);
  expect(saved.nodes).toHaveLength(2); expect(saved.nodes.every(node => !node.enabled)).toBe(true);
});

test("线路固定出口持久化，节点禁用后保留绑定，解除选择前禁止删除", async ({ page }) => {
  await openNetwork(page);
  await addProxy(page, "绑定出口");
  const nodes = page.getByRole("list", { name: "代理节点列表" });
  const entry = nodes.getByRole("listitem").filter({ has: page.getByText("绑定出口", { exact: true }) });
  await entry.getByRole("button", { name: "启用", exact: true }).click();
  await expect(entry.getByText("已启用", { exact: true })).toBeVisible();
  const config = await page.evaluate(async () => (await window.__codexSessionDeleteBridge("/api/network_proxy_get", {})).config);
  const profile = config.profiles.find(profile => !profile.pluginRouteSpec?.transport);
  const label = profile.name || profile.shortName || profile.id;
  const row = page.getByRole("list", { name: "线路出口列表" }).getByRole("listitem").filter({ has: page.getByRole("button", { name: `选择出口 ${label}`, exact: true }) });
  await row.getByRole("button", { name: `选择出口 ${label}`, exact: true }).click();
  await page.getByLabel("线路出口", { exact: true }).selectOption(`node:${config.networkProxy.nodes[0].id}`);
  await page.getByRole("button", { name: "保存出口选择", exact: true }).click();
  await expect(row).toContainText("固定选择");
  await expect(row).toContainText("绑定出口");
  await row.getByRole("button", { name: "测试所选出口", exact: true }).click();
  await expect(row).toContainText("观测出口：203.0.113.5");
  await row.screenshot({ path: "output/playwright/network-proxy-upstream.png" });
  await entry.getByRole("button", { name: "禁用", exact: true }).click();
  await expect(row).toContainText("出口节点已禁用，新请求将被阻断");
  await entry.getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("仍被线路出口引用");
  await page.getByRole("button", { name: "刷新代理池", exact: true }).click();
  await expect(row).toContainText("固定选择");
  const saved = await page.evaluate(async () => (await window.__codexSessionDeleteBridge("/api/network_proxy_get", {})).config);
  expect(saved.networkProxy.upstreamByProfile[profile.id]).toEqual({ kind: "node", id: config.networkProxy.nodes[0].id });
  await row.getByRole("button", { name: `选择出口 ${label}`, exact: true }).click();
  await page.getByLabel("线路出口", { exact: true }).selectOption("legacy");
  await expect(page.getByText(/解除代理池选择后.*可能直连/)).toBeVisible();
  await page.getByRole("button", { name: "保存出口选择", exact: true }).click();
  await expect(row).toContainText("沿用线路设置");
  await entry.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("button", { name: "确认删除代理", exact: true }).click();
  await expect(entry).toHaveCount(0);
});

test("Codex 启动出口独立保存，禁用后显示阻断并保留原有线路选择", async ({ page }) => {
  await openNetwork(page);
  await addProxy(page, "启动专用出口", true);
  const entry = page.getByRole("list", { name: "代理节点列表" }).getByRole("listitem");
  await entry.getByRole("button", { name: "启用", exact: true }).click();
  await expect(entry.getByText("已启用", { exact: true })).toBeVisible();
  const before = await page.evaluate(async () => (await window.__codexSessionDeleteBridge("/api/network_proxy_get", {})).config);
  await page.getByRole("button", { name: "选择 Codex 启动出口", exact: true }).click();
  await page.getByLabel("Codex 启动出口", { exact: true }).selectOption(`node:${before.networkProxy.nodes[0].id}`);
  await page.getByRole("button", { name: "保存启动出口", exact: true }).click();
  await expect(page.getByRole("form", { name: "Codex 启动出口编辑" })).toHaveCount(0);
  await expect(page.getByText(/Codex 启动出口已保存，重启 Codex 后应用/)).toBeVisible();
  const current = page.locator('[aria-label="Codex 启动出口配置"]');
  await expect(current).toContainText("启动专用出口");
  await current.screenshot({ path: "output/playwright/network-proxy-process.png" });
  const saved = await page.evaluate(async () => (await window.__codexSessionDeleteBridge("/api/network_proxy_get", {})).config);
  expect(saved.networkProxy.processProxy).toEqual({ kind: "node", id: before.networkProxy.nodes[0].id });
  expect(saved.networkProxy.upstreamByProfile).toEqual(before.networkProxy.upstreamByProfile);
  expect(saved.codexLaunchProxy).toBe(before.codexLaunchProxy);
  await entry.getByRole("button", { name: "禁用", exact: true }).click();
  await expect(current).toContainText("出口节点已禁用，新请求将被阻断");
  await entry.getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "仍被 Codex 启动出口引用" })).toBeVisible();
  await page.getByRole("button", { name: "选择 Codex 启动出口", exact: true }).click();
  await page.getByLabel("Codex 启动出口", { exact: true }).selectOption("legacy");
  await expect(current.getByText(/未配置手动地址时可能直连/)).toBeVisible();
  await page.getByRole("button", { name: "保存启动出口", exact: true }).click();
  await expect(current).toContainText("手动启动地址或原有网络环境");
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
  await page.getByRole("button", { name: "选择 Codex 启动出口", exact: true }).click();
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
  await page.getByRole("button", { name: "选择 Codex 启动出口", exact: true }).click();
  await expect(capture).toBeChecked();
  await capture.uncheck();
  await page.getByRole("button", { name: "保存启动出口", exact: true }).click();
  await expect(editor).toHaveCount(0);
  const after = await savedPool();
  expect(after.processCapture).toBeUndefined();
  expect(after.processProxy).toEqual({ kind: "node", id: before.nodes[0].id });
  expect(after.nodes).toEqual(before.nodes);
});

test("出口策略显式授权、排序和绑定，禁用保留绑定且未解除前不可删除", async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 900 });
  await openNetwork(page, "dark");
  await addProxy(page, "主出口", false, "primary.example");
  await addProxy(page, "备出口", false, "secondary.example");
  const nodes = await page.evaluate(async () => (await window.__codexSessionDeleteBridge("/api/network_proxy_get", {})).config.networkProxy.nodes);
  await page.getByRole("button", { name: "新增策略", exact: true }).click();
  await page.getByLabel("策略名称", { exact: true }).fill("规则出口");
  await page.getByLabel("未命中规则时", { exact: true }).selectOption("direct");
  await expect(page.getByRole("button", { name: "保存策略", exact: true })).toBeDisabled();
  await expect(page.getByText(/直连或回退直连需要勾选/)).toBeVisible();
  await page.getByRole("checkbox", { name: "允许此策略直连并暴露本机出口及本地 DNS 查询", exact: true }).check();
  await page.getByRole("checkbox", { name: "允许选择此策略", exact: true }).check();
  await page.getByLabel("未命中规则时", { exact: true }).selectOption("proxy");
  await page.getByLabel("未命中规则时故障处理", { exact: true }).selectOption("direct");
  await page.getByLabel("未命中规则时候选 1", { exact: true }).selectOption(`node:${nodes[0].id}`);
  await page.getByRole("button", { name: "添加未命中规则时候选", exact: true }).click();
  await page.getByLabel("未命中规则时候选 2", { exact: true }).selectOption(`node:${nodes[1].id}`);
  await page.getByRole("button", { name: "未命中规则时上移候选 2", exact: true }).click();
  await page.getByRole("button", { name: "添加规则", exact: true }).click();
  await page.getByLabel("规则 1匹配方式", { exact: true }).selectOption("suffix");
  await page.getByLabel("规则 1匹配值", { exact: true }).fill("private.example");
  await page.getByRole("button", { name: "添加规则", exact: true }).click();
  await page.getByLabel("规则 2匹配方式", { exact: true }).selectOption("cidr");
  await page.getByLabel("规则 2匹配值", { exact: true }).fill("10.0.0.0/8");
  await page.getByRole("button", { name: "上移规则 2", exact: true }).click();
  await expect(page.getByLabel("规则 1匹配值", { exact: true })).toHaveValue("10.0.0.0/8");
  const editor = page.getByRole("form", { name: "出口策略编辑", exact: true });
  expect(await editor.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.getByLabel("策略名称", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "output/playwright/network-proxy-policy-dark.png" });
  await page.getByRole("button", { name: "保存策略", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "output/playwright/network-proxy-policy-actions-dark.png" });
  await page.getByRole("button", { name: "保存策略", exact: true }).click();
  await expect(editor).toHaveCount(0);
  const config = await page.evaluate(async () => (await window.__codexSessionDeleteBridge("/api/network_proxy_get", {})).config);
  const policy = config.networkProxy.policies[0];
  expect(policy.allowDirect).toBe(true); expect(policy.rules.map(rule => rule.host.kind)).toEqual(["cidr", "suffix"]);
  expect(policy.defaultAction).toEqual({ kind: "proxy", onFailure: "direct", targets: [{ kind: "node", id: nodes[1].id }, { kind: "node", id: nodes[0].id }] });
  expect(config.networkProxy.processProxy).toBeUndefined();
  await page.getByRole("button", { name: "选择 Codex 启动出口", exact: true }).click();
  await page.getByLabel("Codex 启动出口", { exact: true }).selectOption(`policy:${policy.id}`);
  await page.getByRole("button", { name: "保存启动出口", exact: true }).click();
  const list = page.getByRole("list", { name: "出口策略列表", exact: true });
  await list.getByRole("button", { name: "禁用策略", exact: true }).click();
  await expect(page.getByText("出口策略已禁用，新连接将被阻断", { exact: true })).toBeVisible();
  await list.getByRole("button", { name: "删除策略", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "策略仍被启动或线路出口引用" })).toBeVisible();
  const saved = await page.evaluate(async () => (await window.__codexSessionDeleteBridge("/api/network_proxy_get", {})).config);
  expect(saved.networkProxy.processProxy).toEqual({ kind: "policy", id: policy.id });
});
