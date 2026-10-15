import type { OfficialAccount, OfficialAccountsResult } from "../../App.types";

export type OfficialAccountsControllerOptions = {
  active: boolean;
  isBusy: boolean;
  onAccountsLoaded?: (accounts: OfficialAccount[] | null) => void;
  onAccountsChanged: (result: OfficialAccountsResult) => void;
  onNotice: (notice: { tone: "success" | "info" | "error"; text: string }) => void;
};

export type AccountLoginStart = { loginId: string; authUrl: string; browserOpened?: boolean };
export type AccountLoginPoll = OfficialAccountsResult & {
  status: "wait" | "ok" | "failed" | "expired";
  message?: string;
};
export type AccountAuthorization = AccountLoginStart & (
  { kind: "login" } | { kind: "siwc"; accountId: string }
);

export type AccountUsageSnapshot = {
  status: string; message?: string; reason?: string; fetchedAt?: number; stale?: boolean;
  // 额度接口返回当前套餐，优先于添加账号时保存的快照。
  planType?: string;
  primary?: { usedPercent: number; windowMinutes: number; resetsAt?: number } | null;
  secondary?: { usedPercent: number; windowMinutes: number; resetsAt?: number } | null;
};
