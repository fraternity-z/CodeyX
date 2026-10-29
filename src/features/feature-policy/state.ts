import type { InjectionScriptStatus, RuntimeStatus } from "../../App.types";
import type {
  FeaturePolicyConfig, FeaturePolicyKey, FeaturePolicyPhase, FeaturePolicyPresentation,
} from "./types";

const LABELS: Record<FeaturePolicyPhase, [string, FeaturePolicyPresentation["variant"]]> = {
  verified: ["已验证", "success"],
  applied: ["已应用", "success"],
  disabled: ["已关闭", "secondary"],
  pending: ["待验证", "secondary"],
  applying: ["应用中", "info"],
  restart_required: ["待重启", "warning"],
  failed: ["异常", "destructive"],
  degraded: ["部分失败", "warning"],
  partial: ["部分生效", "warning"],
  stopped: ["未运行", "secondary"],
};

function presentation(phase: FeaturePolicyPhase, detail: string): FeaturePolicyPresentation {
  const [label, variant] = LABELS[phase];
  return { phase, label, variant, detail, unsaved: false };
}

function injectionStatus(script: InjectionScriptStatus | undefined, enabled: boolean) {
  if (script?.status === "failed") return presentation("failed", script.error || script.detail || "运行时探测失败，请查看运行状态。");
  if (enabled && script?.status === "effective") return presentation("verified", script.detail || "当前实例的运行时探测已通过。");
  if (!enabled && script?.status === "inactive") return presentation("disabled", "当前实例保留 Codex 原生行为。");
  return presentation("pending", enabled ? "配置已保存，等待当前实例的运行时探测。" : "配置已关闭，等待当前实例确认。");
}

function traceProtectionStatus(status: RuntimeStatus) {
  const policy = status.featurePolicy;
  if (!policy) return presentation("pending", "当前后端未提供保护检查结果。");
  if (!policy.configured.disableTraceLogWrites) {
    return status.traceLogWriteProtectionActive === false
      ? presentation("disabled", "当前实例允许 Trace 日志写入。")
      : presentation("pending", "关闭设置已保存，等待确认日志写入已恢复。");
  }
  const snapshot = policy.traceProtection;
  if (snapshot.errors.length) return presentation(snapshot.lastSuccessfulAt ? "degraded" : "failed", snapshot.errors[0]);
  if (!policy.traceWatcherActive) return presentation("failed", "日志库守护未运行，请重新启动 Codex。");
  if (snapshot.pending) return presentation("applying", "正在检查日志库并更新写盘保护。");
  if (!snapshot.capturedAt || !snapshot.lastSuccessfulAt || snapshot.lastSuccessfulAt < snapshot.capturedAt) {
    return presentation("pending", "守护已启动，等待首次成功检查。");
  }
  if (!snapshot.logTablesFound) return presentation("pending", "暂未发现可保护的日志表；新建日志库后会自动检查。");
  if (status.traceLogWriteProtectionActive !== true) return presentation("pending", "已完成检查，等待确认日志表阻写保护。");
  return presentation("verified", `最近检查成功，已保护 ${snapshot.logTablesFound} 个日志表。`);
}

function crashpadProtectionStatus(status: RuntimeStatus) {
  const policy = status.featurePolicy;
  if (!policy) return presentation("pending", "当前后端未提供报告清理结果。");
  if (!policy.configured.protectCrashpadPending) {
    return status.crashpadDiskProtectionActive === false
      ? presentation("disabled", "自动容量保护已关闭，可按需手动清理。")
      : presentation("pending", "关闭设置已保存，等待守护确认。");
  }
  const snapshot = policy.crashpadProtection;
  if (snapshot.errors.length) return presentation(snapshot.lastSuccessfulAt ? "degraded" : "failed", snapshot.errors[0]);
  if (snapshot.overLimit) return presentation("degraded", "待处理报告仍超过安全上限，部分报告可能尚不能清理。");
  if (status.crashpadDiskProtectionActive !== true) return presentation("failed", "报告清理守护未运行，请重新启动 Codex。");
  if (snapshot.pending) return presentation("applying", "正在检查待处理报告的容量与清理结果。");
  if (!snapshot.protectionEnabled || !snapshot.capturedAt || !snapshot.lastSuccessfulAt || snapshot.lastSuccessfulAt < snapshot.capturedAt) {
    return presentation("pending", "守护已启动，等待成功检查容量保护。");
  }
  return presentation("verified", "最近检查成功，待处理报告处于安全上限内。");
}

export function confirmedDiskProtections(status: RuntimeStatus) {
  return {
    trace: status.running && traceProtectionStatus(status).phase === "verified",
    crashpad: status.running && crashpadProtectionStatus(status).phase === "verified",
  };
}

function currentPolicyStatus(key: FeaturePolicyKey, status: RuntimeStatus) {
  const policy = status.featurePolicy;
  if (!status.running) return presentation("stopped", "配置已保存，启动 Codex 后确认运行效果。");
  if (!policy) return presentation("pending", "当前后端未提供策略状态，请更新后重新查询。");
  if (status.restartInProgress) return presentation("applying", "Codex 正在重启，完成后将重新检查。");
  if (key === "gpuLaunchMode" || key === "slimCodexPet") {
    if (!policy.applied) return presentation("pending", "尚未读取到当前实例的启动配置。");
    if (policy.configured[key] !== policy.applied[key]) {
      if (status.configApply?.phase === "failed") return presentation("failed", status.configApply.applyError || "配置已保存，但应用失败，请查看运行状态。");
      return presentation("restart_required", "配置已保存，重新启动 Codex 后应用此项修改。");
    }
  }
  if (key === "gpuLaunchMode") {
    return policy.applied?.gpuLaunchMode === "off"
      ? presentation("disabled", "当前实例使用 Codex 默认 GPU 渲染。")
      : presentation("applied", "当前实例已按所选 GPU 模式启动；性能效果取决于设备。");
  }
  if (key === "disableTraceLogWrites") return traceProtectionStatus(status);
  if (key === "protectCrashpadPending") return crashpadProtectionStatus(status);
  const scriptId = key === "slimCodexPet" ? "pet-control-shield" : "security-warning-shield";
  const result = injectionStatus(status.injectionScripts?.find(script => script.id === scriptId), policy.configured[key]);
  if (key === "slimCodexPet" && result.phase === "verified") {
    const resourceScript = status.injectionScripts?.find(script => script.id === "runtime-optimizations");
    if (resourceScript?.status !== "effective" || !resourceScript.detail?.includes("宠物自动预热")) {
      return presentation("partial", "宠物入口已精简，自动预热抑制尚未确认。");
    }
    return presentation("verified", "宠物入口精简和自动预热抑制均已通过运行时探测。");
  }
  return result;
}

export function featurePolicyStatus(
  key: FeaturePolicyKey,
  draft: FeaturePolicyConfig,
  status?: RuntimeStatus,
): FeaturePolicyPresentation {
  if (!status) return presentation("pending", "正在读取当前实例状态。");
  const result = currentPolicyStatus(key, status);
  if (status.configApply?.phase === "pending" || status.configApply?.phase === "applying") {
    result.detail = `配置正在应用；当前实例：${result.label}。${result.detail}`;
    result.phase = "applying";
    [result.label, result.variant] = LABELS.applying;
  }
  return {
    ...result,
    unsaved: Boolean(status.featurePolicy && draft[key] !== status.featurePolicy.configured[key]),
  };
}
