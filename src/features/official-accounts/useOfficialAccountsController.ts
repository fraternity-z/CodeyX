import { useEffect, useRef, useState } from "react";
import type { OfficialAccount, OfficialAccountsResult } from "../../App.types";
import { errorText } from "../../appUtils";
import { useStableEvent } from "../../useStableEvent";
import { accountUsageRequests, officialAccountsRequests } from "./requests";
import type { AccountAuthorization, OfficialAccountsControllerOptions } from "./types";
import { useOfficialAccountUsageController } from "./useOfficialAccountUsageController";

const LOGIN_POLL_INTERVAL_MS = 1500;

// 关闭或丢弃授权时只做尽力清理；服务端会自行过期，不重放登录或账号写入。
function cancelAuthorization(authorization: AccountAuthorization | null) {
  if (authorization) void officialAccountsRequests.cancel(authorization).catch(() => undefined);
}

export function useOfficialAccountsController({
  active, isBusy, onAccountsLoaded, onAccountsChanged, onNotice,
}: OfficialAccountsControllerOptions) {
  const [accounts, setAccounts] = useState<OfficialAccount[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [authorization, setAuthorization] = useState<AccountAuthorization | null>(null);
  const [authorizationError, setAuthorizationError] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [manualInput, setManualInput] = useState("");
  const [manualError, setManualError] = useState("");
  const [revision, setRevision] = useState(0);
  const [usageRevision, setUsageRevision] = useState(0);
  const mounted = useRef(false);
  const session = useRef<object | null>(null);
  const writePending = useRef(false);
  const readGeneration = useRef(0);
  const authorizationRef = useRef<AccountAuthorization | null>(null);
  const authorizationGeneration = useRef(0);
  const manualVersion = useRef(0);
  const completedManualVersion = useRef<number | null>(null);
  const needsReconcile = useRef(false);
  const visited = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      authorizationGeneration.current++;
      cancelAuthorization(authorizationRef.current);
      authorizationRef.current = null;
    };
  }, []);
  useEffect(() => {
    session.current = active ? {} : null;
    return () => { session.current = null; readGeneration.current++; };
  }, [active]);

  const applyResult = useStableEvent((result: OfficialAccountsResult) => {
    readGeneration.current++;
    if (Array.isArray(result.accounts)) {
      officialAccountsRequests.remember(result);
      setAccounts(result.accounts);
      setLoadError("");
    }
    onAccountsChanged(result);
  });
  const applyUsageResult = useStableEvent((result: OfficialAccountsResult) => {
    if (active && session.current && !writePending.current && !authorizationRef.current) applyResult(result);
  });
  const usage = useOfficialAccountUsageController({
    active: active && pending === null && authorization === null && !needsReconcile.current,
    accounts, revision: usageRevision, onAccountsChanged: applyUsageResult, onError: setLoadError,
  });

  const refresh = useStableEvent(async (force: boolean = true) => {
    const scope = session.current;
    if (!active || !scope || writePending.current) return;
    const generation = ++readGeneration.current;
    const reconcile = needsReconcile.current;
    const current = () => session.current === scope && generation === readGeneration.current && !writePending.current;
    try {
      // 隐藏期间已执行的写入只重新读取最终状态，不重放有副作用的命令。
      const result = reconcile
        ? await accountUsageRequests.refreshRoutes()
        : await officialAccountsRequests.list({ force });
      if (!current()) return;
      const loaded = result.accounts ?? [];
      if (!Array.isArray(loaded)) throw new Error("官方账号列表格式无效，请重新加载");
      if (reconcile) {
        needsReconcile.current = false;
        applyResult(result);
      } else setAccounts(loaded);
      onAccountsLoaded?.(loaded);
      setLoadError("");
    } catch (cause) {
      if (!current()) return;
      setLoadError(errorText(cause));
      onAccountsLoaded?.(null);
    }
  });
  useEffect(() => {
    if (!active || writePending.current) return;
    setAuthorization(authorizationRef.current);
    // 已确认成功的导入在重开后收起；失败或结果未知时保留草稿。
    if (completedManualVersion.current === manualVersion.current) {
      setManualOpen(false); setManualInput(""); setManualError("");
      completedManualVersion.current = null;
    }
    void refresh(visited.current);
    visited.current = true;
  }, [active, revision, refresh]);

  const notice = useStableEvent(onNotice);
  const reconcileLater = useStableEvent(() => {
    needsReconcile.current = true;
    readGeneration.current++;
    if (mounted.current && active && !writePending.current) setRevision(value => value + 1);
  });

  const run = useStableEvent(async (
    name: string,
    operation: (current: () => boolean) => Promise<void>,
    onError: (message: string) => void = message => notice({ tone: "error", text: message }),
    changesAccounts = true,
  ) => {
    const scope = session.current;
    if (!active || !scope || isBusy || writePending.current) return;
    writePending.current = true;
    readGeneration.current++;
    setPending(name);
    const current = () => mounted.current && session.current === scope;
    try {
      await operation(current);
      if (changesAccounts && !current()) reconcileLater();
    } catch (cause) {
      if (current()) onError(errorText(cause));
      if (changesAccounts) reconcileLater();
    } finally {
      // 切走页面不能解开仍在执行的写入锁；完成后由当前会话恢复读取。
      writePending.current = false;
      if (mounted.current) {
        setPending(null);
        setUsageRevision(value => value + 1);
        if (!current() || needsReconcile.current || accounts === null) setRevision(value => value + 1);
      }
    }
  });

  useEffect(() => {
    const scope = session.current;
    if (!active || !scope || !authorization || authorizationError || pending !== null || isBusy) return;
    let cancelled = false;
    let timer: number | undefined;
    const current = () => !cancelled && session.current === scope
      && authorizationRef.current === authorization && !writePending.current;
    const poll = async () => {
      if (!current()) return;
      try {
        const result = await officialAccountsRequests.poll(authorization);
        if (!current()) {
          if (result.status === "ok") {
            if (authorizationRef.current === authorization) authorizationRef.current = null;
            reconcileLater();
          }
          return;
        }
        if (result.status === "wait") {
          timer = window.setTimeout(() => void poll(), LOGIN_POLL_INTERVAL_MS);
        } else if (result.status === "ok") {
          authorizationRef.current = null;
          setAuthorization(null);
          applyResult(result);
          setUsageRevision(value => value + 1);
          notice(authorization.kind === "login"
            ? { tone: "success", text: result.warning ? `账号已添加；${result.warning}` : "官方账号已添加" }
            : { tone: result.warning ? "info" : "success", text: result.warning
              ? `已启用官方直连；${result.warning}` : "已启用官方直连，对话将通过 OpenAI 官方通道调用订阅" });
        } else {
          const label = authorization.kind === "login" ? "登录" : "授权";
          setAuthorizationError(result.message || (result.status === "expired" ? `${label}已过期，请重新开始` : `${label}失败`));
        }
      } catch (cause) { if (current()) setAuthorizationError(errorText(cause)); }
    };
    void poll();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [active, authorization, authorizationError, pending, isBusy, applyResult, notice, reconcileLater]);

  const closeAuthorization = useStableEvent(() => {
    authorizationGeneration.current++;
    const previous = authorizationRef.current;
    authorizationRef.current = null;
    if (mounted.current) { setAuthorization(null); setAuthorizationError(""); }
    cancelAuthorization(previous);
  });
  const startAuthorization = useStableEvent((account?: OfficialAccount) => {
    if (account && (!accounts?.some(item => item.id === account.id && !item.invalid))) return Promise.resolve();
    return run(account ? `siwc:${account.id}` : "login", async current => {
      closeAuthorization();
      const generation = authorizationGeneration.current;
      const result = account
        ? await officialAccountsRequests.startSiwc(account.id)
        : await officialAccountsRequests.startLogin();
      const next: AccountAuthorization = account
        ? { ...result, kind: "siwc", accountId: account.id }
        : { ...result, kind: "login" };
      if (!current() || generation !== authorizationGeneration.current) { cancelAuthorization(next); return; }
      authorizationRef.current = next;
      setAuthorization(next);
    }, undefined, false);
  });
  const restartSiwc = useStableEvent(() => {
    const current = authorizationRef.current;
    const account = current?.kind === "siwc" ? accounts?.find(item => item.id === current.accountId) : undefined;
    if (account) return startAuthorization(account);
    closeAuthorization();
  });

  const openManual = useStableEvent(() => {
    if (!active || isBusy || writePending.current) return;
    manualVersion.current++;
    setManualError(""); setManualInput(""); setManualOpen(true);
  });
  const closeManual = useStableEvent(() => {
    if (writePending.current) return;
    manualVersion.current++;
    setManualOpen(false); setManualInput(""); setManualError("");
  });
  const changeManualInput = useStableEvent((value: string) => {
    if (!active || writePending.current) return;
    manualVersion.current++;
    setManualInput(value); setManualError("");
  });
  const submitManual = useStableEvent(() => {
    if (!active || !manualOpen || isBusy || writePending.current) return Promise.resolve();
    const credential = manualInput.trim();
    if (!credential) { setManualError("请粘贴 Refresh Token 或 OAuth JSON"); return Promise.resolve(); }
    return run("manual", async current => {
      setManualError("");
      const version = manualVersion.current;
      const result = await officialAccountsRequests.importCredential(credential);
      if (!current()) { completedManualVersion.current = version; return; }
      applyResult(result);
      setManualOpen(false); setManualInput("");
      notice({ tone: result.warning ? "info" : "success", text: result.warning ? `账号已添加；${result.warning}` : "官方账号已添加" });
    }, setManualError);
  });
  const importCurrent = useStableEvent(() => run("import", async current => {
    const result = await officialAccountsRequests.importCurrent();
    if (!current()) return;
    applyResult(result);
    notice({ tone: "success", text: "已导入当前 Codex 登录的官方账号" });
  }));
  const setDefault = useStableEvent((account: OfficialAccount) => {
    if (!accounts?.some(item => item.id === account.id && !item.invalid && !item.isDefault)) return Promise.resolve();
    return run(`default:${account.id}`, async current => {
      const result = await officialAccountsRequests.setDefault(account.id);
      if (!current()) return;
      applyResult(result);
      notice({ tone: result.warning ? "info" : "success", text: result.warning
        ? `已切换默认官方账号；${result.warning}`
        : result.restartRequired ? "已切换默认官方账号，Codex 重启后以该账号登录"
          : "已切换默认官方账号；本地路由已即时切换，Codex 其余登录态在重启后完全生效" });
    });
  });
  const executeRemove = useStableEvent((account: OfficialAccount) => {
    if (!accounts?.some(item => item.id === account.id)) return Promise.resolve();
    return run(`remove:${account.id}`, async current => {
      const result = await officialAccountsRequests.remove(account.id);
      if (!current()) return;
      applyResult(result);
      notice({ tone: result.warning ? "info" : "success", text: result.warning ? `账号已移除；${result.warning}` : "官方账号已移除" });
    });
  });
  const executeRemoveSiwc = useStableEvent((account: OfficialAccount) => {
    if (!accounts?.some(item => item.id === account.id && item.siwcStatus === "active")) return Promise.resolve();
    return run(`siwc-remove:${account.id}`, async current => {
      const result = await officialAccountsRequests.removeSiwc(account.id);
      if (!current()) return;
      applyResult(result);
      notice({ tone: result.warning ? "info" : "success", text: result.warning
        ? `已停用官方直连；${result.warning}` : "已停用官方直连，对话恢复默认通道" });
    });
  });

  return {
    accounts, loadError, pending, disabled: !active || isBusy || pending !== null,
    ...usage, refresh,
    login: authorization?.kind === "login" ? authorization : null,
    siwcLogin: authorization?.kind === "siwc" ? authorization : null,
    loginError: authorizationError, siwcError: authorizationError,
    startLogin: () => startAuthorization(), startSiwc: startAuthorization, restartSiwc,
    closeLogin: closeAuthorization, closeSiwc: closeAuthorization,
    manualOpen, manualInput, manualError, openManual, closeManual, changeManualInput, submitManual,
    importCurrent, setDefault, executeRemove, executeRemoveSiwc,
  };
}
