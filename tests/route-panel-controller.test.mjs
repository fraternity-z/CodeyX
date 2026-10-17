import assert from "node:assert/strict";
import test from "node:test";
import { createControllerHarness, deferred } from "./helpers/controller-harness.mjs";

function setup(overrides = {}) {
  const reads = [], opens = [], remembered = [], published = [], notices = [];
  const harness = createControllerHarness(new URL("../src/features/routes/useRoutePanelController.ts", import.meta.url), "useRoutePanelController", {
    "./requests": {
      rememberOfficialAccounts: result => remembered.push(result),
      routeRequests: {
        accounts() { const pending = deferred(); reads.push(pending); return pending.promise; },
        openLogs(theme) { const pending = deferred(); opens.push({ ...pending, theme }); return pending.promise; },
      },
    },
  });
  const options = { active: true, readOnly: true, onAccountsChanged: result => published.push(result), onNotice: notice => notices.push(notice), ...overrides };
  harness.render(options);
  return { harness, options, reads, opens, remembered, published, notices };
}
const snapshot = id => ({ accounts: [{ id }] });

test("隐藏线路页不读取账号，重新进入时拒绝旧会话的迟到结果", async () => {
  const { harness, options, reads } = setup({ active: false });
  assert.equal(reads.length, 0);
  harness.render({ ...options, active: true });
  harness.render(options);
  harness.render({ ...options, active: true });
  assert.equal(reads.length, 2);
  reads[1].resolve(snapshot("new"));
  assert.deepEqual((await harness.flush()).officialAccounts, [{ id: "new" }]);
  reads[0].resolve(snapshot("old"));
  assert.deepEqual((await harness.flush()).officialAccounts, [{ id: "new" }]);
});

test("并行刷新、外部账号接管和模式切换均使旧读取失效", async () => {
  for (const failed of [false, true]) {
    const { harness, options, reads } = setup();
    void harness.render().refreshOfficialAccounts();
    reads[1].resolve(snapshot("fresh"));
    await harness.flush();
    if (failed) reads[0].reject(new Error("old failure"));
    else reads[0].resolve(snapshot("stale"));
    assert.deepEqual((await harness.flush()).officialAccounts, [{ id: "fresh" }]);
    void harness.render().refreshOfficialAccounts();
    harness.render().adoptOfficialAccounts([{ id: "adopted" }]);
    reads[2].resolve(snapshot("stale"));
    assert.deepEqual((await harness.flush()).officialAccounts, [{ id: "adopted" }]);
    void harness.render().refreshOfficialAccounts();
    harness.render({ ...options, readOnly: false });
    reads[3].resolve(snapshot("stale"));
    assert.deepEqual((await harness.flush()).officialAccounts, [{ id: "adopted" }]);
    assert.equal(reads.length, 4);
  }
});

test("当前读取失败保留未知状态，重试可恢复，卸载后无状态写入", async () => {
  const { harness, reads } = setup();
  reads[0].reject(new Error("offline"));
  assert.equal((await harness.flush()).officialAccounts, null);
  void harness.render().refreshOfficialAccounts();
  reads[1].resolve({});
  assert.deepEqual((await harness.flush()).officialAccounts, []);
  void harness.render().refreshOfficialAccounts();
  harness.unmount();
  reads[2].reject(new Error("late failure"));
  await harness.flush();
  assert.equal(harness.writesAfterUnmount, 0);
});

test("账号变更回写共享缓存并通知父级，空变更不清除当前账号", async () => {
  const { harness, reads, remembered, published } = setup();
  const changed = snapshot("saved");
  harness.render().handleOfficialAccountsChanged(changed);
  reads[0].resolve(snapshot("old"));
  assert.deepEqual((await harness.flush()).officialAccounts, changed.accounts);
  harness.render().handleOfficialAccountsChanged({});
  assert.deepEqual((await harness.flush()).officialAccounts, changed.accounts);
  assert.deepEqual(remembered, [changed]);
  assert.deepEqual(published, [changed, {}]);
  harness.render().adoptOfficialAccounts(null);
  assert.equal((await harness.flush()).officialAccounts, null);
});

test("打开日志合并重复点击，展示当前失败且可重试，不阻塞账号读取", async () => {
  const { harness, reads, opens, notices } = setup();
  const first = harness.render().openRequestLogs("dark");
  await harness.render().openRequestLogs("light");
  assert.equal(opens.length, 1);
  assert.equal(opens[0].theme, "dark");
  reads[0].resolve(snapshot("current"));
  assert.deepEqual((await harness.flush()).officialAccounts, [{ id: "current" }]);
  opens[0].reject(new Error("browser unavailable"));
  await first;
  assert.deepEqual(notices, [{ tone: "error", text: "browser unavailable" }]);
  const retry = harness.render().openRequestLogs("light");
  opens[1].resolve({ status: "ok" });
  await retry;
  assert.equal(notices.length, 1);
});

test("隐藏或卸载后的日志失败不弹通知，隐藏期间不重复打开", async () => {
  for (const unmount of [false, true]) {
    const { harness, options, opens, notices } = setup({ readOnly: false });
    const operation = harness.render().openRequestLogs("dark");
    if (unmount) harness.unmount();
    else {
      harness.render({ ...options, active: false });
      await harness.render().openRequestLogs("dark");
      assert.equal(opens.length, 1);
      harness.render(options);
      await harness.render().openRequestLogs("dark");
      assert.equal(opens.length, 1);
    }
    opens[0].reject(new Error("late failure"));
    await operation;
    assert.deepEqual(notices, []);
    assert.equal(harness.writesAfterUnmount, 0);
  }
});
