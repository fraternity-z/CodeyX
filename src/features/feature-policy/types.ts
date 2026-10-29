import type { Config } from "../../App.types";
import type { CrashpadPendingStats } from "../../traceLogTypes";

export type FeaturePolicyConfig = Pick<Config,
  | "gpuLaunchMode"
  | "slimCodexPet"
  | "disableTraceLogWrites"
  | "protectCrashpadPending"
  | "hideFullAccessWarning"
>;

export type FeaturePolicyKey = keyof FeaturePolicyConfig;

export type FeaturePolicyRuntime = {
  configured: FeaturePolicyConfig;
  applied: Pick<FeaturePolicyConfig, "gpuLaunchMode" | "slimCodexPet"> | null;
  traceWatcherActive: boolean;
  traceProtection: {
    pending: boolean;
    capturedAt: number;
    lastSuccessfulAt: number | null;
    databasesFound: number;
    logTablesFound: number;
    errors: string[];
  };
  crashpadProtection: CrashpadPendingStats & { lastSuccessfulAt: number | null };
};

export type FeaturePolicyPhase =
  | "verified" | "applied" | "disabled" | "pending" | "applying"
  | "restart_required" | "failed" | "degraded" | "partial" | "stopped";

export type FeaturePolicyPresentation = {
  phase: FeaturePolicyPhase;
  label: string;
  variant: "success" | "secondary" | "info" | "warning" | "destructive";
  detail: string;
  unsaved: boolean;
};
