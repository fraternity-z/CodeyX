import assert from "node:assert/strict";
import test from "node:test";
import { createControllerHarness, deferred, installControllerWindow } from "./helpers/controller-harness.mjs";
import { createModuleGraph } from "./helpers/jsx-tree.mjs";

const state = createModuleGraph(new URL("../src/features/network-proxy/state.ts", import.meta.url)).exports;
const upstream = createModuleGraph(new URL("../src/features/network-proxy/upstream.ts", import.meta.url)).exports;
const processProxy = createModuleGraph(new URL("../src/features/network-proxy/process.ts", import.meta.url)).exports;
const node = (id = "one") => ({ id, name: id, endpoint: { protocol: "socks5", host: `${id}.example`, port: 1080, dns: "remote" },
  credentialRef: null, notes: "", enabled: false, tags: [], group: "" });
const pool = (...nodes) => ({ schemaVersion: 1, nodes, chains: [] });
const probe = (value, elapsedMs = 20) => ({ node: value, result: { nodeId: value.id, success: true, elapsedMs,
  testedAt: "2026-10-17T00:00:00Z", exitIp: "203.0.113.5", errorCode: null, message: "fixture" } });




test("代理草稿校验地址、端口、UTF-8 凭据和标签，凭据与普通配置分离", () => {
  const draft = { ...state.proxyDraft("new"), name: "固定出口", host: "2001:db8::1", authentication: "replace", username: " user ", password: " fake-secret " };
  const prepared = state.prepareNodeSave(pool(), draft);
  assert.equal(prepared.config.nodes[0].enabled, false);
  assert.equal(prepared.config.nodes[0].endpoint.dns, "remote");
  assert.equal(JSON.stringify(prepared.config).includes("fake-secret"), false);
  assert.equal(prepared.credentials[0].change.password, " fake-secret ");
  for (const host of ["", "host/path", "user:pass@host", "host:1080", "*.example", "host?x", "host\nname"])
    assert.notEqual(state.validateDraft({ ...draft, host }), "", host);
  for (const port of ["0", "65536", "1.5", "", "1e3", "-1"])
    assert.notEqual(state.validateDraft({ ...draft, port }), "", port);
  for (const port of ["1", "65535"]) assert.equal(state.validateDraft({ ...draft, port }), "");
  assert.notEqual(state.validateDraft({ ...draft, username: "用".repeat(86) }), "");
  assert.notEqual(state.validateDraft({ ...draft, protocol: "http", username: "user:name" }), "");
  assert.equal(state.validateDraft({ ...draft, username: "user:name" }), "");
  assert.notEqual(state.validateDraft({ ...draft, tags: "same,same" }), "");
  const https = state.prepareNodeSave(pool(), { ...draft, protocol: "https", dns: "local" });
  assert.equal(https.config.nodes[0].endpoint.dns, "remote");
});

test("编辑冲突拒绝保存，旧链路数据不再限制节点管理", () => {
  const original = { ...node(), credentialRef: "saved-reference" };
  const current = pool(original, node("two"));
  const draft = { ...state.proxyDraft(original.id, original), name: "updated" };
  assert.equal(draft.password, ""); assert.equal(draft.authentication, "keep");
  const result = state.prepareNodeSave(current, draft);
  assert.deepEqual(result.credentials, []);
  assert.equal(result.config.nodes[0].credentialRef, original.credentialRef);
  assert.deepEqual(result.config.nodes[1], current.nodes[1]);
  assert.throws(() => state.prepareNodeSave(pool({ ...original, name: "changed elsewhere" }), draft), /修改或删除/);
  assert.throws(() => state.prepareNodeSave(pool(), draft), /修改或删除/);
  assert.equal(state.removeNodes({ ...current, chains: [{ id: "chain", nodeIds: [original.id] }] }, [original.id]).chains.length, 1);
  assert.deepEqual(state.removeNodes(current, [original.id]).nodes, [current.nodes[1]]);
});

test("筛选和显示排序不改变保存顺序，节点修改后测试结果标为过期", () => {
  const first = { ...node("z"), enabled: true, tags: ["stable"], group: "出口" };
  const second = node("a"); const current = pool(first, second);
  const probes = { z: probe(first, 100), a: probe(second, 10) };
  const filter = state.INITIAL_FILTER;
  assert.deepEqual(state.visibleNodes(current, { ...filter, query: "STABLE", enabled: "enabled" }, probes), [first]);
  assert.deepEqual(state.visibleNodes(current, { ...filter, sort: "latency" }, probes).map(value => value.id), ["a", "z"]);
  assert.deepEqual(current.nodes.map(value => value.id), ["z", "a"]);
  assert.equal(state.currentProbe({ ...first, endpoint: { ...first.endpoint, port: 1081 } }, probes).stale, true);
});

function fixture(initial = pool(node()), capabilities = {}) {
  const calls = [], adopted = [];
  const options = { active: true, remote: false, isBusy: false,
    config: { settingsRevision: 1, codexLaunchProxy: "", networkProxy: initial, localRouterEnabled: true, profiles: [{ id: "route", name: "线路" }] },
    onConfigChange(config) { options.config = config; },
    onSaved(snapshot) { adopted.push(snapshot); options.config = snapshot.config; return true; } };
  const h = createControllerHarness(new URL("../src/features/network-proxy/useNetworkProxyController.ts", import.meta.url), "useNetworkProxyController", {
    "../../api": { invoke(command, args) { const call = { command, args, ...deferred() }; calls.push(call); return call.promise; } },
  });
  const snapshot = (revision = options.config.settingsRevision, value = options.config.networkProxy) => ({
    config: { ...options.config, settingsRevision: revision, networkProxy: value }, probeUrl: "https://probe.example/",
    launchProxyPoolSupported: true,
    ...capabilities,
  });
  const render = () => h.render(options);
  const ready = async () => { render(); calls.at(-1).resolve(snapshot()); await h.flush(); return render(); };
  return { ...h, options, calls, adopted, snapshot, render, ready };
}


test("代理池只在电脑端活动页面加载，旧读取在隐藏重开后失效", async t => {
  installControllerWindow(t);
  for (const key of ["active", "remote"]) {
    const h = fixture(); h.options[key] = key === "remote";
    const c = h.render(); c.openNode(); c.refresh(); await c.setEnabled(["one"], true); await c.testNode("one");
    assert.equal(h.calls.length, 0); h.unmount();
  }
  const h = fixture(); h.render(); h.options.active = false; h.render(); h.options.active = true; h.render();
  h.calls[1].resolve(h.snapshot(2)); await h.flush(); h.calls[0].reject(new Error("old")); await h.flush();
  assert.equal(h.options.config.settingsRevision, 2); assert.equal(h.render().error, ""); h.unmount();
});

test("保存立即防重复提交，失败保留草稿与凭据，重新读取前不重放写入", async t => {
  installControllerWindow(t);
  const h = fixture(); (await h.ready()).openNode("one"); h.render().changeDraft("authentication", "replace");
  h.render().changeDraft("username", "fixture-user"); h.render().changeDraft("password", "fixture-password");
  const c = h.render(); const work = c.saveDraft(); await c.saveDraft();
  assert.equal(h.calls.length, 2);
  assert.equal(JSON.stringify(h.calls[1].args.config).includes("fixture-password"), false);
  h.calls[1].reject(new Error("save failed")); await work; await h.flush();
  assert.equal(h.render().draft.password, "fixture-password"); assert.equal(h.render().ready, false);
  await h.render().saveDraft(); assert.equal(h.calls.length, 2);
  h.render().refresh(); h.render(); h.calls[2].resolve(h.snapshot()); await h.flush();
  const saved = h.render().saveDraft(); h.calls[3].resolve(h.snapshot(2)); await saved; await h.flush();
  assert.equal(h.render().draft, null); assert.equal(h.options.config.settingsRevision, 2); h.unmount();
});

test("隐藏期间的写入保持锁，完成后只刷新，不采纳旧写结果或重复提交", async t => {
  installControllerWindow(t);
  for (const failed of [false, true]) {
    const h = fixture(); const c = await h.ready(); const work = c.setEnabled(["one"], true); h.render();
    h.options.active = false; h.render(); h.options.active = true; h.render();
    await h.render().setEnabled(["one"], true); assert.equal(h.calls.length, 2);
    if (failed) h.calls[1].reject(new Error("late")); else h.calls[1].resolve(h.snapshot(2));
    await work; await h.flush(); assert.equal(h.adopted.length, 1);
    assert.equal(h.calls.at(-1).command, "network_proxy_get");
    h.calls.at(-1).resolve(h.snapshot(2)); await h.flush();
    assert.equal(h.render().ready, true); assert.equal(h.render().error, ""); h.unmount();
  }
});

test("卸载后不回写，测试不会启用节点，取消编辑清除局部凭据", async t => {
  installControllerWindow(t);
  for (const failed of [false, true]) {
    const h = fixture(); const work = (await h.ready()).testNode("one"); h.unmount();
    if (failed) h.calls[1].reject(new Error("late")); else h.calls[1].resolve(probe(node()));
    await work; await h.flush(); assert.equal(h.writesAfterUnmount, 0);
  }
  const h = fixture(); const work = (await h.ready()).testNode("one"); h.calls[1].resolve(probe(node())); await work; await h.flush();
  assert.equal(h.options.config.networkProxy.nodes[0].enabled, false);
  assert.equal(h.render().rows[0].probe.exitIp, "203.0.113.5");
  h.render().openNode("one"); h.render().changeDraft("password", "transient"); h.render().cancelDraft();
  assert.equal(h.render().draft, null); h.unmount();
});

test("测试结果不可用时替换旧成功和出口 IP，允许手动重试但不判定节点健康", async t => {
  installControllerWindow(t);
  const h = fixture(); let work = (await h.ready()).testNode("one");
  h.calls.at(-1).resolve(probe(node())); await work; await h.flush();
  assert.equal(h.render().rows[0].probe.success, true);
  work = h.render().testNode("one"); h.calls.at(-1).reject(new Error("系统密钥库已锁定"));
  await work; await h.flush();
  const latest = h.render().rows[0].probe;
  assert.equal(latest.success, false); assert.equal(latest.exitIp, null);
  assert.equal(latest.errorCode, "resultUnavailable"); assert.match(latest.message, /系统密钥库已锁定/);
  assert.equal(h.render().disabled, false); assert.equal(h.options.config.networkProxy.nodes[0].enabled, false);
  h.unmount();
});




test("上游固定选择保护引用，拒绝禁用节点和不支持模式，解除选择需显式保存", () => {
  const current = { ...pool({ ...node(), enabled: true }), chains: [{ id: "chain", name: "出口", enabled: true, nodeIds: ["one"] }] };
  const profiles = [{ id: "route" }];
  const draft = { profileId: "route", original: { kind: "legacy" }, selection: { kind: "node", id: "one" }, originalEnabled: false, enabled: true };
  const selected = upstream.prepareUpstreamSave(current, draft, profiles, true);
  assert.deepEqual(selected.upstreamByProfile.route, draft.selection);
  assert.throws(() => state.removeNodes(selected, ["one"]), /引用/);
  assert.throws(() => upstream.prepareUpstreamSave(selected, draft, profiles, true), /其他操作/);
  assert.throws(() => upstream.prepareUpstreamSave(current, draft, profiles, false), /本地路由/);
  assert.throws(() => upstream.prepareUpstreamSave(current, draft, [], true), /当前不可用/);
  assert.throws(() => upstream.prepareUpstreamSave(current, draft, [{ id: "route", pluginRouteSpec: { transport: {} } }], true), /自行联网/);
  assert.throws(() => upstream.prepareUpstreamSave(pool(node()), draft, profiles, true), /禁用/);
  assert.throws(() => upstream.prepareUpstreamSave(current, { ...draft, selection: { kind: "chain", id: "chain" } }, profiles, true), /已移除/);
  assert.match(upstream.upstreamProblem({ ...selected, nodes: [] }, draft.selection), /阻断/);
  const cleared = upstream.prepareUpstreamSave(selected, { ...draft, original: draft.selection, originalEnabled: true, enabled: false }, [], false);
  assert.deepEqual(cleared.upstreamByProfile, selected.upstreamByProfile);
  assert.equal(cleared.upstreamEnabledByProfile.route, false);
  assert.deepEqual(selected.upstreamByProfile.route, draft.selection);
  for (const selection of [{ kind: "legacy" }, { kind: "node", id: "a:b" }])
    assert.deepEqual(upstream.parseSelection(upstream.selectionKey(selection)), selection);
  assert.throws(() => upstream.parseSelection("automatic"), /无效/);
  assert.throws(() => upstream.parseSelection("chain:chain"), /无效/);
  assert.throws(() => upstream.parseSelection("policy:policy"), /无效/);
});

test("线路开关默认关闭，兼容已有绑定，关闭与重开保留节点和旧配置", () => {
  const selection = { kind: "node", id: "one" };
  const initial = { ...pool({ ...node(), enabled: true }), policies: [{ id: "old" }], upstreamByProfile: { route: selection } };
  assert.equal(upstream.upstreamEnabled(pool(), "route"), false);
  assert.equal(upstream.upstreamEnabled(initial, "route"), true);
  const draft = { profileId: "route", original: selection, selection, originalEnabled: true, enabled: false };
  const disabled = upstream.prepareUpstreamSave(initial, draft, [], false);
  assert.equal(upstream.upstreamEnabled(disabled, "route"), false);
  assert.deepEqual(disabled.upstreamByProfile, initial.upstreamByProfile);
  assert.deepEqual(disabled.policies, initial.policies);
  assert.throws(() => state.removeNodes(initial, ["one"]), /引用/);
  const removed = state.removeNodes(disabled, ["one"]);
  assert.deepEqual(removed.nodes, []);
  assert.deepEqual(removed.upstreamByProfile, disabled.upstreamByProfile);
  assert.throws(() => upstream.prepareUpstreamSave(removed, { ...draft, originalEnabled: false, enabled: true }, [{ id: "route" }], true), /缺失/);
  assert.throws(() => state.removeNodes({ ...disabled, upstreamByProfile: { ...disabled.upstreamByProfile, other: selection } }, ["one"]), /引用/);
  const enabled = upstream.prepareUpstreamSave(disabled, { ...draft, originalEnabled: false, enabled: true }, [{ id: "route" }], true);
  assert.equal(upstream.upstreamEnabled(enabled, "route"), true);
  assert.deepEqual(enabled.upstreamByProfile, initial.upstreamByProfile);
  assert.throws(() => upstream.prepareUpstreamSave(disabled, draft, [], false), /开关.*其他操作/);
  const oldSelection = { kind: "policy", id: "old" };
  const old = { ...initial, upstreamByProfile: { route: oldSelection } };
  assert.match(upstream.upstreamProblem(old, oldSelection), /已移除.*阻断/);
  assert.equal(upstream.prepareUpstreamSave(old, { ...draft, original: oldSelection, selection: oldSelection }, [], false).upstreamEnabledByProfile.route, false);
});

test("线路开关保存失败保留草稿，刷新后显式保存，隐藏期间不回写", async t => {
  installControllerWindow(t);
  const h = fixture(pool({ ...node(), enabled: true }));
  (await h.ready()).openUpstream("route", true); h.render().changeUpstream("node:one");
  let work = h.render().saveUpstream();
  h.calls.at(-1).reject(new Error("save failed")); await work; await h.flush();
  assert.equal(h.render().upstreamDraft.enabled, true); assert.equal(h.render().upstreamDraft.selection.id, "one");
  assert.equal(h.render().ready, false);
  h.render().refresh(); h.render(); h.calls.at(-1).resolve(h.snapshot()); await h.flush();
  work = h.render().saveUpstream(); h.calls.at(-1).resolve(h.snapshot(2, h.calls.at(-1).args.config)); await work; await h.flush();
  h.render().openUpstream("route", false);
  assert.equal(h.render().upstreamDraft.selection.id, "one");
  work = h.render().saveUpstream(); h.options.active = false; h.render();
  h.calls.at(-1).resolve(h.snapshot(3, h.calls.at(-1).args.config)); await work; await h.flush();
  assert.equal(h.render().upstreamDraft.enabled, false); assert.equal(h.options.config.settingsRevision, 2);
  h.unmount();
});

test("出口选择保存与其他编辑互斥，禁用节点后保留选择并显示阻断", async t => {
  installControllerWindow(t);
  const h = fixture(pool({ ...node(), enabled: true }));
  (await h.ready()).openUpstream("route", true);
  h.render().changeUpstream("node:one");
  h.render().openNode("one");
  assert.equal(h.render().draft, null);
  let work = h.render().saveUpstream();
  await h.render().saveUpstream();
  assert.equal(h.calls.length, 2);
  h.calls.at(-1).resolve(h.snapshot(2, h.calls.at(-1).args.config)); await work; await h.flush();
  assert.equal(h.render().upstreamDraft, null);
  assert.equal(h.render().upstreamRows[0].selection.kind, "node");
  h.render().requestDelete(["one"]);
  assert.match(h.render().error, /出口引用/);
  work = h.render().setEnabled(["one"], false);
  h.calls.at(-1).resolve(h.snapshot(3, h.calls.at(-1).args.config)); await work; await h.flush();
  assert.match(h.render().upstreamRows[0].problem, /禁用.*阻断/);
  assert.equal(h.render().upstreamRows[0].selection.kind, "node");
  h.unmount();
});

test("导入标识与对象原型同名时，出口选择和测试结果仍按自己的键读取", () => {
  for (const id of ["__proto__", "constructor", "toString"]) {
    const current = { ...pool({ ...node(id), enabled: true }), upstreamByProfile: {} };
    const selection = { kind: "node", id };
    const draft = { profileId: id, original: { kind: "legacy" }, selection, originalEnabled: false, enabled: true };
    assert.deepEqual(upstream.selectedUpstream(current, id), { kind: "legacy" });
    const selected = upstream.prepareUpstreamSave(current, draft, [{ id }], true);
    const restored = JSON.parse(JSON.stringify(selected));
    assert.equal(Object.prototype.hasOwnProperty.call(restored.upstreamByProfile, id), true);
    assert.deepEqual(upstream.selectedUpstream(restored, id), selection);
    assert.equal(Object.getPrototypeOf(selected.upstreamByProfile), Object.prototype);
    const cleared = upstream.prepareUpstreamSave(restored, { ...draft, original: selection, originalEnabled: true, enabled: false }, [], false);
    assert.deepEqual(upstream.selectedUpstream(cleared, id), selection);
    assert.equal(upstream.upstreamEnabled(cleared, id), false);
    assert.equal(state.currentProbe(current.nodes[0], {}), null);
    const ownProbe = { [id]: probe(current.nodes[0]) };
    assert.equal(state.currentProbe(current.nodes[0], ownProbe).stale, false);
  }
});

test("启动出口独立于线路配置，拒绝禁用或缺失出口，解除选择须显式保存", () => {
  const current = { ...pool({ ...node(), enabled: true }), chains: [{ id: "chain", name: "出口", enabled: true, nodeIds: ["one"] }], upstreamByProfile: { route: { kind: "node", id: "one" } } };
  const draft = { original: { kind: "legacy" }, selection: { kind: "node", id: "one" }, enabled: true };
  assert.deepEqual(processProxy.selectedProcessProxy(current), draft.original);
  const next = processProxy.prepareProcessProxySave(current, draft, true);
  assert.deepEqual(next.processProxy, draft.selection);
  assert.deepEqual(next.upstreamByProfile, current.upstreamByProfile);
  assert.throws(() => processProxy.prepareProcessProxySave(current, { ...draft, selection: { kind: "chain", id: "chain" } }, true), /已移除/);
  assert.throws(() => processProxy.prepareProcessProxySave(next, draft, true), /其他操作/);
  assert.throws(() => processProxy.prepareProcessProxySave(current, draft, false), /宿主/);
  assert.throws(() => processProxy.prepareProcessProxySave({ ...current, nodes: [] }, draft, true), /阻断/);
  assert.throws(() => processProxy.prepareProcessProxySave(pool(node()), { ...draft, selection: { kind: "node", id: "one" } }, true), /禁用/);
  assert.throws(() => state.removeNodes({ ...current, upstreamByProfile: {}, processProxy: { kind: "node", id: "one" } }, ["one"]), /启动出口/);
  assert.throws(() => processProxy.prepareProcessProxySave(current, { ...draft, selection: draft.original }, true), /请选择代理池节点/);
  const cleared = processProxy.prepareProcessProxySave(next, { original: draft.selection, selection: draft.selection, enabled: false }, false);
  assert.equal(cleared.processProxy, undefined);
  assert.deepEqual(cleared.upstreamByProfile, current.upstreamByProfile);
});

test("流量接管必须显式启用，校验宿主、出口和过期草稿", () => {
  const current = pool({ ...node(), enabled: true });
  const draft = { original: { kind: "legacy" }, selection: { kind: "node", id: "one" }, enabled: true };
  assert.equal(processProxy.prepareProcessProxySave(current, draft, true, true).processCapture, undefined);
  assert.throws(() => processProxy.prepareProcessProxySave(current, { ...draft, capture: true }, true), /Windows/);
  assert.throws(() => processProxy.prepareProcessProxySave(current, { ...draft, selection: draft.original, capture: true }, true, true), /请选择代理池节点/);
  const saved = processProxy.prepareProcessProxySave(current, { ...draft, capture: true }, true, true);
  assert.equal(saved.processCapture, true);
  assert.throws(() => processProxy.prepareProcessProxySave(saved, { original: draft.selection, selection: draft.selection, enabled: true }, true, true), /其他操作/);
  const disabled = processProxy.prepareProcessProxySave(saved, { original: draft.selection, selection: draft.selection, enabled: true, originalCapture: true, capture: false }, true, false);
  assert.equal(disabled.processCapture, undefined);
  assert.deepEqual(disabled.processProxy, draft.selection);
  const off = processProxy.prepareProcessProxySave(saved, { ...draft, original: draft.selection, originalCapture: true, capture: true, enabled: false }, false, false);
  assert.equal(off.processProxy, undefined); assert.equal(off.processCapture, undefined);
});

test("接管勾选不立即启动服务，保存失败和隐藏保留草稿，解除池选择会关闭接管", async t => {
  installControllerWindow(t);
  const h = fixture(pool({ ...node(), enabled: true }), { trafficCaptureSupported: true, trafficCaptureAvailable: false });
  (await h.ready()).openProcess(true);
  h.render().changeProcess("node:one");
  h.render().changeProcessCapture(true);
  assert.equal(h.render().processDraft.capture, true);
  assert.equal(h.calls.length, 1);
  let work = h.render().saveProcess();
  assert.equal(h.calls.at(-1).args.config.processCapture, true);
  h.calls.at(-1).reject(new Error("fixture save failed")); await work; await h.flush();
  assert.equal(h.render().processDraft.capture, true);
  h.options.active = false; h.render().changeProcessCapture(false);
  assert.equal(h.render().processDraft.capture, true);
  h.options.active = true; h.render();
  h.render().changeProcessEnabled(false);
  assert.equal(h.render().processDraft.capture, false);
  assert.equal(h.render().processDraft.selection.id, "one");
  assert.equal(h.render().processDraft.enabled, false);
  h.render().changeProcessEnabled(true);
  assert.equal(h.render().processDraft.selection.id, "one");
  h.render().cancelProcess(); assert.equal(h.render().processDraft, null);
  h.unmount();
});

test("启动出口保存与其他编辑互斥，失败保留草稿，禁用节点不清除选择", async t => {
  installControllerWindow(t);
  const h = fixture(pool({ ...node(), enabled: true }));
  (await h.ready()).openProcess(true); h.render().changeProcess("node:one");
  h.render().openUpstream("route"); h.render().openNode("one");
  assert.equal(h.render().upstreamDraft, null); assert.equal(h.render().draft, null);
  let work = h.render().saveProcess(); await h.render().saveProcess();
  assert.equal(h.calls.length, 2);
  h.calls.at(-1).reject(new Error("保存失败")); await work; await h.flush();
  assert.equal(h.render().processDraft.selection.kind, "node");
  h.render().refresh(); h.render(); h.calls.at(-1).resolve(h.snapshot()); await h.flush();
  work = h.render().saveProcess(); h.calls.at(-1).resolve(h.snapshot(2, h.calls.at(-1).args.config)); await work; await h.flush();
  assert.equal(h.render().processDraft, null); assert.match(h.render().notice, /重启/);
  assert.equal(h.render().processSelection.id, "one");
  assert.deepEqual(h.render().upstreamRows[0].selection, { kind: "legacy" });
  work = h.render().setEnabled(["one"], false); h.calls.at(-1).resolve(h.snapshot(3, h.calls.at(-1).args.config)); await work; await h.flush();
  assert.match(h.render().processProblem, /禁用.*阻断/);
  assert.equal(h.render().processSelection.id, "one"); h.unmount();
});
