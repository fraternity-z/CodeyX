import { memo } from "react";
import {
  IconBrandWechat,
  IconLoader2 as LoaderCircle,
  IconQrcode,
} from "@tabler/icons-react";

import { Button, Input } from "../../components/ui";
import { inputShellClass, insetInputClass } from "../../uiClasses";
import { useWechatClawLoginController } from "./useWechatClawLoginController";
import type { NotificationChannelEditorProps } from "./types";

function WechatClawChannelEditorComponent({
  active = true,
  channel,
  disabled,
  onChange,
}: NotificationChannelEditorProps) {
  const { login, isStarting, startLogin, failQrCode } = useWechatClawLoginController({ active, channel, disabled, onChange });

  const sessionExpired = channel.sessionStatus === "expired";
  const hasBinding = Boolean(
    sessionExpired || channel.botToken.trim() || channel.botTokenConfigured,
  );
  const isActivated = Boolean(
    hasBinding &&
      !sessionExpired &&
      (channel.contextToken.trim() || channel.contextTokenConfigured) &&
      channel.chatId.trim(),
  );
  const loginMessage = login?.message || (sessionExpired
    ? "微信 ClawBot 登录已失效，请重新扫码后保存配置。"
    : isActivated
      ? "当前已完成绑定和激活。重新扫码会替换已保存的凭据。"
      : hasBinding
        ? "当前绑定缺少激活上下文，请重新扫码并按提示向 ClawBot 发送一条消息。"
        : "扫码确认后，需要在微信中向 ClawBot 发送一条消息完成激活。二维码 10 分钟内有效。");
  const bindingCardClass = sessionExpired
    ? "rounded-[10px] border border-[#f59e0b]/35 bg-[var(--codey-amber-soft,#fff8eb)] p-3"
    : "rounded-[10px] border border-[#07c160]/25 bg-[var(--codey-green-soft,#f2fff5)] p-3";
  const bindingIconClass = sessionExpired
    ? "grid size-7 place-items-center rounded-full bg-[#f59e0b]/12 text-[var(--codey-amber,#a15c00)]"
    : "grid size-7 place-items-center rounded-full bg-[#07c160]/12 text-[var(--codey-green,#07a854)]";

  return (
    <>
      <div className={bindingCardClass}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className={bindingIconClass}>
              <IconQrcode size={17} aria-hidden="true" />
            </span>
            <div>
              <strong className="block text-xs text-[var(--codey-text,#1d1d1f)]">微信 ClawBot 绑定</strong>
              <span className="block text-[11px] text-[var(--codey-muted,#5d6b61)]">无需企业微信机器人或常驻转发服务</span>
            </div>
          </div>
          <Button
            variant="secondary"
            size="xs"
            disabled={disabled || isStarting}
            onClick={() => void startLogin()}
          >
            {isStarting ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <IconBrandWechat aria-hidden="true" />}
            {isStarting ? "正在生成" : sessionExpired || hasBinding ? "重新扫码" : "扫码绑定"}
          </Button>
        </div>
        <p className="mt-2 text-[11px] leading-5 text-[var(--codey-muted,#526158)]" role="status" aria-live="polite">
          {loginMessage}
        </p>
        {login?.qrCodeImageUrl && (login.phase === "waiting" || login.phase === "scanned") ? (
          <div className="mt-3 flex justify-center rounded-lg bg-[var(--codey-surface,#fff)] p-2">
            <img
              className="size-48 rounded-md object-contain"
              src={login.qrCodeImageUrl}
              alt="微信 ClawBot 登录二维码"
              referrerPolicy="no-referrer"
              onError={() => failQrCode(login.loginId)}
            />
          </div>
        ) : null}
      </div>

      <label className="field notification-field-row">
        <span>iLink 用户 ID</span>
        <div className={inputShellClass}>
          <Input
            className={insetInputClass}
            value={channel.chatId}
            disabled={disabled}
            readOnly
            placeholder="完成激活后自动填入"
            spellCheck={false}
          />
        </div>
      </label>
    </>
  );
}

export const WechatClawChannelEditor = memo(WechatClawChannelEditorComponent);
