import { invoke } from "../../api";
import { listOfficialAccounts } from "../../officialAccountsRequests";
import { loadRequestLogModels, type ModelPage } from "../../requestLogModels";
import type { LogAnalytics } from "../../usageAnalysis";
import type { ClearRouteRequestLogsResult, LogCursor, RequestLogFilters, RouteRequestLogQueryPage } from "./types";

export const requestLogs = {
  list: (query: RequestLogFilters & { page: number; pageSize: number; cursor: LogCursor | null }) =>
    invoke<RouteRequestLogQueryPage>("query_route_request_logs", query),
  stats: (query: RequestLogFilters & { groupBy: string }) =>
    invoke<LogAnalytics>("query_route_request_log_stats", query),
  models: (query: Pick<RequestLogFilters, "fromUnixMs" | "toUnixMs" | "provider" | "officialAccountId">, active: () => boolean) =>
    loadRequestLogModels((afterModel) => invoke<ModelPage>("query_route_request_log_models", { ...query, afterModel }), active),
  accounts: listOfficialAccounts,
  clear: () => invoke<ClearRouteRequestLogsResult>("clear_route_request_logs", {}),
};
