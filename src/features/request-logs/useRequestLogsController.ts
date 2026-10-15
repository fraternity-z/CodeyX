import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OfficialAccount } from "../../App.types";
import { errorText } from "../../appUtils";
import { formatRouteName } from "../../routeShortNames";
import { maskEmail } from "../../sensitiveText";
import type { LogAnalytics } from "../../usageAnalysis";
import { requestLogs } from "./requests";
import type { ActionNotice, LogCursor, RequestLogCatalog, RequestLogFilters, RouteRequestLogQueryPage } from "./types";

const initialFilters = {
  provider: "all", officialAccount: "all", model: "all", status: "all",
  protocol: "all", requestKind: "all", searchMode: "contains", search: "",
  timeRange: "24h", customFrom: "", customTo: "",
};

export function useRequestLogsController(catalog: RequestLogCatalog, opened: boolean) {
  const [selection, setSelection] = useState(initialFilters);
  const { provider, officialAccount, model, status, protocol, requestKind, searchMode, search, timeRange, customFrom, customTo } = selection;
  const [searchInput, setSearchInput] = useState("");
  const [pageSize, setPageSize] = useState(20);
  const [pageJumpInput, setPageJumpInput] = useState("1");
  const [groupBy, setGroupBy] = useState("model");
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [officialAccounts, setOfficialAccounts] = useState<OfficialAccount[]>([]);
  const [usedModels, setUsedModels] = useState<string[]>([]);
  const [modelsCatalogNeeded, setModelsCatalogNeeded] = useState(false);
  const [result, setResult] = useState<RouteRequestLogQueryPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [stats, setStats] = useState<LogAnalytics | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState("");
  const [clearConfirmationOpened, setClearConfirmationOpened] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [actionNotice, setActionNotice] = useState<ActionNotice | null>(null);
  const listTask = useRef(Promise.resolve());
  const statsTask = useRef(Promise.resolve());
  const modelsTask = useRef(Promise.resolve());
  const clearInFlight = useRef(false);
  const dataRevision = useRef(0);
  const lifecycle = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => () => { lifecycle.current++; }, [opened]);

  const rangeEnd = useMemo(() => Date.now(), [opened, refreshRevision, timeRange, customTo]);
  const toUnixMs = timeRange === "custom" ? new Date(customTo).getTime() : rangeEnd;
  const fromUnixMs = timeRange === "custom" ? new Date(customFrom).getTime()
    : toUnixMs - ({ "24h": 1, "7d": 7, "30d": 30 }[timeRange] ?? 1) * 86_400_000;
  const validRange = Number.isFinite(fromUnixMs) && Number.isFinite(toUnixMs)
    && fromUnixMs >= 0 && fromUnixMs < toUnixMs && toUnixMs - fromUnixMs <= 366 * 86_400_000;
  const filters = useMemo<RequestLogFilters>(() => ({
    cursorMode: true, fromUnixMs, toUnixMs,
    ...(search ? { [searchMode === "requestId" ? "requestId" : searchMode === "sessionId" ? "sessionId" : "search"]: search } : {}),
    ...(provider !== "all" ? { provider } : {}),
    ...(officialAccount !== "all" ? { officialAccountId: officialAccount } : {}),
    ...(model !== "all" ? { model } : {}),
    ...(status !== "all" ? { status } : {}),
    ...(protocol !== "all" ? { protocol } : {}),
    ...(requestKind !== "all" ? { requestKind } : {}),
  }), [fromUnixMs, toUnixMs, search, searchMode, provider, officialAccount, model, status, protocol, requestKind]);

  // 页码和游标只属于同一查询快照；重开或刷新改变窗口时，第一轮渲染就回到首页。
  const paginationKey = JSON.stringify([filters, pageSize, refreshRevision]);
  const [pagination, setPagination] = useState({ key: "", page: 1, cursors: {} as Record<number, LogCursor> });
  const page = pagination.key === paginationKey ? pagination.page : 1;
  const cursor = page === 1 ? null : pagination.cursors[page] ?? null;
  useEffect(() => { setPageJumpInput(String(page)); }, [paginationKey, page]);

  const changeFilter = <K extends keyof typeof initialFilters>(key: K, value: typeof initialFilters[K]) => {
    setSelection((current) => ({ ...current, [key]: value }));
  };
  const changePageSize = (value: number) => {
    if ([20, 50, 100].includes(value)) setPageSize(value);
  };
  useEffect(() => {
    const nextSearch = searchInput.trim();
    if (nextSearch === search) return;
    const timer = window.setTimeout(() => {
      setSelection((current) => ({ ...current, search: nextSearch }));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchInput, search]);

  const providerOptions = useMemo(() => {
    const providers = new Map<string, string>();
    for (const profile of catalog.profiles) {
      const value = profile.sourceProviderId || profile.id;
      if (value) providers.set(value, formatRouteName(profile.name, profile.shortName || "") || value);
    }
    return [{ label: "全部供应商", value: "all" }, ...[...providers].map(([value, label]) => ({ label, value }))];
  }, [catalog.profiles]);
  const officialRoutesPresent = catalog.officialAccountAvailable === true
    || catalog.profiles.some((profile) => profile.officialAccount || Boolean(profile.officialAccountId));
  useEffect(() => {
    if (!opened) return;
    if (!officialRoutesPresent) { setOfficialAccounts([]); return; }
    let active = true;
    void requestLogs.accounts().then(
      (next) => { if (active) setOfficialAccounts(next.accounts ?? []); },
      () => { if (active) setOfficialAccounts([]); },
    );
    return () => { active = false; };
  }, [opened, officialRoutesPresent]);
  const officialAccountLabels = useMemo(() => new Map(officialAccounts.map((account) => {
    const email = account.email?.trim();
    return [account.id, email ? maskEmail(email) : account.routeName?.trim() || account.id];
  })), [officialAccounts]);
  const officialAccountOptions = useMemo(() => [
    { label: "全部官方账号", value: "all" },
    ...officialAccounts.map((account) => ({
      label: `${officialAccountLabels.get(account.id) ?? account.id}${account.isDefault ? "（默认）" : ""}`,
      value: account.id,
    })),
  ], [officialAccounts, officialAccountLabels]);
  const officialAccountLabel = useCallback((accountId?: string | null) =>
    accountId ? officialAccountLabels.get(accountId) ?? accountId : "—", [officialAccountLabels]);
  const modelOptions = useMemo(() => {
    const models = new Set<string>(usedModels);
    result?.items?.forEach((item) => {
      const name = item.model?.trim() || item.requestedModel?.trim();
      if (name) models.add(name);
    });
    if (model !== "all" && model.trim()) models.add(model.trim());
    return [{ label: "全部模型", value: "all" }, ...[...models].sort((a, b) => a.localeCompare(b)).map((value) => ({ label: value, value }))];
  }, [usedModels, result?.items, model]);

  useEffect(() => {
    if (!opened || !validRange || clearing || (!modelsCatalogNeeded && model === "all")) return;
    let active = true;
    const revision = dataRevision.current;
    const current = () => active && revision === dataRevision.current;
    setUsedModels([]);
    modelsTask.current = modelsTask.current.then(async () => {
      if (!current()) return;
      try {
        const models = await requestLogs.models({ fromUnixMs, toUnixMs,
          ...(provider !== "all" ? { provider } : {}),
          ...(officialAccount !== "all" ? { officialAccountId: officialAccount } : {}),
        }, current);
        if (current() && models) setUsedModels(models);
      } catch (cause) { if (current()) setError(errorText(cause)); }
    });
    return () => { active = false; };
  }, [opened, fromUnixMs, toUnixMs, provider, officialAccount, validRange, refreshRevision, modelsCatalogNeeded, model, clearing]);

  useEffect(() => {
    if (!opened || clearing) { setLoading(false); return; }
    let active = true;
    const revision = dataRevision.current;
    const current = () => active && revision === dataRevision.current;
    if (!validRange) {
      setError("请选择有效的开始与结束时间，范围不能超过 366 天。");
      setResult(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    listTask.current = listTask.current.then(async () => {
      if (!current()) return;
      try {
        const nextResult = await requestLogs.list({ ...filters, page, pageSize, cursor, cursorMode: page === 1 || cursor !== null });
        if (!current()) return;
        setResult(nextResult);
        setPagination((previous) => {
          const cursors = previous.key === paginationKey ? { ...previous.cursors } : {};
          if (nextResult.nextCursor) cursors[page + 1] = nextResult.nextCursor;
          else delete cursors[page + 1];
          return { key: paginationKey, page, cursors };
        });
      } catch (cause) { if (current()) setError(errorText(cause)); }
      finally { if (current()) setLoading(false); }
    });
    return () => { active = false; };
  }, [opened, filters, page, pageSize, cursor, validRange, refreshRevision, paginationKey, clearing]);

  useEffect(() => {
    if (!opened || clearing) { setStatsLoading(false); return; }
    let active = true;
    const revision = dataRevision.current;
    const current = () => active && revision === dataRevision.current;
    setStats(null);
    setStatsError("");
    setStatsLoading(validRange);
    if (!validRange) return;
    statsTask.current = statsTask.current.then(async () => {
      if (!current()) return;
      try {
        const nextStats = await requestLogs.stats({ ...filters, groupBy });
        if (current()) setStats(nextStats.queryable ? nextStats : null);
      } catch (cause) { if (current()) setStatsError(errorText(cause)); }
      finally { if (current()) setStatsLoading(false); }
    });
    return () => { active = false; };
  }, [opened, filters, groupBy, validRange, refreshRevision, clearing]);

  const refresh = () => {
    setActionNotice(null);
    setRefreshRevision((value) => value + 1);
  };
  const resetFilters = () => { setSearchInput(""); setSelection(initialFilters); };
  const clearRequestLogs = async () => {
    if (!opened || clearInFlight.current) return;
    clearInFlight.current = true;
    dataRevision.current++;
    const session = lifecycle.current;
    const current = () => mounted.current && session === lifecycle.current;
    setClearing(true);
    setActionNotice(null);
    try {
      const clearResult = await requestLogs.clear();
      if (clearResult.status !== "ok") throw new Error(clearResult.message || "删除请求日志失败");
      if (!mounted.current) return;
      setResult((previous) => previous ? { ...previous, page: 1, total: 0, totalPages: 0, items: [], nextCursor: null, hasMore: false } : previous);
      setStats(null);
      setUsedModels([]);
      setRefreshRevision((value) => value + 1);
      if (current()) setActionNotice({ tone: "success", text: clearResult.removedFileCount > 0 ? "请求日志已全部删除。" : "当前没有需要删除的历史请求日志。" });
    } catch (cause) {
      if (current()) setActionNotice({ tone: "error", text: errorText(cause) });
    } finally {
      clearInFlight.current = false;
      if (mounted.current) { setClearing(false); setClearConfirmationOpened(false); }
    }
  };

  const activeFilterCount = [Boolean(search), provider !== "all", officialAccount !== "all", model !== "all", status !== "all", protocol !== "all", requestKind !== "all", timeRange !== "24h"].filter(Boolean).length;
  const firstVisible = result?.items.length ? (page - 1) * pageSize + 1 : 0;
  const lastVisible = result?.items.length ? firstVisible + result.items.length - 1 : 0;
  const totalCount = stats?.total ?? result?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const jumpPage = Number(pageJumpInput);
  const validJumpPage = /^\d+$/.test(pageJumpInput) && Number.isSafeInteger(jumpPage) && jumpPage >= 1 && jumpPage <= totalPages;
  const goToPage = (nextPage: number) => {
    if (loading || clearing || !Number.isSafeInteger(nextPage) || nextPage < 1 || nextPage > totalPages) return;
    setPagination((previous) => ({ key: paginationKey, page: nextPage, cursors: previous.key === paginationKey ? previous.cursors : {} }));
    setPageJumpInput(String(nextPage));
  };
  const health = stats?.recordingHealth;
  const dropped = health ? health.droppedFull + health.droppedClosed + health.writeDropped : 0;
  const healthWarning = health && (dropped > 0 || !health.active || health.sampleRatePerMillion < 1_000_000
    || health.writeFailures > 0 || health.observerPanics > 0 || health.writerPanics > 0 || health.shutdownTimeouts > 0);

  return {
    ...selection, searchInput, setSearchInput, changeFilter, resetFilters,
    page, pageSize, changePageSize, pageJumpInput, setPageJumpInput, jumpPage, validJumpPage, goToPage,
    groupBy, setGroupBy, result, loading, error, stats, statsLoading, statsError, refresh,
    providerOptions, officialAccounts, officialAccountOptions, officialAccountLabels, officialAccountLabel,
    modelOptions, requestModelCatalog: () => setModelsCatalogNeeded(true),
    clearConfirmationOpened, setClearConfirmationOpened, clearing, clearRequestLogs, actionNotice,
    dismissActionNotice: () => setActionNotice(null),
    hasFilters: activeFilterCount > 0, activeFilterCount, firstVisible, lastVisible, totalCount, totalPages,
    health, dropped, healthWarning,
  };
}
