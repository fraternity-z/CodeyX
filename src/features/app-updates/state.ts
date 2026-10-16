import type { Config, InlineResult, UpdateCheck, UpdateDownload, UpdateInstallReport } from "../../App.types";

export const updateAvailable = (check: UpdateCheck | null | undefined): check is UpdateCheck =>
  check?.updateAvailable === true;

export function updateVersionAllowed(update: Pick<UpdateCheck, "latestVersion" | "prerelease">, policy: Config["codeyUpdatePolicy"]): boolean {
  return policy === "experimental" || (!update.prerelease && !update.latestVersion.split("+")[0].includes("-"));
}

export function updatePromptKey(result: Pick<UpdateCheck, "latestVersion">): string {
  return result.latestVersion;
}

export function updateCheckText(result: UpdateCheck) {
  return result.updateAvailable
    ? result.selectedAsset
      ? `发现 v${result.latestVersion} 更新（当前 v${result.currentVersion}）`
      : `发现 v${result.latestVersion} 更新，但当前系统暂无可安装包`
    : `当前已是最新版本 v${result.currentVersion}`;
}

export function releaseAnnouncement(result?: UpdateCheck | null) {
  return {
    releaseNotes: result?.releaseNotes ?? undefined,
    releaseTitle: result?.releaseTitle ?? undefined,
    releaseUrl: result?.releaseUrl ?? undefined,
  };
}

export function updateResultTone(result: UpdateCheck): InlineResult["tone"] {
  return result.updateAvailable && !result.selectedAsset ? "error" : "success";
}

export function updateInstallReportText(report: UpdateInstallReport): string {
  return report.message
    ? `v${report.version} 更新未完成：${report.message}`
    : `v${report.version} 更新未完成，请重试`;
}

export function matchesDownloadedUpdate(download: UpdateDownload | null, check: UpdateCheck): download is UpdateDownload {
  const asset = check.selectedAsset;
  return !!download && !!asset && download.latestVersion === check.latestVersion
    && download.releaseId === check.releaseId && Boolean(download.prerelease) === Boolean(check.prerelease)
    && download.asset.url === asset.url && download.fileName === asset.fileName
    && download.sha256 === asset.sha256 && download.size === asset.size;
}
