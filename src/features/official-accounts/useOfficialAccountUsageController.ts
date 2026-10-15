import { useEffect, useRef, useState } from "react";
import type { OfficialAccount, OfficialAccountsResult } from "../../App.types";
import { errorText } from "../../appUtils";
import { useStableEvent } from "../../useStableEvent";
import { accountUsageRequests } from "./requests";
import type { AccountUsageSnapshot } from "./types";

type Options = {
  active: boolean;
  accounts: OfficialAccount[] | null;
  onAccountsChanged: (result: OfficialAccountsResult) => void;
  onError: (message: string) => void;
};

// 逐条读取之间留出间隔，避免同时向官方接口发起多项额度查询。
const USAGE_QUERY_STAGGER_MS = 200;

export function useOfficialAccountUsageController({ active, accounts, onAccountsChanged, onError }: Options) {
  const [usages, setUsages] = useState<Record<string, AccountUsageSnapshot | null>>({});
  const [usagePending, setUsagePending] = useState<Record<string, number>>({});
  const session = useRef<object | null>(null);
  const requestTokens = useRef(new Map<string, object>());
  const routeGeneration = useRef(0);
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;

  const refreshRoutes = useStableEvent(async (current: () => boolean) => {
    const generation = ++routeGeneration.current;
    try {
      const result = await accountUsageRequests.refreshRoutes();
      if (!current() || generation !== routeGeneration.current) return;
      onAccountsChanged(result);
      onError("");
    } catch (error) {
      if (current() && generation === routeGeneration.current) onError(errorText(error));
    }
  });

  const refreshUsage = useStableEvent(async (accountId: string, force: boolean) => {
    const currentSession = session.current;
    const known = accountsRef.current?.find((account) => account.id === accountId);
    if (!active || !currentSession || !known || known.invalid) return;
    const token = {};
    requestTokens.current.set(accountId, token);
    const current = () => session.current === currentSession && requestTokens.current.get(accountId) === token;
    setUsagePending((previous) => ({ ...previous, [accountId]: 1 }));
    setUsages((previous) => ({ ...previous, [accountId]: previous[accountId] ?? null }));
    try {
      const snapshot = await accountUsageRequests.usage(accountId, force);
      if (!current()) return;
      setUsages((previous) => ({ ...previous, [accountId]: snapshot }));
      // 后端确认账号失效后同步派生线路；过期额度不得触发后续请求。
      if (snapshot.reason === "official_account_invalid") void refreshRoutes(current);
    } catch (error) {
      if (current()) setUsages((previous) => ({ ...previous, [accountId]: { status: "error", message: errorText(error) } }));
    } finally {
      if (current()) setUsagePending((previous) => ({ ...previous, [accountId]: 0 }));
    }
  });

  const accountListKey = accounts?.map((account) => `${account.id}:${account.invalid ? 1 : 0}:${account.invalidReason ?? ""}`).join("\n") ?? "";
  useEffect(() => {
    const currentSession = active ? {} : null;
    session.current = currentSession;
    requestTokens.current.clear();
    setUsagePending({});
    let timer: number | undefined;
    const current = () => currentSession !== null && session.current === currentSession;
    const list = accountsRef.current ?? [];
    let index = 0;
    const queryNext = async () => {
      if (!current()) return;
      while (index < list.length && list[index].invalid) {
        const account = list[index++];
        setUsages((previous) => ({ ...previous, [account.id]: {
          status: "error", reason: "official_account_invalid",
          message: account.invalidReason || "账号已失效，不再查询额度；重新添加该账号即可恢复",
        } }));
      }
      if (index >= list.length) return;
      await refreshUsage(list[index++].id, false);
      if (current() && index < list.length) timer = window.setTimeout(() => void queryNext(), USAGE_QUERY_STAGGER_MS);
    };
    void queryNext();
    return () => {
      session.current = null;
      requestTokens.current.clear();
      window.clearTimeout(timer);
    };
  }, [active, accountListKey, refreshUsage]);

  return { usages, usagePending, refreshUsage };
}
