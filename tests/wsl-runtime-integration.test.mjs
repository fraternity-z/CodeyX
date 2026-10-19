import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

const helper = process.env.CODEY_TEST_WSL_HELPER;
const host = process.env.CODEY_TEST_WSL_WINDOWS_HOST;
const cli = process.env.CODEY_TEST_WSL_CLI;
const distro = process.env.CODEY_TEST_WSL_DISTRO;
const wslArgs = distro ? ["-d", distro] : [];

test("Windows development probes WSL settings without launching Codex or rewriting config", {
  skip: process.platform !== "win32" || !host,
}, async t => {
  const home = await mkdtemp(join(tmpdir(), "codey-wsl-status-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const mapped = spawnSync("wsl.exe", [...wslArgs, "--exec", "wslpath", "-w", host], {
    encoding: "utf8", windowsHide: true,
  });
  assert.equal(mapped.status, 0, mapped.stderr);
  for (const [source, expected] of [
    ["", "false"],
    ["[desktop]\nrunCodexInWindowsSubsystemForLinux = true\n", "true"],
    ["desktop = { runCodexInWindowsSubsystemForLinux = false }\n", "false"],
    ["[desktop", null],
  ]) {
    const config = join(home, "config.toml");
    await writeFile(config, source);
    const result = spawnSync(mapped.stdout.trim(), ["--codey-wsl-status"], {
      encoding: "utf8", windowsHide: true, timeout: 15_000,
      env: { ...process.env, CODEX_HOME: home, CODEY_APP_STATE_DIR: join(home, "app-state") },
    });
    assert.ifError(result.error);
    assert.notEqual(result.status, null);
    if (expected === null) {
      assert.notEqual(result.status, 0);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), expected);
    }
    assert.equal(await readFile(config, "utf8"), source);
  }
});

for (const mode of ["native", "cli-fallback"]) {
  test(`real WSL backend accepts Linux paths, loads FastCtx and streams through Windows loopback (${mode})`, {
    skip: process.platform !== "win32" || !helper || !host || !cli,
    timeout: 120_000,
  }, t => testWslRuntime(t, mode));
}

async function testWslRuntime(t, mode) {
  const home = await mkdtemp(join(tmpdir(), "codey-wsl's integration-"));
  let child;
  let server;
  t.after(async () => {
    if (child) {
      child.stdin.end();
      if (child.exitCode === null) {
        const timer = setTimeout(() => child.kill(), 3000);
        await once(child, "close");
        clearTimeout(timer);
      }
    }
    server?.closeAllConnections();
    server?.close();
    await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  });
  const mapped = spawnSync("wsl.exe", [...wslArgs, "--exec", "wslpath", "-u", home], { encoding: "utf8", windowsHide: true });
  assert.equal(mapped.status, 0);
  const linuxHome = mapped.stdout.trim();
  await writeFile(join(home, "config.toml"), "[analytics]\nenabled = false\n");
  await writeFile(join(home, "probe.txt"), "WSL path ok");
  const requests = [];
  server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"data":[]}');
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ url: request.url, body: JSON.parse(body) });
    const item = { id: "msg_wsl", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "WSL_OK", annotations: [] }] };
    const result = { id: "resp_wsl", object: "response", status: "completed", model: "wsl-test", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { ...result, status: "in_progress", output: [] } },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: result },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const overrides = [
    'model_provider="codey_router"', 'model="wsl-test"',
    'model_providers.codey_router.name="WSL integration"',
    `model_providers.codey_router.base_url="http://127.0.0.1:${server.address().port}/v1"`,
    'model_providers.codey_router.wire_api="responses"',
    'model_providers.codey_router.requires_openai_auth=false',
    'model_providers.codey_router.supports_websockets=false',
    'mcp_servers.codey_fastctx.command="C:/ignored/fastctx.exe"',
    'mcp_servers.codey_fastctx.args=["--codey-fastctx-mcp"]',
    'mcp_servers.codey_fastctx.startup_timeout_sec=60',
    'features.code_mode.direct_only_tool_namespaces=["mcp__codey_fastctx"]',
  ];
  const appServerArgs = ["-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled"];
  const options = { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] };
  if (mode === "native") {
    child = spawn("wsl.exe", [...wslArgs, "--cd", linuxHome, "--exec", "env",
      `CODEX_HOME=${linuxHome}`, `CODEX_SQLITE_HOME=${linuxHome}/sqlite`,
      `CODEY_APP_STATE_DIR=${linuxHome}`, `CODEY_WSL_HELPER=${helper}`, `CODEY_WSL_WINDOWS_HOST=${host}`,
      `CODEY_CODEX_CLI_WRAPPER_TARGET=${cli}`, `CODEY_CODEX_CLI_WRAPPER_MARKER=${linuxHome}/marker.json`,
      `CODEY_CODEX_CLI_WRAPPER_OVERRIDES=${JSON.stringify(overrides)}`,
      "RUST_LOG=off", helper, ...appServerArgs], options);
  } else {
    const windowsPath = path => {
      const result = spawnSync("wsl.exe", [...wslArgs, "--exec", "wslpath", "-w", path], { encoding: "utf8", windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    const windowsCli = `${windowsPath(cli)}.exe`;
    options.env = {
      ...process.env,
      CODEX_HOME: home,
      CODEX_SQLITE_HOME: join(home, "sqlite"),
      CODEY_APP_STATE_DIR: home,
      CODEY_WSL_HELPER: windowsPath(helper),
      CODEY_WSL_WINDOWS_HOST: windowsPath(host),
      CODEY_CODEX_CLI_WRAPPER_TARGET: windowsCli,
      CODEY_CODEX_CLI_WRAPPER_SOURCE: windowsCli,
      CODEY_CODEX_CLI_WRAPPER_OVERRIDES: JSON.stringify(overrides),
      CODEY_CODEX_CLI_WRAPPER_MARKER: join(home, "marker.json"),
      CODEY_CODEX_CLI_WRAPPER_HANDSHAKE_OPTIONAL: "1",
      WSL_DISTRO_NAME: "",
      WSL_INTEROP: "",
      WSLENV: "WSL_DISTRO_NAME/w:WSL_INTEROP/w:USER/w:PWD/w:CODEX_HOME/p:CODEX_SQLITE_HOME/p:CODEY_APP_STATE_DIR/p",
      RUST_LOG: "off",
    };
    // This deliberately launches the Windows wrapper from WSL, without a main-process patch.
    child = spawn("wsl.exe", [...wslArgs, "--cd", linuxHome, "--exec", "/bin/sh", "-c", 'exec "$@"', "test", host, ...appServerArgs], options);
  }
  const messages = [];
  let errors = "";
  child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-8192); });
  child.stdin.on("error", () => {});
  createInterface({ input: child.stdout }).on("line", line => messages.push(JSON.parse(line)));
  const wait = async predicate => {
    const deadline = Date.now() + 80_000;
    while (Date.now() < deadline) {
      const found = messages.find(predicate);
      if (found) return found;
      assert.equal(child.exitCode, null, `WSL backend exited: ${errors}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail(`WSL backend timed out: ${errors}; methods: ${messages.map(v => v.method ?? v.id).join(", ")}`);
  };
  const call = async (id, method, params) => {
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    const reply = await wait(value => value.id === id);
    assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    return reply.result;
  };
  await call(1, "initialize", { clientInfo: { name: "codey_wsl_test", version: "1" }, capabilities: { experimentalApi: true } });
  child.stdin.write('{"method":"initialized"}\n');
  const file = await call(4, "fs/readFile", { path: `${linuxHome}/probe.txt` });
  assert.equal(file.dataBase64, Buffer.from("WSL path ok").toString("base64"));
  const started = await call(2, "thread/start", { cwd: linuxHome, approvalPolicy: "never", sandbox: "danger-full-access", ephemeral: true });
  assert.equal(started.thread.cwd, linuxHome);
  await call(3, "turn/start", { threadId: started.thread.id, input: [{ type: "text", text: "Reply WSL_OK without using tools." }] });
  const done = await wait(value => value.method === "turn/completed");
  assert.equal(done.params.turn.status, "completed", JSON.stringify(done.params.turn.error));
  assert.ok(requests.some(value => value.url === "/v1/responses"));
  assert.ok(requests.some(value => value.body.tools?.some(tool => /codey_fastctx/.test(tool.name ?? ""))));
  const marker = JSON.parse(await readFile(join(home, "marker.json"), "utf8"));
  assert.equal(marker.status, "executed");
}
