import { useEffect, useRef, useState } from "react";
import { IconRefresh, IconTools } from "@tabler/icons-react";
import type { Config, FastContextToolsStatus } from "./App.types";
import { invoke } from "./api";
import { errorText } from "./appUtils";
import { Badge, Button, Switch, Tooltip } from "./components/ui";
import { SettingsPageHeader } from "./SettingsPageHeader";
import type { BuiltinToolsStatus } from "./builtinTools";

type Props = {
  active: boolean;
  config: Config;
  fastContextToolsStatus: FastContextToolsStatus;
  isBusy: boolean;
  onConfigChange: (config: Config) => void;
};

export function BuiltinToolsPage({ active, config, fastContextToolsStatus, isBusy, onConfigChange }: Props) {
  const [status, setStatus] = useState<BuiltinToolsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const pending = useRef(false);
  const generation = useRef(0);
  const fastctxStatusBlocksEmbedded = fastContextToolsStatus.userConfigured || fastContextToolsStatus.detectionFailed;
  const fastContextToolsEnabled = config.fastContextTools && !fastctxStatusBlocksEmbedded;
  const fastctxBlockedReason = fastContextToolsStatus.detectionFailed
    ? "暂时无法确认 Codex 配置中的 FastCtx 状态，为避免重复加载，CodeyX 内置 FastCtx 不可开启"
    : `已检测到 Codex 配置中的 FastCtx${fastContextToolsStatus.serverId ? `（${fastContextToolsStatus.serverId}）` : ""}，为避免重复加载，CodeyX 内置 FastCtx 不可开启`;
  const fastContextToolsSwitch = (
    <Switch checked={fastContextToolsEnabled} disabled={isBusy || fastctxStatusBlocksEmbedded}
      onCheckedChange={(checked) => onConfigChange({ ...config, fastContextTools: checked })}
      aria-label="启用 FastCtx 上下文工具" />
  );

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await invoke<BuiltinToolsStatus>("builtin_tools", { action: "status" });
        if (cancelled) return;
        setStatus(next);
        setError("");
        timer = setTimeout(poll, next.job?.phase === "running" ? 1500 : 5000);
      } catch (cause) {
        if (!cancelled) setError(errorText(cause));
      }
    }
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [active, refreshKey]);

  useEffect(() => () => { ++generation.current; }, []);

  async function run(action: () => Promise<void>) {
    if (pending.current) return;
    const current = generation.current;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try { await action(); }
    catch (cause) { if (generation.current === current) setError(errorText(cause)); }
    finally { pending.current = false; if (generation.current === current) setBusy(false); }
  }

  const running = status?.job?.phase === "running";
  const blocked = busy || running || isBusy || !status;
  const userManaged = Boolean(status?.mcp.id && !status.mcp.managed);

  async function setEnabled(enabled: boolean) {
    const next = await invoke<BuiltinToolsStatus>("builtin_tools", { action: "set_enabled", enabled });
    setStatus(next);
    setNotice(next.message ?? "");
    setRefreshKey(key => key + 1);
  }

  return (
    <section className="secondary-section" aria-labelledby="builtin-tools-title">
      <SettingsPageHeader id="builtin-tools-title" title="内置工具" icon={<IconTools size={15} />}
        description="统一管理文件检索与代码关系索引，让上下文获取更高效。" />
      <div className="flex flex-col gap-4">
        <article className={`feature-card ${fastContextToolsEnabled ? "active" : ""}`}>
          <div className="feature-card-header">
            <div className="feature-card-title"><strong>FastCtx 上下文工具</strong><Badge variant="brand">v0.2.6</Badge></div>
            {fastctxStatusBlocksEmbedded ? (
              <Tooltip content={fastctxBlockedReason} position="top">
                <span className="fastctx-disabled-switch-tooltip" tabIndex={0} aria-label={fastctxBlockedReason}>{fastContextToolsSwitch}</span>
              </Tooltip>
            ) : fastContextToolsSwitch}
          </div>
          <div className="feature-card-body">
            <p className="m-0 text-xs">读取本地文件、搜索内容与定位路径，无需预先建立索引。</p>
            <small>{fastctxStatusBlocksEmbedded ? fastctxBlockedReason : config.fastContextTools
              ? "保存后，下次启动加载 CodeyX 内置 FastCtx 文件工具。" : "开启并保存后，下次启动生效。"}</small>
          </div>
        </article>

        <article className={`feature-card ${status?.mcp.enabled ? "active" : ""}`} aria-busy={Boolean(running)}>
          <div className="feature-card-header">
            <div className="feature-card-title"><strong>CodeGraph 代码索引</strong>
              <Badge variant={status?.installed ? "brand" : "secondary"}>{status ? status.installed ? `v${status.version}` : "待安装" : "检测中"}</Badge>
            </div>
            <Switch checked={Boolean(status?.mcp.enabled && status.mcp.automatic)} disabled={blocked || userManaged}
              aria-label="启用 CodeGraph 自动索引" onCheckedChange={enabled => void run(() => setEnabled(enabled))} />
          </div>
          <div className="feature-card-body flex flex-col gap-3">
            <p className="m-0 text-xs leading-relaxed">理解符号、调用链与模块依赖。启用后，在项目中聊天时自动后台建立索引，并持续同步代码变化。</p>
            {status?.mcp.id && <small>{status.mcp.managed ? "CodeyX 管理的 MCP" : `已配置的 MCP：${status.mcp.id}`} · {status.mcp.enabled ? "已启用" : "已停用"}</small>}
            {userManaged && <small>已检测到你配置的 CodeGraph。请在 MCP 管理中使用或调整，内置版本不会重复接入。</small>}
            {status?.mcp.managed && !status.mcp.automatic && <small>开启自动索引后，已有接入将升级为随聊天项目自动运行。</small>}
            <small>首次启用会下载官方运行包，下一轮项目聊天生效。无需填写路径或执行命令；首次索引期间可继续聊天，关闭后保留已有索引。</small>
            {status?.mcp.automatic && status.mcp.enabled && !status.projects.length && <p role="status" className="m-0 text-xs text-muted">等待项目聊天，索引将自动开始。</p>}
            {Boolean(status?.projects.length) && <div className="flex flex-col gap-2 text-xs" aria-label="最近自动接入的项目">
              {status!.projects.map(project => <div key={project.projectPath} className="rounded-lg border border-default p-3 min-w-0">
                <div className="font-medium break-all">{project.projectPath}</div>
                <div className={`mt-1 ${project.phase === "failed" ? "text-danger" : "text-muted"}`}>{project.message}</div>
              </div>)}
            </div>}
            <div className="flex flex-wrap gap-2">
              {status?.job?.phase === "failed" && <Button size="sm" disabled={blocked || userManaged} onClick={() => void run(() => setEnabled(true))}>重试启用</Button>}
              <Button size="sm" variant="outline" disabled={busy || isBusy} onClick={() => setRefreshKey(key => key + 1)}>
                <IconRefresh size={14} aria-hidden="true" />刷新</Button>
            </div>
            {status?.job && <div role={status.job.phase === "failed" ? "alert" : "status"} className={`rounded-lg p-3 text-xs break-words ${status.job.phase === "failed" ? "bg-red-500/10 text-danger" : "bg-default/40"}`}>
              {status.job.message}
            </div>}
            {error && <p role="alert" className="m-0 text-xs text-danger break-words">{error}</p>}
            {notice && <p role="status" className="m-0 text-xs">{notice}</p>}
          </div>
        </article>
      </div>
    </section>
  );
}
