import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { readSource } from "./helpers/read-source.mjs";

async function quitScript() {
  const source = await readSource("backend/src/cdp/quit.rs");
  const match = /const NATIVE_QUIT_SCRIPT: &str = r#"([\s\S]*?)"#;/.exec(source);
  assert.ok(match, "native quit script must remain independently testable");
  return match[1];
}

test("restart requests native quit without relaunching or directly changing settings", async () => {
  const calls = [];
  const result = await vm.runInNewContext(await quitScript(), {
    window: {
      electronBridge: {
        async sendMessageFromView(message) { calls.push(message); },
      },
    },
  });
  assert.equal(result, true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ type: "quit-app", relaunch: false }]);
});

test("native quit does not report success before its IPC request settles", async () => {
  let finish;
  let settled = false;
  const pending = vm.runInNewContext(await quitScript(), {
    window: {
      electronBridge: {
        sendMessageFromView() { return new Promise(resolve => { finish = resolve; }); },
      },
    },
  }).then(result => { settled = true; return result; });
  await Promise.resolve();
  assert.equal(settled, false);
  finish();
  assert.equal(await pending, true);
});

test("missing native quit support cannot silently authorize force termination", async () => {
  for (const window of [{}, { electronBridge: {} }]) {
    assert.equal(await vm.runInNewContext(await quitScript(), { window }), false);
  }
});

test("native quit failures remain failures rather than being acknowledged", async () => {
  await assert.rejects(vm.runInNewContext(await quitScript(), {
    window: {
      electronBridge: {
        async sendMessageFromView() { throw new Error("IPC rejected"); },
      },
    },
  }), /IPC rejected/);
});

test("Windows restart confirms native exit before process cleanup and config restoration", async () => {
  const runtime = await readSource("backend/src/commands/runtime.rs");
  const scheduled = runtime.slice(
    runtime.indexOf("async fn run_scheduled_restart"),
    runtime.indexOf("async fn stop_codey_runtime_locked"),
  );
  const prepare = scheduled.search(/runtime\s*\.prepare_for_restart\(\)\s*\.await/);
  const stop = scheduled.indexOf("stop_codey_runtime_locked(&restart_state).await");
  assert.ok(prepare !== -1 && stop > prepare);
  assert.match(scheduled.slice(prepare, stop), /map_err[\s\S]*?\?/);
  assert.match(scheduled, /if let Err\(error\) = stop[\s\S]*?return;/);
});
