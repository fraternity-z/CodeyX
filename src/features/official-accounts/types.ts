export type AccountUsageSnapshot = {
  status: string; message?: string; reason?: string; fetchedAt?: number; stale?: boolean;
  // 额度接口返回当前套餐，优先于添加账号时保存的快照。
  planType?: string;
  primary?: { usedPercent: number; windowMinutes: number; resetsAt?: number } | null;
  secondary?: { usedPercent: number; windowMinutes: number; resetsAt?: number } | null;
};
