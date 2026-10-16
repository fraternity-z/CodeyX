import { useEffect, useMemo, useRef, useState } from "react";
import { useStableEvent } from "../../useStableEvent";
import { extensionRequest, getSkillCacheRequests } from "./requests";
import { causeText } from "./state";
import type { ExtensionTransport, SkillCacheInventory, SkillEntry } from "./types";

export function useSkillCacheController(open: boolean, request: ExtensionTransport = extensionRequest) {
  const session = useMemo(() => getSkillCacheRequests(request), [request]);
  const view = useRef<object | null>(null);
  const mounted = useRef(false);
  const running = useRef<{ operation: string } | null>(null);
  const [cache, setCache] = useState<SkillCacheInventory | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [blocked, setBlocked] = useState(true);
  const [confirmation, setConfirmation] = useState<SkillEntry | null>(null);
  const [document, setDocument] = useState<{ name: string; content: string } | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function run<T>(operation: string, task: () => Promise<T>, apply: (result: T) => void) {
    const currentView = view.current;
    if (!open || !currentView || !mounted.current || running.current) return;
    const token = { operation };
    running.current = token;
    const current = () => mounted.current && view.current === currentView;
    setBusy(operation);
    setError("");
    try {
      if (operation === "list") {
        const pending = session.waitForPending();
        if (pending) await pending;
        if (!current()) return;
      }
      const result = await task();
      if (current()) apply(result);
    } catch (cause) {
      if (current()) setError(causeText(cause));
    } finally {
      if (current()) {
        setBlocked(session.blocked);
        if (operation === "remove") setConfirmation(null);
      }
      if (running.current === token) {
        running.current = null;
        if (mounted.current) {
          setBusy("");
          if (!current() && operation === "remove") setRevision(value => value + 1);
        }
      }
    }
  }
  const refresh = useStableEvent(() => {
    if (!open || !view.current || running.current) return;
    setConfirmation(null); setDocument(null); setNotice(""); setBlocked(true);
    return run("list", () => session.list(), setCache);
  });
  useEffect(() => {
    view.current = open ? {} : null;
    setCache(null); setBlocked(true); setConfirmation(null); setDocument(null); setNotice(""); setError("");
    if (!running.current) setBusy("");
    if (open) void refresh();
    return () => {
      view.current = null;
      // 读取可以作废，删除必须保留锁直到返回；超时后的真实写入由请求层继续跟踪。
      if (running.current?.operation !== "remove") running.current = null;
    };
  }, [open, session, revision, refresh]);

  const read = useStableEvent((entry: SkillEntry) => {
    if (!open || !view.current || running.current) return;
    setDocument(null);
    return run("read", () => session.read(entry.id), value => setDocument({ name: entry.name, content: value.content }));
  });
  const askRemove = useStableEvent((entry: SkillEntry) => {
    if (open && view.current && !running.current && !blocked && cache && entry.canRemove !== false) setConfirmation(entry);
  });
  const remove = useStableEvent(() => {
    if (!cache || !confirmation || blocked || session.blocked) return;
    return run("remove", () => session.remove(confirmation.id, cache.revision), result => {
      setCache(result.cache); setDocument(null); setNotice(result.message);
    });
  });
  return { cache, busy, error, notice, blocked, confirmation, document, refresh, read, askRemove, remove,
    cancelRemove: () => { if (!running.current) setConfirmation(null); },
    unavailable: !!busy || blocked || !cache };
}
