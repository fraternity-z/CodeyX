import type { Config, ModelState, Profile } from "../../App.types";
import { uniqueModelIds } from "../../modelIds";
import { globalDefaultForRoute, routeProviderId } from "../../modelRoutes";

export function thirdPartyRouteModelState(config: Config, route: Profile, catalog: ModelState): ModelState {
  const providerId = routeProviderId(route);
  const selectedModels = uniqueModelIds([
    ...(config.selectedModelsByProvider[providerId] || []),
    ...(config.declaredOfficialModelsByProvider[providerId] || []),
  ]);
  return {
    officialModels: [], officialModelIds: [], thirdPartyModels: selectedModels,
    thirdPartyModelMetadata: catalog.thirdPartyModelMetadata,
    manualThirdPartyModels: config.manualThirdPartyModelsByProvider[providerId] || [],
    upstreamModels: uniqueModelIds([...(config.upstreamModelsByProvider[providerId] || []), ...selectedModels]),
    defaultModel: globalDefaultForRoute(config, route, selectedModels) || selectedModels[0] || "",
  };
}
