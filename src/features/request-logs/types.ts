import type { Config, Profile } from "../../App.types";

export type RouteRequestLogItem = {
  requestId: string;
  traceId: string;
  timestampUnixMs: number;
  provider?: string | null;
  providerName?: string | null;
  officialAccountId?: string | null;
  requestedModel: string;
  requestedServiceTier?: string | null;
  serviceTier?: string | null;
  model?: string | null;
  /// 上游响应里回报的实际使用模型，上游没有回报时为空。
  upstreamResponseModel?: string | null;
  reasoningEffort?: string | null;
  thinkingBudgetTokens?: number | null;
  ttftMs?: number | null;
  routerPreUpstreamMs?: number | null;
  upstreamFirstByteMs?: number | null;
  downstreamFirstContentMs?: number | null;
  upstreamHeaderMs?: number | null;
  totalDurationMs: number;
  outputTokensPerSecond?: number | null;
  queueDelayMs: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  reasoningOutputTokens?: number | null;
  totalTokens?: number | null;
  usageReported: boolean;
  usageUnavailableReason?: string | null;
  requestProtocol: string;
  upstreamTransport?: string | null;
  requestKind: string;
  status: string;
  statusCode?: number | null;
  upstreamStatusCode?: number | null;
  errorCode?: string | null;
  upstreamErrorSummary?: string | null;
  completionReason?: string | null;
  fallbackCount: number;
  fallbackReason?: string | null;
  upstreamAuthority?: string | null;
  upstreamRequestHeaders?: string | null;
  upstreamResponseHeaders?: string | null;
  upstreamRequestId?: string | null;
  upstreamProtocol?: string | null;
  protocolBridge?: string | null;
  requestInputState?: string | null;
  requestInputItems?: number | null;
  requestHasPreviousResponseId?: boolean | null;
  requestBytes?: number | null;
  upstreamInputState?: string | null;
  upstreamInputItems?: number | null;
  upstreamHasPreviousResponseId?: boolean | null;
  upstreamBytes?: number | null;
  firstByteSource?: string | null;
  codexSessionId?: string | null;
  codexSessionIsParent?: boolean | null;
  subagent: boolean;
};

export type LogCursor = { timestampUnixMs: number; requestId: string };
export type RouteRequestLogQueryPage = {
  status: "ok" | "unavailable";
  backend: "sqlite" | "ndjson";
  queryable: boolean;
  reason?: string;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  items: RouteRequestLogItem[];
  nextCursor: LogCursor | null;
  hasMore: boolean;
};

export type ClearRouteRequestLogsResult = {
  status: "ok" | "failed";
  message?: string;
  removedFileCount: number;
  removedFiles: string[];
  recordingEnabled: boolean;
  recordingActive: boolean;
  recordingRestarted: boolean;
  error?: string;
  restartError?: string;
};

export type ActionNotice = { tone: "success" | "error"; text: string };
export type RequestLogCatalog = {
  officialAccountAvailable: boolean;
  profiles: Array<Pick<Profile, "id" | "name" | "shortName" | "sourceProviderId" | "officialAccount" | "officialAccountId">>;
  selectedModelsByProvider: Config["selectedModelsByProvider"];
  declaredOfficialModelsByProvider: Config["declaredOfficialModelsByProvider"];
  upstreamModelsByProvider: Config["upstreamModelsByProvider"];
};

export type RequestLogFilters = {
  cursorMode: boolean;
  fromUnixMs: number;
  toUnixMs: number;
  search?: string;
  requestId?: string;
  sessionId?: string;
  provider?: string;
  officialAccountId?: string;
  model?: string;
  status?: string;
  protocol?: string;
  requestKind?: string;
};
