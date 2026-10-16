export type PromptOptimizationTestResult = {
  httpStatus?: number;
  responsePreview?: string;
};

export type PromptOptimizationFeedback = { tone: "success" | "error"; text: string };
