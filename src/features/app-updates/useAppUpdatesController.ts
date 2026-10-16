import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import type {
  Confirmation,
  Config,
  InlineResult,
  Notice,
  UpdateCheck,
  UpdateDownload,
  UpdateInstallReport,
} from "../../App.types";
import { errorText } from "../../appUtils";
import { formatBytes } from "../../formatters";
import { useStableEvent } from "../../useStableEvent";
import { appUpdateRequests } from "./requests";
import { matchesDownloadedUpdate, releaseAnnouncement, updateAvailable, updateCheckText,
  updateInstallReportText, updatePromptKey, updateResultTone, updateVersionAllowed } from "./state";

const UPDATE_AVAILABLE_EVENT = "codey-update-availability-changed";
const UPDATE_PROMPT_EVENT = "codey-update-prompt";
const AUTO_UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 12_000;
const DEFERRED_UPDATE_STORAGE_KEY = "codey.deferredUpdateVersion";

declare global {
  interface Window {
    __codeyUpdateAvailability?: UpdateCheck | null;
    __codeyPendingUpdatePrompt?: UpdateCheck | null;
  }
}

/// 用户点过"稍后"的版本，记在会话里。自动检查因此不会在同一个版本上反复
/// 弹窗，用户重新打开 CodeyX 后仍会收到提醒。
function readDeferredVersion(): string | null {
  try {
    return window.sessionStorage.getItem(DEFERRED_UPDATE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeDeferredVersion(version: string) {
  try {
    window.sessionStorage.setItem(DEFERRED_UPDATE_STORAGE_KEY, version);
  } catch {
    // 存储不可用时退回到"每次检查都会提示"的旧行为，不影响功能。
  }
}

type UseAppUpdatesOptions = {
  active?: boolean;
  embedded: boolean;
  configLoaded: boolean;
  config?: Config | null;
  onConfigChange?: (config: Config) => void;
  codeyUpdatePolicy: Config["codeyUpdatePolicy"];
  isBusy: boolean;
  setBusy: Dispatch<SetStateAction<string | null>>;
  setNotice: Dispatch<SetStateAction<Notice>>;
  setConfirmation: Dispatch<SetStateAction<Confirmation | null>>;
  beforeInstall: () => Promise<void>;
};
type Operation = { name: "check-update" | "download-update" | "install-update"; timer?: number };

function publishUpdateAvailability(result: UpdateCheck | null) {
  window.__codeyUpdateAvailability = updateAvailable(result) ? result : null;
  window.dispatchEvent(
    new CustomEvent(UPDATE_AVAILABLE_EVENT, {
      detail: window.__codeyUpdateAvailability,
    }),
  );
}

export function useAppUpdatesController({
  active = true,
  embedded,
  configLoaded,
  config,
  onConfigChange,
  codeyUpdatePolicy,
  isBusy,
  setBusy,
  setNotice,
  setConfirmation,
  beforeInstall,
}: UseAppUpdatesOptions) {
  const [updateResult, setUpdateResult] = useState<InlineResult>({
    tone: "idle",
    text: "",
  });
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck | null>(null);
  const [downloadedUpdate, setDownloadedUpdate] =
    useState<UpdateDownload | null>(null);
  const updateCheckRef = useRef<UpdateCheck | null>(null);
  const promptedVersionRef = useRef<string | null>(null);
  const [automaticallyChecking, setAutomaticallyChecking] = useState(false);
  const manualCheckVersion = useRef(0);
  const updateCheckInFlightRef = useRef<Promise<UpdateCheck> | null>(null);
  const policyRef = useRef(codeyUpdatePolicy);
  const previousPolicyRef = useRef<Config["codeyUpdatePolicy"] | null>(configLoaded ? codeyUpdatePolicy : null);
  const mounted = useRef(false);
  const session = useRef<object | null>(null);
  const pending = useRef<Operation | null>(null);
  const readTimers = useRef(new Map<number, () => void>());
  const [operation, setOperation] = useState<Operation["name"] | null>(null);
  const reportCache = useRef<{ requested: boolean; report?: UpdateInstallReport | null }>({ requested: false });
  policyRef.current = codeyUpdatePolicy;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(pending.current?.timer);
    };
  }, []);
  const finish = useStableEvent((work: Operation) => {
    window.clearTimeout(work.timer);
    if (pending.current !== work) return;
    pending.current = null;
    if (mounted.current) {
      setOperation(null);
      setBusy(value => value === work.name ? null : value);
    }
  });
  const invalidateReads = useStableEvent(() => {
    updateCheckInFlightRef.current = null;
    readTimers.current.forEach(cancel => cancel());
    readTimers.current.clear();
    const work = pending.current;
    if (work?.name === "check-update") finish(work);
  });
  useEffect(() => {
    session.current = active && configLoaded ? {} : null;
    if (!active) setUpdateResult(result => result.tone === "pending" ? { tone: "idle", text: "" } : result);
    return () => {
      session.current = null;
      // 读取可以作废；下载与安装仍持有防重锁，直到后台请求真正结束。
      invalidateReads();
    };
  }, [active, configLoaded, invalidateReads]);

  const currentScope = () => {
    const scope = session.current;
    const version = manualCheckVersion.current;
    return () => mounted.current && !!scope && session.current === scope && version === manualCheckVersion.current;
  };
  const canAct = () => mounted.current && active && configLoaded && !!session.current && !isBusy && !pending.current;
  const begin = (name: Operation["name"]) => {
    const work: Operation = { name };
    pending.current = work;
    setOperation(name);
    setBusy(name);
    return work;
  };
  useEffect(() => {
    if (!configLoaded) return;
    const previousPolicy = previousPolicyRef.current;
    previousPolicyRef.current = codeyUpdatePolicy;
    if (previousPolicy === null || previousPolicy === codeyUpdatePolicy) return;
    manualCheckVersion.current += 1;
    invalidateReads();
    updateCheckRef.current = null;
    setUpdateCheck(null);
    setDownloadedUpdate(null);
    setUpdateResult({ tone: "idle", text: "" });
    publishUpdateAvailability(null);
    window.__codeyPendingUpdatePrompt = null;
    setConfirmation(current => current && ["download-update", "install-update", "view-update-notes"].includes(current.action) ? null : current);
  }, [codeyUpdatePolicy, configLoaded, invalidateReads]);
  const requestUpdateCheck = useCallback((forceRefresh = false, manual = false) => {
    if (policyRef.current === "off" && !manual) return Promise.reject(new Error("已关闭自动检查更新"));
    const current = updateCheckInFlightRef.current;
    if (current && !forceRefresh) return current;
    let timer: number;
    const request = new Promise<UpdateCheck>((resolve, reject) => {
      timer = window.setTimeout(() => reject(new Error("检查更新超时，请检查网络")), UPDATE_CHECK_TIMEOUT_MS);
      readTimers.current.set(timer, () => { window.clearTimeout(timer); reject(new Error("更新检查已失效")); });
      appUpdateRequests.check(forceRefresh, manual).then(resolve, reject);
    }).finally(() => {
      window.clearTimeout(timer);
      readTimers.current.delete(timer);
      if (updateCheckInFlightRef.current === request) {
        updateCheckInFlightRef.current = null;
      }
    });
    updateCheckInFlightRef.current = request;
    return request;
  }, []);

  useEffect(() => {
    updateCheckRef.current = updateCheck;
  }, [updateCheck]);

  const showInstallReport = useStableEvent(() => {
    if (!mounted.current || !active || !configLoaded) return;
    const report = reportCache.current.report;
    reportCache.current.report = null;
    if (!report || report.status === "installed") return;
    setNotice(report.status === "started"
      ? { tone: "info", text: `v${report.version} 更新未完成，请重新打开 CodeyX 或再次点击更新` }
      : { tone: "error", text: updateInstallReportText(report) });
  });
  useEffect(() => {
    if (!active || !configLoaded) return;
    // 后端读取后删除报告；隐藏期间返回的报告保留到重开，不能重新读取而丢失它。
    if (!reportCache.current.requested) {
      reportCache.current.requested = true;
      void appUpdateRequests.installReport().then(report => {
        if (!mounted.current) return;
        reportCache.current.report = report;
        showInstallReport();
      }).catch(() => undefined);
    } else showInstallReport();
  }, [active, configLoaded, showInstallReport]);

  useEffect(() => {
    if (!active || !configLoaded) return;
    const applyDetectedUpdate = (
      result: UpdateCheck | null | undefined,
    ) => {
      if (pending.current || policyRef.current === "off" || !updateAvailable(result) || !updateVersionAllowed(result, policyRef.current)) return;
      setUpdateCheck(result);
      setDownloadedUpdate(null);
      setUpdateResult({
        tone: updateResultTone(result),
        text: updateCheckText(result),
      });
    };

    applyDetectedUpdate(window.__codeyUpdateAvailability);
    const handleUpdateAvailabilityChanged = (event: Event) => {
      applyDetectedUpdate((event as CustomEvent<UpdateCheck | null>).detail);
    };
    window.addEventListener(
      UPDATE_AVAILABLE_EVENT,
      handleUpdateAvailabilityChanged,
    );
    return () => {
      window.removeEventListener(
        UPDATE_AVAILABLE_EVENT,
        handleUpdateAvailabilityChanged,
      );
    };
  }, [active, configLoaded, codeyUpdatePolicy]);

  useEffect(() => {
    if (!active) return;
    const showPendingUpdate = () => {
      const result = window.__codeyPendingUpdatePrompt;
      if (!result || !configLoaded || isBusy || pending.current) return;
      window.__codeyPendingUpdatePrompt = null;
      if (manualCheckVersion.current > 0 || policyRef.current === "off" || !result.updateAvailable || !result.selectedAsset || !updateVersionAllowed(result, policyRef.current)) return;
      updateCheckRef.current = result;
      setUpdateCheck(result);
      setUpdateResult({ tone: updateResultTone(result), text: updateCheckText(result) });
      publishUpdateAvailability(result);
      if (promptedVersionRef.current === updatePromptKey(result) || readDeferredVersion() === updatePromptKey(result)) return;
      promptedVersionRef.current = updatePromptKey(result);
      confirmDownload(result, true);
    };
    showPendingUpdate();
    window.addEventListener(UPDATE_PROMPT_EVENT, showPendingUpdate);
    return () => window.removeEventListener(UPDATE_PROMPT_EVENT, showPendingUpdate);
  }, [active, configLoaded, isBusy, operation, codeyUpdatePolicy, setConfirmation]);

  useEffect(() => {
    if (!active || embedded || !configLoaded || codeyUpdatePolicy === "off") return;
    let cancelled = false;
    let timer = 0;

    const shouldPause = () =>
      [updateCheckRef.current, window.__codeyUpdateAvailability]
        .some(result => updateAvailable(result) && Boolean(result.selectedAsset));

    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = 0;
        void checkForUpdatesSilently();
      }, AUTO_UPDATE_CHECK_INTERVAL_MS);
    };

    const checkForUpdatesSilently = async () => {
      if (cancelled) return;
      // 暂停只影响本次检查，定时器链必须继续，否则状态被手动清空后不再恢复自动检查。
      if (pending.current || shouldPause()) return schedule();
      const manualVersion = manualCheckVersion.current;
      setAutomaticallyChecking(true);
      try {
        const result = await requestUpdateCheck();
        if (cancelled || manualVersion !== manualCheckVersion.current) return;
        if (result.updateAvailable && updateVersionAllowed(result, policyRef.current)) {
          setUpdateCheck(result);
          setDownloadedUpdate(null);
          setUpdateResult({
            tone: updateResultTone(result),
            text: updateCheckText(result),
          });
          publishUpdateAvailability(result);
          const deferredVersion = readDeferredVersion();
          if (
            result.selectedAsset &&
            promptedVersionRef.current !== updatePromptKey(result) &&
            deferredVersion !== updatePromptKey(result)
          ) {
            promptedVersionRef.current = updatePromptKey(result);
            confirmDownload(result);
          }
          return;
        }
        setUpdateResult({
          tone: "success",
          text: updateCheckText(result),
        });
      } catch {
        if (!cancelled && manualVersion === manualCheckVersion.current) {
          setUpdateResult({ tone: "idle", text: "" });
        }
        // 更新地址不可达或检查超时时直接跳过；手动检查仍会展示具体错误。
      } finally {
        if (!cancelled) {
          setAutomaticallyChecking(false);
          schedule();
        }
      }
    };

    void checkForUpdatesSilently();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (mounted.current) setAutomaticallyChecking(false);
    };
  }, [active, codeyUpdatePolicy, configLoaded, embedded, requestUpdateCheck]);

  const checkForUpdates = useStableEvent(async () => {
    if (!canAct()) return;
    manualCheckVersion.current += 1;
    const current = currentScope();
    const work = begin("check-update");
    setUpdateResult({ tone: "pending", text: "正在检查更新…" });
    setUpdateCheck(null);
    setDownloadedUpdate(null);
    try {
      const result = await requestUpdateCheck(true, true);
      if (!current()) return;
      if (result.updateAvailable && !updateVersionAllowed(result, policyRef.current)) {
        throw new Error("当前更新策略仅检查稳定版，已忽略实验版更新");
      }
      setUpdateCheck(result);
      publishUpdateAvailability(result);
      const text = updateCheckText(result);
      setUpdateResult({
        tone: updateResultTone(result),
        text,
      });
      setNotice({
        tone:
          result.updateAvailable && result.selectedAsset
            ? "info"
            : result.updateAvailable
              ? "error"
              : "success",
        text,
      });
      if (result.updateAvailable && result.selectedAsset) {
        promptedVersionRef.current = updatePromptKey(result);
        if (
          matchesDownloadedUpdate(downloadedUpdate, result)
        ) {
          setDownloadedUpdate(downloadedUpdate);
          confirmInstall(downloadedUpdate, result);
        } else {
          confirmDownload(result);
        }
      } else if (result.releaseNotes?.trim()) {
        setConfirmation({
          action: "view-update-notes",
          title: `CodeyX 更新公告 v${result.latestVersion}`,
          description: text,
          ...releaseAnnouncement(result),
          confirmLabel: "关闭",
          run: () => undefined,
        });
      }
    } catch (error) {
      if (!current()) return;
      const text = errorText(error);
      setUpdateResult({ tone: "error", text });
      setNotice({ tone: "error", text });
    } finally {
      finish(work);
    }
  });

  function confirmDownload(target: UpdateCheck, background = false) {
    const current = currentScope();
    const confirmation: Confirmation = {
      action: "download-update",
      title: `发现 CodeyX 新版本 v${target.latestVersion}`,
      description: [
        `当前版本为 v${target.currentVersion}，检测到新版本 v${target.latestVersion}。`,
        "是否立即下载更新？",
      ]
        .filter(Boolean)
        .join("\n\n"),
      ...releaseAnnouncement(target),
      confirmLabel: "立即更新",
      run: () => { if (current()) void downloadUpdate(target); },
      // 用户已经在这次运行里明确推迟过这个版本，自动检查就不再反复弹窗。
      onDismiss: () => { if (current()) writeDeferredVersion(updatePromptKey(target)); },
    };
    setConfirmation(background ? current => current ?? confirmation : confirmation);
  }
  const askDownloadUpdate = useStableEvent((check?: UpdateCheck | null, background: boolean = false) => {
    const target = check ?? updateCheck;
    if (canAct() && target?.updateAvailable && target.selectedAsset && updateVersionAllowed(target, policyRef.current)) confirmDownload(target, background);
  });

  const downloadUpdate = useStableEvent(async (checkOverride?: UpdateCheck | null) => {
    const target = checkOverride ?? updateCheck;
    if (
      !canAct() ||
      !target?.updateAvailable ||
      !target.selectedAsset ||
      !updateVersionAllowed(target, policyRef.current)
    )
      return;
    manualCheckVersion.current += 1;
    const current = currentScope();
    const work = begin("download-update");
    let timedOut = false;
    setDownloadedUpdate(null);
    setUpdateResult({ tone: "pending", text: "正在下载并校验更新…" });
    try {
      work.timer = window.setTimeout(() => {
        timedOut = true;
        if (!current()) return;
        const text = "下载更新超时，后台结果尚未确认，请等待请求结束后重新检查更新";
        setUpdateResult({ tone: "error", text });
        setNotice({ tone: "error", text });
      }, 300_000);
      const result = await appUpdateRequests.download(target, target.selectedAsset);
      if (!current() || timedOut) return;
      setDownloadedUpdate(result);
      const text = `已下载 ${result.fileName}（${formatBytes(result.size)}），校验通过`;
      setUpdateResult({ tone: "success", text });
      setNotice({ tone: "success", text });
      confirmInstall(result, target);
    } catch (error) {
      if (!current() || timedOut) return;
      const text = errorText(error);
      setUpdateResult({ tone: "error", text });
      setNotice({ tone: "error", text });
    } finally {
      finish(work);
    }
  });

  function confirmInstall(target: UpdateDownload, check?: UpdateCheck | null) {
    const current = currentScope();
    const announcement = check?.latestVersion === target.latestVersion && check.releaseId === target.releaseId ? check : null;
    setConfirmation({
      action: "install-update",
      title: "安装更新",
      description: `CodeyX 会先保存未保存的设置，再退出当前实例，安装 ${target.fileName}，然后尝试启动新版。`,
      ...releaseAnnouncement(announcement),
      confirmLabel: "安装并重启",
      run: () => { if (current()) void installDownloadedUpdate(target); },
      // 安装包已经下载好，"稍后"只影响自动提示，不影响用户从版本入口手动安装。
      onDismiss: () => { if (current()) writeDeferredVersion(updatePromptKey(target)); },
    });
  }
  const askInstallDownloadedUpdate = useStableEvent((downloadOverride?: UpdateDownload | null, checkOverride?: UpdateCheck | null) => {
    const target = downloadOverride ?? downloadedUpdate;
    if (canAct() && target && updateVersionAllowed(target, policyRef.current)) confirmInstall(target, checkOverride ?? updateCheck);
  });

  const installDownloadedUpdate = useStableEvent(async (downloadOverride?: UpdateDownload | null) => {
    const target = downloadOverride ?? downloadedUpdate;
    if (!canAct() || !target || !updateVersionAllowed(target, policyRef.current)) return;
    manualCheckVersion.current += 1;
    let current = currentScope();
    const scope = session.current;
    const version = manualCheckVersion.current;
    const previousPolicy = policyRef.current;
    const submittedPolicy = config?.codeyUpdatePolicy ?? previousPolicy;
    const work = begin("install-update");
    let started = false;
    setUpdateResult({ tone: "pending", text: "正在启动安装器…" });
    try {
      await beforeInstall();
      // 安装前保存可以提交本次草稿里的更新策略；只接受这一轮预期变化。
      const savedPolicy = manualCheckVersion.current === version + 1
        && submittedPolicy !== previousPolicy && policyRef.current === submittedPolicy;
      if (!mounted.current || session.current !== scope || (!current() && !savedPolicy)) return;
      current = currentScope();
      if (!updateVersionAllowed(target, submittedPolicy) || !updateVersionAllowed(target, policyRef.current)) {
        throw new Error("已保存的更新策略不允许安装此版本，请重新检查更新");
      }
      await appUpdateRequests.install(target.filePath);
      started = true;
      if (!current()) return;
      const text = "正在退出 CodeyX 并启动安装器…";
      setUpdateResult({ tone: "pending", text });
      setNotice({ tone: "info", text });
    } catch (error) {
      if (!current()) return;
      const text = errorText(error);
      setUpdateResult({ tone: "error", text });
      setNotice({ tone: "error", text });
    } finally {
      // 安装器已接手后保持忙碌，等待当前实例退出；不能再次启动安装。
      if (!started) finish(work);
    }
  });

  const changeUpdatePolicy = useStableEvent((policy: Config["codeyUpdatePolicy"]) => {
    if (!canAct() || !config || !onConfigChange) return;
    if (policy !== "experimental" || config.codeyUpdatePolicy === "experimental") {
      onConfigChange({ ...config, codeyUpdatePolicy: policy });
      return;
    }
    const current = currentScope();
    setConfirmation({
      action: "enable-experimental-updates",
      title: "切换到实验版更新？",
      description: "实验版尚未经过充分验证，可能出现功能异常、启动失败或数据兼容问题。请先备份重要数据，避免在关键工作环境使用。确认并保存设置后生效；取消会保留原设置。",
      confirmLabel: "了解风险，使用实验版",
      run: () => { if (current()) applyExperimentalPolicy(); },
    });
  });
  const applyExperimentalPolicy = useStableEvent(() => {
    if (canAct() && config) onConfigChange?.({ ...config, codeyUpdatePolicy: "experimental" });
  });

  return {
    automaticallyChecking,
    updateResult,
    updateCheck,
    downloadedUpdate,
    checkForUpdates,
    downloadUpdate,
    askDownloadUpdate,
    askInstallDownloadedUpdate,
    changeUpdatePolicy,
  };
}
