import { useEffect, useState } from "react";
import { errorText } from "../../appUtils";
import { useStableEvent } from "../../useStableEvent";
import { useOperationScope } from "../../useOperationScope";
import { remoteControlRequests } from "./requests";
import { adoptRemoteStatus, remoteStartOptions } from "./state";
import type { RemoteDraft, RemoteSnapshot, RemoteStatus } from "./types";

export function useRemoteControlController(active: boolean, remote: boolean) {
  const [snapshot, setSnapshot] = useState<RemoteSnapshot>({ status: { running: false, urls: [], devices: [] }, url: "", pairing: null });
  const [draft, setDraft] = useState<RemoteDraft>({ bindAddress: "0.0.0.0", port: "43129", publicUrl: "", connection: "tunnel" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const scope = useOperationScope(active && !remote);

  const adoptStatus = useStableEvent((status: RemoteStatus) => setSnapshot(previous => adoptRemoteStatus(previous, status)));
  useEffect(() => {
    if (!active || remote || scope.pending) return;
    let cancelled = false;
    let timer: number | undefined;
    const valid = scope.read();
    const current = () => !cancelled && valid();
    const poll = async () => {
      if (!current()) return;
      try {
        const next = await remoteControlRequests.status();
        if (current()) adoptStatus(next);
      } catch (cause) { if (current()) setError(errorText(cause)); }
      finally { if (current()) timer = window.setTimeout(() => void poll(), 5000); }
    };
    void poll();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [active, remote, busy, revision, adoptStatus, scope]);

  async function run(name: string, operation: (current: () => boolean) => Promise<void>) {
    if (!active || remote) return;
    const operationScope = scope.begin();
    if (!operationScope) return;
    const { current } = operationScope;
    setBusy(name);
    setError("");
    try { await operation(current); }
    catch (cause) { if (current()) setError(errorText(cause)); }
    finally {
      // 隐藏不取消后台写入，锁保留到请求完成；重开后由当前轮询重新读取状态。
      if (operationScope.finish()) { setBusy(null); setRevision(value => value + 1); }
    }
  }

  const refreshStatus = async (current: () => boolean) => {
    const next = await remoteControlRequests.status();
    if (current()) adoptStatus(next);
  };
  const refresh = () => run("refresh", refreshStatus);
  const start = () => {
    if (snapshot.status.running) return Promise.resolve();
    return run("start", async current => {
      const next = await remoteControlRequests.start(remoteStartOptions(draft));
      if (current()) setSnapshot({ status: next, url: draft.connection === "tunnel" ? "" : next.urls[0] || "", pairing: null });
    });
  };
  const stop = () => run("stop", async current => {
    await remoteControlRequests.stop();
    if (!current()) return;
    setSnapshot(previous => ({ ...previous, pairing: null }));
    await refreshStatus(current);
  });
  const pair = () => {
    if (!snapshot.status.running || !snapshot.url) return Promise.resolve();
    return run("pair", async current => {
      const pairing = await remoteControlRequests.pair(snapshot.url);
      if (current()) setSnapshot(previous => ({ ...previous, pairing }));
    });
  };
  const revoke = (id: string) => run("revoke", async current => {
    await remoteControlRequests.revoke(id);
    if (current()) await refreshStatus(current);
  });
  const changeDraft = <K extends keyof RemoteDraft>(key: K, value: RemoteDraft[K]) => {
    if (!active || remote || scope.pending || snapshot.status.running) return;
    setDraft(previous => ({ ...previous, [key]: value }));
  };
  const selectUrl = (url: string) => {
    if (!active || remote || scope.pending || !snapshot.status.urls.includes(url)) return;
    setSnapshot(previous => ({ ...previous, url, pairing: null }));
  };

  return { ...snapshot, draft, changeDraft, selectUrl, busy, error, refresh, start, stop, pair, revoke };
}
