import { invoke } from "../../api";
import type { ModelSelectionInput, ModelSelectionResult } from "./types";

export const modelSelectionRequests = {
  save: ({ routeId, officialRoute, officialModels, thirdPartyModels, manualThirdPartyModels,
    deletedThirdPartyModels, supportsAutoReview, modelContexts, reasoningEfforts }: ModelSelectionInput) => {
    // 省略表示保留原值；空对象表示显式恢复默认，不能合并这两种语义。
    const contextUpdate = modelContexts === undefined ? {} : { modelContexts };
    return officialRoute
      ? invoke<ModelSelectionResult>("save_official_route_models", {
          routeId, models: officialModels, ...contextUpdate,
        })
      : invoke<ModelSelectionResult>("save_selected_models", {
          officialModels, thirdPartyModels, manualThirdPartyModels, deletedThirdPartyModels,
          supportsAutoReview, ...contextUpdate,
          ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
          ...(routeId === null ? {} : { routeId }),
        });
  },
};
