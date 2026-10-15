import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { invoke } from "./api";
import type {
  Confirmation,
  Config,
  InlineResult,
  Notice,
  UpdateCheck,
  UpdateDownload,
  UpdateInstallReport,
} from "./App.types";
import { errorText, withTimeout } from "./appUtils";
import { formatBytes } from "./formatters";

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

function updateInstallReportText(report: UpdateInstallReport): string {
  return report.message
    ? `v${report.version} 更新未完成：${report.message}`
    : `v${report.version} 更新未完成，请重试`;
}

type UseAppUpdatesOptions = {
  embedded: boolean;
  configLoaded: boolean;
  codeyUpdatePolicy: Config["codeyUpdatePolicy"];
  isBusy: boolean;
  setBusy: Dispatch<SetStateAction<string | null>>;
  setNotice: Dispatch<SetStateAction<Notice>>;
  setConfirmation: Dispatch<SetStateAction<Confirmation | null>>;
  beforeInstall: () => Promise<void>;
};

const updateAvailable = (
  check: UpdateCheck | null | undefined,
): check is UpdateCheck => check?.updateAvailable === true;

function updateVersionAllowed(update: Pick<UpdateCheck, "latestVersion" | "prerelease">, policy: Config["codeyUpdatePolicy"]): boolean {
  return policy === "experimental" || (!update.prerelease && !update.latestVersion.split("+")[0].includes("-"));
}

function updatePromptKey(result: Pick<UpdateCheck, "latestVersion">): string {
  return result.latestVersion;
}

function updateCheckText(result: UpdateCheck) {
  return result.updateAvailable
    ? result.selectedAsset
      ? `发现 v${result.latestVersion} 更新（当前 v${result.currentVersion}）`
      : `发现 v${result.latestVersion} 更新，但当前系统暂无可安装包`
    : `当前已是最新版本 v${result.currentVersion}`;
}

function releaseAnnouncement(result?: UpdateCheck | null) {
  return {
    releaseNotes: result?.releaseNotes ?? undefined,
    releaseTitle: result?.releaseTitle ?? undefined,
    releaseUrl: result?.releaseUrl ?? undefined,
  };
}

function updateResultTone(result: UpdateCheck): InlineResult["tone"] {
  return result.updateAvailable && !result.selectedAsset
    ? "error"
    : "success";
}

function publishUpdateAvailability(result: UpdateCheck | null) {
  window.__codeyUpdateAvailability = updateAvailable(result) ? result : null;
  window.dispatchEvent(
    new CustomEvent(UPDATE_AVAILABLE_EVENT, {
      detail: window.__codeyUpdateAvailability,
    }),
  );
}

export function useAppUpdates({
  embedded,
  configLoaded,
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
  policyRef.current = codeyUpdatePolicy;
  useEffect(() => {
    if (!configLoaded) return;
    const previousPolicy = previousPolicyRef.current;
    previousPolicyRef.current = codeyUpdatePolicy;
    if (previousPolicy === null || previousPolicy === codeyUpdatePolicy) return;
    manualCheckVersion.current += 1;
    updateCheckInFlightRef.current = null;
    updateCheckRef.current = null;
    setUpdateCheck(null);
    setDownloadedUpdate(null);
    setUpdateResult({ tone: "idle", text: "" });
    publishUpdateAvailability(null);
    window.__codeyPendingUpdatePrompt = null;
    setConfirmation(current => current && ["download-update", "install-update", "view-update-notes"].includes(current.action) ? null : current);
  }, [codeyUpdatePolicy, configLoaded]);
  const requestUpdateCheck = useCallback((forceRefresh = false, manual = false) => {
    if (policyRef.current === "off" && !manual) return Promise.reject(new Error("已关闭自动检查更新"));
    const current = updateCheckInFlightRef.current;
    if (current && !forceRefresh) return current;
    const request = withTimeout(
      invoke<UpdateCheck>("check_for_updates", { forceRefresh, ...(manual ? { manual: true } : {}) }),
      UPDATE_CHECK_TIMEOUT_MS,
      "检查更新超时，请检查网络",
    ).finally(() => {
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

  // 上一次"安装并重启"的真实结果。助手把结论写在配置目录里，这里读一次并
  // 展示，避免用户只看到版本号没变却没有任何解释。
  useEffect(() => {
    if (!configLoaded) return;
    let cancelled = false;
    void (async () => {
      let report: UpdateInstallReport | null = null;
      try {
        report = await invoke<UpdateInstallReport | null>("update_install_report");
      } catch {
        return;
      }
      if (cancelled || !report || report.status === "installed") return;
      if (report.status === "started") {
        setNotice({
          tone: "info",
          text: `v${report.version} 更新未完成，请重新打开 CodeyX 或再次点击更新`,
        });
        return;
      }
      setNotice({ tone: "error", text: updateInstallReportText(report) });
    })();
    return () => {
      cancelled = true;
    };
  }, [configLoaded, setNotice]);

  useEffect(() => {
    const applyDetectedUpdate = (
      result: UpdateCheck | null | undefined,
    ) => {
      if (policyRef.current === "off" || !updateAvailable(result) || !updateVersionAllowed(result, policyRef.current)) return;
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
  }, []);

  useEffect(() => {
    const showPendingUpdate = () => {
      const result = window.__codeyPendingUpdatePrompt;
      if (!result || !configLoaded || isBusy) return;
      window.__codeyPendingUpdatePrompt = null;
      if (manualCheckVersion.current > 0 || policyRef.current === "off" || !result.updateAvailable || !result.selectedAsset || !updateVersionAllowed(result, policyRef.current)) return;
      updateCheckRef.current = result;
      setUpdateCheck(result);
      setUpdateResult({ tone: updateResultTone(result), text: updateCheckText(result) });
      publishUpdateAvailability(result);
      if (promptedVersionRef.current === updatePromptKey(result) || readDeferredVersion() === updatePromptKey(result)) return;
      promptedVersionRef.current = updatePromptKey(result);
      askDownloadUpdate(result, true);
    };
    showPendingUpdate();
    window.addEventListener(UPDATE_PROMPT_EVENT, showPendingUpdate);
    return () => window.removeEventListener(UPDATE_PROMPT_EVENT, showPendingUpdate);
  }, [configLoaded, isBusy, codeyUpdatePolicy, setConfirmation]);

  useEffect(() => {
    if (embedded || !configLoaded || codeyUpdatePolicy === "off") return;
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
      if (shouldPause()) return schedule();
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
            askDownloadUpdate(result);
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
      setAutomaticallyChecking(false);
    };
  }, [codeyUpdatePolicy, configLoaded, embedded, requestUpdateCheck]);

  async function checkForUpdates() {
    if (!configLoaded || isBusy) return;
    manualCheckVersion.current += 1;
    const requestVersion = manualCheckVersion.current;
    setBusy("check-update");
    setUpdateResult({ tone: "pending", text: "正在检查更新…" });
    setUpdateCheck(null);
    setDownloadedUpdate(null);
    try {
      const result = await requestUpdateCheck(true, true);
      if (requestVersion !== manualCheckVersion.current) return;
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
          downloadedUpdate?.latestVersion === result.latestVersion &&
          downloadedUpdate.releaseId === result.releaseId &&
          Boolean(downloadedUpdate.prerelease) === Boolean(result.prerelease) &&
          downloadedUpdate.asset.url === result.selectedAsset.url &&
          downloadedUpdate.fileName === result.selectedAsset.fileName &&
          downloadedUpdate.sha256 === result.selectedAsset.sha256 &&
          downloadedUpdate.size === result.selectedAsset.size
        ) {
          setDownloadedUpdate(downloadedUpdate);
          askInstallDownloadedUpdate(downloadedUpdate, result);
        } else {
          askDownloadUpdate(result);
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
      if (requestVersion !== manualCheckVersion.current) return;
      const text = errorText(error);
      setUpdateResult({ tone: "error", text });
      setNotice({ tone: "error", text });
    } finally {
      setBusy(null);
    }
  }

  function askDownloadUpdate(check?: UpdateCheck | null, background = false) {
    const target = check ?? updateCheck;
    if (!target?.updateAvailable || !target.selectedAsset || !updateVersionAllowed(target, policyRef.current) || isBusy) return;
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
      run: () => void downloadUpdate(target),
      // 用户已经在这次运行里明确推迟过这个版本，自动检查就不再反复弹窗。
      onDismiss: () => writeDeferredVersion(updatePromptKey(target)),
    };
    setConfirmation(background ? current => current ?? confirmation : confirmation);
  }

  async function downloadUpdate(checkOverride?: UpdateCheck | null) {
    const target = checkOverride ?? updateCheck;
    if (
      !configLoaded ||
      isBusy ||
      !target?.updateAvailable ||
      !target.selectedAsset ||
      !updateVersionAllowed(target, policyRef.current)
    )
      return;
    setBusy("download-update");
    const requestVersion = manualCheckVersion.current;
    setDownloadedUpdate(null);
    setUpdateResult({ tone: "pending", text: "正在下载并校验更新…" });
    try {
      const result = await withTimeout(
        invoke<UpdateDownload>("download_update", {
          expectedVersion: target.latestVersion,
          expectedReleaseId: target.releaseId ?? null,
          expectedSha256: target.selectedAsset.sha256,
        }),
        300_000,
        "下载更新超时，请稍后重试",
      );
      if (requestVersion !== manualCheckVersion.current) return;
      setDownloadedUpdate(result);
      const text = `已下载 ${result.fileName}（${formatBytes(result.size)}），校验通过`;
      setUpdateResult({ tone: "success", text });
      setNotice({ tone: "success", text });
      askInstallDownloadedUpdate(result, target);
    } catch (error) {
      if (requestVersion !== manualCheckVersion.current) return;
      const text = errorText(error);
      setUpdateResult({ tone: "error", text });
      setNotice({ tone: "error", text });
    } finally {
      setBusy(null);
    }
  }

  function askInstallDownloadedUpdate(downloadOverride?: UpdateDownload | null, checkOverride?: UpdateCheck | null) {
    const target = downloadOverride ?? downloadedUpdate;
    if (!target || !updateVersionAllowed(target, policyRef.current) || isBusy) return;
    const check = checkOverride ?? updateCheck;
    const announcement = check?.latestVersion === target.latestVersion && check.releaseId === target.releaseId ? check : null;
    setConfirmation({
      action: "install-update",
      title: "安装更新",
      description: `CodeyX 会先保存未保存的设置，再退出当前实例，安装 ${target.fileName}，然后尝试启动新版。`,
      ...releaseAnnouncement(announcement),
      confirmLabel: "安装并重启",
      run: () => void installDownloadedUpdate(target),
      // 安装包已经下载好，"稍后"只影响自动提示，不影响用户从版本入口手动安装。
      onDismiss: () => writeDeferredVersion(updatePromptKey(target)),
    });
  }

  async function installDownloadedUpdate(downloadOverride?: UpdateDownload | null) {
    const target = downloadOverride ?? downloadedUpdate;
    if (!target || !updateVersionAllowed(target, policyRef.current) || isBusy) return;
    setBusy("install-update");
    setUpdateResult({ tone: "pending", text: "正在启动安装器…" });
    try {
      await beforeInstall();
      await invoke("install_downloaded_update", {
        filePath: target.filePath,
      });
      const text = "正在退出 CodeyX 并启动安装器…";
      setUpdateResult({ tone: "pending", text });
      setNotice({ tone: "info", text });
    } catch (error) {
      const text = errorText(error);
      setUpdateResult({ tone: "error", text });
      setNotice({ tone: "error", text });
      setBusy(null);
    }
  }

  return {
    automaticallyChecking,
    updateResult,
    updateCheck,
    downloadedUpdate,
    checkForUpdates,
    downloadUpdate,
    askDownloadUpdate,
    askInstallDownloadedUpdate,
  };
}
