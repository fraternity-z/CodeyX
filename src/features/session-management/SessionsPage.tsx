import { IconAlertTriangle, IconLoader2, IconMessages, IconMessageOff, IconRefresh, IconTrash } from "@tabler/icons-react";
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui";
import { SettingsPageHeader } from "../../SettingsPageHeader";
import { sessionDate, sessionPath } from "./state";
import type { SessionFilter } from "./types";
import { useSessionsController } from "./useSessionsController";

export function SessionsPage({ active, isBusy, onRestart, container }: {
  active: boolean;
  isBusy: boolean;
  onRestart: () => void;
  container?: HTMLElement | null;
}) {
  const c = useSessionsController({ active, isBusy, onRestart });
  const pending = c.result?.restartRequired || !!c.inventory?.pendingCount;
  return <section className="secondary-section" aria-labelledby="sessions-title" aria-busy={!!c.busy}>
    <SettingsPageHeader id="sessions-title" title="会话管理" icon={<IconMessages size={15} />}
      description="选择清理本机 Codex 会话，或一次清空全部会话与归档。" />
    <div className="flex flex-col gap-4">
      <p className="codey-callout m-0" data-tone="warning"><IconAlertTriangle size={15} aria-hidden="true" />
        <span>永久删除会话记录、归档及关联历史缓存，无法撤销。仅处理本机数据；项目文件、账号配置和云端会话不在清理范围内。</span></p>
      {pending && <div role="status" className="codey-callout" data-tone="warning">
        <IconRefresh size={15} aria-hidden="true" />
        <div className="codey-callout-body">
          <p>{c.result?.errors.length ? "部分数据仍待清理。" : "清理请求已保存。"}请通过 CodeyX 重启 Codex，完成剩余缓存清理并刷新侧边栏。重启前请先停止正在运行的任务。</p>
          <div><Button size="sm" disabled={!!c.busy || isBusy} onClick={c.restart}>重启 Codex</Button></div>
        </div>
      </div>}
      {c.error && <p role="alert" className="codey-callout" data-tone="danger">{c.error}</p>}
      {c.result?.errors.map((error, index) => <p role="alert" key={index} className="codey-callout" data-tone="danger">{error}</p>)}
      <div className="flex flex-wrap gap-2 items-center">
        <input type="search" aria-label="搜索会话" placeholder="搜索标题、项目路径或会话 ID" value={c.query}
          disabled={c.busy === "delete"} onChange={event => c.changeQuery(event.target.value)}
          className="input min-w-[200px] flex-1" />
        <select aria-label="会话范围" value={c.filter} disabled={c.busy === "delete"}
          onChange={event => c.changeFilter(event.target.value as SessionFilter)} className="input codey-native-select w-auto">
          <option value="all">全部会话</option><option value="active">未归档</option><option value="archived">已归档</option>
        </select>
        <Button variant="outline" loading={c.busy === "list"} disabled={!!c.busy || isBusy} onClick={c.refresh}>{c.busy !== "list" && <IconRefresh size={14} aria-hidden="true" />}刷新</Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-muted tabular-nums" aria-live="polite">共 {c.inventory?.sessions.length ?? 0} 个 · 已选 <strong className={c.selected.size ? "text-[var(--codey-blue)]" : "font-normal"}>{c.selected.size}</strong> 个</span>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={c.blocked || !c.visible.length} onClick={c.toggleVisible}>
            {c.visible.length > 0 && c.visible.every(session => c.selected.has(session.id)) ? "取消本页选择" : "选择本页"}</Button>
          <Button size="sm" variant="destructive" disabled={c.blocked || !c.selected.size} onClick={() => c.askRemove(false)}><IconTrash size={14} aria-hidden="true" />清理所选</Button>
          <Button size="sm" variant="destructive-light" disabled={c.blocked || !c.inventory?.sessions.length} onClick={() => c.askRemove(true)}>清空全部（含归档）</Button>
        </div>
      </div>
      {c.busy && <p role="status" className="codey-inline-status"><IconLoader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />{c.busy === "delete" ? "正在清理会话数据…" : "正在读取本机会话…"}</p>}
      {!c.busy && c.inventory && !c.visible.length && <p className="codey-empty-state"><IconMessageOff size={22} stroke={1.6} aria-hidden="true" />{c.inventory.sessions.length ? "没有符合条件的会话。" : "暂无本机会话。"}</p>}
      <div className="flex flex-col gap-2" aria-label="本机会话列表">
        {c.visible.map(session => <label key={session.id} className="codey-select-row">
          <input type="checkbox" aria-label={`选择会话 ${session.title}`} checked={c.selected.has(session.id)} disabled={c.blocked}
            onChange={() => c.toggle(session.id)} className="codey-native-check" />
          <span className="min-w-0 flex-1 space-y-1">
            <span className="flex flex-wrap items-center gap-2"><strong className="text-sm font-semibold break-words min-w-0">{session.title}</strong><Badge variant={session.archived ? "secondary" : "info"}>{session.archived ? "已归档" : "未归档"}</Badge></span>
            <span className="block break-all text-xs text-muted">{sessionPath(session.cwd) || "未记录项目路径"}</span>
            <span className="block break-all text-[11px] text-muted tabular-nums">{sessionDate(session.updatedAt)} · <span className="font-mono">{session.id}</span></span>
          </span>
        </label>)}
      </div>
      {c.filteredCount > 20 && <div className="flex items-center justify-end gap-3 text-xs">
        <Button size="sm" variant="outline" disabled={c.blocked || c.page === 0} onClick={() => c.changePage(c.page - 1)}>上一页</Button>
        <span className="tabular-nums text-muted">{c.page + 1} / {c.pages}</span>
        <Button size="sm" variant="outline" disabled={c.blocked || c.page + 1 === c.pages} onClick={() => c.changePage(c.page + 1)}>下一页</Button>
      </div>}
    </div>
    {active && c.confirmation && <Dialog open onOpenChange={open => { if (!open) c.cancelRemove(); }}>
      <DialogContent container={container} onEscapeKeyDown={event => { if (c.busy === "delete") event.preventDefault(); }}>
        <DialogHeader><DialogTitle>{c.confirmation.all ? "清空全部本机会话？" : "永久清理所选会话？"}</DialogTitle>
          <DialogDescription>将永久清理 {c.confirmation.ids.length} 个本机会话，其中归档 {c.confirmation.archivedCount} 个，包括会话内容及关联历史缓存。{c.confirmation.all ? "此操作包含当前筛选条件以外的全部会话。" : ""}无法撤销，完成后需要通过 CodeyX 重启 Codex。</DialogDescription></DialogHeader>
        <DialogFooter><Button variant="outline" disabled={c.busy === "delete"} onClick={c.cancelRemove}>取消</Button>
          <Button variant="destructive" loading={c.busy === "delete"} onClick={() => void c.remove()}>确认永久清理</Button></DialogFooter>
      </DialogContent>
    </Dialog>}
  </section>;
}
