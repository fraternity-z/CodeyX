import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import type {
  Config,
  ModelState,
  ModelContextConfig,
  ModelReasoningEffort,
  Notice,
  ProviderStatus,
  RuntimeStatus,
} from "../../App.types";
import {
  includesModelId,
  modelKey,
  uniqueModelIds,
  withoutModelId,
} from "../../modelIds";
import { buildSubagentModelOptions } from "../../subagentModels";
import { modelSelectionNotice } from "../../modelSelectionNotice";
import type { useDraftConfig } from "../../useDraftConfig";
import { autoReasoningEfforts } from "../../modelReasoningEfforts";
import { modelSelectionRequests } from "./requests";
import { customModelError, DEFAULT_THIRD_PARTY_REASONING_EFFORTS, emptyModelState,
  modelPickerDraft, modelSelectionInput, thirdPartyOptions } from "./state";

type UseModelSelectionOptions = {
  active?: boolean;
  config: Config | null;
  currentProvider: ProviderStatus["provider"] | null;
  officialAccountAvailable: boolean;
  runOperation: (name: string, action: () => Promise<void>) => Promise<void>;
  adoptRouteConfig: ReturnType<typeof useDraftConfig>["adoptRouteConfig"];
  setDirty: Dispatch<SetStateAction<boolean>>;
  setStatus: Dispatch<SetStateAction<RuntimeStatus>>;
  setNotice: Dispatch<SetStateAction<Notice>>;
};

export function useModelSelectionController({
  active = true,
  config,
  currentProvider,
  officialAccountAvailable,
  runOperation,
  adoptRouteConfig,
  setDirty,
  setStatus,
  setNotice,
}: UseModelSelectionOptions) {
  const mounted = useRef(true);
  const saving = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  const pageSession = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [modelState, setModelState] = useState<ModelState>(emptyModelState);
  const [modelPickerVisible, setModelPickerVisible] = useState(false);
  const [modelPickerLoading, setModelPickerLoading] = useState(false);
  const modelPickerSession = useRef(0);
  useEffect(() => {
    if (!active) {
      setModelPickerLoading(false);
      setModelPickerVisible(false);
    }
    return () => { pageSession.current++; modelPickerSession.current++; };
  }, [active]);
  const [modelPickerRouteId, setModelPickerRouteId] = useState<string | null>(null);
  const [modelPickerState, setModelPickerState] = useState<ModelState | null>(null);
  const [draftModels, setDraftModels] = useState<string[]>([]);
  const [draftReasoningEfforts, setDraftReasoningEfforts] = useState<
    Record<string, ModelReasoningEffort[]>
  >({});
  const [reasoningEffortAutoByModel, setReasoningEffortAutoByModel] = useState<
    Record<string, ModelReasoningEffort[]>
  >({});
  const [draftModelContexts, setDraftModelContexts] = useState<Record<string, ModelContextConfig>>({});
  const updateDraftModelContext = useCallback((model: string, policy: ModelContextConfig | undefined) => {
    setDraftModelContexts((current) => {
      const next = { ...current };
      for (const key of Object.keys(next)) if (modelKey(key) === modelKey(model)) delete next[key];
      if (policy) next[model] = policy;
      return next;
    });
  }, []);
  const updateDraftReasoningEffort = useCallback(
    (model: string, efforts: ModelReasoningEffort[]) => {
      setDraftReasoningEfforts((current) => ({
        ...current,
        [modelKey(model)]: efforts,
      }));
    },
    [],
  );
  const resetDraftReasoningEffort = useCallback((model: string) => {
    setDraftReasoningEfforts((current) => ({
      ...current,
      [modelKey(model)]:
        reasoningEffortAutoByModel[modelKey(model)] ??
        autoReasoningEfforts(DEFAULT_THIRD_PARTY_REASONING_EFFORTS),
    }));
  }, [reasoningEffortAutoByModel]);
  const [draftManualThirdPartyModels, setDraftManualThirdPartyModels] = useState<string[]>([]);
  const [deletedThirdPartyModels, setDeletedThirdPartyModels] = useState<string[]>([]);
  const [customModelInput, setCustomModelInput] = useState("");
  const [modelInputError, setModelInputError] = useState("");
  const [modelSyncWarning, setModelSyncWarning] = useState("");
  const [draftAutoReviewSupported, setDraftAutoReviewSupported] = useState(false);

  const modelEditorState = modelPickerState ?? modelState;
  const officialRoutePicker = Boolean(
    modelPickerRouteId &&
      config?.profiles.some(
        (profile) =>
          profile.id === modelPickerRouteId && profile.authMode === "officialAccount",
      ),
  );
  const officialOnly = Boolean(
    officialRoutePicker || (!modelPickerRouteId && currentProvider?.official),
  );
  const modelPickerReasoningCapabilities = useMemo(() => {
    const profile = config?.profiles.find(
      (entry) => entry.id === (modelPickerRouteId ?? config.activeProfileId),
    );
    return Object.fromEntries(Object.entries(
      profile?.pluginOwnerId ? profile.pluginRouteSpec?.modelReasoningEfforts ?? {} : {},
    ).map(([model, levels]) => [modelKey(model), levels]));
  }, [config, modelPickerRouteId]);
  const officialSlugKeys = useMemo(
    () =>
      new Set(
        (!modelPickerRouteId || officialRoutePicker)
          ? modelEditorState.officialModelIds.map(modelKey)
          : [],
      ),
    [modelEditorState.officialModelIds, modelPickerRouteId, officialRoutePicker],
  );
  const draftModelSet = useMemo(
    () => new Set(draftModels.map(modelKey)),
    [draftModels],
  );
  const draftManualThirdPartyModelKeys = useMemo(
    () => new Set(draftManualThirdPartyModels.map(modelKey)),
    [draftManualThirdPartyModels],
  );
  const manualThirdPartyModelKeys = useMemo(
    () => new Set(modelEditorState.manualThirdPartyModels.map(modelKey)),
    [modelEditorState.manualThirdPartyModels],
  );
  const deletedThirdPartyModelKeys = useMemo(
    () => new Set(deletedThirdPartyModels.map(modelKey)),
    [deletedThirdPartyModels],
  );
  const thirdPartyModelOptions = useMemo(
    () => thirdPartyOptions(modelEditorState, draftModels, officialSlugKeys, deletedThirdPartyModelKeys, officialOnly),
    [
      draftModels,
      deletedThirdPartyModelKeys,
      modelEditorState,
      officialSlugKeys,
      officialOnly,
    ],
  );
  const subagentModelOptions = useMemo(
    () =>
      buildSubagentModelOptions(
        config,
        modelState,
        officialAccountAvailable,
        currentProvider,
      ),
    [config, currentProvider, modelState, officialAccountAvailable],
  );

  const openModelPicker = useCallback((
    state: ModelState,
    warning = "",
    routeId: string | null = null,
    autoReviewSupported = false,
  ) => {
    if (!mounted.current || !activeRef.current) return;
    const draft = modelPickerDraft(state, config, currentProvider, routeId);
    setDraftModels(draft.models);
    setDraftModelContexts(draft.contexts);
    setReasoningEffortAutoByModel(draft.autoEfforts);
    setDraftReasoningEfforts(draft.efforts);
    setDraftManualThirdPartyModels(state.manualThirdPartyModels);
    setDeletedThirdPartyModels([]);
    setCustomModelInput("");
    setModelInputError("");
    setModelSyncWarning(warning);
    setModelPickerRouteId(routeId);
    setModelPickerState(state);
    setDraftAutoReviewSupported(autoReviewSupported);
    setModelPickerVisible(true);
  }, [config, currentProvider]);

  const beginModelPickerLoad = useCallback((
    routeId: string | null = null,
    autoReviewSupported = false,
  ) => {
    if (!mounted.current || !activeRef.current) return modelPickerSession.current;
    const session = modelPickerSession.current + 1;
    modelPickerSession.current = session;
    setModelPickerLoading(true);
    openModelPicker(emptyModelState(), "", routeId, autoReviewSupported);
    return session;
  }, [openModelPicker]);

  const completeModelPickerLoad = useCallback((
    session: number,
    state: ModelState,
    warning = "",
    routeId: string | null = null,
    autoReviewSupported = false,
  ) => {
    if (!mounted.current || !activeRef.current || modelPickerSession.current !== session) return;
    setModelPickerLoading(false);
    openModelPicker(state, warning, routeId, autoReviewSupported);
  }, [openModelPicker]);

  const cancelModelPickerLoad = useCallback((session: number) => {
    if (!mounted.current || !activeRef.current || modelPickerSession.current !== session) return;
    setModelPickerLoading(false);
    setModelSyncWarning("配置已更新，请关闭后重新同步模型");
  }, []);

  const setModelPickerOpen = useCallback((open: boolean) => {
    if (!mounted.current || !activeRef.current) return;
    if (!open) {
      modelPickerSession.current += 1;
      setModelPickerLoading(false);
    }
    setModelPickerVisible(open);
  }, []);

  const toggleDraftModel = useCallback((model: string | readonly string[], checked: boolean) => {
    const models = typeof model === "string" ? [model] : model;
    const keys = new Set(models.map(modelKey));
    if (checked) {
      setDeletedThirdPartyModels((current) =>
        current.filter((item) => !keys.has(modelKey(item))),
      );
    }
    setDraftModels((current) =>
      checked
        ? uniqueModelIds([...current, ...models])
        : current.filter((item) => !keys.has(modelKey(item))),
    );
    if (!checked) {
      const retainedKeys = new Set([...modelEditorState.upstreamModels.map(modelKey), ...officialSlugKeys]);
      setDraftReasoningEfforts((current) =>
        Object.fromEntries(
          Object.entries(current).filter(
            ([key]) => !keys.has(key) || retainedKeys.has(key),
          ),
        ),
      );
      setDraftManualThirdPartyModels((current) =>
        current.filter((item) => !keys.has(modelKey(item))),
      );
    }
  }, [modelEditorState.upstreamModels, officialSlugKeys]);

  const updateCustomModelInput = useCallback((value: string) => {
    setCustomModelInput(value);
    if (modelInputError) setModelInputError("");
  }, [modelInputError]);

  const addCustomModel = useCallback(() => {
    const error = customModelError(customModelInput, draftModels, modelEditorState.officialModelIds, modelPickerRouteId, officialOnly);
    if (error) {
      setModelInputError(error);
      return;
    }
    const model = customModelInput.trim();
    const existingUpstreamModel = modelEditorState.upstreamModels.find(
      (upstream) => modelKey(upstream) === modelKey(model),
    );
    setDraftModels((current) =>
      includesModelId(current, model) ? current : [...current, model],
    );
    if (!existingUpstreamModel || manualThirdPartyModelKeys.has(modelKey(model))) {
      setDraftManualThirdPartyModels((current) =>
        current.some((item) => modelKey(item) === modelKey(model))
          ? current
          : [...current, model],
      );
    }
    setDeletedThirdPartyModels((current) =>
      withoutModelId(current, model),
    );
    setCustomModelInput("");
    setModelInputError("");
  }, [
    customModelInput,
    draftModels,
    manualThirdPartyModelKeys,
    modelEditorState.officialModelIds,
    modelEditorState.upstreamModels,
    modelPickerRouteId,
    officialOnly,
  ]);

  const deleteDraftThirdPartyModel = useCallback((model: string) => {
    const normalized = model.trim();
    if (!normalized) return;
    const normalizedKey = modelKey(normalized);
    const wasManual = draftManualThirdPartyModelKeys.has(normalizedKey);
    if (!wasManual) return;
    setDraftReasoningEfforts((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([key]) => key !== normalizedKey),
      ),
    );
    setDraftModels((current) =>
      withoutModelId(current, normalized),
    );
    setDraftManualThirdPartyModels((current) =>
      withoutModelId(current, normalized),
    );
    setDeletedThirdPartyModels((current) =>
      !manualThirdPartyModelKeys.has(normalizedKey) ||
      current.some((item) => modelKey(item) === normalizedKey)
        ? current
        : [...current, normalized],
    );
    setModelInputError("");
  }, [
    draftManualThirdPartyModelKeys,
    manualThirdPartyModelKeys,
  ]);

  const saveModelSelection = useCallback(async () => {
    if (!mounted.current || !activeRef.current || saving.current) return;
    saving.current = true;
    const session = modelPickerSession.current;
    const page = pageSession.current;
    const currentPage = () => mounted.current && activeRef.current && pageSession.current === page;
    try {
      await runOperation("save-models", async () => {
        if (!currentPage() || modelPickerSession.current !== session) return;
        try {
          const input = modelSelectionInput({
            routeId: modelPickerRouteId, officialRoute: officialRoutePicker, officialOnly,
            localRouterEnabled: config?.localRouterEnabled === true,
            models: draftModels, officialKeys: officialSlugKeys, officialModelIds: modelEditorState.officialModelIds,
            thirdPartyModelOptions, manualModels: draftManualThirdPartyModels, deletedModels: deletedThirdPartyModels,
            supportsAutoReview: draftAutoReviewSupported, contexts: draftModelContexts,
            efforts: draftReasoningEfforts, autoEfforts: reasoningEffortAutoByModel,
          });
          const result = await modelSelectionRequests.save(input);
          if (!mounted.current) return;
          // 已确认的写入仍按配置版本合并共享基线；页面会话只控制当前弹窗和提示。
          const merged = adoptRouteConfig(result.config);
          if (!merged) return;
          setDirty(merged.dirty);
          if (result.modelState) setModelState(result.modelState);
          setStatus(current => ({ ...current, restartRequired: result.restartRequired ?? current.restartRequired }));
          if (!currentPage() || modelPickerSession.current !== session) return;
          setModelPickerVisible(false);
          setModelPickerRouteId(null);
          setModelPickerState(null);
          setDeletedThirdPartyModels([]);
          const totalCount = input.officialModels.length + input.thirdPartyModels.length;
          const summary = totalCount > 0 ? `已保存 ${totalCount} 个模型` : "已保存模型";
          setNotice(modelSelectionNotice(result, summary));
        } catch (error) {
          if (currentPage() && modelPickerSession.current === session) throw error;
        }
      });
    } finally {
      saving.current = false;
    }
  }, [
    config,
    modelPickerRouteId,
    officialRoutePicker,
    officialOnly,
    modelEditorState.officialModelIds,
    thirdPartyModelOptions,
    draftModelContexts,
    draftReasoningEfforts,
    reasoningEffortAutoByModel,
    adoptRouteConfig,
    setDirty,
    setStatus,
    setNotice,
    deletedThirdPartyModels,
    draftManualThirdPartyModels,
    draftModels,
    draftAutoReviewSupported,
    officialSlugKeys,
    runOperation,
  ]);

  return {
    subagentModelOptions,
    modelState,
    modelEditorState,
    officialOnly,
    setModelState,
    modelPickerVisible,
    modelPickerLoading,
    setModelPickerVisible: setModelPickerOpen,
    beginModelPickerLoad,
    completeModelPickerLoad,
    cancelModelPickerLoad,
    customModelInput,
    modelInputError,
    modelSyncWarning,
    draftAutoReviewSupported,
    setDraftAutoReviewSupported,
    draftModelSet,
    draftModelContexts,
    updateDraftModelContext,
    draftReasoningEfforts,
    reasoningEffortAutoByModel,
    modelPickerReasoningCapabilities,
    updateDraftReasoningEffort,
    resetDraftReasoningEffort,
    draftManualThirdPartyModelKeys,
    thirdPartyModelOptions,
    openModelPicker,
    toggleDraftModel,
    deleteDraftThirdPartyModel,
    updateCustomModelInput,
    addCustomModel,
    saveModelSelection,
  };
}
