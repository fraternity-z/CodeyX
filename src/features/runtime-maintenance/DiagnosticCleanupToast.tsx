import { useEffect } from "react";
import { toast } from "@heroui/react";
import { DiagnosticCleanupNotice } from "../../DiagnosticCleanupNotice";
import type { DiagnosticCleanupState } from "./types";

export function DiagnosticCleanupToast({ state }: { state: DiagnosticCleanupState | null }) {
  useEffect(() => {
    if (!state) return;
    const title = state.target === "trace" ? "Trace 日志" : "Crashpad";
    let key: string;
    if (state.phase === "running") {
      key = toast(`${title}：正在分析并清理`, {
        description: "正在统计占用并清理，请稍候…", isLoading: true, timeout: 0,
      });
    } else if (state.phase === "complete") {
      const incomplete = state.result.status === "partial" || state.result.errors.length > 0;
      key = toast(`${title}：${incomplete ? "部分项目未完成" : "分析并清理完成"}`, {
        description: <DiagnosticCleanupNotice result={state.result} target={state.target} />,
        variant: incomplete ? "warning" : "success", timeout: 8_000,
      });
    } else {
      key = toast.danger(`${title}：清理结果未能确认`, {
        description: `无法确认清理前后占用及清理情况：${state.error}`, timeout: 8_000,
      });
    }
    // 同一次清理的进行态和结果共用一条提示，隐藏或卸载时关闭。
    return () => toast.close(key);
  }, [state]);
  return null;
}
