import { useEffect, useRef, useState } from "react";
import type { Config, Notice, PromptOptimizationConfig } from "../../App.types";
import { errorText } from "../../appUtils";
import { useStableEvent } from "../../useStableEvent";
import { promptOptimizationRequests } from "./requests";
import { promptOptimizationTestFeedback, validatePromptOptimization } from "./state";
import type { PromptOptimizationFeedback } from "./types";

type Options = {
  active: boolean;
  config: Config;
  isBusy: boolean;
  onConfigChange: (config: Config) => void;
  onNotice: (notice: Notice) => void;
  onFeedback: (notice: PromptOptimizationFeedback) => void;
};
type Operation = "models" | "test";
type PendingOperation = { timer?: number };

const TEST_TIMEOUT_MS = 65_000;
const FETCH_MODELS_TIMEOUT_MS = 20_000;

export function usePromptOptimizationController({ active, config, isBusy, onConfigChange, onNotice, onFeedback }: Options) {
  const optimization = config.promptOptimization;
  const validation = validatePromptOptimization(optimization, config.localRouterEnabled);
  const [cloudModels, setCloudModels] = useState<string[]>([]);
  const [operation, setOperation] = useState<Operation | null>(null);
  const pending = useRef<PendingOperation | null>(null);
  const mounted = useRef(false);
  const session = useRef<object | null>(null);
  const testGeneration = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(pending.current?.timer);
    };
  }, []);
  useEffect(() => {
    session.current = active && optimization.enabled ? {} : null;
    return () => { session.current = null; };
  }, [active, config.settingsRevision, config.localRouterEnabled, optimization.enabled, optimization.mode,
    optimization.upstreamProtocol, optimization.baseUrl, optimization.apiKey, optimization.apiKeyConfigured, optimization.clearApiKey]);
  useEffect(() => {
    setCloudModels([]);
  }, [config.settingsRevision, optimization.mode, optimization.upstreamProtocol, optimization.baseUrl,
    optimization.apiKey, optimization.apiKeyConfigured, optimization.clearApiKey]);
  useEffect(() => { testGeneration.current++; }, [optimization.model, optimization.instruction]);

  const updateOptimization = useStableEvent((patch: Partial<PromptOptimizationConfig>) => {
    if (!active || !mounted.current || isBusy) return;
    onConfigChange({ ...config, promptOptimization: { ...optimization, ...patch } });
  });
  const changeMode = useStableEvent((mode: PromptOptimizationConfig["mode"]) => {
    if (!active || !mounted.current || isBusy || optimization.mode === mode || (mode === "codeyRoute" && !config.localRouterEnabled)) return;
    onNotice({ tone: "info", text: "" });
    updateOptimization({ mode });
  });
  const handleApiKeyChange = (value: string) => updateOptimization({ apiKey: value, clearApiKey: false });
  const showFeedback = useStableEvent((notice: PromptOptimizationFeedback, kind: Operation) => {
    onFeedback(notice);
    if (kind === "test") onNotice({ tone: "info", text: "" });
  });

  const run = useStableEvent(async (kind: Operation) => {
    const scope = session.current;
    if (!active || !scope || !mounted.current || isBusy || pending.current) return;
    if (kind === "models" ? validation.usesCodeyRoute || !validation.connectionDraftValid : !validation.testDraftValid) return;
    const generation = testGeneration.current;
    const current = () => mounted.current && session.current === scope && (kind === "models" || generation === testGeneration.current);
    const request: PendingOperation = {};
    pending.current = request;
    setOperation(kind);
    if (kind === "test") onNotice({ tone: "info", text: "" });
    const timeout = new Promise<never>((_, reject) => {
      request.timer = window.setTimeout(() => reject(new Error(kind === "models"
        ? "获取模型列表超时，请检查 API 地址与网络"
        : "测试超时，请检查 API 地址与网络")), kind === "models" ? FETCH_MODELS_TIMEOUT_MS : TEST_TIMEOUT_MS);
    });
    try {
      if (kind === "models") {
        const result = await Promise.race([promptOptimizationRequests.models(optimization), timeout]);
        if (!current()) return;
        const models = result?.models ?? [];
        setCloudModels(models);
        showFeedback(models.length > 0
          ? { tone: "success", text: `已获取 ${models.length} 个模型` }
          : { tone: "error", text: "服务端没有返回可用模型" }, kind);
      } else {
        const result = await Promise.race([promptOptimizationRequests.test(optimization), timeout]);
        if (current()) showFeedback(promptOptimizationTestFeedback(result?.result), kind);
      }
    } catch (cause) {
      if (current()) showFeedback({ tone: "error", text: errorText(cause) }, kind);
    } finally {
      window.clearTimeout(request.timer);
      // 隐藏或编辑不取消后台请求；只有本次操作可以释放锁，不能清除较新操作的忙碌状态。
      if (pending.current === request) {
        pending.current = null;
        if (mounted.current) setOperation(null);
      }
    }
  });

  return { optimization, ...validation, cloudModels, testing: operation === "test", fetchingModels: operation === "models",
    updateOptimization, changeMode, handleApiKeyChange, runFetchModels: () => run("models"), runTest: () => run("test") };
}
