import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CheckResult,
  ExtensionTransport,
  Inventory,
  MutationResult,
  Scope,
} from "./types";
import { causeText } from "./state";
import { executeExtensionAction, isExtensionMutation, readInventory, waitForExtensionMutation } from "./requests";

/**
 * run 的结果：ok 提交成功且本地状态同步；superseded 后端已落库但结果被抢占；
 * failed 未提交或提交失败，调用方应保留草稿。
 */
export type RunOutcome = "ok" | "superseded" | "failed";

export function useExtensionsController(
  request: ExtensionTransport,
  active: boolean,
) {
  const [scope, setScope] = useState<Scope>({ kind: "user" });
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [noticeSeq, setNoticeSeq] = useState(0);
  const [check, setCheck] = useState<
    (CheckResult & { id: string; revision?: string }) | null
  >(null);
  const [checks, setChecks] = useState<
    Record<string, CheckResult & { revision?: string }>
  >({});
  const [reconcile, setReconcile] = useState(0);
  const session = useRef<object | null>(null);
  // 读写各用一条序号：run 抢占刷新不再作废在飞的清单读取，刷新也不会作废在飞的提交。
  const readEpoch = useRef(0);
  const writeEpoch = useRef(0);
  const locked = useRef<object | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      readEpoch.current++;
      writeEpoch.current++;
    };
  }, []);
  const refresh = useCallback(
    async (force = true) => {
      const currentSession = session.current;
      if (!active || !mounted.current || !currentSession) return null;
      const generation = ++readEpoch.current;
      const current = () => mounted.current && session.current === currentSession && generation === readEpoch.current;
      setLoading(true);
      setError("");
      try {
        const pending = waitForExtensionMutation(request);
        if (pending) await pending;
        if (!current()) return null;
        const result = await readInventory(request, scope, force);
        if (current()) {
          setInventory(result);
          setUncertain(false);
          return result;
        }
        return null;
      } catch (cause) {
        if (current()) {
          setError(causeText(cause));
        }
        return null;
      } finally {
        if (current()) setLoading(false);
      }
    },
    [active, request, scope],
  );
  useEffect(() => {
    setInventory(null);
    setCheck(null);
    setNotice("");
    setChecks({});
  }, [request, scope]);
  useEffect(() => {
    session.current = active ? {} : null;
    // 序号失效后旧请求不会再清 loading，这里显式收尾，避免切走范围时卡在加载态。
    setLoading(false);
    // 隐藏不会取消后台写入，也不能释放写入锁；重开按当前范围重新确认。
    if (active) void refresh(true);
    return () => {
      session.current = null;
      readEpoch.current++;
      writeEpoch.current++;
    };
  }, [active, refresh, reconcile]);
  const run = useCallback(
    async <T>(
      action: Record<string, unknown>,
      onSuccess?: (result: T) => void,
    ): Promise<RunOutcome> => {
      const currentSession = session.current;
      if (!active || !mounted.current || !currentSession || locked.current) return "failed";
      const token = {};
      locked.current = token;
      setBusy(true);
      setBusyAction(String(action.action));
      setError("");
      const generation = ++writeEpoch.current;
      const current = () => mounted.current && session.current === currentSession && generation === writeEpoch.current;
      const mutation = isExtensionMutation(String(action.action));
      if (mutation && uncertain) {
        setError("上次操作结果尚不确定，请先刷新确认后再提交修改。");
        locked.current = null;
        setBusy(false);
        setBusyAction("");
        return "failed";
      }
      try {
        const result = await executeExtensionAction<T>(request, scope, inventory?.revision, action);
        if (!mounted.current) return "failed";
        // 被新的操作或范围切换抢占：后端已落库，但本地状态不能再用这次结果覆盖。
        if (!current()) return "superseded";
        onSuccess?.(result);
        return "ok";
      } catch (cause) {
        const message = causeText(cause);
        if (current()) {
          setError(message);
          if (mutation && (message.includes("结果尚不确定") || message.includes("仍在执行"))) {
            readEpoch.current++;
            setLoading(false);
            setUncertain(true);
          }
        }
        return "failed";
      } finally {
        if (locked.current === token) {
          locked.current = null;
          if (mounted.current) {
            setBusy(false);
            setBusyAction("");
            if (mutation && !current()) setReconcile(value => value + 1);
          }
        }
      }
    },
    [active, request, scope, inventory?.revision, uncertain],
  );
  const postNotice = useCallback((text: string) => {
    setNotice(text);
    setNoticeSeq((current) => current + 1);
  }, []);
  const mutate = useCallback(
    async (action: Record<string, unknown>) => {
      const outcome = await run<MutationResult>(action, (result) => {
        // 写入成功后，先于它发起的列表读取不得再覆盖新版本。
        readEpoch.current++;
        setLoading(false);
        setInventory(result.inventory);
        // 后端 message 已说明保存结果，这里只在仍需重启时补充生效方式，避免同一句提示重复两遍。
        postNotice(
          result.applyStatus === "restart-required"
            ? "配置已保存，重启 Codex 后生效。"
            : result.message,
        );
      });
      return outcome;
    },
    [postNotice, run],
  );
  const inspect = useCallback(
    (action: Record<string, unknown>) =>
      run<CheckResult>(action, (result) => {
        const id = String(action.id),
          revision = inventory?.revision;
        const checkedAt = new Date().toISOString();
        setCheck({ ...result, id, revision, checkedAt });
        setChecks((current) => ({
          ...current,
          [id]: { ...result, revision, checkedAt },
        }));
      }),
    [run, inventory?.revision],
  );
  return {
    scope,
    setScope,
    inventory,
    loading,
    busy,
    busyAction,
    uncertain,
    clearError: () => setError(""),
    error,
    notice,
    noticeSeq,
    check,
    checks,
    refresh,
    run,
    mutate,
    inspect,
    canRun: () => active && mounted.current && session.current !== null && locked.current === null,
  };
}
