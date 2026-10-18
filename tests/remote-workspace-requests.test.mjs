import assert from "node:assert/strict";
import test from "node:test";
import { createModuleGraph } from "./helpers/jsx-tree.mjs";

function fixture() {
  const calls = [];
  let id = 0;
  class RemoteError extends Error { constructor(status) { super("fixture"); this.status = status; } }
  const transport = { RemoteError, requestId: () => `id-${++id}`, readSubmission() {}, rememberSubmission() {}, forgetSubmission() {},
    async remoteRequest(path, args) { calls.push({ path, args }); return { fixture: true }; } };
  const { remoteWorkspaceRequests: requests } = createModuleGraph(new URL("../src/features/remote-workspace/requests.ts", import.meta.url), {
    stubs: { "../../remote/transport": transport },
  }).exports;
  return { requests, calls, transport, RemoteError };
}

test("手机请求保留各端点、GET 会话读取和原有提交 ID，不自行重放失败操作", async () => {
  const { requests, calls, transport, RemoteError } = fixture();
  await requests.threads("query", true); await requests.projects(); await requests.models(); await requests.defaults("p"); await requests.session();
  assert.deepEqual(calls, [
    { path: "/remote/threads", args: { search: "query", archived: true } }, { path: "/remote/projects", args: {} },
    { path: "/remote/models", args: {} }, { path: "/remote/defaults", args: { projectId: "p" } }, { path: "/remote/session", args: undefined },
  ]);
  await requests.action("t", "settings", { serviceTier: null, threadId: "invalid", requestId: "invalid" });
  assert.deepEqual(calls.at(-1), { path: "/remote/action", args: { threadId: "t", action: "settings", requestId: "id-1", serviceTier: null } });
  const submission = { id: "saved-id", args: { action: "send", text: "hello", images: [] } };
  await requests.submit("t", submission); assert.equal(calls.at(-1).args.requestId, "saved-id");
  await requests.create(submission); assert.deepEqual(calls.at(-1), { path: "/remote/create", args: { ...submission.args, requestId: "saved-id" } });
  let attempts = 0; transport.remoteRequest = async () => { attempts++; throw new Error("uncertain"); };
  await assert.rejects(requests.submit("t", submission), /uncertain/); assert.equal(attempts, 1);
  assert.equal(requests.unauthorized(new RemoteError(401)), true); assert.equal(requests.unauthorized(new RemoteError(503)), false); assert.equal(requests.unauthorized({ status: 401 }), false);
});

test("会话连接适配安全路径与消息，清理监听后才关闭，损坏数据不交给 controller", t => {
  const previousSocket = globalThis.WebSocket, previousLocation = globalThis.location;
  const sockets = [];
  globalThis.WebSocket = class {
    constructor(url) { this.url = url; sockets.push(this); }
    close() { this.closed = true; this.onclose?.(); }
  };
  t.after(() => { if (previousSocket === undefined) delete globalThis.WebSocket; else globalThis.WebSocket = previousSocket; if (previousLocation === undefined) delete globalThis.location; else globalThis.location = previousLocation; });
  const { requests } = fixture();
  for (const protocol of ["http:", "https:"]) {
    globalThis.location = { protocol, host: "example.test:1234" };
    const messages = []; let invalid = 0, closed = 0;
    const connection = requests.connect("id/with spaces", { message: event => messages.push(event), invalid: () => invalid++, close: () => closed++ });
    const socket = sockets.at(-1);
    assert.equal(socket.url, `${protocol === "https:" ? "wss:" : "ws:"}//example.test:1234/remote/events/id%2Fwith%20spaces`);
    for (const data of ["bad json", JSON.stringify({ type: "state", state: {} })]) socket.onmessage({ data });
    socket.onmessage({ data: JSON.stringify({ type: "heartbeat" }) });
    socket.onmessage({ data: JSON.stringify({ type: "disconnected", message: "offline" }) });
    assert.equal(invalid, 2); assert.deepEqual(messages, [{ type: "disconnected", message: "offline" }]);
    socket.onclose(); assert.equal(closed, 1); connection.close(); assert.equal(closed, 1); assert.equal(socket.closed, true); assert.equal(socket.onmessage, null);
  }
});
