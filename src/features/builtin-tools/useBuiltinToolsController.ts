import { useEffect, useRef, useState } from "react";
import type { Config, FastContextToolsStatus } from "../../App.types";
import type { BuiltinToolsStatus } from "../../builtinTools";
import { errorText } from "../../appUtils";
import { builtinToolsRequests } from "./requests";

type Options = {
  active: boolean;
  config: Config;
  fastContextToolsStatus: FastContextToolsStatus;
  isBusy: boolean;
  onConfigChange: (config: Config) => void;
};

export function useBuiltinToolsController({ active, config, fastContextToolsStatus, isBusy, onConfigChange }: Options) {
  const [status, setStatus] = useState<BuiltinToolsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const pending = useRef(false);
  const mounted = useRef(false);
  const session = useRef<object | null>(null);
  const readGeneration = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    session.current = active ? {} : null;
    return () => { session.current = null; readGeneration.current++; };
  }, [active]);

  useEffect(() => {
    if (!active || pending.current) return;
    let cancelled = false;
    let timer: number | undefined;
    const generation = readGeneration.current;
    const current = () => !cancelled && generation === readGeneration.current && !pending.current;
    async function poll() {
      if (!current()) return;
      try {
        const next = await builtinToolsRequests.status();
        if (!current()) return;
        setStatus(next);
        setReadError("");
        timer = window.setTimeout(() => void poll(), next.job?.phase === "running" ? 1500 : 5000);
      } catch (cause) { if (current()) setReadError(errorText(cause)); }
    }
    void poll();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [active, busy, revision]);

  const running = status?.job?.phase === "running";
  const blocked = busy || running || isBusy || !status;
  const userManaged = Boolean(status?.mcp.id && !status.mcp.managed);
  async function setEnabled(enabled: boolean) {
    const scope = session.current;
    if (!active || !scope || pending.current || blocked || userManaged) return;
    pending.current = true;
    readGeneration.current++;
    const current = () => mounted.current && session.current === scope;
    setBusy(true);
    setError("");
    setReadError("");
    setNotice("");
    try {
      const next = await builtinToolsRequests.setEnabled(enabled);
      if (current()) { setStatus(next); setNotice(next.message ?? ""); }
    } catch (cause) { if (current()) setError(errorText(cause)); }
    finally {
      pending.current = false;
      if (mounted.current) { setBusy(false); setRevision(value => value + 1); }
    }
  }
  function refresh() {
    if (!active || pending.current || isBusy) return;
    readGeneration.current++;
    setError("");
    setReadError("");
    setRevision(value => value + 1);
  }

  const fastctxStatusBlocksEmbedded = fastContextToolsStatus.userConfigured || fastContextToolsStatus.detectionFailed;
  const fastContextToolsEnabled = config.fastContextTools && !fastctxStatusBlocksEmbedded;
  const fastctxBlockedReason = fastContextToolsStatus.detectionFailed
    ? "暂时无法确认 Codex 配置中的 FastCtx 状态，为避免重复加载，CodeyX 内置 FastCtx 不可开启"
    : `已检测到 Codex 配置中的 FastCtx${fastContextToolsStatus.serverId ? `（${fastContextToolsStatus.serverId}）` : ""}，为避免重复加载，CodeyX 内置 FastCtx 不可开启`;
  function changeFastContextTools(enabled: boolean) {
    if (active && !isBusy && !fastctxStatusBlocksEmbedded) onConfigChange({ ...config, fastContextTools: enabled });
  }

  return { status, busy, error: error || readError, notice, running, blocked, userManaged, setEnabled, refresh,
    fastctxStatusBlocksEmbedded, fastContextToolsEnabled, fastctxBlockedReason, changeFastContextTools };
}
