import { memo, useState } from "react";
import {
  IconCheck,
  IconCopy,
  IconFolder,
  IconHelpCircle,
  IconLoader2 as LoaderCircle,
  IconSettings,
  IconTool,
} from "@tabler/icons-react";

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Switch,
  Tooltip,
} from "./components/ui";
import type { Config } from "./App.types";

export type SystemSettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  container: HTMLElement | null;
  appVersion?: string;
  codexAppVersion?: string;
  codexAppPath?: string;
  isBusy: boolean;
  busy: string | null;
  onRepairCodexConfig: () => void;
  onSelectCodexDirectory: () => void;
  codexDirectoryNotice?: { tone: "info" | "success" | "error"; text: string } | null;
  configRepairNotice?: { tone: "info" | "success" | "error"; text: string } | null;
  codeyUpdatePolicy: Config["codeyUpdatePolicy"];
  onCodeyUpdatePolicyChange: (policy: Config["codeyUpdatePolicy"]) => void;
};

function SystemSettingsDialogComponent({
  open,
  onOpenChange,
  container,
  appVersion,
  codexAppVersion,
  codexAppPath,
  isBusy,
  busy,
  onRepairCodexConfig,
  onSelectCodexDirectory,
  codexDirectoryNotice,
  configRepairNotice,
  codeyUpdatePolicy,
  onCodeyUpdatePolicyChange,
}: SystemSettingsDialogProps) {
  const [copied, setCopied] = useState(false);
  const resolvedCodexPath = codexAppPath || "/Applications/ChatGPT.app";
  const formattedCodexVersion = codexAppVersion?.trim()
    ? `v${codexAppVersion.trim().replace(/^v/, "")}`
    : "未运行 / 未检测到";

  const handleCopyPath = async () => {
    try {
      await navigator.clipboard.writeText(resolvedCodexPath);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 忽略写入剪贴板异常
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="system-settings-dialog sm:w-[500px]"
        container={container}
      >
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[var(--codey-blue-soft)] text-[var(--codey-accent,#0071e3)]">
              <IconSettings size={18} aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <DialogTitle>系统设置与偏好</DialogTitle>
              <DialogDescription>
                查看版本与本地路径，管理 Codex 维护与 Releases 更新策略。
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="flex flex-col gap-2.5 py-1 text-sm">
          {/* 版本与目录信息 */}
          <div className="flex flex-col rounded-xl border border-[var(--codey-border-subtle)] bg-[var(--codey-surface-muted)] p-3">
            {/* 上半部分：CodeyX 与 Codex 版本并排 */}
            <div className="grid grid-cols-2 divide-x divide-[var(--codey-border-subtle)] pb-2.5 border-b border-[var(--codey-border-subtle)]">
              <div className="flex items-center justify-between pr-3 min-w-0">
                <span className="text-xs font-medium text-[var(--codey-muted)] shrink-0">CodeyX 版本</span>
                <span className="font-mono text-xs font-semibold tracking-tight text-[var(--codey-text)] truncate">
                  v{appVersion || "1.0.0"}
                </span>
              </div>
              <div className="flex items-center justify-between pl-3 min-w-0">
                <span className="text-xs font-medium text-[var(--codey-muted)] shrink-0">Codex 版本</span>
                <span className="font-mono text-xs font-semibold tracking-tight text-[var(--codey-text)] truncate">
                  {formattedCodexVersion}
                </span>
              </div>
            </div>

            {/* Codex 目录支持长路径换行与一键复制 */}
            <div className="pt-2.5 flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--codey-muted)]">
                  <IconFolder size={14} className="shrink-0 text-[var(--codey-muted)]" aria-hidden="true" />
                  <span>Codex 目录</span>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={isBusy}
                    aria-label="重新选择 Codex 目录"
                    onClick={onSelectCodexDirectory}
                    className="h-6 px-2 text-xs text-[var(--codey-muted)]"
                  >
                    {busy === "select-codex-directory" && <LoaderCircle className="animate-spin" size={13} aria-hidden="true" />}
                    {busy === "select-codex-directory" ? "识别中…" : "重新选择"}
                  </Button>
                  <Tooltip content={copied ? "已复制到剪贴板" : "复制路径"}>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="size-6 min-w-6 shrink-0 text-[var(--codey-muted)] hover:text-[var(--codey-text)]"
                      aria-label="复制 Codex 路径"
                      onClick={handleCopyPath}
                    >
                      {copied ? (
                        <IconCheck size={13} className="text-success" aria-hidden="true" />
                      ) : (
                        <IconCopy size={13} aria-hidden="true" />
                      )}
                    </Button>
                  </Tooltip>
                </div>
              </div>
              <div className="rounded-lg border border-[var(--codey-border-subtle)] bg-[var(--codey-surface,#fff)] px-2.5 py-1.5">
                <code
                  className="block font-mono text-[11px] text-[var(--codey-text)] break-all select-all leading-relaxed max-h-20 overflow-y-auto"
                  title={resolvedCodexPath}
                >
                  {resolvedCodexPath}
                </code>
              </div>
              {codexDirectoryNotice && (
                <div role="status" className={`text-xs break-words ${codexDirectoryNotice.tone === "error" ? "text-danger" : "text-[var(--codey-muted)]"}`}>
                  {codexDirectoryNotice.text}
                </div>
              )}
            </div>
          </div>

          {/* Codex 配置维护 */}
          <div className="flex flex-col gap-2 rounded-xl border border-[var(--codey-border-subtle)] bg-[var(--codey-surface-muted)] p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-semibold text-[var(--codey-text)]">
                修复 Codex 配置
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={isBusy}
                onClick={onRepairCodexConfig}
                className="shrink-0 whitespace-nowrap"
              >
                {busy === "repair-codex-config" ? (
                  <LoaderCircle className="animate-spin" size={14} aria-hidden="true" />
                ) : (
                  <IconTool size={14} aria-hidden="true" />
                )}
                <span>{busy === "repair-codex-config" ? "修复中…" : "修复"}</span>
              </Button>
            </div>
            {configRepairNotice && (
              <div
                role="status"
                className={`mt-1 rounded-lg px-2.5 py-1.5 text-xs whitespace-pre-line break-words ${
                  configRepairNotice.tone === "error"
                    ? "bg-danger/10 text-danger"
                    : "bg-success/10 text-success"
                }`}
              >
                {configRepairNotice.text}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--codey-border-subtle)] bg-[var(--codey-surface-muted)] p-3">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-xs font-semibold text-[var(--codey-text)]">CodeyX 更新策略</span>
              <Tooltip content="从本项目 GitHub Releases 检测稳定版更新，保存后生效。不更新仅关闭自动检查，仍可手动检查稳定版。" position="top">
                <span
                  className="inline-flex shrink-0 cursor-help items-center text-[var(--codey-muted)] transition-colors hover:text-[var(--codey-text)]"
                  aria-label="CodeyX 更新策略说明"
                >
                  <IconHelpCircle size={14} aria-hidden="true" />
                </span>
              </Tooltip>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-[var(--codey-muted)]">{codeyUpdatePolicy === "off" ? "不更新" : "更新"}</span>
              <Switch
                aria-label="CodeyX 自动更新"
                checked={codeyUpdatePolicy !== "off"}
                disabled={isBusy}
                onCheckedChange={(checked) => onCodeyUpdatePolicyChange(checked ? "stable" : "off")}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="default" onClick={() => onOpenChange(false)}>
            完成
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export const SystemSettingsDialog = memo(SystemSettingsDialogComponent);
