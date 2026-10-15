import { createControllerHarness } from "./controller-harness.mjs";

export const catalog = { officialAccountAvailable: false, profiles: [], selectedModelsByProvider: {}, declaredOfficialModelsByProvider: {}, upstreamModelsByProvider: {} };
export const logPage = (id = "current", nextCursor = null) => ({
  status: "ok", backend: "sqlite", queryable: true, page: 1, pageSize: 20,
  total: 10_000, totalPages: 500, items: [{ requestId: id, timestampUnixMs: 900, requestedModel: "model-a" }], nextCursor, hasMore: true,
});
export function createLogHarness(handlers = {}) {
  const calls = [];
  const invoke = async (command, args) => {
    calls.push({ command, args });
    if (handlers[command]) return handlers[command](args);
    if (command === "query_route_request_logs") return logPage(`page-${args.page}`);
    if (command === "query_route_request_log_stats") return { queryable: true, total: 10_000, groups: [] };
    if (command === "query_route_request_log_models") return { queryable: true, models: ["model-a"], nextCursor: null };
    if (command === "list_official_accounts") return { accounts: [] };
    if (command === "clear_route_request_logs") return { status: "ok", removedFileCount: 1 };
    throw new Error(`Unexpected command: ${command}`);
  };
  const harness = createControllerHarness(new URL("../../src/features/request-logs/useRequestLogsController.ts", import.meta.url), "useRequestLogsController", {
    "../../api": { invoke },
    "../../officialAccountsRequests": { listOfficialAccounts: () => invoke("list_official_accounts", {}) },
  });
  return { ...harness, get writesAfterUnmount() { return harness.writesAfterUnmount; }, calls,
    requests: (command) => calls.filter((call) => call.command === command).map((call) => call.args) };
}
