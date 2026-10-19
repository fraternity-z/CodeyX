import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { Config, ConfigSaveResult, Confirmation, Notice } from "../../App.types";
import { errorText } from "../../appUtils";
import { useStableEvent } from "../../useStableEvent";
import { notificationRequests } from "./requests";
import { channelLabels, isChannelConfigured } from "./state";
import { MAX_NOTIFICATION_CHANNELS, type NotificationChannel } from "./types";

type Options = {
  active: boolean;
  config: Config | null;
  isBusy: boolean;
  onSaved: (result: ConfigSaveResult, submitted?: Config) => boolean;
  setBusy: Dispatch<SetStateAction<string | null>>;
  setNotice: (notice: Notice) => void;
  setConfirmation: (confirmation: Confirmation | null) => void;
};

export function useNotificationsController({ active, config, isBusy, onSaved, setBusy, setNotice, setConfirmation }: Options) {
  const mounted = useRef(false);
  const session = useRef<object | null>(null);
  const pending = useRef(false);
  const reconcile = useRef<{ submitted?: Config } | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    session.current = active ? {} : null;
    return () => { session.current = null; };
  }, [active]);

  const adopt = useStableEvent(onSaved);
  useEffect(() => {
    const base = reconcile.current;
    if (!active || pending.current || !base) return;
    let cancelled = false;
    void notificationRequests.load().then(result => {
      if (cancelled) return;
      adopt(result, base.submitted);
      reconcile.current = null;
    }).catch(cause => {
      if (!cancelled) setNotice({ tone: "error", text: `通知渠道保存结果未能重新读取：${errorText(cause)}` });
    });
    return () => { cancelled = true; };
  }, [active, revision, adopt, setNotice]);

  const persistChannels = useStableEvent(async (channels: NotificationChannel[], successText: string) => {
    const scope = session.current;
    if (!active || !scope || !mounted.current || !config || isBusy || pending.current || reconcile.current) return false;
    const base = config;
    pending.current = true;
    setBusy("save-notification-channel");
    const current = () => mounted.current && session.current === scope;
    try {
      const result = await notificationRequests.save({ ...base, webhook: { ...base.webhook, channels } });
      if (!current()) { reconcile.current = { submitted: base }; return false; }
      if (!adopt(result, base)) return false;
      setNotice(result.configApply
        ? { tone: "info", text: "通知设置已保存，正在后台应用" }
        : { tone: "success", text: successText });
      return true;
    } catch (cause) {
      if (current()) setNotice({ tone: "error", text: errorText(cause) });
      else reconcile.current = {};
      return false;
    } finally {
      pending.current = false;
      if (mounted.current) {
        setBusy(value => value === "save-notification-channel" ? null : value);
        if (reconcile.current) setRevision(value => value + 1);
      }
    }
  });

  const addNotificationChannel = useStableEvent((channel: NotificationChannel) => {
    if (!config || !isChannelConfigured(channel) || config.webhook.channels.length >= MAX_NOTIFICATION_CHANNELS
      || config.webhook.channels.some(existing => existing.id === channel.id)) return Promise.resolve(false);
    return persistChannels([...config.webhook.channels, channel], "通知渠道已保存，自动通知已生效");
  });
  const updateNotificationChannel = useStableEvent((channelId: string, patch: Partial<NotificationChannel>) => {
    const existing = config?.webhook.channels.find(channel => channel.id === channelId);
    if (!config || !existing) return Promise.resolve(false);
    const updated = { ...existing, ...patch, id: existing.id, kind: existing.kind };
    if (!isChannelConfigured(updated)) return Promise.resolve(false);
    return persistChannels(config.webhook.channels.map(channel => channel.id === channelId ? updated : channel),
      "通知渠道已更新，自动通知已生效");
  });
  const removeNotificationChannel = useStableEvent((channelId: string) => {
    if (!config?.webhook.channels.some(channel => channel.id === channelId)) return Promise.resolve(false);
    return persistChannels(config.webhook.channels.filter(channel => channel.id !== channelId), "通知渠道已删除");
  });
  const askRemoveNotificationChannel = useStableEvent((channel: NotificationChannel) => {
    if (!active || !session.current || isBusy || pending.current || !config?.webhook.channels.some(item => item.id === channel.id)) return;
    const scope = session.current;
    setConfirmation({ action: "delete-notification-channel", title: `删除${channelLabels[channel.kind]}通知渠道？`,
      description: "将立即移除这个通知渠道，删除后不会再接收自动通知。", confirmLabel: "删除渠道",
      run: () => { if (session.current === scope) void removeNotificationChannel(channel.id); } });
  });
  return { addNotificationChannel, updateNotificationChannel, askRemoveNotificationChannel };
}
