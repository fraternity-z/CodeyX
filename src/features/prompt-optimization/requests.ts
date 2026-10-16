import { invoke } from "../../api";
import type { PromptOptimizationConfig } from "../../App.types";
import type { PromptOptimizationTestResult } from "./types";

export const promptOptimizationRequests = {
  models: (config: PromptOptimizationConfig) =>
    invoke<{ models?: string[] }>("fetch_prompt_optimization_models", { config }),
  test: (config: PromptOptimizationConfig) =>
    invoke<{ result?: PromptOptimizationTestResult }>("test_prompt_optimization", { config }),
};
