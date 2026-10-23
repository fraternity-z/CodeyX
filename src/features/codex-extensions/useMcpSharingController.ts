import { useEffect, useState } from "react";
import { readMcpSharingStatus } from "./requests";
import type { ExtensionTransport, McpSharingStatus, Scope } from "./types";

export function useMcpSharingController(request: ExtensionTransport, scope: Scope, active: boolean, revision?: string) {
  const [status, setStatus] = useState<McpSharingStatus | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setStatus(null);
    setError("");
    setLoading(active);
    if (!active) return;
    const poll = async () => {
      try {
        const result = await readMcpSharingStatus(request, scope);
        if (current) { setStatus(result); setError(""); }
      } catch {
        if (current) { setStatus(null); setError("未能读取共享运行状态，请刷新后重试。"); }
      } finally {
        if (current) {
          setLoading(false);
          timer = setTimeout(() => void poll(), 5000);
        }
      }
    };
    void poll();
    return () => { current = false; clearTimeout(timer); };
  }, [request, scope, active, revision, refreshKey]);
  return { status, error, loading, refresh: () => setRefreshKey(value => value + 1) };
}
