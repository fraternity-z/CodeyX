import { useEffect, useRef, useState } from "react";
import type { Config, FastContextToolsStatus } from "../../App.types";
import type { BuiltinToolsStatus } from "../../builtinTools";
import { errorText } from "../../appUtils";
import { useOperationScope } from "../../useOperationScope";
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
  const needsStatusRead = useRef(true);
  const scope = useOperationScope(active);

  useEffect(() => {
    if (!active || scope.pending || !needsStatusRead.current) return;
    let cancelled = false;
    let timer: number | undefined;
    const valid = scope.read();
    const current = () => !cancelled && valid();
    async function poll() {
      if (!current()) return;
      try {
        const next = await builtinToolsRequests.status();
        if (!current()) return;
        setStatus(next);
        setReadError("");
        needsStatusRead.current = next.job?.phase === "running";
        if (needsStatusRead.current) timer = window.setTimeout(() => void poll(), 1500);
      } catch (cause) {
        if (current()) { needsStatusRead.current = false; setReadError(errorText(cause)); }
      }
    }
    void poll();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [active, busy, revision, scope]);

  const running = status?.job?.phase === "running";
  const blocked = busy || running || isBusy || !status;
  const userManaged = Boolean(status?.mcp.id && !status.mcp.managed);
  async function setEnabled(enabled: boolean) {
    if (!active || blocked || userManaged) return;
    const operationScope = scope.begin();
    if (!operationScope) return;
    const { current } = operationScope;
    setBusy(true);
    setError("");
    setReadError("");
    setNotice("");
    try {
      const next = await builtinToolsRequests.setEnabled(enabled);
      if (current()) { setStatus(next); setNotice(next.message ?? ""); }
    } catch (cause) { if (current()) setError(errorText(cause)); }
    finally {
      if (operationScope.finish()) { needsStatusRead.current = true; setBusy(false); setRevision(value => value + 1); }
    }
  }
  function refresh() {
    if (!active || scope.pending || isBusy) return;
    scope.invalidateReads();
    needsStatusRead.current = true;
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
