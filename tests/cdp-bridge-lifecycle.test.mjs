import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const rust = readFileSync(new URL("../vendor/CodeyRuntime/crates/codey-runtime-core/src/bridge.rs", import.meta.url), "utf8");
const template = rust.match(/fn build_bridge_script_for_session[\s\S]*?r#"([\s\S]*?)"#/)[1];
const script = template
  .replaceAll("{{", "{").replaceAll("}}", "}")
  .replaceAll("{session_token}", JSON.stringify("test-session"))
  .replaceAll("{binding_name}", "testBinding");

function page(documentId, cryptoAvailable = true) {
  const calls = [];
  const window = {
    testBinding(payload) { calls.push(JSON.parse(payload)); },
    setTimeout, clearTimeout,
  };
  const context = vm.createContext({ window, crypto: cryptoAvailable ? { randomUUID: () => documentId } : undefined });
  vm.runInContext(script, context);
  return { window, calls, context };
}

test("a late result from a previous document cannot settle a new document's request", async () => {
  const oldPage = page("old-document");
  oldPage.window.__codexSessionDeleteBridge("/settings/set", {});
  const oldId = oldPage.calls[0].id;
  const newPage = page("new-document");
  const result = newPage.window.__codexSessionDeleteBridge("/settings/set", {});
  const newId = newPage.calls[0].id;
  assert.notEqual(oldId, newId);
  newPage.window.__codexSessionDeleteResolve(oldId, { status: "stale" });
  newPage.window.__codexSessionDeleteReject(oldId, "stale error");
  assert.equal(newPage.window.__codexSessionDeleteCallbacks.size, 1);
  newPage.window.__codexSessionDeleteResolve(newId, { status: "ok" });
  assert.equal((await result).status, "ok");
  assert.equal(newPage.window.__codexSessionDeleteCallbacks.size, 0);
  assert.equal(newPage.calls.length, 1, "delivery failures must not repeat business requests");
});

test("reinstall settles pending calls and gives replacement calls a new document id", async () => {
  const current = page("before-reinstall");
  const pending = current.window.__codexSessionDeleteBridge("/settings/set", {});
  const oldId = current.calls[0].id;
  current.context.crypto.randomUUID = () => "after-reinstall";
  vm.runInContext(script, current.context);
  assert.equal((await pending).code, "bridge_reinstalled");
  const next = current.window.__codexSessionDeleteBridge("/settings/set", {});
  assert.notEqual(current.calls[1].id, oldId);
  current.window.__codexSessionDeleteResolve(oldId, { status: "stale" });
  assert.equal(current.window.__codexSessionDeleteCallbacks.size, 1);
  current.window.__codexSessionDeleteResolve(current.calls[1].id, { status: "ok" });
  assert.equal((await next).status, "ok");
});

test("bridge supports renderers without randomUUID and keeps calls distinct", async () => {
  const current = page("unused", false);
  const first = current.window.__codexSessionDeleteBridge("/backend/status", {});
  const second = current.window.__codexSessionDeleteBridge("/backend/status", {});
  assert.notEqual(current.calls[0].id, current.calls[1].id);
  for (const call of current.calls) {
    assert.equal(call.bridgeSession, "test-session");
    current.window.__codexSessionDeleteResolve(call.id, { status: "ok" });
  }
  assert.equal((await first).status, "ok");
  assert.equal((await second).status, "ok");
});
