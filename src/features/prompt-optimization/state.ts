import type { PromptOptimizationConfig } from "../../App.types";
import { validateOutboundApiUrl } from "../../urlValidation";
import type { PromptOptimizationFeedback, PromptOptimizationTestResult } from "./types";

export function validatePromptOptimization(optimization: PromptOptimizationConfig, codeyRouteAvailable: boolean) {
  const usesCodeyRoute = optimization.mode === "codeyRoute";
  const hasApiKey = Boolean(optimization.apiKey.trim() || (optimization.apiKeyConfigured && !optimization.clearApiKey));
  const baseUrlError = !usesCodeyRoute && (optimization.enabled || optimization.baseUrl.trim())
    ? validateOutboundApiUrl(optimization.baseUrl, "API 地址") : "";
  const apiKeyError = !usesCodeyRoute && optimization.enabled && !hasApiKey ? "请输入 API Key" : "";
  const modelError = optimization.enabled && !optimization.model.trim()
    ? usesCodeyRoute ? "请选择 CodeyX 路由模型" : "请选择或填写模型" : "";
  const connectionDraftValid = usesCodeyRoute ? codeyRouteAvailable : !baseUrlError && !apiKeyError;
  return { usesCodeyRoute, codeyRouteAvailable, baseUrlError, apiKeyError, modelError,
    connectionDraftValid, testDraftValid: connectionDraftValid && !modelError };
}

export function promptOptimizationTestFeedback(result?: PromptOptimizationTestResult): PromptOptimizationFeedback {
  const httpStatus = result?.httpStatus;
  const preview = result?.responsePreview?.trim();
  if (typeof httpStatus === "number" && httpStatus >= 400) {
    return { tone: "error", text: `连接失败（HTTP ${httpStatus}）${preview ? `：${preview}` : ""}` };
  }
  return { tone: "success", text: typeof httpStatus === "number" ? `连接成功（HTTP ${httpStatus}）` : "连接成功" };
}
