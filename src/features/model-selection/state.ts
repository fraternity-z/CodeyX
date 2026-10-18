import type { Config, ModelContextConfig, ModelReasoningEffort, ModelState, ProviderStatus } from "../../App.types";
import { AUTO_REVIEW_MODEL, includesModelId, modelIdsEqual, modelKey, orderModelIdsBy, partitionModelIdsByKey, uniqueModelIds } from "../../modelIds";
import { normalizeReasoningEfforts, reasoningEffortsEqual, resolveModelReasoningEfforts } from "../../modelReasoningEfforts";
import { routeProviderId } from "../../modelRoutes";
import type { ModelSelectionInput } from "./types";

const MAX_MODEL_ID_BYTES = 512;
const MAX_MODEL_COUNT = 10_000;
const modelIdEncoder = new TextEncoder();
const AUTO_REVIEW_MODEL_KEY = modelKey(AUTO_REVIEW_MODEL);
// 线路模板没有给出档位时使用的默认思考强度。
export const DEFAULT_THIRD_PARTY_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"];

export const emptyModelState = (): ModelState => ({
  officialModels: [], officialModelIds: [], thirdPartyModels: [],
  manualThirdPartyModels: [], upstreamModels: [], defaultModel: "",
});

export function modelPickerDraft(state: ModelState, config: Config | null,
  currentProvider: ProviderStatus["provider"] | null, routeId: string | null) {
  const profile = config?.profiles.find(candidate => candidate.id === (routeId ?? config.activeProfileId));
  const providerId = routeId && profile ? routeProviderId(profile) : currentProvider?.id || (profile ? routeProviderId(profile) : "");
  const selection = [
    ...state.officialModels.filter(model => model.supported).map(model => model.slug),
    ...state.thirdPartyModels,
  ].filter(model => modelKey(model) !== AUTO_REVIEW_MODEL_KEY);
  const storedReasoningEfforts = config?.modelReasoningEffortsByProvider?.[providerId];
  const reasoningModels = uniqueModelIds([
    ...state.upstreamModels, ...state.thirdPartyModels, ...state.manualThirdPartyModels, ...selection,
  ]);
  const autoEfforts: Record<string, ModelReasoningEffort[]> = {};
  const efforts: Record<string, ModelReasoningEffort[]> = {};
  for (const model of reasoningModels) {
    const key = modelKey(model);
    if (autoEfforts[key]) continue;
    const declared = state.thirdPartyModelMetadata?.find(entry => modelKey(entry.slug) === key)?.autoSupportedReasoningEfforts;
    const stored = Object.entries(storedReasoningEfforts ?? {}).find(([name]) => modelIdsEqual(name, model))?.[1];
    const capability = profile?.pluginOwnerId
      ? Object.entries(profile.pluginRouteSpec?.modelReasoningEfforts ?? {}).find(([name]) => modelIdsEqual(name, model))?.[1]
      : undefined;
    const resolved = resolveModelReasoningEfforts(
      declared?.length ? declared : DEFAULT_THIRD_PARTY_REASONING_EFFORTS, stored, capability,
    );
    autoEfforts[key] = resolved.autoEfforts;
    efforts[key] = resolved.efforts;
  }
  return {
    // 官方目录按缓存顺序返回，草稿沿用线路已保存的模型顺序。
    models: orderModelIdsBy(selection, config?.selectedModelsByProvider[providerId] || []),
    contexts: config?.modelContextByProvider?.[providerId] || {},
    autoEfforts, efforts,
  };
}

export function thirdPartyOptions(state: ModelState, draftModels: string[],
  officialKeys: ReadonlySet<string>, deletedKeys: ReadonlySet<string>, officialOnly: boolean) {
  if (officialOnly) return [];
  return uniqueModelIds([...state.upstreamModels, ...state.thirdPartyModels, ...draftModels])
    .filter(model => {
      const key = modelKey(model);
      return key !== AUTO_REVIEW_MODEL_KEY && !officialKeys.has(key) && !deletedKeys.has(key);
    });
}

export function customModelError(input: string, draftModels: string[], officialModelIds: string[],
  routeId: string | null, officialOnly: boolean) {
  if (officialOnly) return "官方线路只能勾选当前账号可用的模型";
  const model = input.trim();
  if (!model) return "请输入要添加的模型 ID";
  if (modelKey(model) === AUTO_REVIEW_MODEL_KEY) return `${AUTO_REVIEW_MODEL} 是线路能力，请使用上方 Auto Review 开关`;
  if (modelIdEncoder.encode(model).byteLength > MAX_MODEL_ID_BYTES) return `模型 ID 不能超过 ${MAX_MODEL_ID_BYTES} 字节`;
  if (draftModels.length >= MAX_MODEL_COUNT && !includesModelId(draftModels, model)) return `模型数量不能超过 ${MAX_MODEL_COUNT} 个`;
  const officialModel = routeId ? undefined : officialModelIds.find(official => modelIdsEqual(official, model));
  return officialModel ? `${officialModel} 已在上方官方模型列表中，请直接勾选，不可重复输入` : "";
}

type SelectionDraft = {
  routeId: string | null;
  officialRoute: boolean;
  officialOnly: boolean;
  localRouterEnabled: boolean;
  models: string[];
  officialKeys: ReadonlySet<string>;
  officialModelIds: string[];
  thirdPartyModelOptions: string[];
  manualModels: string[];
  deletedModels: string[];
  supportsAutoReview: boolean;
  contexts: Record<string, ModelContextConfig>;
  efforts: Record<string, ModelReasoningEffort[]>;
  autoEfforts: Record<string, ModelReasoningEffort[]>;
};

export function modelSelectionInput(draft: SelectionDraft): ModelSelectionInput {
  const { matching: officialModels, remaining: thirdPartyModels } = partitionModelIdsByKey(
    uniqueModelIds(draft.models), draft.officialKeys,
  );
  const thirdPartyKeys = new Set(thirdPartyModels.map(modelKey));
  const input: ModelSelectionInput = {
    routeId: draft.routeId, officialRoute: draft.officialRoute, officialModels, thirdPartyModels,
    manualThirdPartyModels: draft.manualModels.filter(model => thirdPartyKeys.has(modelKey(model))),
    deletedThirdPartyModels: draft.deletedModels, supportsAutoReview: draft.supportsAutoReview,
  };
  if (!draft.localRouterEnabled) return input;
  input.modelContexts = Object.fromEntries(Object.entries(draft.contexts).filter(([model]) =>
    includesModelId(draft.officialModelIds, model) || (!draft.officialOnly && includesModelId(draft.thirdPartyModelOptions, model)),
  ));
  if (!draft.officialOnly) {
    input.reasoningEfforts = {};
    for (const [key, efforts] of Object.entries(draft.efforts)) {
      const model = draft.thirdPartyModelOptions.find(candidate => modelKey(candidate) === key);
      if (!model) continue;
      const normalized = normalizeReasoningEfforts(efforts);
      if (!reasoningEffortsEqual(normalized, draft.autoEfforts[key] ?? [])) input.reasoningEfforts[model] = normalized;
    }
  }
  return input;
}
