import { memo, type CSSProperties } from "react";
import {
  IconAdjustments,
} from "@tabler/icons-react";

import type {
  Config,
} from "./App.types";
import {
  Button,
  Badge,
  Switch,
} from "./components/ui";
import type { DiagnosticStorageTarget } from "./diagnosticStorage";
import { NotificationChannelsCard, type NotificationChannel } from "./features/notifications";

const GPU_LAUNCH_MODES = [
  { value: "off", label: "关闭" },
  { value: "disableGpu", label: "禁用 GPU" },
  { value: "disableGpuRasterization", label: "禁用 GPU 栅格化" },
] as const satisfies ReadonlyArray<{
  value: Config["gpuLaunchMode"];
  label: string;
}>;
export { SubagentPolicyCard } from "./features/subagents";
export type { SubagentPolicyCardProps } from "./features/subagents";

type FeaturePolicyCardProps = {
  active?: boolean;
  config: Config;
  isMacClient: boolean;
  isWindowsClient: boolean;
  cleanupBusy: boolean;
  onAnalyzeDiagnosticStorage: (target: DiagnosticStorageTarget) => void;
  popupContainer: HTMLElement | null;
  isBusy: boolean;
  onConfigChange: (config: Config) => void;
  onAddChannel?: (channel: NotificationChannel) => Promise<boolean>;
  onChannelChange?: (
    channelId: string,
    patch: Partial<NotificationChannel>,
  ) => Promise<boolean>;
  onRequestRemoveChannel?: (channel: NotificationChannel) => void;
};

function FeaturePolicyCardComponent({
  active = true,
  config,
  isMacClient,
  isWindowsClient,
  cleanupBusy,
  onAnalyzeDiagnosticStorage,
  popupContainer,
  isBusy,
  onConfigChange,
  onAddChannel,
  onChannelChange,
  onRequestRemoveChannel,
}: FeaturePolicyCardProps) {
  const configuredGpuLaunchModeIndex = GPU_LAUNCH_MODES.findIndex(
    ({ value }) => value === config.gpuLaunchMode,
  );
  const gpuLaunchModeIndex = Math.max(configuredGpuLaunchModeIndex, 0);
  const gpuLaunchMode = GPU_LAUNCH_MODES[gpuLaunchModeIndex];
  const gpuLaunchModeStyle = {
    "--gpu-mode-offset": `${gpuLaunchModeIndex * 100}%`,
  } as CSSProperties;

  return (
    <>
      <section className="secondary-section" aria-labelledby="runtime-title">
        <div className="feature-policy-heading">
          <div className="flex items-center gap-2">
            <span className="section-title-icon" aria-hidden="true">
              <IconAdjustments size={14} />
            </span>
            <h3 id="runtime-title" className="settings-section-heading">Codex 功能策略</h3>
          </div>
          <p>按需精简客户端模块和界面行为。</p>
        </div>
        <div className="runtime-settings">
          <div className="feature-grid">
            {/* GPU 渲染模式：仅 Windows 客户端展示 */}
            {isWindowsClient && (
              <div className={`feature-card gpu-mode-card full-width-card ${gpuLaunchMode.value !== "off" ? "active" : ""}`}>
                <div className="feature-card-header">
                  <div className="feature-card-title">
                    <strong>GPU 渲染模式</strong>
                    <Badge variant="warning">实验性</Badge>
                  </div>
                </div>
                <div className="feature-card-body gpu-mode-card-body">
                  <fieldset
                    className="gpu-mode-fieldset"
                    disabled={isBusy}
                    aria-describedby="gpu-launch-mode-description"
                  >
                    <legend className="sr-only">Codex GPU 启动模式</legend>
                    <div className="gpu-mode-slider" style={gpuLaunchModeStyle}>
                      <span className="gpu-mode-slider-thumb" aria-hidden="true" />
                      {GPU_LAUNCH_MODES.map((mode) => (
                        <label
                          key={mode.value}
                          className={`gpu-mode-option ${gpuLaunchMode.value === mode.value ? "selected" : ""}`}
                        >
                          <input
                            type="radio"
                            name="codey-gpu-launch-mode"
                            value={mode.value}
                            checked={gpuLaunchMode.value === mode.value}
                            onChange={() =>
                              onConfigChange({
                                ...config,
                                gpuLaunchMode: mode.value,
                              })
                            }
                          />
                          <span>{mode.label}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <small id="gpu-launch-mode-description" aria-live="polite">
                    {gpuLaunchMode.value === "disableGpu"
                      ? "启动 Codex 时附加 --disable-gpu；可能增加 CPU 占用"
                      : gpuLaunchMode.value === "disableGpuRasterization"
                        ? "启动 Codex 时附加 --disable-gpu-rasterization；仅将栅格化移到 CPU"
                        : "保持 Codex 默认 GPU 渲染，不附加诊断参数"}
                  </small>
                </div>
              </div>
            )}

            <div
              className={`feature-card ${config.slimCodexPet ? "active" : ""}`}
            >
              <div className="feature-card-header">
                <strong>精简 Codex 宠物模块</strong>
                <Switch
                  checked={config.slimCodexPet}
                  disabled={isBusy}
                  onCheckedChange={(checked) =>
                    onConfigChange({ ...config, slimCodexPet: checked })
                  }
                  aria-label="精简 Codex 宠物模块"
                />
              </div>
              <div className="feature-card-body">
                <small>
                  {config.slimCodexPet
                    ? "隐藏宠物入口并抑制自动预热；语音功能仍按需启用"
                    : "保留 Codex 宠物的完整功能"}
                </small>
              </div>
            </div>

            <div
              className={`feature-card ${config.disableTraceLogWrites ? "active" : ""}`}
            >
              <div className="feature-card-header">
                <strong>Trace 日志写盘保护</strong>
                <div className="feature-card-actions">
                  <Button
                    className="feature-action-btn"
                    size="xs"
                    disabled={isBusy}
                    loading={cleanupBusy}
                    onClick={() => onAnalyzeDiagnosticStorage("trace")}
                    aria-label="分析并清理 Trace 日志"
                  >
                    分析并清理
                  </Button>
                  <Switch
                    checked={config.disableTraceLogWrites}
                    disabled={isBusy}
                    onCheckedChange={(checked) =>
                      onConfigChange({
                        ...config,
                        disableTraceLogWrites: checked,
                      })
                    }
                    aria-label="启用 Codex Trace 日志写盘保护"
                  />
                </div>
              </div>
              <div className="feature-card-body">
                <small>阻止 Trace 日志持续写入数据库影响硬盘寿命</small>
              </div>
            </div>

            {(isMacClient || isWindowsClient) && (
              <div
                className={`feature-card ${config.protectCrashpadPending ? "active" : ""}`}
              >
                <div className="feature-card-header">
                  <strong>Crashpad 磁盘保护</strong>
                  <div className="feature-card-actions">
                    <Button
                      className="feature-action-btn"
                      size="xs"
                      disabled={isBusy}
                      loading={cleanupBusy}
                      onClick={() => onAnalyzeDiagnosticStorage("crashpad")}
                      aria-label="分析并清理 Crashpad 报告"
                    >
                      分析并清理
                    </Button>
                    <Switch
                      checked={config.protectCrashpadPending}
                      disabled={isBusy}
                      onCheckedChange={(checked) =>
                        onConfigChange({
                          ...config,
                          protectCrashpadPending: checked,
                        })}
                      aria-label="启用 Codex Crashpad 磁盘保护"
                    />
                  </div>
                </div>
                <div className="feature-card-body">
                  <small>
                    {config.protectCrashpadPending
                      ? "待处理崩溃报告超过安全上限时自动收敛，并保留最近写入"
                      : "仅显示占用和提供手动清理，不执行自动容量保护"}
                  </small>
                </div>
              </div>
            )}

            <div
              className={`feature-card ${config.hideFullAccessWarning ? "active" : ""}`}
            >
              <div className="feature-card-header">
                <strong>屏蔽完全访问安全提示</strong>
                <Switch
                  checked={config.hideFullAccessWarning}
                  disabled={isBusy}
                  onCheckedChange={(checked) =>
                    onConfigChange({ ...config, hideFullAccessWarning: checked })
                  }
                  aria-label="屏蔽完全访问安全提示"
                />
              </div>
              <div className="feature-card-body">
                <small>
                  {config.hideFullAccessWarning
                    ? "自动隐藏完全访问模式和 Ultra 的原生安全提示"
                    : "保留 Codex 原生安全提示"}
                </small>
              </div>
            </div>
          </div>
        </div>
      </section>

      {onAddChannel && onChannelChange && onRequestRemoveChannel && (
        <section className="secondary-section notification-section" aria-labelledby="notification-title">
          <NotificationChannelsCard
            active={active}
            config={config}
            container={popupContainer ?? null}
            popupContainer={popupContainer ?? null}
            isBusy={isBusy}
            onAddChannel={onAddChannel}
            onChannelChange={onChannelChange}
            onRequestRemoveChannel={onRequestRemoveChannel}
          />
        </section>
      )}
    </>
  );
}

export const FeaturePolicyCard = memo(FeaturePolicyCardComponent);
