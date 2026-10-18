import { invoke } from "../../api";
import type { PluginMarketplaceStatus } from "../../App.types";
import type { DiagnosticStorageCleanup, DiagnosticStorageTarget } from "../../diagnosticStorage";
import type { CodexConfigRepairResult } from "./types";

export const runtimeMaintenanceRequests = {
  marketplaceStatus: () => invoke<PluginMarketplaceStatus>("plugin_marketplace_status"),
  repairMarketplace: () => invoke<PluginMarketplaceStatus>("repair_plugin_marketplace"),
  prepareComputerUse: () => invoke<PluginMarketplaceStatus>("prepare_computer_use"),
  restart: () => invoke<void>("restart_codey"),
  repairInjection: () => invoke<void>("repair_main_process_injection"),
  repairConfig: () => invoke<CodexConfigRepairResult>("repair_codex_config"),
  selectCodexDirectory: () => invoke<string | null>("select_codex_app_directory"),
  clearDiagnosticStorage: (target: DiagnosticStorageTarget) =>
    invoke<DiagnosticStorageCleanup>("clear_diagnostic_storage", { target }),
};
