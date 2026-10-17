import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../public/codex-runtime-adapter.js", import.meta.url), "utf8");
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fixture(globals = {}) {
  const timers = new Map();
  let sequence = 0;
  const window = {
    setTimeout(callback) { const id = ++sequence; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  // Installation and cached operations must work even when the host UI is absent.
  const document = new Proxy({}, { get() { throw new Error("unexpected DOM access"); } });
  const context = vm.createContext({ window, document, ...globals });
  return { window, timers, load: () => vm.runInContext(source, context) };
}

function discoveryFixture() {
  class Element {}
  const root = new Element();
  const manager = { async sendRequest() {} };
  const scope = { get: () => ({ forHost: () => manager }), set() {}, watch() {}, when() {}, query: {} };
  root.__reactFiber$fixture = { memoizedProps: { scope } };
  const runtime = fixture({
    HTMLElement: Element,
    document: {
      scripts: [{ src: "app://-/assets/app-initial-fixture.js" }],
      querySelectorAll: () => [],
      querySelector: (selector) => selector === "#root" ? root : null,
    },
  });
  function resolve(scope, hostId) {
    const registry = scope.get("registry");
    if (!registry) throw new Error("AppServerManager RPC is not connected");
    return registry.forHost(hostId);
  }
  return { ...runtime, module: { resolve }, manager };
}

test("a timed-out capability probe cannot replace a newer cached manager", async () => {
  const runtime = discoveryFixture();
  let finish;
  runtime.window.__codeyImportCodexAsset = () => new Promise(resolve => { finish = resolve; });
  runtime.load();
  const pending = runtime.window.__codeyLoadCodexSessionController({ feature: "usage" });
  const rejected = assert.rejects(pending, { code: "codey_capability_unavailable" });
  await settle();
  assert.equal(typeof finish, "function");
  for (const callback of runtime.timers.values()) callback();
  await rejected;
  const replacement = { async sendRequest() {} };
  runtime.window.__codeyCodexSessionController = { manager: replacement };
  await runtime.window.__codeyLoadCodexSessionController({ feature: "usage" });
  finish(runtime.module);
  await settle();
  assert.equal(runtime.window.__codeyCodexSessionController.manager, replacement);
  assert.equal(runtime.window.__codeyPageCapabilities.usage.status, "available");
});

test("MCP reload never chooses a remote client when the local client is absent", async () => {
  const runtime = fixture();
  const calls = [];
  runtime.window.__codeyAppServerRequestClients = new Map([
    ["ssh-host", { sendRequest() { calls.push("remote"); } }],
  ]);
  runtime.window.__codeyCodexSessionController = { manager: {
    async sendRequest() { calls.push("local"); },
  } };
  runtime.load();
  assert.equal((await runtime.window.__codeyReloadMcpServers()).ok, true);
  assert.deepEqual(calls, ["local"]);
});

test("an unconfirmed MCP reload is not submitted again through the manager", async () => {
  const runtime = fixture();
  let calls = 0;
  const client = { async sendRequest() { calls += 1; throw new Error("connection closed"); } };
  runtime.window.__codeyAppServerRequestClients = new Map([["local", client]]);
  runtime.window.__codeyCodexSessionController = { manager: client };
  runtime.load();
  await assert.rejects(runtime.window.__codeyReloadMcpServers(), /connection closed/);
  assert.equal(calls, 1);
});

test("installation only registers the native adapter and is idempotent", () => {
  const runtime = fixture();
  runtime.load();
  const adapter = runtime.window.__codeyNativeRuntime;
  const reload = runtime.window.__codeyReloadMcpServers;
  assert.equal(adapter.isActive(), true);
  assert.equal(runtime.timers.size, 0);
  assert.equal(runtime.window.__codeySessionToolsInjectLoaded, undefined);
  assert.equal(runtime.window.__codeySessionToolsInstall, undefined);
  runtime.load();
  assert.equal(runtime.window.__codeyNativeRuntime, adapter);
  assert.equal(runtime.window.__codeyReloadMcpServers, reload);
  adapter.dispose();
  adapter.dispose();
  assert.equal(adapter.isActive(), false);
  assert.equal(runtime.window.__codeyNativeRuntime, undefined);
  assert.equal(runtime.window.__codeyReloadMcpServers, undefined);
  runtime.load();
  assert.notEqual(runtime.window.__codeyNativeRuntime, adapter);
});

test("usage, MCP reload and remote resume do not require session UI", async () => {
  const runtime = fixture();
  const calls = [];
  const limits = { rateLimits: { primary: { usedPercent: 25 } } };
  runtime.window.__codeyCodexSessionController = { manager: {
    async sendRequest(method, params) {
      calls.push({ method, params });
      return limits;
    },
    async resumeConversation(params) {
      calls.push({ method: "resume", params });
      return { status: "ready" };
    },
  } };
  runtime.load();
  assert.equal(await runtime.window.__codeyReadAccountRateLimits(), limits);
  assert.equal((await runtime.window.__codeyReloadMcpServers()).ok, true);
  assert.equal((await runtime.window.__codeyRemoteControl({ action: "resume", threadId: "thread-1" }, Date.now() + 5_000)).status, "ok");
  assert.deepEqual(calls.map(({ method }) => method), ["account/rateLimits/read", "config/mcpServer/reload", "resume"]);
  assert.equal(calls[2].params.conversationId, "thread-1");
  assert.equal(runtime.window.__codeyPageCapabilities.usage.status, "available");
  assert.equal(runtime.window.__codeySessionToolsInstall, undefined);
  assert.equal(runtime.timers.size, 0);
});

test("disposal prevents queued operations from using a stale native client", async () => {
  const runtime = fixture();
  let calls = 0;
  runtime.window.__codeyCodexSessionController = { manager: {
    sendRequest() { calls += 1; },
    requestClient: { hostId: "local", enqueueRequest() {}, createRequest() {}, onResult() {} },
  } };
  runtime.load();
  const usage = runtime.window.__codeyReadAccountRateLimits();
  const client = runtime.window.__codeyLoadCodexRequestClient();
  const operation = runtime.window.__codeyNativeRuntime.waitForOperation(() => { calls += 1; });
  const reload = runtime.window.__codeyReloadMcpServers;
  runtime.window.__codeyNativeRuntime.dispose();
  assert.equal((await usage).status, "unavailable");
  await assert.rejects(client, { code: "codey_capability_unavailable" });
  await assert.rejects(operation, /适配已重新加载/);
  await assert.rejects(reload(), { code: "codey_capability_unavailable" });
  await settle();
  assert.equal(calls, 0);
  assert.equal(runtime.timers.size, 0);
});

for (const succeeds of [false, true]) {
  test(`a pending MCP ${succeeds ? "success" : "failure"} cannot change the replacement adapter`, async () => {
    const runtime = fixture();
    let complete;
    runtime.window.__codeyCodexSessionController = { manager: {
      sendRequest: () => new Promise((resolve, reject) => { complete = succeeds ? resolve : reject; }),
    } };
    runtime.load();
    const pending = runtime.window.__codeyReloadMcpServers();
    await settle();
    assert.equal(typeof complete, "function");
    runtime.window.__codeyNativeRuntime.dispose();
    runtime.load();
    const replacement = { manager: { async sendRequest() {} } };
    runtime.window.__codeyCodexSessionController = replacement;
    const capabilities = runtime.window.__codeyPageCapabilities;
    complete(succeeds ? {} : new Error("old reload failed"));
    if (succeeds) assert.equal((await pending).ok, true);
    else await assert.rejects(pending, /old reload failed/);
    assert.equal(runtime.window.__codeyCodexSessionController, replacement);
    assert.equal(runtime.window.__codeyPageCapabilities, capabilities);
    assert.equal(capabilities.mcpReload, undefined);
  });
}
