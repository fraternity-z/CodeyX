import assert from "node:assert/strict";
import test from "node:test";
import { createControllerHarness, deferred, installControllerWindow } from "./helpers/controller-harness.mjs";
import { createModuleGraph } from "./helpers/jsx-tree.mjs";

const state = createModuleGraph(new URL("../src/features/network-proxy/state.ts", import.meta.url)).exports;
const chains = createModuleGraph(new URL("../src/features/network-proxy/chains.ts", import.meta.url)).exports;
const upstream = createModuleGraph(new URL("../src/features/network-proxy/upstream.ts", import.meta.url)).exports;
const policies = createModuleGraph(new URL("../src/features/network-proxy/policies.ts", import.meta.url)).exports;
const processProxy = createModuleGraph(new URL("../src/features/network-proxy/process.ts", import.meta.url)).exports;
const node = (id = "one") => ({ id, name: id, endpoint: { protocol: "socks5", host: `${id}.example`, port: 1080, dns: "remote" },
  credentialRef: null, notes: "", enabled: false, tags: [], group: "" });
const pool = (...nodes) => ({ schemaVersion: 1, nodes, chains: [] });
const probe = (value, elapsedMs = 20) => ({ node: value, result: { nodeId: value.id, success: true, elapsedMs,
  testedAt: "2026-10-17T00:00:00Z", exitIp: "203.0.113.5", errorCode: null, message: "fixture" } });

test("出口策略默认阻断且不启用，直连需要显式授权，保留规则顺序与固定出口", () => {
  const initial = pool({ ...node(), enabled: true });
  const draft = { ...policies.policyDraft("work"), name: "按需出口" };
  assert.equal(draft.enabled, false); assert.equal(draft.allowDirect, false); assert.equal(draft.defaultAction.kind, "block");
  const rule = { ...policies.ruleDraft("rule"), host: { kind: "suffix", value: "example.com" }, ports: "80, 443",
    action: { kind: "proxy", targets: [{ kind: "node", id: "one" }], onFailure: "stop" } };
  const saved = policies.preparePolicySave(initial, { ...draft, rules: [rule], defaultAction: { kind: "block" } });
  assert.deepEqual(saved.policies[0].rules[0].ports, [80, 443]);
  assert.equal(saved.processProxy, undefined); assert.equal(saved.upstreamByProfile, undefined);
  assert.deepEqual(saved.nodes, initial.nodes); assert.deepEqual(draft.rules, []);
  for (const action of [{ kind: "direct" }, { kind: "proxy", targets: [{ kind: "node", id: "one" }], onFailure: "direct" }]) {
    assert.throws(() => policies.preparePolicySave(initial, { ...draft, defaultAction: action }), /勾选/);
    assert.equal(policies.preparePolicySave(initial, { ...draft, defaultAction: action, allowDirect: true }).policies[0].allowDirect, true);
    assert.throws(() => policies.preparePolicySave(initial, { ...draft, rules: [{ ...rule, enabled: false, action }] }), /勾选/);
  }
  assert.throws(() => policies.preparePolicySave(saved, draft), /修改或删除/);
  assert.throws(() => state.removeNodes(saved, ["one"]), /策略引用/);
});

test("出口规则校验 CIDR、端口、主机与候选引用，不静默更改用户输入", () => {
  const initial = { ...pool(node()), chains: [{ id: "chain", name: "chain", nodeIds: ["one"], enabled: false }] };
  const draft = { ...policies.policyDraft("work"), name: "工作" };
  const rule = policies.ruleDraft("rule");
  for (const value of ["10.0.0.0/8", "0.0.0.0/0", "2001:db8::/32", "::/0", "::1/128", "::ffff:192.0.2.1/128"])
    assert.equal(policies.validatePolicyDraft(initial, { ...draft, rules: [{ ...rule, host: { kind: "cidr", value } }] }), "", value);
  for (const value of ["10.1.0.1/8", "::1/0", "::/129", "10.0.0.0/33", "host/8", "127.01.0.1/32"])
    assert.match(policies.validatePolicyDraft(initial, { ...draft, rules: [{ ...rule, host: { kind: "cidr", value } }] }), /网段/);
  for (const ports of ["0", "65536", "443,", "443,443", "1e3", "1.5", "80,,443"])
    assert.match(policies.validatePolicyDraft(initial, { ...draft, rules: [{ ...rule, host: { kind: "any" }, ports }] }), /端口/);
  for (const value of ["*.example.com", "http://host", "user@host", "host/path", " "])
    assert.notEqual(policies.validatePolicyDraft(initial, { ...draft, rules: [{ ...rule, host: { kind: "exact", value } }] }), "");
  const candidate = { kind: "chain", id: "chain" };
  const current = policies.preparePolicySave(initial, { ...draft, defaultAction: { kind: "proxy", targets: [candidate], onFailure: "stop" } });
  assert.throws(() => upstream.removeChain(current, "chain"), /策略引用/);
  assert.throws(() => policies.preparePolicySave(initial, { ...draft, defaultAction: { kind: "proxy", targets: [candidate, candidate], onFailure: "next" } }), /唯一/);
  assert.throws(() => policies.preparePolicySave(initial, { ...draft, defaultAction: { kind: "proxy", targets: [{ kind: "node", id: "missing" }], onFailure: "stop" } }), /已存在/);
});

test("出口策略引用保护与禁用行为适用于启动和线路，解除引用后才可删除", () => {
  const draft = { ...policies.policyDraft("work"), name: "策略", enabled: true };
  const current = policies.preparePolicySave(pool(), draft);
  const selected = { kind: "policy", id: "work" };
  assert.deepEqual(upstream.parseSelection(upstream.selectionKey(selected)), selected);
  assert.equal(upstream.upstreamLabel(current, selected), "策略");
  for (const next of [{ ...current, processProxy: selected }, { ...current, upstreamByProfile: { route: selected } }])
    assert.throws(() => policies.removePolicy(next, "work"), /出口引用/);
  assert.equal(policies.removePolicy(current, "work").policies.length, 0);
  const disabled = { ...current, policies: [{ ...current.policies[0], enabled: false }] };
  assert.match(upstream.upstreamProblem(disabled, selected), /禁用.*阻断/);
  assert.throws(() => processProxy.prepareProcessProxySave(disabled, { original: { kind: "legacy" }, selection: selected }, true), /禁用/);
});

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

test("编辑冲突与被链路引用的删除均拒绝，不覆盖其他节点", () => {
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
  assert.throws(() => state.removeNodes({ ...current, chains: [{ id: "chain", nodeIds: [original.id] }] }, [original.id]), /引用/);
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

function fixture(initial = pool(node())) {
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
  });
  const render = () => h.render(options);
  const ready = async () => { render(); calls.at(-1).resolve(snapshot()); await h.flush(); return render(); };
  return { ...h, options, calls, adopted, snapshot, render, ready };
}

test("策略编辑与其他写入互斥，保存失败保留规则和授权草稿，旧结果不覆盖状态", async t => {
  installControllerWindow(t);
  const policy = { id: "work", name: "原策略", enabled: true, allowDirect: false, rules: [], defaultAction: { kind: "block" } };
  const h = fixture({ ...pool(node()), policies: [policy] });
  (await h.ready()).openPolicy("work"); h.render().changePolicy("name", "新策略");
  h.render().openProcess(); h.render().openNode("one");
  assert.equal(h.render().processDraft, null); assert.equal(h.render().draft, null);
  const before = h.calls.length; await h.render().setEnabled(["one"], true); assert.equal(h.calls.length, before);
  let work = h.render().savePolicy(); await h.render().savePolicy(); assert.equal(h.calls.length, before + 1);
  h.calls.at(-1).reject(new Error("save failed")); await work; await h.flush();
  assert.equal(h.render().policyDraft.name, "新策略"); assert.equal(h.render().policyDraft.allowDirect, false);
  h.render().refresh(); h.render(); h.calls.at(-1).resolve(h.snapshot()); await h.flush();
  work = h.render().savePolicy(); h.options.active = false; h.render();
  h.calls.at(-1).resolve(h.snapshot(2, h.calls.at(-1).args.config)); await work; await h.flush();
  assert.equal(h.render().policyDraft.name, "新策略"); assert.equal(h.options.config.settingsRevision, 1);
  h.unmount(); assert.equal(h.writesAfterUnmount, 0);
});

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

test("链路保存保持顺序，拒绝重复端点、回环后继、缺失引用和过期草稿", () => {
  const local = { ...node("local"), endpoint: { ...node().endpoint, host: "127.1" } };
  const current = pool(local, node("exit"));
  const draft = { ...chains.chainDraft("chain"), name: "本地到出口", nodeIds: ["local", "exit"] };
  const saved = chains.prepareChainSave(current, draft);
  assert.deepEqual(saved.nodes, current.nodes);
  assert.deepEqual(saved.chains[0].nodeIds, ["local", "exit"]);
  assert.equal(saved.chains[0].enabled, false);
  for (const nodeIds of [[], ["missing"], ["local", "local"], ["local", "exit", "local", "exit"]])
    assert.notEqual(chains.validateChainDraft(current, { ...draft, nodeIds }), "");
  assert.match(chains.validateChainDraft(current, { ...draft, nodeIds: ["exit", "local"] }), /回环/);
  const duplicate = { ...node("duplicate"), endpoint: { ...node("exit").endpoint, protocol: "https", host: "EXIT.EXAMPLE." } };
  assert.match(chains.validateChainDraft(pool(node("exit"), duplicate), { ...draft, nodeIds: ["exit", "duplicate"] }), /同一端点/);
  assert.throws(() => chains.prepareChainSave({ ...saved, chains: [] }, { ...draft, original: saved.chains[0] }), /修改或删除/);
  const moved = chains.moveChainNode(draft.nodeIds, 1, -1);
  assert.deepEqual(moved, ["exit", "local"]); assert.deepEqual(draft.nodeIds, ["local", "exit"]);
  assert.equal(chains.moveChainNode(draft.nodeIds, 0, -1), draft.nodeIds);
  const result = { ...probe(local).result, chainId: "chain" };
  const probes = { chain: { chain: saved.chains[0], nodes: saved.nodes, result } };
  assert.equal(chains.currentChainProbe(saved, saved.chains[0], probes).stale, false);
  assert.equal(chains.currentChainProbe({ ...saved, nodes: [local, { ...node("exit"), credentialRef: "rotated" }] }, saved.chains[0], probes).stale, true);
  assert.equal(chains.currentChainProbe(saved, { ...saved.chains[0], nodeIds: moved }, probes).stale, true);
});

test("链路编辑与节点写入互斥，保存失败保留草稿，刷新后仍需手动提交", async t => {
  installControllerWindow(t);
  const initial = { ...pool(node("one"), node("two")), chains: [{ id: "chain", name: "双跳", enabled: false, nodeIds: ["one", "two"] }] };
  const h = fixture(initial); (await h.ready()).openChain("chain");
  h.render().changeChainDraft("name", "新名称"); h.render().moveHop(1, -1);
  const calls = h.calls.length;
  await h.render().setEnabled(["one"], true); h.render().openNode("one"); h.render().requestDelete(["one"]);
  assert.equal(h.calls.length, calls); assert.equal(h.render().draft, null); assert.deepEqual(h.render().deleteIds, []);
  let work = h.render().saveChainDraft(); await h.render().saveChainDraft();
  assert.equal(h.calls.length, calls + 1); assert.deepEqual(h.calls.at(-1).args.config.chains[0].nodeIds, ["two", "one"]);
  h.calls.at(-1).reject(new Error("版本冲突")); await work; await h.flush();
  assert.equal(h.render().chainDraft.name, "新名称"); assert.equal(h.render().ready, false);
  h.render().refresh(); h.render(); h.calls.at(-1).resolve(h.snapshot()); await h.flush();
  work = h.render().saveChainDraft(); const next = h.calls.at(-1).args.config;
  h.calls.at(-1).resolve(h.snapshot(2, next)); await work; await h.flush();
  assert.equal(h.render().chainDraft, null); assert.equal(h.render().pool.nodes[0].enabled, false);
  h.render().requestDeleteChain("chain"); h.render().cancelDeleteChain();
  assert.equal(h.render().deleteChainId, null);
  h.render().requestDeleteChain("chain"); work = h.render().confirmDeleteChain();
  const removed = h.calls.at(-1).args.config; assert.deepEqual(removed.nodes, initial.nodes); assert.deepEqual(removed.chains, []);
  h.calls.at(-1).resolve(h.snapshot(3, removed)); await work; h.unmount();
});

test("链路测试不改变启用状态，凭据错误清除旧出口，隐藏后丢弃迟到结果", async t => {
  installControllerWindow(t);
  const initial = { ...pool(node()), chains: [{ id: "chain", name: "单跳", enabled: false, nodeIds: ["one"] }] };
  const h = fixture(initial); let work = (await h.ready()).testChain("chain");
  assert.deepEqual(h.calls.at(-1).args, { chainId: "chain" });
  const result = { chain: initial.chains[0], nodes: initial.nodes, result: { ...probe(node()).result, chainId: "chain" } };
  h.calls.at(-1).resolve(result); await work; await h.flush();
  assert.equal(h.render().chainRows[0].probe.exitIp, "203.0.113.5"); assert.equal(h.render().pool.chains[0].enabled, false);
  work = h.render().testChain("chain"); h.calls.at(-1).reject(new Error("凭据不可用")); await work; await h.flush();
  assert.equal(h.render().chainRows[0].probe.exitIp, null); assert.equal(h.render().chainRows[0].probe.errorCode, "resultUnavailable");
  work = h.render().testChain("chain"); h.options.active = false; h.render();
  h.calls.at(-1).resolve(result); await work; await h.flush();
  assert.equal(h.render().chainRows[0].probe.exitIp, null); h.unmount();
});

test("上游固定选择保护引用，拒绝禁用节点和不支持模式，解除选择需显式保存", () => {
  const current = { ...pool({ ...node(), enabled: true }), chains: [{ id: "chain", name: "出口", enabled: true, nodeIds: ["one"] }] };
  const profiles = [{ id: "route" }];
  const draft = { profileId: "route", original: { kind: "legacy" }, selection: { kind: "node", id: "one" } };
  const selected = upstream.prepareUpstreamSave(current, draft, profiles, true);
  assert.deepEqual(selected.upstreamByProfile.route, draft.selection);
  assert.throws(() => state.removeNodes(selected, ["one"]), /引用/);
  assert.throws(() => upstream.prepareUpstreamSave(selected, draft, profiles, true), /其他操作/);
  assert.throws(() => upstream.prepareUpstreamSave(current, draft, profiles, false), /本地路由/);
  assert.throws(() => upstream.prepareUpstreamSave(current, draft, [], true), /当前不可用/);
  assert.throws(() => upstream.prepareUpstreamSave(current, draft, [{ id: "route", pluginRouteSpec: { transport: {} } }], true), /自行联网/);
  assert.throws(() => upstream.prepareUpstreamSave(pool(node()), draft, profiles, true), /禁用/);
  const chainSelected = upstream.prepareUpstreamSave(current, { ...draft, selection: { kind: "chain", id: "chain" } }, profiles, true);
  assert.throws(() => upstream.removeChain(chainSelected, "chain"), /引用/);
  assert.match(upstream.upstreamProblem({ ...selected, nodes: [] }, draft.selection), /阻断/);
  const cleared = upstream.prepareUpstreamSave(selected, { ...draft, original: draft.selection, selection: { kind: "legacy" } }, [], false);
  assert.deepEqual(cleared.upstreamByProfile, {});
  assert.deepEqual(selected.upstreamByProfile.route, draft.selection);
  for (const selection of [{ kind: "legacy" }, { kind: "node", id: "a:b" }, { kind: "chain", id: "chain" }])
    assert.deepEqual(upstream.parseSelection(upstream.selectionKey(selection)), selection);
  assert.throws(() => upstream.parseSelection("automatic"), /无效/);
});

test("出口选择保存与其他编辑互斥，禁用节点后保留选择并显示阻断", async t => {
  installControllerWindow(t);
  const h = fixture(pool({ ...node(), enabled: true }));
  (await h.ready()).openUpstream("route");
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
    const draft = { profileId: id, original: { kind: "legacy" }, selection };
    assert.deepEqual(upstream.selectedUpstream(current, id), { kind: "legacy" });
    const selected = upstream.prepareUpstreamSave(current, draft, [{ id }], true);
    const restored = JSON.parse(JSON.stringify(selected));
    assert.equal(Object.prototype.hasOwnProperty.call(restored.upstreamByProfile, id), true);
    assert.deepEqual(upstream.selectedUpstream(restored, id), selection);
    assert.equal(Object.getPrototypeOf(selected.upstreamByProfile), Object.prototype);
    const cleared = upstream.prepareUpstreamSave(restored, { ...draft, original: selection, selection: { kind: "legacy" } }, [], false);
    assert.deepEqual(upstream.selectedUpstream(cleared, id), { kind: "legacy" });
    assert.equal(Object.prototype.hasOwnProperty.call(cleared.upstreamByProfile, id), false);
    assert.equal(state.currentProbe(current.nodes[0], {}), null);
    const ownProbe = { [id]: probe(current.nodes[0]) };
    assert.equal(state.currentProbe(current.nodes[0], ownProbe).stale, false);
    const chain = { id, name: id, enabled: true, nodeIds: [id] };
    assert.equal(chains.currentChainProbe(current, chain, {}), null);
    const chainProbes = { [id]: { chain, nodes: current.nodes, result: { ...probe(current.nodes[0]).result, chainId: id } } };
    assert.equal(chains.currentChainProbe(current, chain, chainProbes).stale, false);
  }
});

test("启动出口独立于线路配置，拒绝禁用或缺失出口，解除选择须显式保存", () => {
  const current = { ...pool({ ...node(), enabled: true }), chains: [{ id: "chain", name: "出口", enabled: true, nodeIds: ["one"] }], upstreamByProfile: { route: { kind: "node", id: "one" } } };
  const draft = { original: { kind: "legacy" }, selection: { kind: "chain", id: "chain" } };
  assert.deepEqual(processProxy.selectedProcessProxy(current), draft.original);
  const next = processProxy.prepareProcessProxySave(current, draft, true);
  assert.deepEqual(next.processProxy, draft.selection);
  assert.deepEqual(next.upstreamByProfile, current.upstreamByProfile);
  assert.throws(() => upstream.removeChain(next, "chain"), /启动出口/);
  assert.throws(() => processProxy.prepareProcessProxySave(next, draft, true), /其他操作/);
  assert.throws(() => processProxy.prepareProcessProxySave(current, draft, false), /宿主/);
  assert.throws(() => processProxy.prepareProcessProxySave({ ...current, chains: [] }, draft, true), /阻断/);
  assert.throws(() => processProxy.prepareProcessProxySave(pool(node()), { ...draft, selection: { kind: "node", id: "one" } }, true), /禁用/);
  assert.throws(() => state.removeNodes({ ...current, upstreamByProfile: {}, processProxy: { kind: "node", id: "one" } }, ["one"]), /启动出口/);
  const cleared = processProxy.prepareProcessProxySave(next, { original: draft.selection, selection: draft.original }, false);
  assert.equal(cleared.processProxy, undefined);
  assert.deepEqual(cleared.upstreamByProfile, current.upstreamByProfile);
});

test("启动出口保存与其他编辑互斥，失败保留草稿，禁用节点不清除选择", async t => {
  installControllerWindow(t);
  const h = fixture(pool({ ...node(), enabled: true }));
  (await h.ready()).openProcess(); h.render().changeProcess("node:one");
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
