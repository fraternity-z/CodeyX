import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { Config, ConfigSaveResult, ModelState, Notice, ProviderStatus, RuntimeStatus } from "../../App.types";
import { errorText } from "../../appUtils";
import type { useDraftConfig } from "../../useDraftConfig";
import { useStableEvent } from "../../useStableEvent";
import { configurationRequests } from "./requests";
import { configLoadNotice, configSaveNotice, UNKNOWN_FAST_CONTEXT_TOOLS_STATUS } from "./state";
import { validateSubagents } from "../subagents";
import type { ConfigLoadResult } from "./types";

const CONFIG_LOAD_TIMEOUT_MS = 30_000;

type Options = Pick<ReturnType<typeof useDraftConfig>,
  "config" | "persistedConfigRef" | "adoptRouteConfig" | "adoptSavedConfig" | "setDirty"
> & {
  active: boolean;
  isBusy: boolean;
  setBusy: Dispatch<SetStateAction<string | null>>;
  setNotice: (notice: Notice) => void;
  setProviderStatus: Dispatch<SetStateAction<ProviderStatus | null>>;
  setModelState: Dispatch<SetStateAction<ModelState>>;
  setStatus: Dispatch<SetStateAction<RuntimeStatus>>;
  refreshStatus: () => Promise<RuntimeStatus>;
  refreshStatusForLoad: () => Promise<RuntimeStatus | null>;
  refreshPluginMarketplaceStatus: (isCurrent: () => boolean) => Promise<void>;
};

export function useConfigurationController({ active, config, isBusy, persistedConfigRef,
  adoptRouteConfig, adoptSavedConfig, setDirty, setBusy, setNotice, setProviderStatus,
  setModelState, setStatus, refreshStatus, refreshStatusForLoad, refreshPluginMarketplaceStatus,
}: Options) {
  const [loadFailed, setLoadFailed] = useState(false);
  const [fastContextToolsStatus, setFastContextToolsStatus] = useState(UNKNOWN_FAST_CONTEXT_TOOLS_STATUS);
  const [revision, setRevision] = useState(0);
  const mounted = useRef(false);
  const session = useRef<object | null>(null);
  const readGeneration = useRef(0);
  const timers = useRef(new Set<number>());
  const loaded = useRef(false);
  const pending = useRef(false);
  const reconcile = useRef<{ submitted?: Config } | null>(null);
  const refreshPending = useRef(false);

  const invalidateReads = useCallback(() => {
    readGeneration.current++;
    timers.current.forEach(timer => window.clearTimeout(timer));
    timers.current.clear();
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; invalidateReads(); };
  }, [invalidateReads]);
  useEffect(() => {
    session.current = active ? {} : null;
    return () => { session.current = null; invalidateReads(); };
  }, [active, invalidateReads]);

  const load = useStableEvent(async () => {
    const scope = session.current;
    if (!active || !scope || !mounted.current) return;
    if (pending.current) { refreshPending.current = true; return; }
    refreshPending.current = false;
    invalidateReads();
    const generation = readGeneration.current;
    const current = () => mounted.current && session.current === scope && generation === readGeneration.current;
    const reconciliation = reconcile.current;
    setLoadFailed(false);
    let timer: number | undefined;
    try {
      const result = await new Promise<ConfigLoadResult>((resolve, reject) => {
        timer = window.setTimeout(() => reject(new Error("加载配置超时，请重新检查")), CONFIG_LOAD_TIMEOUT_MS);
        timers.current.add(timer);
        configurationRequests.load().then(resolve, reject);
      });
      if (timer !== undefined) { window.clearTimeout(timer); timers.current.delete(timer); }
      if (!current()) return;
      if (!result.providerStatus) throw new Error("未能读取当前服务配置，请重新检查");
      const merged = reconciliation?.submitted
        ? adoptSavedConfig(result.config, reconciliation.submitted)
        : adoptRouteConfig(result.config);
      if (!merged) return;
      setDirty(merged.dirty);
      setProviderStatus(result.providerStatus);
      setFastContextToolsStatus(result.fastContextToolsStatus ?? UNKNOWN_FAST_CONTEXT_TOOLS_STATUS);
      if (result.modelState) setModelState(result.modelState);
      if (typeof result.officialAccountAvailable === "boolean") {
        setStatus(previous => ({ ...previous, officialAccountAvailable: result.officialAccountAvailable }));
      }
      reconcile.current = null;
      if (reconciliation) {
        window.dispatchEvent(new CustomEvent("codey:config-changed", { detail: { config: result.config } }));
      }
      const [status] = await Promise.all([
        refreshStatusForLoad(),
        refreshPluginMarketplaceStatus(current),
      ]);
      if (!current()) return;
      loaded.current = true;
      const notice = configLoadNotice(result, status);
      if (notice) setNotice(notice);
    } catch (error) {
      if (current()) {
        setLoadFailed(true);
        setNotice({ tone: "error", text: errorText(error) });
      }
    } finally {
      if (timer !== undefined) { window.clearTimeout(timer); timers.current.delete(timer); }
    }
  });

  useEffect(() => {
    // 已载入配置的普通重开刷新由线路 controller 负责；这里补齐初始化和未确认保存。
    if (active && (!loaded.current || reconcile.current || refreshPending.current)) void load();
  }, [active, revision, load]);

  const applySavedConfig = useStableEvent((result: ConfigSaveResult, submitted?: Config) => {
    if (!mounted.current || !active || !session.current) return false;
    const merged = submitted ? adoptSavedConfig(result.config, submitted) : adoptRouteConfig(result.config);
    if (!merged) return false;
    invalidateReads();
    setDirty(merged.dirty);
    setFastContextToolsStatus(result.fastContextToolsStatus ?? UNKNOWN_FAST_CONTEXT_TOOLS_STATUS);
    window.dispatchEvent(new CustomEvent("codey:config-changed", { detail: { config: result.config } }));
    if (result.providerStatus) setProviderStatus(result.providerStatus);
    if (result.modelState) setModelState(result.modelState);
    if (typeof result.restartRequired === "boolean") {
      setStatus(previous => ({ ...previous, restartRequired: result.restartRequired }));
    }
    // 保存结果已包含配置、模型和重启状态；其余运行状态在后台补充。
    void refreshStatus().catch(() => undefined);
    return true;
  });

  const persist = useStableEvent(async (next: Config): Promise<ConfigSaveResult> => {
    const subagentError = validateSubagents(next);
    if (subagentError) throw new Error(subagentError);
    const scope = session.current;
    if (!mounted.current || !active || !scope) throw new Error("设置页面已关闭，请重新打开后保存");
    if (pending.current) throw new Error("配置正在保存，请等待完成");
    if (reconcile.current) throw new Error("配置保存结果尚未确认，请重新打开设置读取后再保存");
    const submitted = config ?? next;
    pending.current = true;
    invalidateReads();
    const current = () => mounted.current && session.current === scope;
    try {
      const result = await configurationRequests.save(next);
      if (current()) applySavedConfig(result, submitted);
      else reconcile.current = { submitted };
      return result;
    } catch (error) {
      if (!current()) reconcile.current = {};
      throw error;
    } finally {
      pending.current = false;
      if (mounted.current && (reconcile.current || refreshPending.current)) setRevision(value => value + 1);
    }
  });

  const saveCurrent = useStableEvent(async () => {
    const scope = session.current;
    if (!mounted.current || !active || !scope || !config || isBusy || pending.current) return;
    const current = () => mounted.current && session.current === scope;
    const retryCountChanged = persistedConfigRef.current?.streamMaxRetries !== config.streamMaxRetries;
    setBusy("save");
    try {
      const result = await persist(config);
      if (current() && persistedConfigRef.current?.settingsRevision === result.config.settingsRevision) {
        setNotice(configSaveNotice(result, retryCountChanged));
      }
    } catch (error) {
      if (current()) setNotice({ tone: "error", text: errorText(error) });
    } finally {
      if (mounted.current) setBusy(value => value === "save" ? null : value);
    }
  });

  return { load, loadFailed, fastContextToolsStatus, persist, applySavedConfig, saveCurrent };
}
