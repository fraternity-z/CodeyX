import { invoke } from "../../api";
import type { OfficialAccountsResult } from "../../App.types";
import { listOfficialAccounts, rememberOfficialAccounts } from "../../officialAccountsRequests";
import type { AccountAuthorization, AccountLoginPoll, AccountLoginStart, AccountUsageSnapshot } from "./types";

export const officialAccountsRequests = {
  list: listOfficialAccounts,
  remember: rememberOfficialAccounts,
  startLogin: () => invoke<AccountLoginStart>("start_official_account_login"),
  startSiwc: (accountId: string) => invoke<AccountLoginStart>("start_official_account_siwc", { accountId }),
  poll: (authorization: AccountAuthorization) => invoke<AccountLoginPoll>(
    authorization.kind === "login" ? "poll_official_account_login" : "poll_official_account_siwc",
    { loginId: authorization.loginId },
  ),
  cancel: (authorization: AccountAuthorization) => invoke(
    authorization.kind === "login" ? "cancel_official_account_login" : "cancel_official_account_siwc",
    { loginId: authorization.loginId },
  ),
  importCurrent: () => invoke<OfficialAccountsResult>("import_current_codex_login"),
  importCredential: (credential: string) => invoke<OfficialAccountsResult>("import_official_account_credential", { credential }),
  setDefault: (accountId: string) => invoke<OfficialAccountsResult>("set_default_official_account", { accountId }),
  remove: (accountId: string) => invoke<OfficialAccountsResult>("remove_official_account", { accountId }),
  removeSiwc: (accountId: string) => invoke<OfficialAccountsResult>("remove_official_account_siwc", { accountId }),
};

export const accountUsageRequests = {
  usage: (accountId: string, forceRefresh: boolean) =>
    invoke<AccountUsageSnapshot>("query_official_account_usage", { accountId, forceRefresh }),
  refreshRoutes: () => invoke<OfficialAccountsResult>("refresh_official_account_routes"),
};
