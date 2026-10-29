import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../public/model-request-gate.js", import.meta.url), "utf8");
function fixture() {
  const window = {};
  vm.runInNewContext(source, { window });
  class Client {
    hostId = "local";
    enqueueRequest(method, params) { return { method, params }; }
    createRequest(method, params) { return { request: { method, params } }; }
    onResult(_id, value) { return value; }
  }
  const client = new Client();
  window.__codeyLoadCodexRequestClient = async () => client;
  const create = (options = {}) => window.__codeyCreateModelRequestGate({
    rewriteRequest: (method, params) => ({ method, params: { ...params, checked: true } }),
    trackRequest() {}, rewriteResult: (_id, _method, value) => value, ...options,
  });
  return { window, Client, client, create };
}

test("the standalone gate validates local requests and leaves remote ownership intact", async () => {
  const { Client, client, create } = fixture();
  const original = Client.prototype.enqueueRequest;
  const gate = create();
  await gate.ensure();
  assert.equal(client.enqueueRequest("turn/start", {}).params.checked, true);
  const remote = new Client();
  remote.hostId = "ssh";
  assert.equal(remote.enqueueRequest("turn/start", {}).params.checked, undefined);
  gate.dispose();
  gate.dispose();
  assert.equal(Client.prototype.enqueueRequest, original);
  await assert.rejects(gate.ensure(), /重新加载/);
});

test("a partial installation is rolled back and never reported as verified", async () => {
  const { window, Client, client, create } = fixture();
  const original = Client.prototype.enqueueRequest;
  let rejectInstall = true;
  Object.setPrototypeOf(client, new Proxy(Client.prototype, {
    defineProperty(target, name, descriptor) {
      if (rejectInstall && name === "createRequest") throw new Error("read-only client");
      return Reflect.defineProperty(target, name, descriptor);
    },
  }));
  const gate = create();
  await assert.rejects(gate.ensure(), /read-only client/);
  assert.equal(Client.prototype.enqueueRequest, original);
  assert.equal(window.__codeyAppServerRequestClients, undefined);
  rejectInstall = false;
  assert.equal(await gate.ensure(), true);
  assert.equal(client.enqueueRequest("turn/start", {}).params.checked, true);
  gate.dispose();
  assert.equal(Client.prototype.enqueueRequest, original);
});

test("disposal during discovery prevents a late gate from patching the client", async () => {
  const { window, Client, client, create } = fixture();
  const original = Client.prototype.enqueueRequest;
  let finish;
  window.__codeyLoadCodexRequestClient = () => new Promise(resolve => { finish = resolve; });
  const gate = create();
  const pending = gate.ensure();
  assert.equal(gate.ensure(), pending);
  await new Promise(resolve => setImmediate(resolve));
  gate.dispose();
  finish(client);
  await assert.rejects(pending, /重新加载/);
  assert.equal(Client.prototype.enqueueRequest, original);
});

test("failed validation does not reach the original transport", async () => {
  const { client, create } = fixture();
  const gate = create({ rewriteRequest() { throw new Error("blocked route"); } });
  await gate.ensure();
  await assert.rejects(client.enqueueRequest("turn/start", {}), /blocked route/);
  gate.dispose();
});

test("the verified source gate works before the offline page exposes a client", async () => {
  const { window, create } = fixture();
  window.__codeyNativeRuntime = { async ensureRequestSourceGate() {
    window.__codeyModelRequestSourceGateInstalled = true;
    return true;
  } };
  window.__codeyLoadCodexRequestClient = () => { throw new Error("page is waiting for network"); };
  const gate = create();
  assert.equal(await gate.ensure(), true);
  gate.dispose();
});

test("a source loader success without the installed marker cannot bypass validation", async () => {
  const { window, create } = fixture();
  window.__codeyNativeRuntime = { async ensureRequestSourceGate() { return true; } };
  window.__codeyLoadCodexRequestClient = () => { throw new Error("missing local client"); };
  const gate = create();
  await assert.rejects(gate.ensure(), /missing local client/);
  gate.dispose();
});

test("a source gate installed during failed client discovery is accepted", async () => {
  const { window, create } = fixture();
  window.__codeyLoadCodexRequestClient = async () => {
    window.__codeyModelRequestSourceGateInstalled = true;
    throw new Error("page has not hydrated");
  };
  const gate = create();
  assert.equal(await gate.ensure(), true);
  gate.dispose();
});

test("disposal during source loading cannot verify an obsolete gate", async () => {
  const { window, create } = fixture();
  let finish;
  window.__codeyNativeRuntime = { ensureRequestSourceGate: () => new Promise(resolve => { finish = resolve; }) };
  const gate = create();
  const pending = gate.ensure();
  await new Promise(resolve => setImmediate(resolve));
  gate.dispose();
  window.__codeyModelRequestSourceGateInstalled = true;
  finish(true);
  await assert.rejects(pending, /重新加载/);
});
