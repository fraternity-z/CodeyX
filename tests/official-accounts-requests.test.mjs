import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createModuleGraph } from "./helpers/jsx-tree.mjs";
import { deferred } from "./helpers/controller-harness.mjs";

const source = {
  helper: await readFile(new URL("../src/officialAccountsRequests.ts", import.meta.url), "utf8"),
  controller: await readFile(new URL("../src/features/official-accounts/useOfficialAccountsController.ts", import.meta.url), "utf8"),
  requests: await readFile(new URL("../src/features/official-accounts/requests.ts", import.meta.url), "utf8"),
  models: await readFile(new URL("../src/ModelSection.tsx", import.meta.url), "utf8"),
  logs: await readFile(new URL("../src/features/request-logs/requests.ts", import.meta.url), "utf8"),
  app: await readFile(new URL("../src/features/routes/useRoutesController.ts", import.meta.url), "utf8"),
};

test("官方账号列表共用短缓存，变更结果回写缓存", () => {
  assert.match(source.helper, /list_official_accounts/);
  assert.match(source.helper, /const LIST_TTL_MS = 2_000/);
  assert.match(source.helper, /export function rememberOfficialAccounts/);
  assert.match(source.helper, /if \(!force && cache.promise\) return cache.promise/);
});

test("控制台各入口走共享读取，不再各自直接 invoke 列表", () => {
  assert.match(source.requests, /list: listOfficialAccounts/);
  assert.match(source.requests, /remember: rememberOfficialAccounts/);
  assert.match(source.controller, /officialAccountsRequests\.list\(\{ force \}\)/);
  assert.match(source.controller, /officialAccountsRequests\.remember\(result\)/);
  assert.match(source.models, /await listOfficialAccounts\(\)/);
  assert.match(source.logs, /accounts: listOfficialAccounts/);
  assert.match(source.app, /rememberOfficialAccounts\(result\)/);
  assert.doesNotMatch(source.models, /invoke<OfficialAccountsResult>\("list_official_accounts"\)/);
  assert.doesNotMatch(source.logs, /invoke<OfficialAccountsResult>\("list_official_accounts"\)/);
});

function createCache() {
  const requests = [];
  const { exports: cache } = createModuleGraph(new URL("../src/officialAccountsRequests.ts", import.meta.url), {
    stubs: { "./api": { invoke(command) {
      assert.equal(command, "list_official_accounts");
      const pending = deferred();
      requests.push(pending);
      return pending.promise;
    } } },
  });
  return { ...cache, requests };
}
const snapshot = (id) => ({ accounts: [{ id }] });

test("官方账号列表复用在途请求和有效缓存，过期后重新读取", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const cache = createCache();
  const first = cache.listOfficialAccounts();
  assert.equal(cache.listOfficialAccounts(), first);
  const result = snapshot("account-a");
  cache.requests[0].resolve(result);
  assert.equal(await first, result);
  assert.equal(await cache.listOfficialAccounts(), result);
  t.mock.timers.tick(2001);
  const next = cache.listOfficialAccounts();
  assert.equal(cache.requests.length, 2);
  cache.requests[1].resolve(result);
  await next;
});

test("较早读取的迟到成功不能覆盖较新的账号缓存", async () => {
  const cache = createCache();
  const older = cache.listOfficialAccounts();
  const newer = cache.listOfficialAccounts({ force: true });
  const current = snapshot("new-account");
  cache.requests[1].resolve(current);
  await newer;
  cache.requests[0].resolve(snapshot("old-account"));
  await older;
  assert.equal(await cache.listOfficialAccounts(), current);
  assert.equal(cache.requests.length, 2);
});

test("旧读取不能抢占仍在等待的新读取", async () => {
  const cache = createCache();
  const older = cache.listOfficialAccounts();
  const newer = cache.listOfficialAccounts({ force: true });
  cache.requests[0].resolve(snapshot("old-account"));
  await older;
  assert.equal(cache.listOfficialAccounts(), newer);
  cache.requests[1].resolve(snapshot("new-account"));
  await newer;
});

test("账号变更写回缓存后，旧读取的成功或失败都不能恢复旧账号", async () => {
  for (const failed of [false, true]) {
    const cache = createCache();
    const reading = cache.listOfficialAccounts();
    const current = { accounts: [] };
    cache.rememberOfficialAccounts(current);
    if (failed) {
      cache.requests[0].reject(new Error("offline"));
      await assert.rejects(reading, /offline/);
    } else {
      cache.requests[0].resolve(snapshot("removed-account"));
      await reading;
    }
    assert.equal(await cache.listOfficialAccounts(), current);
  }
});

test("旧请求失败不清除新请求，当前请求失败后可重试", async () => {
  const cache = createCache();
  const older = cache.listOfficialAccounts();
  const newer = cache.listOfficialAccounts({ force: true });
  cache.requests[0].reject(new Error("old failure"));
  await assert.rejects(older, /old failure/);
  assert.equal(cache.listOfficialAccounts(), newer);
  cache.requests[1].reject(new Error("current failure"));
  await assert.rejects(newer, /current failure/);
  const retry = cache.listOfficialAccounts();
  assert.equal(cache.requests.length, 3);
  cache.requests[2].resolve(snapshot("recovered-account"));
  await retry;
});

test("无效变更结果不清除现有账号缓存", async () => {
  const cache = createCache();
  const current = snapshot("account-a");
  cache.rememberOfficialAccounts(current);
  cache.rememberOfficialAccounts({});
  assert.equal(await cache.listOfficialAccounts(), current);
  assert.equal(cache.requests.length, 0);
});
