import { useEffect, useRef, useState } from "react";
import { errorText } from "../../appUtils";
import { useStableEvent } from "../../useStableEvent";
import { usageAnalysisRequests } from "./requests";
import { usageQuery } from "./state";
import type { UsageLoadState, UsageRange } from "./types";

export function useUsageAnalysisController(active: boolean) {
  const [range, setRange] = useState<UsageRange>("7d");
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<UsageLoadState>({ loading: active, data: null, error: "" });
  const mounted = useRef(false);
  const generation = useRef(0);
  const pending = useRef(false);
  const statsTask = useRef(Promise.resolve());
  const statsTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; window.clearTimeout(statsTimer.current); };
  }, []);
  useEffect(() => {
    if (!active) {
      pending.current = false;
      setState({ loading: false, data: null, error: "" });
      return;
    }
    const version = generation.current;
    const query = usageQuery(range);
    let cancelled = false;
    let timer: number | undefined;
    const current = () => !cancelled && version === generation.current;
    pending.current = true;
    setState({ loading: true, data: null, error: "" });
    statsTask.current = statsTask.current.then(async () => {
      if (!current()) return;
      const timeout = new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error("统计请求超时，请稍后重试。")), 30_000);
        statsTimer.current = timer;
      });
      try {
        const data = await Promise.race([usageAnalysisRequests.stats(query), timeout]);
        if (current()) setState({ loading: false, data, error: "" });
      } catch (cause) {
        if (current()) setState({ loading: false, data: null, error: errorText(cause) });
      } finally {
        window.clearTimeout(timer);
        if (current()) pending.current = false;
      }
    });
    // 失效任务保留超时以释放读取队列；超时只停止等待，不取消后端执行。
    return () => { cancelled = true; };
  }, [active, range, revision]);

  const changeRange = useStableEvent((value: string | number | null) => {
    if (!mounted.current || !active || value === range || (value !== "7d" && value !== "30d" && value !== "all")) return;
    generation.current++;
    pending.current = true;
    setState({ loading: true, data: null, error: "" });
    setRange(value);
  });
  const reload = useStableEvent(() => {
    if (!mounted.current || !active || pending.current) return;
    generation.current++;
    pending.current = true;
    setState({ loading: true, data: null, error: "" });
    setRevision(value => value + 1);
  });

  return { range, changeRange, state, reload };
}
