import { useEffect, useState } from "react";
import type { Config, ConfigSaveResult, Profile } from "../../App.types";
import { errorText } from "../../appUtils";
import { useOperationScope } from "../../useOperationScope";
import { useStableEvent } from "../../useStableEvent";
import { validateCodexLaunchProxy } from "../../urlValidation";
import { networkProxyRequests } from "./requests";
import { chainDraft as createChainDraft, currentChainProbe, moveChainNode, prepareChainSave, validateChainDraft } from "./chains";
import { currentProbe, EMPTY_POOL, INITIAL_FILTER, prepareNodeSave, proxyDraft, removeNodes, validateDraft, visibleNodes } from "./state";
import type { ChainDraft, ChainProbeSnapshot, CredentialUpdate, NetworkProxyConfig, PolicyDraft, PoolFilter, PoolSnapshot, ProbeSnapshot, ProcessProxyDraft, ProxyDraft, UpstreamDraft } from "./types";
import { parseSelection, prepareUpstreamSave, removeChain, selectedUpstream, upstreamLabel, upstreamProblem } from "./upstream";
import { prepareProcessProxySave, selectedProcessProxy } from "./process";
import { policyDraft as createPolicyDraft, preparePolicySave, removePolicy, ruleDraft, validatePolicyDraft } from "./policies";

type Options = {
  active: boolean;
  config: Config;
  isBusy: boolean;
  onConfigChange: (config: Config) => void;
  onSaved: (result: ConfigSaveResult) => boolean;
  remote?: boolean;
};

export function useNetworkProxyController({ active, config, isBusy, onConfigChange, onSaved, remote = false }: Options) {
  const launchProxy = config.codexLaunchProxy ?? "";
  const launchProxyError = validateCodexLaunchProxy(launchProxy);
  const pool = config.networkProxy ?? EMPTY_POOL;
  const [draft, setDraft] = useState<ProxyDraft | null>(null);
  const [chainDraft, setChainDraft] = useState<ChainDraft | null>(null);
  const [upstreamDraft, setUpstreamDraft] = useState<UpstreamDraft | null>(null);
  const [processDraft, setProcessDraft] = useState<ProcessProxyDraft | null>(null);
  const [policyDraft, setPolicyDraft] = useState<PolicyDraft | null>(null);
  const [deletePolicyId, setDeletePolicyId] = useState<string | null>(null);
  const [launchProxyPoolSupported, setLaunchProxyPoolSupported] = useState(false);
  const [trafficCaptureSupported, setTrafficCaptureSupported] = useState(false);
  const [trafficCaptureAvailable, setTrafficCaptureAvailable] = useState(false);
  const [savedProfiles, setSavedProfiles] = useState<Profile[]>([]);
  const [routerEnabled, setRouterEnabled] = useState(false);
  const [chainProbes, setChainProbes] = useState<Record<string, ChainProbeSnapshot>>({});
  const [deleteChainId, setDeleteChainId] = useState<string | null>(null);
  const [filter, setFilter] = useState<PoolFilter>(INITIAL_FILTER);
  const [selected, setSelected] = useState<string[]>([]);
  const [deleteIds, setDeleteIds] = useState<string[]>([]);
  const [probes, setProbes] = useState<Record<string, ProbeSnapshot>>({});
  const [probeUrl, setProbeUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const scope = useOperationScope(active && !remote);
  const adopt = useStableEvent((snapshot: PoolSnapshot) => {
    if (!onSaved(snapshot)) return false;
    setProbeUrl(snapshot.probeUrl);
    setSavedProfiles(snapshot.config.profiles);
    setRouterEnabled(snapshot.config.localRouterEnabled);
    setLaunchProxyPoolSupported(snapshot.launchProxyPoolSupported === true);
    setTrafficCaptureSupported(snapshot.trafficCaptureSupported === true);
    setTrafficCaptureAvailable(snapshot.trafficCaptureAvailable === true);
    setReady(true);
    return true;
  });
  useEffect(() => {
    if (!active || remote || scope.pending) return;
    let cancelled = false;
    const valid = scope.read();
    const current = () => !cancelled && valid();
    setLoading(true);
    setReady(false);
    void networkProxyRequests.load().then(snapshot => {
      if (!current()) return;
      if (adopt(snapshot)) setError("");
      else setError("读取到的配置已过期，请刷新后继续");
    }).catch(cause => { if (current()) setError(errorText(cause)); })
      .finally(() => { if (current()) setLoading(false); });
    return () => { cancelled = true; };
  }, [active, remote, refreshEpoch, scope, adopt]);

  const available = active && !remote && !isBusy && ready && !scope.pending && !loading;
  const editing = Boolean(draft || chainDraft || upstreamDraft || processDraft || policyDraft);
  const processSelection = selectedProcessProxy(pool);
  const upstreamRows = [...new Set([...savedProfiles.map(profile => profile.id), ...Object.keys(pool.upstreamByProfile ?? {})])].map(id => {
    const profile = savedProfiles.find(profile => profile.id === id);
    const selection = selectedUpstream(pool, id);
    const node = selection.kind === "node" ? pool.nodes.find(node => node.id === selection.id) : undefined;
    const chain = selection.kind === "chain" ? pool.chains.find(chain => chain.id === selection.id) : undefined;
    const probe = node ? currentProbe(node, probes) : chain ? currentChainProbe(pool, chain, chainProbes) : null;
    return { id, profile, label: profile?.name || profile?.shortName || id, selection,
      selectedLabel: upstreamLabel(pool, selection), problem: upstreamProblem(pool, selection), probe };
  });
  const rows = visibleNodes(pool, filter, probes).map(node => ({ node, probe: currentProbe(node, probes) }));
  const chainRows = pool.chains.map(chain => ({ chain, probe: currentChainProbe(pool, chain, chainProbes) }));
  const selectedIds = selected.filter(id => pool.nodes.some(node => node.id === id));
  const changeLaunchProxy = useStableEvent((value: string) => {
    if (!active || isBusy) return;
    onConfigChange({ ...config, codexLaunchProxy: value });
  });
  const refresh = () => {
    if (!active || remote || scope.pending || isBusy) return;
    scope.invalidateReads();
    setReady(false);
    setRefreshEpoch(value => value + 1);
  };
  async function run(name: string, operation: (current: () => boolean) => Promise<void>) {
    if (!available) return;
    const token = scope.begin();
    if (!token) return;
    setBusy(name); setError(""); setNotice("");
    try { await operation(token.current); }
    catch (cause) { if (token.current()) setError(errorText(cause)); }
    finally {
      const wasCurrent = token.current();
      if (token.finish()) {
        setBusy(null);
        // A hidden write keeps its lock until completion; only a fresh read may adopt its result.
        if (!wasCurrent) { setReady(false); setRefreshEpoch(value => value + 1); }
      }
    }
  }
  async function persist(next: NetworkProxyConfig, credentials: CredentialUpdate[], current: () => boolean) {
    let snapshot: PoolSnapshot;
    try { snapshot = await networkProxyRequests.save(config.settingsRevision, next, credentials); }
    catch (cause) {
      // A transport timeout does not cancel a disk/vault write. Require reload before retry.
      if (current()) setReady(false);
      throw cause;
    }
    if (!current()) return false;
    if (!adopt(snapshot)) { setReady(false); throw new Error("保存结果晚于其他操作，请刷新后确认当前配置"); }
    setSelected([]); setDeleteIds([]); setDeleteChainId(null); setDeletePolicyId(null); setNotice("代理池已保存");
    return true;
  }
  const openNode = (id?: string) => {
    if (!available || editing) return;
    const node = id ? pool.nodes.find(value => value.id === id) : undefined;
    if (id && !node) return;
    setDraft(proxyDraft(id ?? crypto.randomUUID(), node)); setError(""); setNotice(""); setDeleteIds([]); setDeleteChainId(null); setDeletePolicyId(null);
  };
  const changeDraft = <K extends keyof ProxyDraft>(key: K, value: ProxyDraft[K]) => {
    if (!active || remote || scope.pending || isBusy) return;
    setDraft(previous => previous ? { ...previous, [key]: value,
      ...(key === "protocol" && value !== "socks5" ? { dns: "remote" as const } : {}),
      ...(key === "authentication" ? { username: "", password: "" } : {}),
    } : previous);
  };
  const cancelDraft = () => { if (!scope.pending) setDraft(null); };
  const saveDraft = () => run("save", async current => {
    if (!draft) return;
    const prepared = prepareNodeSave(pool, draft);
    if (await persist(prepared.config, prepared.credentials, current)) setDraft(null);
  });
  const setEnabled = (ids: string[], enabled: boolean) => run("enable", async current => {
    if (editing || !ids.length) return;
    await persist({ ...pool, nodes: pool.nodes.map(node => ids.includes(node.id) ? { ...node, enabled } : node) }, [], current);
  });
  const requestDelete = (ids: string[]) => {
    if (!available || editing || !ids.length) return;
    try { removeNodes(pool, ids); setDeleteIds(ids); setDeleteChainId(null); setDeletePolicyId(null); setError(""); }
    catch (cause) { setError(errorText(cause)); }
  };
  const cancelDelete = () => { if (!scope.pending) setDeleteIds([]); };
  const confirmDelete = () => run("delete", async current => {
    if (!deleteIds.length || editing) return;
    await persist(removeNodes(pool, deleteIds), [], current);
  });
  const testNode = (id: string) => run(`test:${id}`, async current => {
    const node = pool.nodes.find(node => node.id === id);
    if (!node) return;
    const started = performance.now();
    let snapshot: ProbeSnapshot;
    try { snapshot = await networkProxyRequests.test(id); }
    catch (cause) {
      // Missing credentials or a lost IPC response must replace the previous
      // success, without interpreting an unknown result as a health verdict.
      snapshot = { node, result: { nodeId: id, success: false, testedAt: new Date().toISOString(),
        elapsedMs: Math.round(performance.now() - started), exitIp: null, errorCode: "resultUnavailable",
        message: `未能取得测试结果：${errorText(cause)}` } };
    }
    if (current()) setProbes(previous => ({ ...previous, [id]: snapshot }));
  });
  const toggleSelected = (id: string) => {
    if (!available || editing) return;
    setSelected(previous => previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id]);
  };
  const changeFilter = <K extends keyof PoolFilter>(key: K, value: PoolFilter[K]) => {
    setFilter(previous => ({ ...previous, [key]: value })); setSelected([]); setDeleteIds([]);
  };
  const openChain = (id?: string) => {
    if (!available || editing) return;
    const chain = id ? pool.chains.find(chain => chain.id === id) : undefined;
    if (id && !chain) return;
    setChainDraft(createChainDraft(id ?? crypto.randomUUID(), chain)); setDeleteIds([]); setDeleteChainId(null); setDeletePolicyId(null); setError(""); setNotice("");
  };
  const changeChainDraft = <K extends "name" | "enabled" | "nodeIds">(key: K, value: ChainDraft[K]) => {
    if (!active || remote || scope.pending || isBusy) return;
    setChainDraft(previous => previous ? { ...previous, [key]: value } : null);
  };
  const moveHop = (index: number, direction: -1 | 1) => {
    if (chainDraft) changeChainDraft("nodeIds", moveChainNode(chainDraft.nodeIds, index, direction));
  };
  const cancelChainDraft = () => { if (!scope.pending) setChainDraft(null); };
  const saveChainDraft = () => run("save-chain", async current => {
    if (!chainDraft) return;
    if (await persist(prepareChainSave(pool, chainDraft), [], current)) { setChainDraft(null); setNotice("代理链路已保存"); }
  });
  const setChainEnabled = (id: string, enabled: boolean) => run("enable-chain", async current => {
    if (editing) return;
    await persist({ ...pool, chains: pool.chains.map(chain => chain.id === id ? { ...chain, enabled } : chain) }, [], current);
  });
  const requestDeleteChain = (id: string) => {
    if (!available || editing || !pool.chains.some(chain => chain.id === id)) return;
    try { removeChain(pool, id); setDeleteChainId(id); setDeleteIds([]); setDeletePolicyId(null); setError(""); }
    catch (cause) { setError(errorText(cause)); }
  };
  const cancelDeleteChain = () => { if (!scope.pending) setDeleteChainId(null); };
  const confirmDeleteChain = () => run("delete-chain", async current => {
    if (!deleteChainId || editing) return;
    await persist(removeChain(pool, deleteChainId), [], current);
  });
  const testChain = (id: string) => run(`test-chain:${id}`, async current => {
    const chain = pool.chains.find(chain => chain.id === id);
    if (!chain) return;
    const nodes = chain.nodeIds.map(id => pool.nodes.find(node => node.id === id)).filter(node => node !== undefined);
    const started = performance.now();
    let snapshot: ChainProbeSnapshot;
    try { snapshot = await networkProxyRequests.testChain(id); }
    catch (cause) {
      snapshot = { chain, nodes, result: { chainId: id, success: false, testedAt: new Date().toISOString(),
        elapsedMs: Math.round(performance.now() - started), exitIp: null, errorCode: "resultUnavailable",
        message: `未能取得测试结果：${errorText(cause)}` } };
    }
    if (current()) setChainProbes(previous => ({ ...previous, [id]: snapshot }));
  });
  const openUpstream = (profileId: string) => {
    if (!available || editing) return;
    const original = selectedUpstream(pool, profileId);
    setUpstreamDraft({ profileId, original, selection: original }); setError(""); setNotice(""); setDeleteIds([]); setDeleteChainId(null); setDeletePolicyId(null);
  };
  const changeUpstream = (value: string) => {
    if (!active || remote || scope.pending || isBusy) return;
    setUpstreamDraft(previous => previous ? { ...previous, selection: parseSelection(value) } : null);
  };
  const cancelUpstream = () => { if (!scope.pending) setUpstreamDraft(null); };
  const saveUpstream = () => run("save-upstream", async current => {
    if (!upstreamDraft) return;
    if (await persist(prepareUpstreamSave(pool, upstreamDraft, savedProfiles, routerEnabled), [], current)) {
      setUpstreamDraft(null); setNotice("线路出口已保存，后续请求使用新选择；正在传输的响应继续使用原出口");
    }
  });
  const openProcess = () => {
    if (!available || editing) return;
    setProcessDraft({ original: processSelection, selection: processSelection, originalCapture: Boolean(pool.processCapture), capture: Boolean(pool.processCapture) }); setError(""); setNotice(""); setDeleteIds([]); setDeleteChainId(null); setDeletePolicyId(null);
  };
  const changeProcess = (value: string) => {
    if (!active || remote || scope.pending || isBusy) return;
    setProcessDraft(previous => previous ? { ...previous, selection: parseSelection(value), capture: parseSelection(value).kind === "legacy" ? false : previous.capture } : null);
  };
  const changeProcessCapture = (capture: boolean) => {
    if (!active || remote || scope.pending || isBusy) return;
    setProcessDraft(previous => previous ? { ...previous, capture } : null);
  };
  const cancelProcess = () => { if (!scope.pending) setProcessDraft(null); };
  const saveProcess = () => run("save-process", async current => {
    if (!processDraft) return;
    if (await persist(prepareProcessProxySave(pool, processDraft, launchProxyPoolSupported, trafficCaptureSupported), [], current)) {
      setProcessDraft(null); setNotice("Codex 启动出口已保存，重启 Codex 后应用；各线路的上游出口保持各自选择");
    }
  });
  const openPolicy = (id?: string) => {
    if (!available || editing) return;
    const policy = id ? pool.policies?.find(policy => policy.id === id) : undefined;
    if (id && !policy) return;
    setPolicyDraft(createPolicyDraft(id ?? crypto.randomUUID(), policy)); setDeleteIds([]); setDeleteChainId(null); setDeletePolicyId(null); setError(""); setNotice("");
  };
  const changePolicy = <K extends "name" | "enabled" | "allowDirect" | "rules" | "defaultAction">(key: K, value: PolicyDraft[K]) => {
    if (!active || remote || scope.pending || isBusy) return;
    setPolicyDraft(previous => previous ? { ...previous, [key]: value } : null);
  };
  const addRule = () => { if (policyDraft && policyDraft.rules.length < 64) changePolicy("rules", [...policyDraft.rules, ruleDraft(crypto.randomUUID())]); };
  const moveRule = (index: number, direction: -1 | 1) => {
    if (!policyDraft) return;
    const next = [...policyDraft.rules], target = index + direction;
    if (index < 0 || index >= next.length || target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]]; changePolicy("rules", next);
  };
  const cancelPolicy = () => { if (!scope.pending) setPolicyDraft(null); };
  const savePolicy = () => run("save-policy", async current => {
    if (!policyDraft) return;
    if (await persist(preparePolicySave(pool, policyDraft), [], current)) {
      setPolicyDraft(null); setNotice("出口策略已保存；绑定此策略的后续连接按新规则处理，现有连接继续使用原出口");
    }
  });
  const setPolicyEnabled = (id: string, enabled: boolean) => run("enable-policy", async current => {
    if (editing) return;
    await persist({ ...pool, policies: (pool.policies ?? []).map(policy => policy.id === id ? { ...policy, enabled } : policy) }, [], current);
  });
  const requestDeletePolicy = (id: string) => {
    if (!available || editing || !pool.policies?.some(policy => policy.id === id)) return;
    try { removePolicy(pool, id); setDeletePolicyId(id); setDeleteIds([]); setDeleteChainId(null); setError(""); }
    catch (cause) { setError(errorText(cause)); }
  };
  const cancelDeletePolicy = () => { if (!scope.pending) setDeletePolicyId(null); };
  const confirmDeletePolicy = () => run("delete-policy", async current => {
    if (deletePolicyId && !editing) await persist(removePolicy(pool, deletePolicyId), [], current);
  });
  let upstreamDraftError = "";
  if (upstreamDraft) { try { prepareUpstreamSave(pool, upstreamDraft, savedProfiles, routerEnabled); } catch (cause) { upstreamDraftError = errorText(cause); } }
  let processDraftError = "";
  if (processDraft) { try { prepareProcessProxySave(pool, processDraft, launchProxyPoolSupported, trafficCaptureSupported); } catch (cause) { processDraftError = errorText(cause); } }
  return { launchProxy, launchProxyError, changeLaunchProxy, pool, draft, draftError: draft ? validateDraft(draft) : "",
    filter, changeFilter, rows, selectedIds, toggleSelected, deleteIds, requestDelete, cancelDelete, confirmDelete,
    openNode, changeDraft, cancelDraft, saveDraft, setEnabled, testNode, probeUrl, busy, loading, ready, error, notice,
    editing, chainDraft, chainDraftError: chainDraft ? validateChainDraft(pool, chainDraft) : "", chainRows,
    openChain, changeChainDraft, moveHop, cancelChainDraft, saveChainDraft, setChainEnabled, testChain,
    deleteChainId, requestDeleteChain, cancelDeleteChain, confirmDeleteChain,
    upstreamRows, upstreamDraft, upstreamDraftError, openUpstream, changeUpstream, cancelUpstream, saveUpstream, routerEnabled,
    processSelection, processLabel: processSelection.kind === "legacy" ? "手动启动地址或原有网络环境" : upstreamLabel(pool, processSelection),
    processProblem: upstreamProblem(pool, processSelection), processDraft, processDraftError,
    openProcess, changeProcess, changeProcessCapture, cancelProcess, saveProcess, launchProxyPoolSupported, trafficCaptureSupported, trafficCaptureAvailable,
    policyDraft, policyDraftError: policyDraft ? validatePolicyDraft(pool, policyDraft) : "", openPolicy, changePolicy, addRule, moveRule, cancelPolicy, savePolicy, setPolicyEnabled,
    deletePolicyId, requestDeletePolicy, cancelDeletePolicy, confirmDeletePolicy,
    disabled: !available, draftDisabled: !active || remote || isBusy || scope.pending, remote, refresh };
}
