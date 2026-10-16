import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconBrandGithub,
  IconCheck,
  IconCircleArrowUp,
  IconDeviceFloppy as Save,
  IconGitBranch as GitBranch,
  IconLayoutDashboard,
  IconLoader2 as LoaderCircle,
  IconRefresh as RefreshCw,
  IconSettings,
  IconX,
} from "@tabler/icons-react";
import { invoke } from "./api";
import { useRoutesController } from "./features/routes";
import { useDraftConfig } from "./useDraftConfig";
import { ModelPickerDialog } from "./AppDialogs";
import { SystemSettingsDialog } from "./SystemSettingsDialog";
import { FeaturePolicyCard, SubagentPolicyCard } from "./FeaturePolicyCard";
import { ModelSection } from "./ModelSection";
import { UsageAnalysisPanel } from "./UsageAnalysisPanel";
import { OperationsPanel } from "./OperationsPanel";
import { CodeyPluginsSection } from "./CodeyPluginsSection";
import { BuiltinToolsPage } from "./features/builtin-tools";
import { CodexExtensionsPage, type ExtensionTransport } from "./features/codex-extensions";
import { DiagnosticCleanupToast, useRuntimeMaintenanceController } from "./features/runtime-maintenance";
import {
  getNotificationChannelDefinition,
} from "./notifications";
import type { NotificationChannel } from "./notifications";
import { errorText } from "./appUtils";
import type { DiagnosticStorageTarget } from "./diagnosticStorage";
import { subagentUpdateNote } from "./modelSelectionNotice";
import { PromptOptimizationCard } from "./features/prompt-optimization";
import { CodeyBrandMark, SettingsModalShell } from "./SettingsModalShell";
import { SettingsPageHeader } from "./SettingsPageHeader";
import { SettingsLayout } from "./SettingsLayout";
import { RemoteControlPanel } from "./features/remote-control";
import { useModelSelection } from "./useModelSelection";
import { useRuntimeStatus } from "./useRuntimeStatus";
import { useAppUpdates } from "./useAppUpdates";
import {
  NoticeLoadingText,
  NoticeToast,
  useAppNoticeController,
} from "./useAppNotice";
import {
  ConfirmationDialogHost,
  useConfirmationController,
} from "./useConfirmationDialog";
import { useStableEvent } from "./useStableEvent";
import type {
  AppProps,
  ProviderStatus,
  Config,
  FastContextToolsStatus,
  ModelState,
  Profile,
} from "./App.types";
import { Badge, Button, Tooltip } from "./components/ui";

const Check = IconCheck;
const extensionRequest: ExtensionTransport = request => invoke("codex_extensions", { request });
const X = IconX;
const UNKNOWN_FAST_CONTEXT_TOOLS_STATUS: FastContextToolsStatus = {
  userConfigured: false,
  detectionFailed: true,
};
const CONFIG_LOAD_TIMEOUT_MS = 30_000;

export function App({
  embedded = false,
  modalContainer,
  modalVisible = true,
  onAfterClose,
  onClose,
}: AppProps) {
  const {
    config,
    setConfig,
    dirty,
    setDirty,
    persistedConfigRef,
    setPersistedConfig,
    canSyncCurrentProvider,
    editConfig,
    isOnlyNativeRouterToggle,
    adoptRouteConfig,
    discardDraft,
  } = useDraftConfig();
  const { status, setStatus, markRestartInProgress, refreshStatus, refreshStatusForLoad,
    restartStatusError, setRestartStatusError } =
    useRuntimeStatus({
      active: !embedded || modalVisible,
      embedded,
    });
  const [providerStatus, setProviderStatus] = useState<ProviderStatus | null>(
    null,
  );
  const [fastContextToolsStatus, setFastContextToolsStatus] =
    useState<FastContextToolsStatus>(UNKNOWN_FAST_CONTEXT_TOOLS_STATUS);
  const [usageAnalysisOpen, setUsageAnalysisOpen] = useState(false);
  const loadGenerationRef = useRef(0);
  const settingsScroll = useRef<HTMLDivElement>(null);
  const usageReturn = useRef<{ trigger: HTMLElement; scrollTop: number } | null>(null);
  const handleOpenUsageAnalysis = useCallback((trigger: HTMLElement) => {
    usageReturn.current = { trigger, scrollTop: settingsScroll.current?.scrollTop ?? 0 };
    setUsageAnalysisOpen(true);
  }, []);
  useEffect(() => {
    if (usageAnalysisOpen || !usageReturn.current) return;
    const previous = usageReturn.current;
    const frame = requestAnimationFrame(() => {
      if (settingsScroll.current) settingsScroll.current.scrollTop = previous.scrollTop;
      previous.trigger.focus({ preventScroll: true });
      usageReturn.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [usageAnalysisOpen]);
  const [busy, setBusy] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [systemSettingsOpen, setSystemSettingsOpen] = useState(false);
  const popupContainer = modalContainer ?? null;
  const noticeController = useAppNoticeController();
  const confirmationController = useConfirmationController();
  const setNotice = noticeController.set;
  const setConfirmation = confirmationController.set;
  useEffect(() => {
    if (restartStatusError) setNotice({ tone: "error", text: restartStatusError });
  }, [restartStatusError, setNotice]);

  const provider = providerStatus?.provider;
  const {
    pluginMarketplaceStatus, computerUseNotice, configRepairNotice, injectionRepairRequested, diagnosticCleanup,
    refreshPluginMarketplaceStatus, askRestartCodex, repairPluginMarketplace, prepareComputerUse,
    repairMainProcessInjection, askRepairCodexConfig, analyzeDiagnosticStorage,
  } = useRuntimeMaintenanceController({
    active: !embedded || modalVisible,
    config, dirty, isBusy: busy !== null, status, restartStatusError, persist, refreshStatus,
    markRestartInProgress, setRestartStatusError, setStatus, setBusy, setNotice, setConfirmation,
  });
  const isBusy = busy !== null || (injectionRepairRequested && !restartStatusError);
  const configLoaded = config !== null;
  const setSubagentOptimization = useCallback((enabled: boolean) => {
    setConfig((current) =>
      current ? { ...current, subagentOptimization: enabled } : current,
    );
    setDirty(true);
  }, []);
  const runOperation = useCallback(
    async (name: string, action: () => Promise<void>) => {
      if (isBusy) return;
      setBusy(name);
      try {
        await action();
      } catch (error) {
        setNotice({ tone: "error", text: errorText(error) });
      } finally {
        setBusy(null);
      }
    },
    [isBusy, setNotice],
  );
  const operationsStatus = useMemo(
    () => ({
      running: status.running,
      codexAppVersion: status.codexAppVersion,
      clientPlatform: status.clientPlatform,
      restartRequired: status.restartRequired,
      restartInProgress: status.restartInProgress,
      codexAppPath: status.codexAppPath,
      maintenance: status.maintenance,
      injectionScripts: status.injectionScripts,
      fastContextToolsActive: status.fastContextToolsActive,
      subagentOptimizationActive: status.subagentOptimizationActive,
      notificationChannelsActive: status.notificationChannelsActive,
      activeNotificationChannelCount: status.activeNotificationChannelCount,
      traceLogWriteProtectionActive: status.traceLogWriteProtectionActive,
      crashpadDiskProtectionActive: status.crashpadDiskProtectionActive,
    }),
    [
      status.running,
      status.codexAppVersion,
      status.clientPlatform,
      status.restartRequired,
      status.restartInProgress,
      status.codexAppPath,
      status.maintenance,
      status.injectionScripts,
      status.fastContextToolsActive,
      status.subagentOptimizationActive,
      status.notificationChannelsActive,
      status.activeNotificationChannelCount,
      status.traceLogWriteProtectionActive,
      status.crashpadDiskProtectionActive,
    ],
  );
  const {
    subagentModelOptions,
    modelState,
    modelEditorState,
    officialOnly,
    setModelState,
    modelPickerVisible,
    modelPickerLoading,
    setModelPickerVisible,
    beginModelPickerLoad,
    completeModelPickerLoad,
    customModelInput,
    modelInputError,
    modelSyncWarning,
    draftAutoReviewSupported,
    setDraftAutoReviewSupported,
    draftModelSet,
    draftModelContexts,
    updateDraftModelContext,
    draftReasoningEfforts,
    reasoningEffortAutoByModel,
    modelPickerReasoningCapabilities,
    updateDraftReasoningEffort,
    resetDraftReasoningEffort,
    draftManualThirdPartyModelKeys,
    thirdPartyModelOptions,
    toggleDraftModel,
    deleteDraftThirdPartyModel,
    updateCustomModelInput,
    addCustomModel,
    saveModelSelection,
  } = useModelSelection({
    config,
    currentProvider: provider ?? null,
    officialAccountAvailable: status.officialAccountAvailable === true,
    runOperation,
    setPersistedConfig,
    setStatus,
    setNotice,
  });
  const {
    saveRoute, setRouteEnabled, reorderRoute, reorderRouteModels, requestDeleteRoute,
    fetchRouteModels, saveOfficialRouteSettings, setRouteDefaultModel, handleOfficialAccountsChanged,
  } = useRoutesController({
    active: !embedded || modalVisible,
    config, dirty, isBusy, provider, setConfig, setDirty, persistedConfigRef,
    setPersistedConfig, isOnlyNativeRouterToggle, adoptRouteConfig,
    modelState, setModelState, beginModelPickerLoad, completeModelPickerLoad,
    setProviderStatus, setStatus, setNotice, setConfirmation, runOperation, persist,
  });
  const {
    automaticallyChecking,
    updateResult,
    updateCheck,
    downloadedUpdate,
    checkForUpdates,
  } = useAppUpdates({
    embedded,
    configLoaded,
    codeyUpdatePolicy: persistedConfigRef.current?.codeyUpdatePolicy ?? "stable",
    isBusy,
    setBusy,
    setNotice,
    setConfirmation,
    beforeInstall: async () => {
      if (config && dirty) await persist(config);
    },
  });

  useEffect(() => {
    void load();
    return () => {
      loadGenerationRef.current += 1;
    };
  }, []);

  async function load() {
    const generation = ++loadGenerationRef.current;
    const current = () => generation === loadGenerationRef.current;
    setLoadFailed(false);
    const timer = window.setTimeout(() => {
      if (!current()) return;
      setLoadFailed(true);
      setNotice({ tone: "error", text: "加载配置超时，请重新检查" });
    }, CONFIG_LOAD_TIMEOUT_MS);
    try {
      const result = await invoke<{
        config: Config;
        modelState?: ModelState;
        startupError?: string;
        configLoadError?: string;
        officialAccountAvailable?: boolean;
        providerStatus?: ProviderStatus;
        fastContextToolsStatus?: FastContextToolsStatus;
      }>("load_codey_config");
      window.clearTimeout(timer);
      if (!current()) return;
      setLoadFailed(false);
      setPersistedConfig(result.config);
      setProviderStatus(result.providerStatus ?? null);
      if (!result.providerStatus) throw new Error("未能读取当前服务配置，请重新检查");
      if (typeof result.officialAccountAvailable === "boolean") {
        setStatus((currentStatus) => ({
          ...currentStatus,
          officialAccountAvailable: result.officialAccountAvailable,
        }));
      }
      setFastContextToolsStatus(
        result.fastContextToolsStatus ?? UNKNOWN_FAST_CONTEXT_TOOLS_STATUS,
      );
      if (result.modelState) setModelState(result.modelState);
      const [next] = await Promise.all([
        refreshStatusForLoad(),
        refreshPluginMarketplaceStatus(current),
      ]);
      if (!current()) return;
      const startupError = next.startupError || result.startupError;
      const loadErrors = [
        startupError && `自动启动失败：${startupError}`,
        result.configLoadError,
      ].filter(Boolean);
      if (loadErrors.length > 0) {
        setNotice({ tone: "error", text: loadErrors.join("；") });
      } else if (next.restartRequired) {
        setNotice({ tone: "info", text: "已保存的配置需重启 Codex 后生效" });
      } else if (!next.running) {
        setNotice({ tone: "info", text: "CodeyX 运行时已就绪" });
      }
    } catch (error) {
      window.clearTimeout(timer);
      if (!current()) return;
      setLoadFailed(true);
      setNotice({ tone: "error", text: errorText(error) });
    }
  }

  function changeUpdatePolicy(policy: Config["codeyUpdatePolicy"]) {
    if (!config || isBusy) return;
    if (policy !== "experimental" || config.codeyUpdatePolicy === "experimental") {
      editConfig({ ...config, codeyUpdatePolicy: policy });
      return;
    }
    setConfirmation({
      action: "enable-experimental-updates",
      title: "切换到实验版更新？",
      description: "实验版尚未经过充分验证，可能出现功能异常、启动失败或数据兼容问题。请先备份重要数据，避免在关键工作环境使用。确认并保存设置后生效；取消会保留原设置。",
      confirmLabel: "了解风险，使用实验版",
      run: () => {
        setConfig((current) => current ? { ...current, codeyUpdatePolicy: policy } : current);
        setDirty(true);
      },
    });
  }

  async function persist(next: Config) {
    const result = await invoke<{
      config: Config;
      providerStatus?: ProviderStatus;
      modelState?: ModelState;
      restartRequired?: boolean;
      modelHotReloaded?: boolean;
      modelHotReloadError?: string;
      routeRequestLogHotReloaded?: boolean;
      routeRequestLogHealth?:
        | "not_applicable"
        | "unchanged"
        | "enabled"
        | "disabled"
        | "superseded"
        | "failed";
      routeRequestLogHotReloadError?: string;
      subagentConfigHotReloaded?: boolean;
      subagentConfigRepaired?: boolean;
      subagentConfigHealth?: string;
      subagentConfigRepairReasons?: string[];
      subagentConfigHotReloadError?: string;
      fastContextToolsStatus?: FastContextToolsStatus;
    }>("save_codey_config", { config: next });
    setPersistedConfig(result.config);
    setFastContextToolsStatus(
      result.fastContextToolsStatus ?? UNKNOWN_FAST_CONTEXT_TOOLS_STATUS,
    );
    window.dispatchEvent(
      new CustomEvent("codey:config-changed", {
        detail: { config: result.config },
      }),
    );
    if (result.providerStatus) setProviderStatus(result.providerStatus);
    if (result.modelState) setModelState(result.modelState);
    if (typeof result.restartRequired === "boolean") {
      setStatus((current) => ({
        ...current,
        restartRequired: result.restartRequired,
      }));
    }
    setDirty(false);
    // 保存结果已包含配置、模型和重启状态；其余运行状态在后台补充。
    void refreshStatus().catch(() => undefined);
    return result;
  }

  async function persistNotificationChannels(
    current: Config,
    channels: NotificationChannel[],
    successText: string,
  ) {
    if (isBusy) return false;
    setBusy("save-notification-channel");
    try {
      await persist({
        ...current,
        webhook: {
          ...current.webhook,
          channels,
        },
      });
      setNotice({ tone: "success", text: successText });
      return true;
    } catch (error) {
      setNotice({ tone: "error", text: errorText(error) });
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function addNotificationChannel(channel: NotificationChannel) {
    if (!config) return false;
    const channels = config.webhook.channels.some(
      (existing) => existing.id === channel.id,
    )
      ? config.webhook.channels
      : [...config.webhook.channels, channel];
    return persistNotificationChannels(
      config,
      channels,
      "通知渠道已保存，自动通知已生效",
    );
  }

  async function updateNotificationChannel(
    channelId: string,
    patch: Partial<NotificationChannel>,
  ) {
    if (!config) return false;
    const channels = config.webhook.channels.map((channel) =>
      channel.id === channelId ? { ...channel, ...patch } : channel,
    );
    return persistNotificationChannels(
      config,
      channels,
      "通知渠道已更新，自动通知已生效",
    );
  }

  async function removeNotificationChannel(channelId: string) {
    if (!config) return false;
    const channels = config.webhook.channels.filter(
      (channel) => channel.id !== channelId,
    );
    return persistNotificationChannels(
      config,
      channels,
      "通知渠道已删除",
    );
  }

  async function saveCurrent() {
    if (!config) return;
    await runOperation("save", async () => {
      const retryCountChanged =
        persistedConfigRef.current?.streamMaxRetries !== config.streamMaxRetries;
      const result = await persist(config);
      const subagentHotReloaded = Boolean(result.subagentConfigHotReloaded);
      const subagentHotReloadFailed = Boolean(result.subagentConfigHotReloadError);
      const subagentNote = subagentUpdateNote(result);
      const subagentConfigRepaired = Boolean(result.subagentConfigRepaired);
      const requestLogHealth = result.routeRequestLogHealth;
      const requestLogHotReloadFailed = requestLogHealth === "failed";
      const requestLogSuperseded = requestLogHealth === "superseded";
      const restartSuffix = result.restartRequired
        ? "；其他启动参数将在重启 Codex 后生效"
        : "";
      let noticeTone: "success" | "info" | "error" =
        result.restartRequired || subagentHotReloadFailed ? "info" : "success";
      let noticeText = result.restartRequired && !subagentNote
        ? "CodeyX 设置已保存，启动参数将在重启 Codex 后生效"
        : "CodeyX 设置已保存";
      if (subagentConfigRepaired) {
        noticeText = "CodeyX 设置已保存；子代理配置已同步";
      } else if (subagentHotReloaded) {
        noticeText = "CodeyX 设置已保存；子代理配置已实时更新";
      }
      if (requestLogHotReloadFailed) {
        noticeTone = "error";
        noticeText = `CodeyX 设置已保存；${result.routeRequestLogHotReloadError || "请求日志记录未能实时更新"}`;
      } else if (requestLogSuperseded) {
        noticeTone = "info";
        noticeText = `CodeyX 设置已保存；${result.routeRequestLogHotReloadError || "请求日志配置被更新的设置取代，请确认当前开关状态"}`;
      } else if (requestLogHealth === "enabled") {
        noticeText = `CodeyX 设置已保存；请求日志记录已实时开启，无需重启${restartSuffix}`;
      } else if (requestLogHealth === "disabled") {
        noticeText = `CodeyX 设置已保存；请求日志记录已实时关闭，无需重启${restartSuffix}`;
      }
      if (retryCountChanged && result.restartRequired) {
        noticeText = "CodeyX 设置已保存；会话重试次数将在重启 Codex 后生效";
      }
      if (subagentNote) {
        noticeText += `；${subagentNote}`;
        if (noticeTone === "success") noticeTone = "info";
      }
      setNotice({ tone: noticeTone, text: noticeText });
    });
  }

  function closeSettings() {
    if (isBusy) return;
    discardDraft();
    setModelPickerVisible(false);
    setUsageAnalysisOpen(false);
    usageReturn.current = null;
    setConfirmation(null);
    onClose?.();
  }

  function requestCloseSettings() {
    if (isBusy) return;
    if (!dirty) {
      closeSettings();
      return;
    }
    setConfirmation({
      action: "discard-settings-changes",
      title: "放弃未保存的更改？",
      description: "关闭后将丢弃尚未保存的配置修改。你可以取消关闭，继续编辑或保存。",
      confirmLabel: "放弃更改并关闭",
      run: closeSettings,
    });
  }

  function askRemoveNotificationChannel(channel: NotificationChannel) {
    const channelName = getNotificationChannelDefinition(channel.kind).addLabel;
    setConfirmation({
      action: "delete-notification-channel",
      title: `删除${channelName}通知渠道？`,
      description:
        "将立即移除这个通知渠道，删除后不会再接收自动通知。",
      confirmLabel: "删除渠道",
      run: () => void removeNotificationChannel(channel.id),
    });
  }

  const handleCloseSettings = useStableEvent(requestCloseSettings);
  const handleSaveCurrent = useStableEvent(() => void saveCurrent());
  const handleRepairPluginMarketplace = useStableEvent(
    () => void repairPluginMarketplace(),
  );
  const handlePrepareComputerUse = useStableEvent(
    () => void prepareComputerUse(),
  );
  const handleRestartCodex = useStableEvent(askRestartCodex);
  const handleRepairMainProcessInjection = useStableEvent(
    () => void repairMainProcessInjection(),
  );
  const handleFooterUpdateClick = useStableEvent(() => void checkForUpdates());
  const handleConfigChange = useStableEvent(editConfig);
  const handleAddNotificationChannel = useStableEvent(addNotificationChannel);
  const handleNotificationChannelChange = useStableEvent(
    updateNotificationChannel,
  );
  const handleRequestRemoveNotificationChannel = useStableEvent(
    askRemoveNotificationChannel,
  );
  const handleSubagentOptimizationChange = useStableEvent(
    (checked: boolean) => setSubagentOptimization(checked),
  );
  const handleSaveRoute = useStableEvent(saveRoute);
  const handleSetRouteEnabled = useStableEvent(setRouteEnabled);
  const handleReorderRoute = useStableEvent(reorderRoute);
  const handleReorderRouteModels = useStableEvent(reorderRouteModels);
  const handleDeleteRoute = useStableEvent(requestDeleteRoute);
  const handleFetchRouteModels = useStableEvent((route: Profile) => {
    void fetchRouteModels(route);
  });
  const handleToggleLocalRouter = useStableEvent((checked: boolean) => {
    if (!config) return;
    editConfig({
      ...config,
      localRouterEnabled: checked,
    });
    setNotice({
      tone: "info",
      text: checked
        ? "保存并重启 Codex 后开启本地路由"
        : "保存并重启 Codex 后关闭本地路由",
    });
  });
  const handleToggleRouteRequestLog = useStableEvent((checked: boolean) => {
    if (!config) return;
    editConfig({
      ...config,
      routeRequestLog: {
        ...config.routeRequestLog,
        enabled: checked,
        ...(checked ? { backend: "sqlite" as const } : {}),
      },
    });
    setNotice({
      tone: "info",
      text: checked
        ? "保存后开启日志记录，无需重启"
        : "保存后关闭日志记录，无需重启",
    });
  });
  const handleNotice = useStableEvent(
    (notice: { tone: "success" | "info" | "error"; text: string }) => setNotice(notice),
  );
  const handleSaveOfficialRouteSettings = useStableEvent(
    saveOfficialRouteSettings,
  );
  const handleSetRouteDefaultModel = useStableEvent(
    (routeId: string, model: string) => {
      void setRouteDefaultModel(routeId, model);
    },
  );
  const handleAnalyzeDiagnosticStorage = useStableEvent(
    (target: DiagnosticStorageTarget) => void analyzeDiagnosticStorage(target),
  );
  const handleModelPickerOpenChange = useStableEvent((open: boolean) => {
    if (!isBusy || open) setModelPickerVisible(open);
  });
  if (!config || !provider) {
    const loadingContent = (
      <main className="app-shell loading-shell">
        <div className="loading-mark">
          <GitBranch size={17} />
        </div>
        <div>
          <strong>{loadFailed ? "CodeyX 加载失败" : "正在载入 CodeyX"}</strong>
          <p>
            <NoticeLoadingText controller={noticeController} />
          </p>
          {loadFailed && (
            <div className="flex flex-wrap gap-2 mt-3">
              <Button variant="outline" size="sm" disabled={isBusy} onClick={askRepairCodexConfig}>
                {busy === "repair-codex-config" ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
                {busy === "repair-codex-config" ? "检查修复中…" : "修复 Codex 配置"}
              </Button>
              <Button variant="secondary" size="sm" disabled={isBusy} onClick={() => void runOperation("reload-config", load)}>
                重新检查
              </Button>
            </div>
          )}
        </div>
        {!loadFailed && <LoaderCircle
          className="animate-spin loading-animate-spin"
          size={16}
          aria-hidden="true"
        />}
        <ConfirmationDialogHost
          container={popupContainer}
          controller={confirmationController}
        />
      </main>
    );
    return embedded ? (
      <SettingsModalShell
        afterClose={onAfterClose}
        container={modalContainer}
        onCancel={handleCloseSettings}
        title="CodeyX 配置"
        visible={modalVisible}
      >
        {loadingContent}
      </SettingsModalShell>
    ) : (
      loadingContent
    );
  }

  const hasUpdate =
    updateCheck?.updateAvailable === true &&
    Boolean(updateCheck.selectedAsset);
  const isCheckingUpdate = busy === "check-update" || automaticallyChecking;
  const isDownloadingUpdate = busy === "download-update";
  const isInstallingUpdate = busy === "install-update";
  const updateTooltipText = downloadedUpdate
    ? `新版本 v${downloadedUpdate.latestVersion} 已下载，点击检查更新并安装`
    : hasUpdate
      ? `发现新版本 v${updateCheck?.latestVersion}，点击重新检查并更新`
      : isCheckingUpdate
        ? "正在检查更新…"
        : updateResult?.text
          ? `${updateResult.text}（点击再次检查）`
          : "检查 CodeyX 在线更新";

  const configHeaderContent = (
    <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-5 max-[760px]:grid-cols-[minmax(0,1fr)_auto_auto] max-[760px]:gap-2.5">
      <div className="flex min-w-0 items-center gap-3 justify-self-start max-[760px]:gap-2">
        <CodeyBrandMark />
        <div className="flex min-w-0 flex-col">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h1 className="m-0 whitespace-nowrap text-base font-bold tracking-[-0.02em] text-[var(--codey-text,#1d1d1f)]">CodeyX 控制台</h1>
            {dirty && (
              <Badge variant="warning">
                未保存更改
              </Badge>
            )}
          </div>
          <p className="m-0 mt-0.5 text-[11px] text-[var(--codey-muted,#6e6e73)] max-[760px]:hidden">管理 Codex 线路、模型服务、运行策略与诊断日志</p>
        </div>
      </div>

      {embedded && (
        <div className="flex items-center gap-3 justify-self-center max-[760px]:gap-2">
          <Button
            aria-label="打开 CodeyX GitHub 仓库"
            className="h-8! w-8! min-w-8! px-0!"
            onClick={() => window.open("https://github.com/fraternity-z/CodeyX", "_blank", "noopener,noreferrer")}
            size="icon-sm"
            title="GitHub 仓库"
            variant="brand-outline"
          >
            <IconBrandGithub aria-hidden="true" />
          </Button>
        </div>
      )}

      <div className="flex min-w-0 items-center gap-4 justify-self-end">
        <div className="flex items-center gap-2">
          {embedded && (
            <Button
              aria-label={restartStatusError ? "重新查询状态" : status.running ? "重启 Codex" : "Codex 未运行"}
              className="h-8! whitespace-nowrap px-3 text-xs max-[520px]:w-8! max-[520px]:px-0!"
              disabled={isBusy || (!restartStatusError && (status.restartInProgress || !status.running))}
              onClick={handleRestartCodex}
              variant="warning"
            >
              {busy === "restart" || (status.restartInProgress && !restartStatusError) ? (
                <LoaderCircle className="animate-spin" size={14} aria-hidden="true" />
              ) : (
                <RefreshCw size={14} aria-hidden="true" />
              )}
              <span className="max-[520px]:hidden">
                {restartStatusError ? "重新查询状态" : status.running ? "重启 Codex" : "未运行"}
              </span>
            </Button>
          )}
          <Button
            aria-label={dirty ? "保存更改" : "已保存"}
            className="h-8! min-w-[84px] px-3 text-xs max-[520px]:min-w-8! max-[520px]:w-8! max-[520px]:px-0!"
            disabled={!dirty || isBusy}
            onClick={handleSaveCurrent}
            variant={dirty ? "default" : "secondary"}
          >
            {busy === "save" ? (
              <LoaderCircle className="animate-spin" size={14} aria-hidden="true" />
            ) : dirty ? (
              <Save size={14} aria-hidden="true" />
            ) : (
              <Check size={14} aria-hidden="true" />
            )}
            <span className="max-[520px]:hidden">
              {dirty ? "保存更改" : "已保存"}
            </span>
          </Button>
          {embedded && (
            <Button
              aria-label="关闭配置"
              className="size-8! flex-none p-0! rounded-full! max-[520px]:size-8! max-[520px]:p-0!"
              disabled={isBusy}
              onClick={handleCloseSettings}
              size="icon"
              variant="ghost"
            >
              <X size={15} aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );

  const appContent = (
    <main className={`app-shell${embedded ? " embedded" : ""}`}>
      <a className="skip-link" href={usageAnalysisOpen ? "#usage-analysis-title" : "#codey-settings-content"}>
        {usageAnalysisOpen ? "跳至用量分析" : "跳至设置内容"}
      </a>

      {!embedded && (
        <div className="macos-titlebar">
          <div className="macos-traffic-lights">
            <Button
              variant="ghost"
              size="icon"
              className="size-3! min-w-3! rounded-full! border! border-[rgb(var(--codey-ink-rgb,0,0,0))]/15! bg-[#ff5f56]! p-0! shadow-none! hover:opacity-85"
              title="关闭"
              aria-label="关闭窗口"
            />
            <Button
              variant="ghost"
              size="icon"
              className="size-3! min-w-3! rounded-full! border! border-[rgb(var(--codey-ink-rgb,0,0,0))]/15! bg-[#ffbd2e]! p-0! shadow-none! hover:opacity-85"
              title="最小化"
              aria-label="最小化窗口"
            />
            <Button
              variant="ghost"
              size="icon"
              className="size-3! min-w-3! rounded-full! border! border-[rgb(var(--codey-ink-rgb,0,0,0))]/15! bg-[#27c93f]! p-0! shadow-none! hover:opacity-85"
              title="缩放"
              aria-label="全屏缩放"
            />
          </div>
          <div className="macos-titlebar-title">
            <span className="app-title-text">CodeyX Control Panel</span>
          </div>
          <div className="macos-titlebar-right" aria-hidden="true" />
        </div>
      )}

      {!embedded && (
        <header className="z-30 flex flex-col border-b border-[rgb(var(--codey-ink-rgb,0,0,0))]/8 bg-[var(--codey-surface,#fff)]/75 px-5 py-2.5 backdrop-blur-xl shadow-[0_3px_8px_rgba(0,0,0,0.04),0_1px_2px_rgba(0,0,0,0.02)]">
          {configHeaderContent}
        </header>
      )}

      {usageAnalysisOpen ? (
        <div className="page-scroll">
          <UsageAnalysisPanel onBack={() => setUsageAnalysisOpen(false)} />
        </div>
      ) : (
      <SettingsLayout
        contentRef={settingsScroll}
        sidebarFooter={
          <div className="sidebar-footer-bar">
            <div className="sidebar-footer-left">
              <span className="sidebar-footer-version font-mono">
                v{status.appVersion || "1.0.0"}
                {(updateCheck?.updateAvailable === true || Boolean(downloadedUpdate)) && (
                  <span
                    className="ml-1.5 inline-flex shrink-0"
                    role="img"
                    aria-label={downloadedUpdate ? "新版本已下载，待安装" : "有新版本可用"}
                    title={downloadedUpdate ? "新版本已下载，待安装" : "有新版本可用"}
                  >
                    <span className="size-1.5 rounded-full bg-[var(--codey-red)]" aria-hidden="true" />
                  </span>
                )}
              </span>
              <Tooltip content={updateTooltipText} position="top">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="sidebar-footer-icon-btn"
                  disabled={isBusy && !isCheckingUpdate}
                  aria-label={updateTooltipText}
                  onClick={handleFooterUpdateClick}
                >
                  {isCheckingUpdate || isDownloadingUpdate || isInstallingUpdate ? (
                    <LoaderCircle className="animate-spin" size={14} aria-hidden="true" />
                  ) : downloadedUpdate ? (
                    <IconCheck size={14} className="text-success" aria-hidden="true" />
                  ) : hasUpdate ? (
                    <span className="relative inline-flex items-center justify-center">
                      <IconCircleArrowUp size={15} className="text-primary" aria-hidden="true" />
                      <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-primary animate-pulse" />
                    </span>
                  ) : (
                    <IconCircleArrowUp size={15} aria-hidden="true" />
                  )}
                </Button>
              </Tooltip>
            </div>

            <div className="sidebar-footer-right">
              <Tooltip content="系统设置与偏好" position="top">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="sidebar-footer-icon-btn"
                  aria-label="系统设置与偏好"
                  onClick={() => setSystemSettingsOpen(true)}
                >
                  <IconSettings size={15} aria-hidden="true" />
                </Button>
              </Tooltip>
            </div>
          </div>
        }
        sections={{
          overview: (
            <>
              <SettingsPageHeader
                id="overview-title"
                title="基础功能"
                icon={<IconLayoutDashboard size={15} />}
                description="查看 Codex 运行状态，管理客户端功能与通知。"
              />
              <OperationsPanel
                codexAppPath={config.codexAppPath}
                fastContextToolsStatus={fastContextToolsStatus}
                status={operationsStatus}
                busy={busy}
                isBusy={isBusy}
                pluginMarketplaceStatus={pluginMarketplaceStatus}
                onRepairPluginMarketplace={handleRepairPluginMarketplace}
                onPrepareComputerUse={handlePrepareComputerUse}
                computerUseNotice={computerUseNotice}
                onRepairMainProcessInjection={handleRepairMainProcessInjection}
                onRepairCodexConfig={askRepairCodexConfig}
                configRepairNotice={configRepairNotice}
                injectionRepairing={injectionRepairRequested || busy === "repair-main-process-injection"}
                onRestart={handleRestartCodex}
                restartStatusUnknown={Boolean(restartStatusError)}
                showRestartAction={!embedded}
              />
              <FeaturePolicyCard
                config={config}
                isMacClient={status.clientPlatform === "macos"}
                isWindowsClient={status.clientPlatform === "windows"}
                cleanupBusy={busy === "clear-diagnostic-storage"}
                onAnalyzeDiagnosticStorage={handleAnalyzeDiagnosticStorage}
                popupContainer={popupContainer}
                isBusy={isBusy}
                onConfigChange={handleConfigChange}
                onAddChannel={handleAddNotificationChannel}
                onChannelChange={handleNotificationChannelChange}
                onRequestRemoveChannel={handleRequestRemoveNotificationChannel}
              />
            </>
          ),
          models: (active) => (
            <ModelSection
              active={active}
              config={config}
              runtimeStatus={status}
              currentProvider={provider ?? null}
              officialAccountAvailable={status.officialAccountAvailable === true}
              popupContainer={popupContainer}
              modelState={modelState}
              dirty={dirty}
              canSyncCurrentProvider={canSyncCurrentProvider}
              isBusy={isBusy}
              busy={busy}
              showAccountUsageInHeader={config.showAccountUsageInHeader}
              subagentModelOptions={subagentModelOptions}
              onToggleLocalRouter={handleToggleLocalRouter}
              onToggleRouteRequestLog={handleToggleRouteRequestLog}
              onOpenUsageAnalysis={handleOpenUsageAnalysis}
              onSaveRoute={handleSaveRoute}
              onSetRouteEnabled={handleSetRouteEnabled}
              onReorderRoute={handleReorderRoute}
              onReorderRouteModels={handleReorderRouteModels}
              onDeleteRoute={handleDeleteRoute}
              onFetchRouteModels={handleFetchRouteModels}
              onOfficialAccountsChanged={handleOfficialAccountsChanged}
              onNotice={handleNotice}
              onSaveOfficialRouteSettings={handleSaveOfficialRouteSettings}
              onSetDefaultModel={handleSetRouteDefaultModel}
              onConfigChange={handleConfigChange}
              onRequestConfirmation={setConfirmation}
            />
          ),
          prompt: (active) => (
            <PromptOptimizationCard
              active={active && (!embedded || modalVisible)}
              config={config}
              isBusy={isBusy}
              subagentModelOptions={subagentModelOptions}
              onConfigChange={handleConfigChange}
              onNotice={setNotice}
            />
          ),
          subagents: (
            <SubagentPolicyCard
              config={config}
              isBusy={isBusy}
              subagentModelOptions={subagentModelOptions}
              onConfigChange={handleConfigChange}
              onSubagentOptimizationChange={handleSubagentOptimizationChange}
            />
          ),
          remote: (active) => <RemoteControlPanel active={active} />,
          tools: (active) => (
            <BuiltinToolsPage active={active} config={config} fastContextToolsStatus={fastContextToolsStatus}
              isBusy={isBusy} onConfigChange={handleConfigChange} />
          ),
          plugins: <CodeyPluginsSection container={popupContainer} />,
          mcp: (active) => (
            <CodexExtensionsPage kind="mcp" active={active} request={extensionRequest} container={popupContainer} />
          ),
          skills: (active) => (
            <CodexExtensionsPage kind="skill" active={active} request={extensionRequest} container={popupContainer} />
          ),
        }}
      />
      )}

      <NoticeToast controller={noticeController} />
      <DiagnosticCleanupToast state={diagnosticCleanup} />

      <ModelPickerDialog
        open={modelPickerVisible}
        routeConfigReadOnly={config?.localRouterEnabled === false}
        officialOnly={officialOnly}
        isBusy={isBusy}
        busy={busy}
        container={popupContainer}
        customModelInput={customModelInput}
        modelInputError={modelInputError}
        modelSyncWarning={modelSyncWarning}
        loading={modelPickerLoading}
        autoReviewSupported={draftAutoReviewSupported}
        reasoningEffortCapabilities={modelPickerReasoningCapabilities}
        thirdPartyModelOptions={thirdPartyModelOptions}
        modelState={modelEditorState}
        draftModelSet={draftModelSet}
        draftModelContexts={draftModelContexts}
        draftReasoningEfforts={draftReasoningEfforts}
        reasoningEffortAutoByModel={reasoningEffortAutoByModel}
        onUpdateDraftModelContext={updateDraftModelContext}
        onUpdateDraftReasoningEffort={updateDraftReasoningEffort}
        onResetDraftReasoningEffort={resetDraftReasoningEffort}
        manualThirdPartyModelKeys={draftManualThirdPartyModelKeys}
        onOpenChange={handleModelPickerOpenChange}
        onCustomModelInputChange={updateCustomModelInput}
        onAddCustomModel={addCustomModel}
        onToggleDraftModel={toggleDraftModel}
        onDeleteThirdPartyModel={deleteDraftThirdPartyModel}
        onAutoReviewSupportedChange={setDraftAutoReviewSupported}
        onSave={saveModelSelection}
      />

      <ConfirmationDialogHost
        container={popupContainer}
        controller={confirmationController}
      />

      <SystemSettingsDialog
        open={systemSettingsOpen}
        onOpenChange={setSystemSettingsOpen}
        container={popupContainer}
        appVersion={status.appVersion}
        codexAppVersion={status.codexAppVersion}
        codexAppPath={config.codexAppPath || status.codexAppPath}
        isBusy={isBusy}
        busy={busy}
        onRepairCodexConfig={askRepairCodexConfig}
        configRepairNotice={configRepairNotice}
        codeyUpdatePolicy={config.codeyUpdatePolicy}
        onCodeyUpdatePolicyChange={changeUpdatePolicy}
      />
    </main>
  );
  return embedded ? (
    <SettingsModalShell
      afterClose={onAfterClose}
      container={modalContainer}
      header={
        <div className="flex w-full items-center overflow-visible">
          {configHeaderContent}
        </div>
      }
      onCancel={handleCloseSettings}
      visible={modalVisible}
    >
      {appContent}
    </SettingsModalShell>
  ) : (
    appContent
  );
}
