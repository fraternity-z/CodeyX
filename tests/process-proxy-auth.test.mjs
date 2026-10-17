import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import vm from "node:vm";
import { loadStartupPatchTemplate } from "./helpers/startup-patch.mjs";

const auth = { host: "127.0.0.1", port: 49152, username: "codeyx", password: "a".repeat(32), realm: `codeyx-${"b".repeat(32)}` };
async function install(value = auth, app = new EventEmitter()) {
  const source = await loadStartupPatchTemplate({ processProxyAuth: value });
  const start = source.indexOf('  const rawProcessProxyAuth =');
  const end = source.indexOf('  const readCodexAppVersion =', start);
  assert.ok(start > 0 && end > start);
  const context = { Module: {}, originalLoad: () => ({ app }) };
  vm.runInNewContext(source.slice(start, end), context);
  return { app, context };
}
function challenge(app, overrides = {}, firstAuthAttempt = true) {
  let prevented = false; const calls = [];
  app.emit("login", { preventDefault() { prevented = true; } }, {}, { firstAuthAttempt },
    { isProxy: true, host: auth.host, port: auth.port, scheme: "basic", realm: auth.realm, ...overrides }, (...args) => calls.push(args));
  return { prevented, calls };
}
test("本机认证只响应精确代理挑战，拒绝来源认证、其他端口和伪造 realm", async () => {
  const { app, context } = await install();
  assert.deepEqual(challenge(app), { prevented: true, calls: [[auth.username, auth.password]] });
  assert.deepEqual(challenge(app, { scheme: "Basic" }), { prevented: true, calls: [[auth.username, auth.password]] });
  for (const override of [{ isProxy: false }, { host: "evil.example" }, { host: "localhost" }, { port: 49153 }, { port: "49152" }, { realm: "other" }, { scheme: "digest" }]) {
    assert.deepEqual(challenge(app, override), { prevented: false, calls: [] });
  }
  assert.deepEqual(challenge(app, {}, false), { prevented: true, calls: [[]] });
  assert.equal(JSON.stringify(context).includes(auth.password), false);
});
test("默认启动不安装认证监听，认证安装失败不静默继续", async () => {
  assert.equal((await install(null)).app.listenerCount("login"), 0);
  for (const value of [{ ...auth, host: "external.example" }, { ...auth, port: 0 }, { ...auth, password: "bad" }]) {
    await assert.rejects(install(value), /authentication is invalid/);
  }
  await assert.rejects(install(auth, {}), /could not be installed/);
});
