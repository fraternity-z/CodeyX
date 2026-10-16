import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Notice } from "../../App.types";
import { errorText } from "../../appUtils";
import { useStableEvent } from "../../useStableEvent";
import { notificationRequests } from "./requests";
import { channelLabels, createNotificationChannel, isChannelConfigured } from "./state";
import type { NotificationChannel, NotificationChannelKind } from "./types";

type Options = {
  active: boolean;
  open: boolean;
  editingChannel: NotificationChannel | null;
  isBusy: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (channel: NotificationChannel) => Promise<boolean>;
  onFeedback: (notice: Notice) => void;
};
type Operation = { kind: "save" | "test"; timer?: number };
const newChannel = (kind: NotificationChannelKind) => createNotificationChannel(kind,
  globalThis.crypto?.randomUUID?.() ?? `notification-${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function useNotificationChannelController({ active, open, editingChannel, isBusy, onOpenChange, onSave, onFeedback }: Options) {
  const [draft, setDraft] = useState<NotificationChannel | null>(null);
  const [operation, setOperation] = useState<Operation["kind"] | null>(null);
  const pending = useRef<Operation | null>(null);
  const mounted = useRef(false);
  const session = useRef<object | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; window.clearTimeout(pending.current?.timer); };
  }, []);
  useLayoutEffect(() => {
    session.current = active && open ? {} : null;
    return () => { session.current = null; };
  }, [active, open, editingChannel?.id]);
  useLayoutEffect(() => {
    // 关闭后的退出动画保留表单；页面隐藏不重置草稿。
    if (open) setDraft(editingChannel ? { ...editingChannel } : newChannel("feishu"));
  }, [open, editingChannel?.id]);

  const updateDraft = useStableEvent((patch: Partial<NotificationChannel>) => {
    if (!session.current || isBusy || pending.current) return;
    setDraft(current => current ? { ...current, ...patch, id: current.id, kind: current.kind } : current);
  });
  const selectChannel = useStableEvent((kind: NotificationChannelKind) => {
    if (!session.current || isBusy || pending.current || editingChannel || draft?.kind === kind || !(kind in channelLabels)) return;
    setDraft(newChannel(kind));
  });
  const changeOpen = useStableEvent((next: boolean) => {
    if (active && (next || (!isBusy && !pending.current))) onOpenChange(next);
  });
  const run = useStableEvent(async (kind: Operation["kind"]) => {
    const scope = session.current;
    if (!scope || !mounted.current || isBusy || pending.current || !draft || !isChannelConfigured(draft)) return;
    const request: Operation = { kind };
    pending.current = request; setOperation(kind);
    const current = () => mounted.current && session.current === scope;
    let timedOut = false;
    try {
      if (kind === "save") {
        if (await onSave(draft) && current()) onOpenChange(false);
      } else {
        request.timer = window.setTimeout(() => {
          timedOut = true;
          if (current()) onFeedback({ tone: "error", text: `${channelLabels[draft.kind]}测试在 12 秒内没有完成，发送结果尚未确认，请勿重复发送` });
        }, 12_000);
        await notificationRequests.test(draft);
        if (current() && !timedOut) onFeedback({ tone: "success", text: draft.kind === "wechatClaw"
          ? "iLink 已接受测试消息，请在微信中确认接收" : "测试发送成功" });
      }
    } catch (cause) {
      if (current() && !timedOut) onFeedback({ tone: "error", text: errorText(cause) });
    } finally {
      window.clearTimeout(request.timer);
      // 超时和隐藏都不取消发送；后台结束前保留同一个防重锁。
      if (pending.current === request) {
        pending.current = null;
        if (mounted.current) setOperation(null);
      }
    }
  });
  return { draft, updateDraft, selectChannel, changeOpen, closeDialog: () => changeOpen(false),
    saveChannel: () => run("save"), testChannel: () => run("test"),
    isTesting: operation === "test", isSaving: operation === "save",
    formBusy: !active || isBusy || operation !== null, canSave: !!draft && isChannelConfigured(draft) };
}
