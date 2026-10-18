import { useMemo, useState } from "react";
import type { Config, ModelState, Notice, Profile, ProviderStatus } from "../../App.types";
import { errorText } from "../../appUtils";
import { modelKey } from "../../modelIds";
import { useOperationScope } from "../../useOperationScope";
import { useStableEvent } from "../../useStableEvent";
import { officialModelCatalog, routeModelGroups, visibleRoutes } from "./catalog";

type Options = {
  active: boolean;
  config: Config;
  currentProvider: ProviderStatus["provider"] | null;
  modelState: ModelState;
  officialAccountAvailable: boolean;
  isBusy: boolean;
  dirty: boolean;
  onSetRouteEnabled: (routeId: string, enabled: boolean) => Promise<boolean>;
  onNotice: (notice: Notice) => void;
};

export function useRouteCatalogController(options: Options) {
  const { active, config, currentProvider, modelState, officialAccountAvailable } = options;
  const [pendingRouteToggle, setPendingRouteToggle] = useState<{ id: string; enabled: boolean } | null>(null);
  const scope = useOperationScope(active && config.localRouterEnabled);
  const officialCatalog = useMemo(() => officialModelCatalog(modelState), [modelState]);
  const visibleProfiles = useMemo(() => visibleRoutes(config, currentProvider, officialAccountAvailable, pendingRouteToggle),
    [config, currentProvider, officialAccountAvailable, pendingRouteToggle]);
  const modelGroups = useMemo(() => routeModelGroups(config, modelState, visibleProfiles, officialCatalog),
    [config, modelState, visibleProfiles, officialCatalog]);
  const modelGroupByProviderId = useMemo(() => new Map(modelGroups.map(group => [group.providerId, group])), [modelGroups]);
  const officialDisplayNames = useMemo(() => new Map(modelState.officialModels.map(model => [modelKey(model.slug), model.displayName])), [modelState]);
  const handleToggleRouteEnabled = useStableEvent(async (profile: Profile, enabled: boolean) => {
    if (options.isBusy || options.dirty) return;
    const operation = scope.begin();
    if (!operation) return;
    setPendingRouteToggle({ id: profile.id, enabled });
    try { await options.onSetRouteEnabled(profile.id, enabled); }
    catch (cause) { if (operation.current()) options.onNotice({ tone: "error", text: errorText(cause) }); }
    finally {
      // 只清理本次乐观展示，不修改共享配置草稿；隐藏期间仍持有写入锁。
      if (operation.finish()) setPendingRouteToggle(null);
    }
  });
  return { officialCatalog, officialDisplayNames, visibleProfiles, modelGroupByProviderId,
    totalModelCount: modelGroups.reduce((count, group) => count + group.models.length, 0),
    pendingRouteToggle, handleToggleRouteEnabled };
}
