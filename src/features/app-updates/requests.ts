import { invoke } from "../../api";
import type { UpdateAsset, UpdateCheck, UpdateDownload, UpdateInstallReport } from "../../App.types";

export const appUpdateRequests = {
  check: (forceRefresh = false, manual = false) =>
    invoke<UpdateCheck>("check_for_updates", { forceRefresh, ...(manual ? { manual: true } : {}) }),
  installReport: () => invoke<UpdateInstallReport | null>("update_install_report"),
  download: (target: UpdateCheck, asset: UpdateAsset) => invoke<UpdateDownload>("download_update", {
    expectedVersion: target.latestVersion,
    expectedReleaseId: target.releaseId ?? null,
    expectedSha256: asset.sha256,
  }),
  install: (filePath: string) => invoke<void>("install_downloaded_update", { filePath }),
};
