import type { Config, ModelState, OfficialAccountsResult, ProviderStatus } from "../../App.types";
import type { ModelRuntimeUpdate } from "../../modelSelectionNotice";

export type RouteResult = {
  config: Config;
  providerStatus?: ProviderStatus;
  modelState?: ModelState;
  restartRequired?: boolean;
} & ModelRuntimeUpdate;

export type SyncedRouteResult = RouteResult & { providerStatus: ProviderStatus; modelState: ModelState };
export type OfficialRouteResult = RouteResult & OfficialAccountsResult & { customContextsRestored?: boolean };
