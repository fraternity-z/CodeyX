import type { NotificationChannel, NotificationChannelKind, WechatClawLoginPollResult } from "./types";

export const channelLabels: Record<NotificationChannelKind, string> = {
  feishu: "飞书", wecom: "企业微信", telegram: "Telegram", wechatClaw: "微信 ClawBot", ntfy: "ntfy",
};

export function createNotificationChannel(kind: NotificationChannelKind, id: string): NotificationChannel {
  return { id, kind, enabled: true, url: "", urlConfigured: false, clearUrl: false,
    botToken: "", botTokenConfigured: false, clearBotToken: false,
    contextToken: "", contextTokenConfigured: false, clearContextToken: false,
    getUpdatesBuf: "", chatId: "", sessionStatus: "active" };
}

export function isChannelConfigured(channel: NotificationChannel): boolean {
  const url = Boolean(channel.url.trim() || (channel.urlConfigured && !channel.clearUrl));
  const token = Boolean(channel.botToken.trim() || (channel.botTokenConfigured && !channel.clearBotToken));
  switch (channel.kind) {
    case "feishu": case "wecom": return url;
    case "telegram": return token && Boolean(channel.chatId.trim());
    case "ntfy": return url && Boolean(channel.chatId.trim());
    case "wechatClaw": return channel.sessionStatus !== "expired" && url && token && Boolean(
      (channel.contextToken.trim() || (channel.contextTokenConfigured && !channel.clearContextToken)) && channel.chatId.trim());
    default: return false;
  }
}

export function wechatBindingPatch(result: WechatClawLoginPollResult): Partial<NotificationChannel> {
  const token = result.botToken?.trim();
  const baseUrl = result.baseUrl?.trim();
  const recipientId = result.recipientId?.trim();
  const contextToken = result.contextToken?.trim();
  if (result.status !== "confirmed" || !token || !baseUrl || !recipientId || !contextToken) {
    throw new Error("微信 ClawBot 没有返回完整的激活凭据，请重新扫码");
  }
  return { url: baseUrl, urlConfigured: true, clearUrl: false,
    botToken: token, botTokenConfigured: true, clearBotToken: false,
    contextToken, contextTokenConfigured: true, clearContextToken: false,
    getUpdatesBuf: result.getUpdatesBuf?.trim() ?? "", chatId: recipientId, sessionStatus: "active" };
}
