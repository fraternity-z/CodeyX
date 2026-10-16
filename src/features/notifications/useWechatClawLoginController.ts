import { useEffect, useRef, useState } from "react";
import { errorText } from "../../appUtils";
import { useStableEvent } from "../../useStableEvent";
import { notificationRequests } from "./requests";
import { wechatBindingPatch } from "./state";
import type { ActiveLogin, NotificationChannelEditorProps } from "./types";

export function useWechatClawLoginController({ active = true, channel, disabled, onChange }: NotificationChannelEditorProps) {
  const [login, setLogin] = useState<ActiveLogin | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [revision, setRevision] = useState(0);
  const mounted = useRef(false);
  const session = useRef<object | null>(null);
  const starting = useRef(false);
  const polling = useRef(false);
  const loginChannel = useRef<string | null>(null);
  const epoch = useRef(0);
  const change = useStableEvent(onChange);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    session.current = active ? {} : null;
    return () => { session.current = null; epoch.current++; };
  }, [active, channel.id]);
  useEffect(() => { setLogin(null); }, [channel.id]);

  useEffect(() => {
    const loginId = login?.loginId;
    const scope = session.current;
    if (!active || disabled || !scope || !loginId || loginChannel.current !== channel.id || polling.current
      || !["waiting", "scanned", "activating"].includes(login.phase)) return;
    const generation = epoch.current;
    let cancelled = false;
    let timer: number | undefined;
    const current = () => !cancelled && mounted.current && session.current === scope && epoch.current === generation;
    const update = (patch: Partial<ActiveLogin>) => setLogin(value => value?.loginId === loginId ? { ...value, ...patch } : value);
    const poll = async () => {
      if (!current() || polling.current) return;
      polling.current = true;
      try {
        const result = await notificationRequests.pollLogin(loginId);
        if (!current()) return;
        if (result.status === "confirmed") {
          change(wechatBindingPatch(result));
          update({ phase: "confirmed", message: "绑定并激活成功，保存后即可接收通知。" });
        } else if (result.status === "expired" || result.status === "failed") {
          update({ phase: result.status, message: result.message || "微信 ClawBot 登录没有完成，请重新扫码" });
        } else {
          update({ phase: result.status === "activating" ? "activating" : result.status === "scanned" ? "scanned" : "waiting",
            message: result.message || (result.status === "activating" ? "请在微信中打开 ClawBot，并发送一条消息完成激活。"
              : result.status === "scanned" ? "已扫码，请在微信中确认授权。" : "请使用微信扫描二维码。") });
          // 长轮询结束后再延迟，避免快速 wait 响应造成紧密轮询。
          timer = window.setTimeout(() => void poll(), 1_200);
        }
      } catch (cause) {
        if (current()) update({ phase: "failed", message: errorText(cause) });
      } finally {
        polling.current = false;
        // 隐藏重开仍等待旧长轮询结束，然后读取当前登录，不并发轮询。
        if (!current() && mounted.current) setRevision(value => value + 1);
      }
    };
    void poll();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [active, disabled, channel.id, login?.loginId, revision, change]);

  const startLogin = useStableEvent(async () => {
    const scope = session.current;
    if (!active || !scope || disabled || starting.current || !mounted.current) return;
    const generation = ++epoch.current;
    const current = () => mounted.current && session.current === scope && epoch.current === generation;
    starting.current = true; setIsStarting(true); setLogin(null);
    try {
      const result = await notificationRequests.startLogin();
      if (current()) {
        loginChannel.current = channel.id;
        setLogin({ loginId: result.loginId, qrCodeImageUrl: result.qrCodeImageUrl,
          phase: "waiting", message: "请使用微信扫描二维码，并在手机上确认授权。" });
      }
    } catch (cause) {
      if (current()) setLogin({ loginId: "", phase: "failed", message: errorText(cause) });
    } finally {
      starting.current = false;
      if (mounted.current) setIsStarting(false);
    }
  });
  const failQrCode = useStableEvent((loginId: string) => {
    if (!session.current || login?.loginId !== loginId || !["waiting", "scanned"].includes(login.phase)) return;
    epoch.current++;
    setLogin({ ...login, phase: "failed", message: "二维码加载失败，请重新生成后重试。" });
  });
  return { login, isStarting, startLogin, failQrCode };
}
