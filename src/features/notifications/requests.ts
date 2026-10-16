import { invoke } from "../../api";
import type { Config, ConfigSaveResult } from "../../App.types";
import type { NotificationChannel, WechatClawLoginPollResult, WechatClawLoginStartResult } from "./types";

export const notificationRequests = {
  save: (config: Config) => invoke<ConfigSaveResult>("save_codey_config", { config }),
  load: () => invoke<ConfigSaveResult>("load_codey_config"),
  test: (channel: NotificationChannel) => invoke<void>("test_notification_channel", { channel }),
  startLogin: () => invoke<WechatClawLoginStartResult>("start_wechat_claw_login"),
  pollLogin: (loginId: string) => invoke<WechatClawLoginPollResult>("poll_wechat_claw_login", { loginId }),
};
