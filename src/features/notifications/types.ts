export type NotificationChannelKind =
  "feishu" | "wecom" | "telegram" | "wechatClaw" | "ntfy";
export type NotificationChannelSessionStatus = "active" | "expired";

export const MAX_NOTIFICATION_CHANNELS = 32;

export type NotificationChannel = {
  id: string;
  kind: NotificationChannelKind;
  enabled: boolean;
  url: string;
  urlConfigured: boolean;
  clearUrl?: boolean;
  botToken: string;
  botTokenConfigured: boolean;
  clearBotToken?: boolean;
  contextToken: string;
  contextTokenConfigured: boolean;
  clearContextToken?: boolean;
  getUpdatesBuf?: string;
  chatId: string;
  sessionStatus?: NotificationChannelSessionStatus;
};

export type NotificationChannelEditorProps = {
  active?: boolean;
  channel: NotificationChannel;
  disabled: boolean;
  onChange: (patch: Partial<NotificationChannel>) => void;
};

export type WechatClawLoginStartResult = {
  loginId: string;
  status: "wait";
  qrCode?: string;
  qrCodeImageUrl?: string;
};

export type WechatClawLoginPollResult = {
  status: "wait" | "scanned" | "activating" | "confirmed" | "expired" | "failed";
  message?: string;
  baseUrl?: string;
  botToken?: string;
  recipientId?: string;
  contextToken?: string;
  getUpdatesBuf?: string;
};

export type ActiveLogin = {
  loginId: string;
  qrCodeImageUrl?: string;
  phase: "waiting" | "scanned" | "activating" | "confirmed" | "expired" | "failed";
  message: string;
};
