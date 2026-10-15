import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import launcher from "../backend/src/commands/builtin_tools/auto_mcp.cjs";

const sessions = new Map();

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codey-codegraph-test-"));
  sessions.set(root, []);
  t.after(async () => {
    for (const close of sessions.get(root)) close();
    await delay(250);
    sessions.delete(root);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const project = path.join(root, "中文 project with spaces");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "source.ts"), "export function original() {}\n");
  return { root, project };
}

async function until(check) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = check();
    if (value) return value;
    await delay(25);
  }
  throw new Error("Timed out waiting for automatic project indexing");
}

function session(t, root, project) {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  let buffer = "";
  output.on("data", chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      messages.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
  });
  const server = launcher.start({ entry: fileURLToPath(new URL("./fixtures/codegraph-runtime.cjs", import.meta.url)),
    root, cwd: project, input, output, tools: [{ name: "codegraph_explore", inputSchema: { type: "object" } }] });
  sessions.get(root).push(() => { server.stop(); input.destroy(); output.destroy(); });
  const send = (id, method, params = {}) => input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  const response = id => until(() => messages.find(message => message.id === id));
  return { send, response, messages, stop: server.stop };
}

function records(root) {
  const directory = path.join(root, "projects");
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter(file => file.endsWith(".json")).map(file => JSON.parse(fs.readFileSync(path.join(directory, file)))) : [];
}

test("project selection rejects roots, home, relative and missing paths", t => {
  const { root, project } = fixture(t);
  assert.equal(launcher.projectPath(project), fs.realpathSync(project));
  for (const candidate of ["relative", path.parse(root).root, os.homedir(), path.join(root, "missing")]) assert.throws(() => launcher.projectPath(candidate));
  assert.throws(() => launcher.projectPath(root, os.homedir(), root));
});

test("managed environment does not inherit routing or watcher overrides", () => {
  const env = launcher.cleanEnv({ KEEP: "yes", NODE_OPTIONS: "private", NODE_PATH: "custom", CODEGRAPH_DIR: "other", CODEGRAPH_NO_WATCH: "1", CODEGRAPH_DAEMON_INTERNAL: "1" });
  assert.equal(env.KEEP, "yes");
  assert.equal(env.CODEGRAPH_TELEMETRY, "0");
  for (const key of ["NODE_OPTIONS", "NODE_PATH", "CODEGRAPH_DIR", "CODEGRAPH_NO_WATCH", "CODEGRAPH_DAEMON_INTERNAL"]) assert.equal(env[key], undefined);
});

test("missing, partial, failed and outdated indexes require preparation", () => {
  assert.equal(launcher.needsIndex({ initialized: false }), true);
  for (const state of ["partial", "failed", "indexing"]) assert.equal(launcher.needsIndex({ initialized: true, index: { state } }), true);
  assert.equal(launcher.needsIndex({ initialized: true, index: { reindexRecommended: true } }), true);
  assert.equal(launcher.needsIndex({ initialized: true, index: { state: "complete" } }), false);
});

test("handshake and tool discovery stay responsive during automatic initialization", async t => {
  const { root, project } = fixture(t);
  const client = session(t, root, project);
  client.send(1, "initialize");
  client.send(2, "tools/list");
  client.send(3, "tools/call", { name: "codegraph_explore", arguments: { query: "original" } });
  assert.equal(client.messages.find(message => message.id === 1).result.serverInfo.name, "codey-codegraph");
  assert.equal((await client.response(2)).result.tools[0].name, "codegraph_explore");
  assert.match((await client.response(3)).result.content[0].text, /后台/);
  await until(() => records(root).some(record => record.phase === "watching"));
  client.send(4, "tools/call", { name: "codegraph_explore", arguments: { query: "original" } });
  assert.equal((await client.response(4)).result.project, fs.realpathSync(project));
  assert.match((await client.response(4)).result.content[0].text, /original/);
  const calls = fs.readFileSync(path.join(project, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.filter(call => call.action === "init").length, 1);
  assert.deepEqual(calls.find(call => call.action === "serve").args, ["--mcp", "--path", fs.realpathSync(project)]);
  assert.equal(fs.existsSync(path.join(root, ".codegraph")), false);
});

test("existing project launches retain the index and use the official watcher", async t => {
  const { root, project } = fixture(t);
  fs.mkdirSync(path.join(project, ".codegraph"));
  fs.writeFileSync(path.join(project, ".codegraph", "codegraph.db"), "existing");
  const first = session(t, root, project);
  const second = session(t, root, project);
  first.send(1, "initialize");
  second.send(1, "initialize");
  await until(() => records(root).some(record => record.phase === "watching"));
  await delay(150);
  const calls = fs.readFileSync(path.join(project, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.some(call => ["init", "index", "sync"].includes(call.action)), false);
  assert.equal(fs.readFileSync(path.join(project, ".codegraph", "codegraph.db"), "utf8"), "existing");
});

test("two new chats initialize a project only once", async t => {
  const { root, project } = fixture(t);
  const first = session(t, root, project);
  const second = session(t, root, project);
  first.send(1, "initialize");
  second.send(1, "initialize");
  const calls = () => fs.existsSync(path.join(project, "calls.jsonl")) ? fs.readFileSync(path.join(project, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse) : [];
  await until(() => calls().filter(call => call.action === "serve").length === 2);
  assert.equal(calls().filter(call => call.action === "init").length, 1);
  assert.equal(fs.existsSync(path.join(project, ".codegraph", "codey-bootstrap.lock")), false);
});

test("index failure is bounded, visible and redacts child output", async t => {
  const { root, project } = fixture(t);
  fs.writeFileSync(path.join(project, "fail"), "");
  const client = session(t, root, project);
  client.send(1, "initialize");
  await until(() => records(root).some(record => record.phase === "failed"));
  client.send(2, "tools/call", { name: "codegraph_explore" });
  const reply = await client.response(2);
  assert.equal(reply.result.isError, true);
  assert.doesNotMatch(JSON.stringify([reply, records(root)]), /private-source-and-token/);
  assert.match(reply.result.content[0].text, /自动重试/);
});

test("active writer is respected and cancellation stops preparation", async t => {
  const { project } = fixture(t);
  fs.mkdirSync(path.join(project, ".codegraph"));
  fs.writeFileSync(path.join(project, ".codegraph", "codegraph.lock"), String(process.pid));
  assert.equal(launcher.activeWriter(project), true);
  const controller = new AbortController();
  const work = launcher.prepareProject({ project, signal: controller.signal, record() {}, run() { throw new Error("must not index while another writer is active"); } });
  controller.abort();
  await assert.rejects(work, { name: "AbortError" });
  assert.equal(fs.readFileSync(path.join(project, ".codegraph", "codegraph.lock"), "utf8"), String(process.pid));
});

test("linked index directories are preserved instead of indexing outside the chat project", async t => {
  const { root, project } = fixture(t);
  const external = path.join(root, "existing-index");
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, "keep"), "user data");
  fs.symlinkSync(external, path.join(project, ".codegraph"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(launcher.acquireBootstrap(project, new AbortController().signal), /外部链接/);
  assert.deepEqual(fs.readdirSync(external), ["keep"]);
});

test("separate project chats remain isolated when one initialization fails", async t => {
  const { root, project } = fixture(t);
  const other = path.join(root, "another project");
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, "source.ts"), "export const separateProject = true;");
  fs.writeFileSync(path.join(project, "fail"), "");
  const first = session(t, root, project);
  const second = session(t, root, other);
  first.send(1, "initialize");
  second.send(1, "initialize");
  await until(() => records(root).some(record => record.phase === "failed") && records(root).some(record => record.phase === "watching"));
  second.send(2, "tools/call", { name: "codegraph_explore" });
  assert.match((await second.response(2)).result.content[0].text, /separateProject/);
  assert.equal(fs.existsSync(path.join(root, ".codegraph")), false);
});
