// Attach the Playwright CLI to the running CodeyX-managed desktop, select its
// main renderer, then run-code --filename tests/codex-client-smoke.playwright.js.
// Read-only: no threads, messages, settings, credentials, or page reloads.
// Keep the returned key-only report under tests/fixtures/codex-client/, keyed
// by runtime_status version and platform. It describes the running build only.
async page => {
  const report = await page.evaluate(async () => {
    const require = (ok, message) => { if (!ok) throw new Error(message); };
    const bounded = async operation => {
      let timer;
      try {
        return await Promise.race([
          Promise.resolve().then(operation),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("客户端回归读取超时")), 20_000); }),
        ]);
      } finally { clearTimeout(timer); }
    };
    require(location.protocol === "app:", "请选择 Codex 主窗口");
    require(typeof window.__codeyCall === "function", "CodeyX 桥接未就绪");
    const runtime = await bounded(() => window.__codeyCall("/api/runtime_status", {}));
    require(runtime.running === true && typeof runtime.codexAppVersion === "string", "客户端未运行或版本未知");
    const patch = window.__codeyModelWhitelistPatch;
    require(window.__codeyNativeRuntime?.isActive() === true, "原生接口适配未就绪");
    require(await bounded(() => patch?.ensureRequestGate()) === true, "模型请求入口校验失败");
    const catalog = patch.snapshot();
    require(catalog.loaded && catalog.models.length > 0, "模型目录为空或未加载");
    const client = await bounded(() => window.__codeyLoadCodexRequestClient());
    const models = await bounded(() => client.sendRequest("model/list", { limit: 100 }));
    require(Array.isArray(models?.data) && models.data.length > 0, "客户端模型目录响应不兼容");
    const usage = await bounded(() => window.__codeyReadAccountRateLimits());
    require(usage?.rateLimits || usage?.rateLimitsByLimitId, "客户端未返回额度信息");
    const defaults = await bounded(() => window.__codeyRemoteControl({ action: "defaults" }, Date.now() + 20_000));
    require(typeof defaults?.model === "string" && typeof defaults?.serviceTier === "string", "远程默认设置响应不兼容");
    // Keep only protocol shape, never account data, paths, model identities or
    // config/read contents. This result can be retained as a version fixture.
    return {
      codexAppVersion: runtime.codexAppVersion,
      platform: runtime.clientPlatform,
      adapterVersion: window.__codeyNativeRuntime.version,
      requestGate: true,
      modelListKeys: Object.keys(models).sort(),
      rateLimitsKeys: Object.keys(usage).sort(),
      remoteDefaultsKeys: Object.keys(defaults).sort(),
      localClient: client.hostId === "local",
      presentation: patch.presentation?.().status ?? "not-reported",
    };
  });
  if (!report.localClient) throw new Error("客户端读取未使用本机连接");
  return report;
}
