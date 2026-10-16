export type LogSummary = {
  total: number;
  succeededCount: number;
  failedCount: number;
  incompleteCount: number;
  cancelledCount: number;
  successRate: number | null;
  avgDuration: number | null;
  avgTtft: number | null;
  avgOutputTokensPerSecond: number | null;
  avgRouterPreUpstream: number | null;
  avgUpstreamHeader: number | null;
  avgUpstreamFirstByte: number | null;
  avgDownstreamFirstContent: number | null;
  avgQueueDelay: number | null;
  inputTokensSum: number | null;
  outputTokensSum: number | null;
  totalTokensSum: number | null;
  cachedTokensSum: number | null;
  usageReportedCount: number;
  totalTokensKnownCount: number;
};

export type LogAnalytics = LogSummary & {
  queryable: boolean;
  reason?: string;
  fromUnixMs: number;
  toUnixMs: number;
  groups: Array<LogSummary & { key: string }>;
  groupsTruncated: boolean;
  trend: Array<{ timestampUnixMs: number; total: number; totalTokensSum: number | null; avgDuration: number | null; avgTtft: number | null; avgOutputTokensPerSecond: number | null; avgDownstreamFirstContent: number | null }>;
  bucketMs: number;
  dailyTrend?: UsageDay[];
  databaseBytes?: number;
  walBytes?: number;
  recordingHealth?: {
    enabled: boolean; active: boolean; sampleRatePerMillion: number; pendingEntries: number;
    accepted: number; entriesWritten: number; sampledOut: number;
    droppedFull: number; droppedClosed: number; writeDropped: number; writeFailures: number;
    observerPanics: number; writerPanics: number; shutdownTimeouts: number;
  } | null;
};

export type UsageRange = "7d" | "30d" | "all";
export type UsageLoadState = { loading: boolean; data: LogAnalytics | null; error: string };
export type UsageDay = { timestampUnixMs: number; total: number; totalTokensSum: number | null; totalTokensKnownCount: number };
