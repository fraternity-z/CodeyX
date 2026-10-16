import type { DiagnosticStorageCleanup, DiagnosticStorageTarget } from "../../diagnosticStorage";

export type CodexConfigRepairResult = {
  message: string;
  configPath: string;
  repaired: boolean;
  backupPath?: string | null;
};

export type DiagnosticCleanupState = { target: DiagnosticStorageTarget } & (
  | { phase: "running" }
  | { phase: "complete"; result: DiagnosticStorageCleanup }
  | { phase: "failed"; error: string }
);
