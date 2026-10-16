import { invoke } from "../../api";
import type { usageQuery } from "./state";
import type { LogAnalytics } from "./types";

export const usageAnalysisRequests = {
  stats: (query: ReturnType<typeof usageQuery>) => invoke<LogAnalytics>("query_route_request_log_stats", query),
};
