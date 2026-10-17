import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const rust = readFileSync(new URL("../backend/src/cdp.rs", import.meta.url), "utf8");
const source = rust.slice(rust.indexOf("pub async fn reload_mcp_servers("))
  .match(/r#"([\s\S]*?)"#/)[1];

test("the CDP wrapper submits an available MCP adapter only once", async () => {
  for (const outcome of ["ok", "rejected", "disconnected"]) {
    let calls = 0;
    const window = {
      setTimeout: resolve => resolve(),
      async __codeyReloadMcpServers() {
        calls += 1;
        if (outcome === "disconnected") throw new Error("connection lost after submission");
        return { ok: outcome === "ok" };
      },
    };
    assert.equal(await vm.runInNewContext(source, { window }), outcome === "ok");
    assert.equal(calls, 1);
  }
});

test("readiness retries never bypass the adapter's local-client selection", async () => {
  let waits = 0;
  let calls = 0;
  const window = {
    __codeyAppServerRequestClients: new Map([["ssh", { sendRequest() { assert.fail("remote client used"); } }]]),
    setTimeout(resolve) {
      waits += 1;
      if (waits === 2) window.__codeyReloadMcpServers = async () => { calls += 1; return { ok: true }; };
      resolve();
    },
  };
  assert.equal(await vm.runInNewContext(source, { window }), true);
  assert.equal(waits, 2);
  assert.equal(calls, 1);
});

test("an absent adapter exhausts readiness without sending a request", async () => {
  let waits = 0;
  const window = { setTimeout(resolve) { waits += 1; resolve(); } };
  assert.equal(await vm.runInNewContext(source, { window }), false);
  assert.equal(waits, 4);
});
