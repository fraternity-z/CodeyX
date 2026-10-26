import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createControllerHarness } from "./helpers/controller-harness.mjs";

const root = new URL("../", import.meta.url);

test("手动代理输入不校验或请求网络，保留旧代理池数据和其他草稿", () => {
  const legacy = { schemaVersion: 999, nodes: [{ legacy: true }], processCapture: true };
  const changes = [];
  const options = { active: true, isBusy: false, config: { codexLaunchProxy: "", networkProxy: legacy, retained: "draft" },
    onConfigChange: config => changes.push(config) };
  const h = createControllerHarness(new URL("src/features/network-proxy/useNetworkProxyController.ts", root), "useNetworkProxyController");
  for (const value of ["not a url", "http://user:pass@proxy.example:8080", "socks5://127.0.0.1", ""]) {
    h.render(options).changeLaunchProxy(value);
    assert.deepEqual(changes.at(-1), { ...options.config, codexLaunchProxy: value });
    assert.equal(changes.at(-1).networkProxy, legacy);
  }
  const count = changes.length;
  options.active = false; h.render(options).changeLaunchProxy("hidden");
  options.active = true; options.isBusy = true; h.render(options).changeLaunchProxy("busy");
  assert.equal(changes.length, count);
  h.unmount();
});

test("代理页只保留手动地址，不挂载代理池或探测请求", async () => {
  const [page, controller, types, mock, api] = await Promise.all([
    "src/features/network-proxy/NetworkProxyPage.tsx", "src/features/network-proxy/useNetworkProxyController.ts",
    "src/App.types.ts", "src/dev/mockApi.ts", "src/api.ts",
  ].map(path => readFile(new URL(path, root), "utf8")));
  assert.match(page, /title="网络代理"/);
  assert.match(page, /changeLaunchProxy\(event\.target\.value\)/);
  assert.match(page, /保存后重启 Codex 生效/);
  assert.doesNotMatch(page, /ProxyPool|UpstreamSelection|ProcessProxySelection|launchProxyError|aria-invalid/);
  assert.doesNotMatch(controller, /validateCodexLaunchProxy|invoke|Requests/);
  assert.match(types, /networkProxy\?: unknown/);
  assert.doesNotMatch(mock + api, /network_proxy_(get|save|test)/);
});

test("手动代理仍传给Chromium与子进程，保存不再校验代理", async () => {
  const [commands, process, proxy, appServer] = await Promise.all([
    "backend/src/commands.rs", "backend/src/launcher/process.rs", "backend/src/launch_proxy.rs", "backend/src/appserver_call.rs",
  ].map(path => readFile(new URL(path, root), "utf8")));
  assert.doesNotMatch(commands, /validate_codex_launch_proxy\(codex_launch_proxy\)/);
  assert.match(commands, /applied\.codex_launch_proxy != current\.codex_launch_proxy/);
  assert.match(process, /proxy\.chromium_argument\(\)/);
  assert.match(process, /CodexLaunchProxy::environment/);
  assert.match(proxy, /--proxy-server=/);
  assert.match(proxy, /"HTTP_PROXY"/);
  assert.match(proxy, /"NO_PROXY"/);
  assert.match(appServer, /shared_app_server_launch\(\)/);
});
