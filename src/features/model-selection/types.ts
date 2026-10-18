import type { Config, ModelContextConfig, ModelReasoningEffort, ModelState } from "../../App.types";
import type { ModelRuntimeUpdate } from "../../modelSelectionNotice";

export type ModelSelectionInput = {
  routeId: string | null;
  officialRoute: boolean;
  officialModels: string[];
  thirdPartyModels: string[];
  manualThirdPartyModels: string[];
  deletedThirdPartyModels: string[];
  supportsAutoReview: boolean;
  modelContexts?: Record<string, ModelContextConfig>;
  reasoningEfforts?: Record<string, ModelReasoningEffort[]>;
};

export type ModelSelectionResult = ModelRuntimeUpdate & {
  config: Config;
  modelState?: ModelState;
};
