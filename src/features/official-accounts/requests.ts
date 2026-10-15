import { invoke } from "../../api";
import type { OfficialAccountsResult } from "../../App.types";
import type { AccountUsageSnapshot } from "./types";

export const accountUsageRequests = {
  usage: (accountId: string, forceRefresh: boolean) =>
    invoke<AccountUsageSnapshot>("query_official_account_usage", { accountId, forceRefresh }),
  refreshRoutes: () => invoke<OfficialAccountsResult>("refresh_official_account_routes"),
};
