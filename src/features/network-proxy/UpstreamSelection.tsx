import { Badge, Button, Switch } from "../../components/ui";
import { ProxySelectionField } from "./ProxySelectionField";
import type { useNetworkProxyController } from "./useNetworkProxyController";

type Controller = ReturnType<typeof useNetworkProxyController>;

export function UpstreamSelection({ controller: c }: { controller: Controller }) {
  if (c.remote) return null;
  return <section className="proxy-pool" aria-labelledby="proxy-upstream-title">
    <div><h3 id="proxy-upstream-title" className="settings-section-heading">线路代理</h3>
      <p className="proxy-help">开启后选择代理池节点；关闭时沿用线路原有代理或软件默认网络，所选节点会保留。</p>
      <p className="proxy-help">对话、图片、模型目录和账号请求共用所选节点；节点不可用时停止连接。保存只影响后续请求，外部浏览器沿用自己的网络设置。</p></div>
    {!c.routerEnabled && <p className="proxy-help" role="note">请先启用本地路由，再开启线路代理。</p>}
    <ul className="proxy-node-list" aria-label="线路出口列表">{c.upstreamRows.map(row => {
      const draft = c.upstreamDraft?.profileId === row.id ? c.upstreamDraft : null;
      const enabled = draft?.enabled ?? row.enabled;
      return <li key={row.id} className="proxy-node">
        <div className="proxy-pool-heading"><strong>{row.label}</strong>
          <Switch size="sm" label="使用代理池" aria-label={`使用代理池 ${row.label}`} checked={enabled}
            disabled={draft ? c.draftDisabled : c.disabled || c.editing}
            onCheckedChange={value => draft ? c.changeUpstreamEnabled(value) : c.openUpstream(row.id, value)} /></div>
        {draft ? <form className="proxy-editor" aria-label="线路出口编辑" onSubmit={event => { event.preventDefault(); void c.saveUpstream(); }}>
          {enabled ? <fieldset disabled={c.draftDisabled} className="proxy-editor-grid"><ProxySelectionField label="线路代理节点"
            selection={draft.selection} pool={c.pool} onChange={c.changeUpstream} /></fieldset>
            : <p className="proxy-help">保存后沿用线路原有代理或软件默认网络。</p>}
          {c.upstreamDraftError && <p className="proxy-help" role="alert">{c.upstreamDraftError}</p>}
          <div className="proxy-actions"><Button size="xs" type="submit" disabled={c.disabled || Boolean(c.upstreamDraftError)} loading={c.busy === "save-upstream"}>保存线路代理</Button>
            <Button size="xs" variant="light" disabled={c.busy !== null} onClick={c.cancelUpstream}>取消线路编辑</Button></div>
        </form> : <>
          <div className="proxy-actions"><Badge variant="secondary">{row.enabled ? "已启用" : "默认设置"}</Badge>
            {row.enabled && <><span>{row.selectedLabel}</span><Button size="xs" variant="light" disabled={c.disabled || c.editing} onClick={() => c.openUpstream(row.id)}>选择节点 {row.label}</Button></>}
          </div>
          {row.problem && <p className="text-danger text-xs" role="alert">{row.problem}</p>}
          {row.enabled && row.selection.kind === "node" && <div className="proxy-actions"><Button size="xs" variant="light" disabled={c.disabled}
            loading={c.busy === `test:${row.selection.id}`} onClick={() => { if (row.selection.kind === "node") void c.testNode(row.selection.id); }}>测试所选出口</Button></div>}
          {row.probe && <div className="proxy-probe" role="status"><span>{row.probe.stale ? "出口配置已变化，请重新测试" : row.probe.success ? "出口检测成功" : "出口检测未成功"} · {row.probe.elapsedMs} ms</span>
            {row.probe.exitIp && <span>观测出口：{row.probe.exitIp}</span>}<span>{row.probe.message}</span></div>}
        </>}
        {!row.profile && <p className="proxy-help">线路当前不可用，代理设置仍保留。</p>}
      </li>;
    })}</ul>
    {!c.upstreamRows.length && <p className="proxy-empty">添加线路后，可在这里选择代理。</p>}
  </section>;
}
