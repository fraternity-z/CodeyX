import { useCallback, useEffect, useState } from "react";
import type { Notice, OfficialAccount, OfficialAccountsResult } from "../../App.types";
import { errorText } from "../../appUtils";
import { useOperationScope } from "../../useOperationScope";
import { useStableEvent } from "../../useStableEvent";
import { rememberOfficialAccounts, routeRequests } from "./requests";

type Options = {
  active: boolean;
  readOnly: boolean;
  onAccountsChanged: (result: OfficialAccountsResult) => void;
  onNotice: (notice: Notice) => void;
};

export function useRoutePanelController({ active, readOnly, onAccountsChanged, onNotice }: Options) {
  const [officialAccounts, setOfficialAccounts] = useState<OfficialAccount[] | null>(null);
  const accountsScope = useOperationScope(active);
  const logsScope = useOperationScope(active);
  const notify = useStableEvent(onNotice);
  const publishAccounts = useStableEvent(onAccountsChanged);

  const refreshOfficialAccounts = useCallback(async () => {
    accountsScope.invalidateReads();
    const current = accountsScope.read();
    if (!current()) return;
    try {
      const result = await routeRequests.accounts();
      if (current()) setOfficialAccounts(result.accounts ?? []);
    } catch {
      if (current()) setOfficialAccounts(null);
    }
  }, [accountsScope]);

  // 可编辑模式由账号面板读取；只读模式仍需账号邮箱。切换模式使旧读取失效。
  useEffect(() => {
    accountsScope.invalidateReads();
    if (active && readOnly) void refreshOfficialAccounts();
    return () => accountsScope.invalidateReads();
  }, [active, readOnly, accountsScope, refreshOfficialAccounts]);

  const adoptOfficialAccounts = useCallback((accounts: OfficialAccount[] | null) => {
    accountsScope.invalidateReads();
    if (accountsScope.read()()) setOfficialAccounts(accounts);
  }, [accountsScope]);

  const handleOfficialAccountsChanged = useCallback((result: OfficialAccountsResult) => {
    if (Array.isArray(result.accounts)) {
      rememberOfficialAccounts(result);
      adoptOfficialAccounts(result.accounts);
    }
    publishAccounts(result);
  }, [adoptOfficialAccounts, publishAccounts]);

  async function openRequestLogs(theme: string) {
    const operation = logsScope.begin();
    if (!operation) return;
    try {
      await routeRequests.openLogs(theme);
    } catch (cause) {
      if (operation.current()) notify({ tone: "error", text: errorText(cause) });
    } finally {
      operation.finish();
    }
  }

  return { officialAccounts, refreshOfficialAccounts, adoptOfficialAccounts, handleOfficialAccountsChanged, openRequestLogs };
}
