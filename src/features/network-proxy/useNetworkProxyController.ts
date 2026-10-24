import { useEffect, useState } from "react";
import type { Config, ConfigSaveResult, Profile } from "../../App.types";
import { errorText } from "../../appUtils";
import { useOperationScope } from "../../useOperationScope";
import { useStableEvent } from "../../useStableEvent";
import { validateCodexLaunchProxy } from "../../urlValidation";
import { networkProxyRequests } from "./requests";
import { currentProbe, EMPTY_POOL, INITIAL_FILTER, prepareNodeSave, proxyDraft, removeNodes, validateDraft, visibleNodes } from "./state";
import type { CredentialUpdate, NetworkProxyConfig, PoolFilter, PoolSnapshot, ProbeSnapshot, ProcessProxyDraft, ProxyDraft, UpstreamDraft } from "./types";
import { parseSelection, prepareUpstreamSave, selectedUpstream, upstreamEnabled, upstreamLabel, upstreamProblem } from "./upstream";
import { prepareProcessProxySave, selectedProcessProxy } from "./process";

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
  const [upstreamDraft, setUpstreamDraft] = useState<UpstreamDraft | null>(null);
  const [processDraft, setProcessDraft] = useState<ProcessProxyDraft | null>(null);
  const [launchProxyPoolSupported, setLaunchProxyPoolSupported] = useState(false);
  const [trafficCaptureSupported, setTrafficCaptureSupported] = useState(false);
  const [trafficCaptureAvailable, setTrafficCaptureAvailable] = useState(false);
  const [savedProfiles, setSavedProfiles] = useState<Profile[]>([]);
  const [routerEnabled, setRouterEnabled] = useState(false);
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
  const editing = Boolean(draft || upstreamDraft || processDraft);
  const processSelection = selectedProcessProxy(pool);
  const upstreamRows = [...new Set([...savedProfiles.map(profile => profile.id), ...Object.keys(pool.upstreamByProfile ?? {})])].map(id => {
    const profile = savedProfiles.find(profile => profile.id === id);
    const selection = selectedUpstream(pool, id);
    const node = selection.kind === "node" ? pool.nodes.find(node => node.id === selection.id) : undefined;
    const enabled = upstreamEnabled(pool, id);
    const probe = enabled && node ? currentProbe(node, probes) : null;
    return { id, profile, label: profile?.name || profile?.shortName || id, selection,
      enabled, selectedLabel: upstreamLabel(pool, selection), problem: enabled ? selection.kind === "legacy" ? "未选择代理池节点，新请求将被阻断" : upstreamProblem(pool, selection) : "", probe };
  });
  const rows = visibleNodes(pool, filter, probes).map(node => ({ node, probe: currentProbe(node, probes) }));
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
    setSelected([]); setDeleteIds([]); setNotice("代理池已保存");
    return true;
  }
  const openNode = (id?: string) => {
    if (!available || editing) return;
    const node = id ? pool.nodes.find(value => value.id === id) : undefined;
    if (id && !node) return;
    setDraft(proxyDraft(id ?? crypto.randomUUID(), node)); setError(""); setNotice(""); setDeleteIds([]);
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
    try { removeNodes(pool, ids); setDeleteIds(ids); setError(""); }
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
  const openUpstream = (profileId: string, enabled = upstreamEnabled(pool, profileId)) => {
    if (!available || editing) return;
    const original = selectedUpstream(pool, profileId);
    setUpstreamDraft({ profileId, original, selection: original, originalEnabled: upstreamEnabled(pool, profileId), enabled }); setError(""); setNotice(""); setDeleteIds([]);
  };
  const changeUpstream = (value: string) => {
    if (!active || remote || scope.pending || isBusy) return;
    setUpstreamDraft(previous => previous ? { ...previous, selection: parseSelection(value) } : null);
  };
  const cancelUpstream = () => { if (!scope.pending) setUpstreamDraft(null); };
  const changeUpstreamEnabled = (enabled: boolean) => {
    if (!active || remote || scope.pending || isBusy) return;
    setUpstreamDraft(previous => previous ? { ...previous, enabled } : null);
  };
  const saveUpstream = () => run("save-upstream", async current => {
    if (!upstreamDraft) return;
    if (await persist(prepareUpstreamSave(pool, upstreamDraft, savedProfiles, routerEnabled), [], current)) {
      setUpstreamDraft(null); setNotice("线路出口已保存，后续请求使用新选择；正在传输的响应继续使用原出口");
    }
  });
  const openProcess = (enabled = processSelection.kind !== "legacy") => {
    if (!available || editing) return;
    setProcessDraft({ original: processSelection, selection: processSelection, enabled, originalCapture: Boolean(pool.processCapture), capture: enabled && Boolean(pool.processCapture) }); setError(""); setNotice(""); setDeleteIds([]);
  };
  const changeProcess = (value: string) => {
    if (!active || remote || scope.pending || isBusy) return;
    setProcessDraft(previous => previous ? { ...previous, selection: parseSelection(value), capture: parseSelection(value).kind === "legacy" ? false : previous.capture } : null);
  };
  const changeProcessCapture = (capture: boolean) => {
    if (!active || remote || scope.pending || isBusy) return;
    setProcessDraft(previous => previous ? { ...previous, capture } : null);
  };
  const changeProcessEnabled = (enabled: boolean) => {
    if (!active || remote || scope.pending || isBusy) return;
    setProcessDraft(previous => previous ? { ...previous, enabled, capture: enabled && previous.capture } : null);
  };
  const cancelProcess = () => { if (!scope.pending) setProcessDraft(null); };
  const saveProcess = () => run("save-process", async current => {
    if (!processDraft) return;
    if (await persist(prepareProcessProxySave(pool, processDraft, launchProxyPoolSupported, trafficCaptureSupported), [], current)) {
      setProcessDraft(null); setNotice("Codex 启动出口已保存，重启 Codex 后应用；各线路的上游出口保持各自选择");
    }
  });
  let upstreamDraftError = "";
  if (upstreamDraft) { try { prepareUpstreamSave(pool, upstreamDraft, savedProfiles, routerEnabled); } catch (cause) { upstreamDraftError = errorText(cause); } }
  let processDraftError = "";
  if (processDraft) { try { prepareProcessProxySave(pool, processDraft, launchProxyPoolSupported, trafficCaptureSupported); } catch (cause) { processDraftError = errorText(cause); } }
  return { launchProxy, launchProxyError, changeLaunchProxy, pool, draft, draftError: draft ? validateDraft(draft) : "",
    filter, changeFilter, rows, selectedIds, toggleSelected, deleteIds, requestDelete, cancelDelete, confirmDelete,
    openNode, changeDraft, cancelDraft, saveDraft, setEnabled, testNode, probeUrl, busy, loading, ready, error, notice,
    editing, upstreamRows, upstreamDraft, upstreamDraftError, openUpstream, changeUpstream, changeUpstreamEnabled, cancelUpstream, saveUpstream, routerEnabled,
    processSelection, processLabel: processSelection.kind === "legacy" ? "手动启动地址或原有网络环境" : upstreamLabel(pool, processSelection),
    processProblem: upstreamProblem(pool, processSelection), processDraft, processDraftError,
    openProcess, changeProcess, changeProcessEnabled, changeProcessCapture, cancelProcess, saveProcess, launchProxyPoolSupported, trafficCaptureSupported, trafficCaptureAvailable,
    disabled: !available, draftDisabled: !active || remote || isBusy || scope.pending, remote, refresh };
}
