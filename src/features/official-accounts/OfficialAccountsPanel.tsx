import { useCallback, useEffect, useState } from "react";
import { IconAlertCircle, IconBrandOpenai, IconClipboard, IconClock, IconLogin2 as IconLogin, IconPlus, IconRefresh, IconSparkles, IconTrash } from "@tabler/icons-react";

import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, TextArea, Tooltip } from "../../components/ui";
import { maskEmail } from "../../sensitiveText";
import type { Confirmation, OfficialAccount } from "../../App.types";
import type { AccountUsageSnapshot, OfficialAccountsControllerOptions } from "./types";
import { useOfficialAccountsController } from "./useOfficialAccountsController";

function formatPlan(plan?: string) {
  if (!plan) return "";
  const known: Record<string, string> = { free: "Free", plus: "Plus", pro: "Pro", team: "Team", business: "Business", enterprise: "Enterprise", edu: "Edu" };
  return known[plan.toLowerCase()] || plan;
}

function planTagClass(plan?: string) {
  const p = plan?.toLowerCase();
  if (p === "plus") return "official-account-plan-badge is-plus";
  if (p === "pro") return "official-account-plan-badge is-pro";
  if (p === "team" || p === "business" || p === "enterprise") return "official-account-plan-badge is-team";
  return "official-account-plan-badge is-default";
}

function formatSpecificResetTime(resetsAt?: number): { full: string; short: string; exact: string; relative: string } | null {
  if (!resetsAt) return null;
  const date = new Date(resetsAt * 1000);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;

  const remaining = resetsAt * 1000 - Date.now();
  let relative = "";
  if (remaining <= 0) {
    relative = "即将重置";
  } else {
    const hours = Math.floor(remaining / 3_600_000);
    if (hours >= 48) {
      relative = `${Math.floor(hours / 24)} 天后`;
    } else if (hours >= 1) {
      relative = `${hours} 小时后`;
    } else {
      relative = `${Math.max(1, Math.floor(remaining / 60_000))} 分钟后`;
    }
  }

  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow =
    date.getFullYear() === tomorrow.getFullYear() &&
    date.getMonth() === tomorrow.getMonth() &&
    date.getDate() === tomorrow.getDate();

  let dateLabel = "";
  if (isToday) {
    dateLabel = "今天 ";
  } else if (isTomorrow) {
    dateLabel = "明天 ";
  } else if (date.getFullYear() === now.getFullYear()) {
    dateLabel = `${date.getMonth() + 1}月${date.getDate()}日 `;
  } else {
    dateLabel = `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} `;
  }

  const exact = `${dateLabel}${time}`;
  return {
    exact,
    relative,
    short: `${exact} 重置`,
    full: `${exact} 重置${relative ? `（${relative}）` : ""}`,
  };
}

function windowLabel(minutes: number) {
  if (minutes === 300) return "5 小时";
  if (minutes === 10080) return "每周";
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

function UsageLine({
  snapshot,
  onRetry,
}: {
  snapshot: AccountUsageSnapshot | null;
  onRetry?: () => void;
}) {
  if (!snapshot) return <small className="official-account-usage">正在读取额度…</small>;
  if (snapshot.status !== "ok") {
    return (
      <small className="official-account-usage is-muted">
        <span>{snapshot.message || "额度暂不可用"}</span>
        {onRetry ? (
          <button
            type="button"
            className="official-account-usage-action"
            onClick={(event) => {
              event.stopPropagation();
              onRetry();
            }}
          >
            重试
          </button>
        ) : null}
      </small>
    );
  }
  const windows = [snapshot.primary, snapshot.secondary].filter(
    (window): window is NonNullable<typeof window> => Boolean(window),
  );
  if (windows.length === 0) return <small className="official-account-usage is-muted">官方未返回额度窗口</small>;
  return (
    <div className="official-account-usage-grid">
      {windows.map((window, index) => {
        const remainingPercent = Math.max(0, Math.min(100, 100 - Math.round(window.usedPercent)));
        const resetInfo = formatSpecificResetTime(window.resetsAt);
        const toneClass =
          remainingPercent <= 10
            ? "is-danger"
            : remainingPercent <= 30
              ? "is-warning"
              : "is-normal";
        const fullTimeTitle = window.resetsAt
          ? `重置时间：${new Date(window.resetsAt * 1000).toLocaleString("zh-CN")}（已消耗 ${Math.round(window.usedPercent)}%，剩余 ${remainingPercent}%）`
          : `已消耗 ${Math.round(window.usedPercent)}%，剩余 ${remainingPercent}%`;
        const resetLabel = resetInfo
          ? resetInfo.relative
            ? resetInfo.relative.endsWith("重置")
              ? resetInfo.relative
              : `${resetInfo.relative}重置`
            : resetInfo.short
          : null;
        return (
          <div
            key={`${window.windowMinutes}-${index}`}
            className="official-account-usage-cell"
            title={fullTimeTitle}
          >
            <div className="official-account-usage-cell-head">
              <span className="official-account-usage-window">{windowLabel(window.windowMinutes)}</span>
              <span className={`official-account-usage-percent ${toneClass}`}>剩余 {remainingPercent}%</span>
            </div>
            <div className="official-account-progress-track" aria-hidden="true">
              <div
                className={`official-account-progress-fill ${toneClass}`}
                style={{ width: `${remainingPercent}%` }}
              />
            </div>
            <div className="official-account-usage-cell-foot">
              {resetLabel ? (
                <>
                  <IconClock size={11} className="official-account-usage-clock" aria-hidden="true" />
                  <span>{resetLabel}</span>
                  {resetInfo?.exact && <span className="official-account-usage-reset-time">（{resetInfo.exact}）</span>}
                </>
              ) : (
                <span className="official-account-usage-reset-none">暂无重置信息</span>
              )}
            </div>
          </div>
        );
      })}
      {snapshot.stale ? <span className="official-account-usage-stale">上次成功数据</span> : null}
    </div>
  );
}

export type OfficialAccountsPanelProps = OfficialAccountsControllerOptions & {
  officialAccountAvailable: boolean;
  maskSensitive?: boolean;
  popupContainer: HTMLElement | null;
  onRequestConfirmation?: (confirmation: Confirmation) => void;
};

export function OfficialAccountsPanel({
  officialAccountAvailable,
  isBusy,
  active,
  maskSensitive = false,
  popupContainer,
  onAccountsLoaded,
  onAccountsChanged,
  onNotice,
  onRequestConfirmation,
}: OfficialAccountsPanelProps) {
  const {
    accounts, loadError, pending, disabled, usages, usagePending, refreshUsage,
    login, loginError, startLogin, closeLogin,
    siwcLogin, siwcError, startSiwc, closeSiwc, restartSiwc,
    manualOpen, manualInput, manualError, openManual, closeManual, changeManualInput, submitManual,
    importCurrent, setDefault, executeRemove, executeRemoveSiwc,
  } = useOfficialAccountsController({ active, isBusy, onAccountsLoaded, onAccountsChanged, onNotice });
  const [confirmAccount, setConfirmAccount] = useState<OfficialAccount | null>(null);
  const [copied, setCopied] = useState(false);
  const [siwcCopied, setSiwcCopied] = useState(false);
  const [confirmSiwcAccount, setConfirmSiwcAccount] = useState<OfficialAccount | null>(null);
  const [confirmDefaultAccount, setConfirmDefaultAccount] = useState<OfficialAccount | null>(null);
  useEffect(() => { setCopied(false); }, [login?.loginId]);
  useEffect(() => { setSiwcCopied(false); }, [siwcLogin?.loginId]);

  async function copySiwcUrl() {
    if (!siwcLogin) return;
    try {
      await navigator.clipboard.writeText(siwcLogin.authUrl);
      setSiwcCopied(true);
    } catch {
      setSiwcCopied(false);
      onNotice({ tone: "info", text: "无法访问剪贴板，请手动复制授权链接" });
    }
  }

  function handleRemoveSiwc(account: OfficialAccount) {
    const label = accountLabel(account);
    if (onRequestConfirmation) {
      onRequestConfirmation({
        action: "disable-official-account-siwc",
        title: `停用「${label}」的官方直连？`,
        description: "将撤销授权并恢复默认通道；账号的额度查询与登录不受影响。",
        confirmLabel: "停用直连",
        run: () => void executeRemoveSiwc(account),
      });
      return;
    }
    setConfirmSiwcAccount(account);
  }

  async function copyAuthUrl() {
    if (!login) return;
    try {
      await navigator.clipboard.writeText(login.authUrl);
      setCopied(true);
    } catch {
      setCopied(false);
      onNotice({ tone: "info", text: "无法访问剪贴板，请手动复制登录链接" });
    }
  }

  // 卡片点击即切换默认账号；切换会改动 Codex 登录身份，先弹确认窗。
  function askSetDefault(account: OfficialAccount) {
    if (disabled) return;
    const label = accountLabel(account);
    if (onRequestConfirmation) {
      onRequestConfirmation({
        action: "set-default-official-account",
        title: `切换默认官方账号为「${label}」？`,
        description: "默认账号决定 Codex 的登录身份；本地路由会即时切换，其余登录态在重启后完全生效。",
        confirmLabel: "设为默认",
        run: () => void setDefault(account),
      });
      return;
    }
    setConfirmDefaultAccount(account);
  }

  // 页面开启脱敏时，账号标签与提示统一使用脱敏后的邮箱。
  const accountLabel = useCallback(
    (account: OfficialAccount) => {
      const email = account.email?.trim();
      if (!email) return account.accountId || account.id;
      return maskSensitive ? maskEmail(email) : email;
    },
    [maskSensitive],
  );

  function handleRemove(account: OfficialAccount) {
    const label = accountLabel(account);
    const title = `移除官方账号「${label}」？`;
    const description = account.isDefault
      ? "它是当前默认账号，移除后 Codex 将退出该账号登录。"
      : "确定要移除该官方账号吗？移除后将无法继续使用该账号。";
    if (onRequestConfirmation) {
      onRequestConfirmation({
        action: "delete-official-account",
        title,
        description,
        confirmLabel: "移除账号",
        run: () => void executeRemove(account),
      });
      return;
    }
    setConfirmAccount(account);
  }

  return (
    <div className="official-accounts-panel" aria-label="官方账号">
      <div className="official-accounts-header">
        <div className="official-accounts-title-group">
          <div className="official-accounts-avatar-pill" aria-hidden="true">
            <IconBrandOpenai size={15} />
          </div>
          <div className="official-accounts-heading-text">
            <div className="official-accounts-title-row">
              <span className="official-accounts-title">官方账号</span>
              {accounts && accounts.length > 0 && (
                <Badge variant="secondary">{accounts.length} 个账号</Badge>
              )}
            </div>
            <small className="official-accounts-subtitle">
              管理 ChatGPT 官方账号身份与使用额度
            </small>
          </div>
        </div>
        <div className="official-accounts-actions">
          <Tooltip content="把 Codex 里已登录的 ChatGPT 账号加入列表">
            <Button variant="link" color="primary" size="xs" disabled={disabled} loading={pending === "import"} onClick={() => void importCurrent()}>
              <IconLogin size={13} aria-hidden="true" />
              <span>导入当前登录</span>
            </Button>
          </Tooltip>
          <Tooltip content="粘贴 Refresh Token 或 OAuth JSON">
            <Button variant="link" color="primary" size="xs" disabled={disabled} onClick={openManual}>
              <IconClipboard size={13} aria-hidden="true" />
              <span>手动输入</span>
            </Button>
          </Tooltip>
          <Button variant="brand-outline" size="xs" disabled={disabled} loading={pending === "login"} onClick={() => void startLogin()}>
            <IconPlus size={13} aria-hidden="true" />
            <span>添加账号</span>
          </Button>
        </div>
      </div>

      {loadError && <small className="official-accounts-error">{loadError}</small>}
      {accounts && accounts.length === 0 && !loadError && (
        <small className="official-accounts-empty">尚未添加官方账号。添加后每个账号都会成为一条官方线路，设为默认只决定 Codex 的登录身份和页头额度来源。</small>
      )}

      {accounts && accounts.length > 0 && (
        <ul className="official-account-list">
          {accounts.map((account) => {
            const label = accountLabel(account);
            // 账号记录里的套餐只反映添加账号时的登录信息。额度查询每次都带
            // 官方当前的套餐，有它时以它为准，降级后才不会继续显示 Pro。
            const snapshotPlan = usages[account.id]?.status === "ok" ? usages[account.id]?.planType : undefined;
            const planType = snapshotPlan || account.planType;
            const plan = formatPlan(planType);
            const usageLoading = Boolean(usagePending[account.id]);
            const usageSnapshot = usages[account.id] ?? null;
            const siwcStatus = account.siwcStatus ?? "none";
            const siwcBusy = pending === `siwc:${account.id}` || pending === `siwc-remove:${account.id}`;
            // 后端标记失效或额度查询刚发现凭据被拒时，额度行换成失效交互。
            const usageInvalid =
              Boolean(account.invalid) ||
              usageSnapshot?.reason === "official_account_invalid" ||
              usageSnapshot?.reason === "official_account_credential_rejected";
            const usageInvalidText =
              usageSnapshot?.reason === "official_account_credential_rejected"
                ? "官方已拒绝该账号的凭据，需要重新添加"
                : account.invalidReason || usageSnapshot?.message || "账号凭据已失效";
            const switchable = !account.isDefault && !account.invalid;
            const siwcTip =
              siwcStatus === "active"
                ? "官方直连已启用，对话走 OpenAI 官方通道；点击停用并撤销授权，恢复默认通道"
                : siwcStatus === "invalid"
                  ? `${account.siwcInvalidReason || "官方直连授权已失效"}，点击重新授权`
                  : "通过 Sign in with ChatGPT 二次授权，对话走 OpenAI 官方通道；额度查询等继续使用现有登录";
            return (
              <li
                key={account.id}
                className={`official-account-item${account.isDefault ? " is-default" : ""}${account.invalid ? " is-invalid" : ""}${switchable ? " is-switchable" : ""}`}
                {...(switchable
                  ? {
                      role: "button",
                      tabIndex: 0,
                      title: "点击切换为默认官方账号",
                      onClick: (event: React.MouseEvent) => {
                        // li 自身也是 role=button，不能把卡片算进交互元素。
                        if ((event.target as HTMLElement).closest("button, a, input, textarea")) return;
                        // 拖选文本时的点击不弹确认窗。
                        if (window.getSelection()?.toString()) return;
                        askSetDefault(account);
                      },
                      onKeyDown: (event: React.KeyboardEvent) => {
                        if (event.target !== event.currentTarget) return;
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          askSetDefault(account);
                        }
                      },
                    }
                  : {})}
              >
                {account.isDefault && (
                  <span
                    className={`official-account-default-corner${account.invalid ? " is-invalid" : officialAccountAvailable ? " is-ready" : " is-pending"}`}
                    title={
                      account.invalid
                        ? "默认官方账号（凭据已失效）"
                        : officialAccountAvailable
                          ? "默认官方账号，Codex 以此账号登录"
                          : "默认官方账号，Codex 重启后生效"
                    }
                  >
                    默认
                  </span>
                )}
                <div className="official-account-item-top">
                  <div className="official-account-item-left">
                    <div className="official-account-item-icon-pill" aria-hidden="true">
                      <IconBrandOpenai size={16} className="official-account-avatar" />
                    </div>
                    <div className="official-account-main">
                      <div className="official-account-line">
                        <strong title={label}>{label}</strong>
                        {plan && (
                          <span className={planTagClass(planType)}>
                            {planType?.toLowerCase() === "pro" ? (
                              <IconSparkles size={11} stroke={2.2} className="official-account-plan-icon" aria-hidden="true" />
                            ) : null}
                            <span>{plan}</span>
                          </span>
                        )}
                        {account.invalid && (
                          <Badge variant="destructive" title={account.invalidReason}>
                            已失效
                          </Badge>
                        )}
                        {!account.invalid && (
                          <Tooltip content={siwcTip}>
                            <button
                              type="button"
                              className={`official-account-siwc-chip is-${siwcStatus}`}
                              disabled={disabled || siwcBusy}
                              aria-label={
                                siwcStatus === "active"
                                  ? "停用官方直连"
                                  : siwcStatus === "invalid"
                                    ? "重新授权官方直连"
                                    : "启用官方直连"
                              }
                              onClick={() =>
                                siwcStatus === "active" ? handleRemoveSiwc(account) : void startSiwc(account)
                              }
                            >
                              <IconBrandOpenai size={11} className={siwcBusy ? "animate-spin" : undefined} aria-hidden="true" />
                              <span>{siwcStatus === "invalid" ? "官方直连 · 已失效" : "官方直连"}</span>
                            </button>
                          </Tooltip>
                        )}
                        {!account.invalid && !usageInvalid && (
                          <Tooltip content={usageLoading ? "正在刷新额度…" : "刷新额度"}>
                            <button
                              type="button"
                              className="official-account-usage-refresh-chip"
                              disabled={disabled || usageLoading}
                              aria-label={usageLoading ? "正在刷新额度" : "刷新额度"}
                              onClick={() => void refreshUsage(account.id, true)}
                            >
                              <IconRefresh size={11} className={usageLoading ? "animate-spin" : undefined} aria-hidden="true" />
                              <span>{usageLoading ? "正在刷新" : "刷新额度"}</span>
                            </button>
                          </Tooltip>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
                <div className="official-account-usage-container">
                  {usageInvalid ? (
                    <small className="official-account-usage is-error">
                      <IconAlertCircle size={12} className="official-account-usage-error-icon" aria-hidden="true" />
                      <span>{usageInvalidText}</span>
                      <button
                        type="button"
                        className="official-account-usage-action"
                        disabled={disabled}
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleRemove(account);
                        }}
                      >
                        重新添加
                      </button>
                    </small>
                  ) : (
                    <UsageLine
                      snapshot={usageSnapshot}
                      onRetry={() => void refreshUsage(account.id, true)}
                    />
                  )}
                </div>
                <div className="official-account-controls">
                  <Button
                    variant="link"
                    color="danger"
                    size="icon-sm"
                    className="official-account-delete-btn"
                    disabled={disabled}
                    loading={pending === `remove:${account.id}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleRemove(account);
                    }}
                    aria-label={`移除官方账号 ${label}`}
                    title="移除账号"
                  >
                    <IconTrash size={14} aria-hidden="true" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog open={active && login !== null} onOpenChange={(open) => { if (!open) void closeLogin(); }}>
        <DialogContent className="official-login-dialog" container={popupContainer}>
          <DialogHeader>
            <DialogTitle>添加官方账号</DialogTitle>
            <DialogDescription>
              {login?.browserOpened === false
                ? "未能自动打开浏览器，请复制下方链接手动打开并完成 ChatGPT 登录。"
                : "已在系统浏览器打开 ChatGPT 登录页，完成登录后会自动回到这里。"}
            </DialogDescription>
          </DialogHeader>
          <div className="official-login-body">
            <code className="official-login-url" title={login?.authUrl}>{login?.authUrl}</code>
            {loginError
              ? <small className="official-accounts-error">{loginError}</small>
              : <small className="official-login-waiting">等待浏览器完成登录…（10 分钟内有效）</small>}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => void copyAuthUrl()}>
              {copied ? "已复制" : "复制登录链接"}
            </Button>
            {loginError ? (
              <Button size="sm" disabled={disabled} onClick={() => void startLogin()}>重新开始</Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => void closeLogin()}>取消</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={active && siwcLogin !== null} onOpenChange={(open) => { if (!open) void closeSiwc(); }}>
        <DialogContent className="official-login-dialog" container={popupContainer}>
          <DialogHeader>
            <DialogTitle>启用官方直连</DialogTitle>
            <DialogDescription>
              {siwcLogin?.browserOpened === false
                ? "未能自动打开浏览器，请复制下方链接手动打开并完成授权。"
                : "已在系统浏览器打开授权页。授权后将通过 OpenAI 官方通道调用你的 ChatGPT 订阅，完成后会自动回到这里。"}
            </DialogDescription>
          </DialogHeader>
          <div className="official-login-body">
            <code className="official-login-url" title={siwcLogin?.authUrl}>{siwcLogin?.authUrl}</code>
            {siwcError
              ? <small className="official-accounts-error">{siwcError}</small>
              : <small className="official-login-waiting">等待浏览器完成授权…（10 分钟内有效）</small>}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => void copySiwcUrl()}>
              {siwcCopied ? "已复制" : "复制授权链接"}
            </Button>
            {siwcError ? (
              <Button size="sm" disabled={disabled} onClick={() => void restartSiwc()}>重新开始</Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => void closeSiwc()}>取消</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={active && manualOpen} onOpenChange={(open) => { if (!open) closeManual(); }}>
        <DialogContent
          className="sm:w-[520px]"
          container={popupContainer}
          onEscapeKeyDown={(event) => { if (pending === "manual") event.preventDefault(); }}
          onPointerDownOutside={(event) => { if (pending === "manual") event.preventDefault(); }}
        >
          <DialogHeader>
            <DialogTitle>手动添加官方账号</DialogTitle>
            <DialogDescription>
              粘贴 Refresh Token，或包含 access_token 与 refresh_token 的 OAuth JSON。只含 Refresh Token 时会向官方换取登录；已含 access token 的 JSON 直接保存，不会轮换来源令牌。
            </DialogDescription>
          </DialogHeader>
          <div className="official-login-body">
            <TextArea
              aria-label="Refresh Token 或 OAuth JSON"
              autoFocus
              autoComplete="off"
              className="min-h-[148px] resize-y font-mono text-xs leading-relaxed"
              disabled={pending === "manual"}
              placeholder="Refresh Token 或 OAuth JSON"
              spellCheck={false}
              value={manualInput}
              onChange={(event) => changeManualInput(event.target.value)}
            />
            {manualError ? <small className="official-accounts-error">{manualError}</small> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" disabled={pending === "manual"} onClick={closeManual}>取消</Button>
            <Button size="sm" disabled={disabled || manualInput.trim() === ""} loading={pending === "manual"} onClick={() => void submitManual()}>
              添加
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={active && confirmDefaultAccount !== null} onOpenChange={(open) => { if (!open) setConfirmDefaultAccount(null); }}>
        <DialogContent className="confirmation-dialog" container={popupContainer}>
          <DialogHeader>
            <DialogTitle>
              {confirmDefaultAccount ? `切换默认官方账号为「${accountLabel(confirmDefaultAccount)}」？` : "切换默认官方账号？"}
            </DialogTitle>
            <DialogDescription>
              默认账号决定 Codex 的登录身份；本地路由会即时切换，其余登录态在重启后完全生效。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDefaultAccount(null)}>取消</Button>
            <Button
              disabled={disabled}
              loading={confirmDefaultAccount ? pending === `default:${confirmDefaultAccount.id}` : false}
              onClick={() => {
                const target = confirmDefaultAccount;
                setConfirmDefaultAccount(null);
                if (target) void setDefault(target);
              }}
            >
              设为默认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={active && confirmSiwcAccount !== null} onOpenChange={(open) => { if (!open) setConfirmSiwcAccount(null); }}>
        <DialogContent className="confirmation-dialog" container={popupContainer}>
          <DialogHeader>
            <DialogTitle>
              {confirmSiwcAccount ? `停用「${accountLabel(confirmSiwcAccount)}」的官方直连？` : "停用官方直连？"}
            </DialogTitle>
            <DialogDescription>
              将撤销授权并恢复默认通道；账号的额度查询与登录不受影响。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmSiwcAccount(null)}>取消</Button>
            <Button
              variant="destructive"
              disabled={disabled}
              loading={confirmSiwcAccount ? pending === `siwc-remove:${confirmSiwcAccount.id}` : false}
              onClick={() => {
                const target = confirmSiwcAccount;
                setConfirmSiwcAccount(null);
                if (target) void executeRemoveSiwc(target);
              }}
            >
              停用直连
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={active && confirmAccount !== null} onOpenChange={(open) => { if (!open) setConfirmAccount(null); }}>
        <DialogContent className="confirmation-dialog" container={popupContainer}>
          <DialogHeader>
            <DialogTitle>
              {confirmAccount ? `移除官方账号「${accountLabel(confirmAccount)}」？` : "移除官方账号？"}
            </DialogTitle>
            <DialogDescription>
              {confirmAccount?.isDefault
                ? "它是当前默认账号，移除后 Codex 将退出该账号登录。"
                : "确定要移除该官方账号吗？移除后将无法继续使用该账号。"}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmAccount(null)}>取消</Button>
            <Button
              variant="destructive"
              disabled={disabled}
              loading={confirmAccount ? pending === `remove:${confirmAccount.id}` : false}
              onClick={() => {
                const target = confirmAccount;
                setConfirmAccount(null);
                if (target) void executeRemove(target);
              }}
            >
              <IconTrash aria-hidden="true" />
              移除账号
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
