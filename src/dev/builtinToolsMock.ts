import type { BuiltinToolsStatus } from "../builtinTools";

export function createBuiltinToolsPreview() {
  const state: BuiltinToolsStatus = { installed: false, version: "1.6.2", projects: [], mcp: { enabled: false, managed: false, automatic: false }, job: null };
  let finishAt = 0;
  return async (args: Record<string, unknown> = {}) => {
    if (state.job?.phase === "running" && Date.now() >= finishAt) {
      state.installed = true;
      state.mcp = { id: "codey_codegraph", enabled: true, managed: true, automatic: true };
      state.job = { ...state.job, phase: "succeeded", message: "自动接入已启用。下一轮项目聊天会在后台建立索引并持续同步，无需选择目录。" };
    }
    if (args.action === "status") return structuredClone(state);
    if (args.action !== "set_enabled") throw new Error("未知内置工具操作");
    if (state.job?.phase === "running") throw new Error("已有 CodeGraph 操作进行中，请等待完成");
    if (args.enabled === false) {
      state.mcp.enabled = false;
      state.job = null;
    } else if (args.enabled === true) {
      state.job = { id: String(Date.now()), phase: "running", message: "正在准备 CodeGraph 自动接入，首次启用需下载官方运行包…" };
      finishAt = Date.now() + 2200;
    } else throw new Error("enabled 必须为布尔值");
    return structuredClone(state);
  };
}
