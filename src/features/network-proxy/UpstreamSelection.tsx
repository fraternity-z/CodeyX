import { Badge, Button } from "../../components/ui";
import { ProxySelectionField } from "./ProxySelectionField";
import type { useNetworkProxyController } from "./useNetworkProxyController";

type Controller = ReturnType<typeof useNetworkProxyController>;

export function UpstreamSelection({ controller: c }: { controller: Controller }) {
  if (c.remote) return null;
  const draft = c.upstreamDraft;
  return <section className="proxy-pool" aria-labelledby="proxy-upstream-title">
    <div className="proxy-pool-heading"><div>
      <h3 id="proxy-upstream-title" className="settings-section-heading">线路上游出口</h3>
      <p className="proxy-help">为每条线路指定节点、链路或出口策略，覆盖该线路原有的手动上游设置。</p>
    </div></div>
    <p className="proxy-help">对话、图片、模型目录和 Codey 维护的账号请求使用同一选择。固定选择遇到故障即停止；策略选择按显式配置处理故障。保存后影响后续请求，正在传输的响应继续使用原出口；使用代理池时采用 HTTP/SSE。</p>
    <p className="proxy-help">这里只设置线路出口。Codex 其他进程流量仍由上方启动代理控制；外部浏览器登录沿用浏览器的网络设置。固定选择不保证服务商永远分配相同 IP，可通过节点或链路测试核对。</p>
    {!c.routerEnabled && <p className="proxy-help" role="note">当前未启用本地路由，暂不能新增代理池出口选择。</p>}
    {draft && <form className="proxy-editor" aria-label="线路出口编辑" onSubmit={event => { event.preventDefault(); void c.saveUpstream(); }}>
      <h4>选择出口 · {c.upstreamRows.find(row => row.id === draft.profileId)?.label}</h4>
      <fieldset disabled={c.draftDisabled} className="proxy-editor-grid"><ProxySelectionField label="线路出口"
        legacyLabel="沿用线路设置（不使用代理池）" selection={draft.selection} pool={c.pool} onChange={c.changeUpstream} /></fieldset>
      {draft.selection.kind === "legacy" && draft.original.kind !== "legacy" && <p className="proxy-help" role="note">解除代理池选择后，将恢复原有手动上游或网络环境；未配置手动上游时可能直连。</p>}
      {c.upstreamDraftError && <p className="proxy-help" role="alert">{c.upstreamDraftError}</p>}
      <div className="proxy-actions"><Button size="xs" type="submit" disabled={c.disabled || Boolean(c.upstreamDraftError)} loading={c.busy === "save-upstream"}>保存出口选择</Button>
        <Button size="xs" variant="light" disabled={c.busy !== null} onClick={c.cancelUpstream}>取消出口编辑</Button></div>
    </form>}
    <ul className="proxy-node-list" aria-label="线路出口列表">{c.upstreamRows.map(row => <li key={row.id} className="proxy-node">
      <div className="proxy-node-details"><div className="proxy-actions"><strong>{row.label}</strong><Badge variant="secondary">{row.selection.kind === "legacy" ? "原有设置" : row.selection.kind === "policy" ? "按规则选择" : "固定选择"}</Badge></div>
        <p className="proxy-chain-path">{row.selectedLabel}</p>
        {!row.profile && <p className="proxy-help">线路当前不可用，出口选择仍保留，恢复该线路后继续生效。</p>}
        {row.problem && <p className="text-danger text-xs">{row.problem}</p>}
        {row.probe && <div className="proxy-probe" role="status">
          <span>{row.probe.stale ? "出口配置已变化，请重新测试" : row.probe.success ? "出口检测成功" : "出口检测未成功"} · {row.probe.elapsedMs} ms</span>
          {row.probe.exitIp && <span>观测出口：{row.probe.exitIp}</span>}
          <span>{row.probe.message}</span><time dateTime={row.probe.testedAt}>{new Date(row.probe.testedAt).toLocaleString()}</time>
        </div>}
        {row.selection.kind === "legacy" && row.profile?.upstreamProxy?.trim() && <p className="proxy-help">已配置手动上游；可在线路设置中编辑。</p>}
      </div>
      <div className="proxy-actions"><Button size="xs" variant="light" disabled={c.disabled || c.editing} onClick={() => c.openUpstream(row.id)}>选择出口 {row.label}</Button>
        {(row.selection.kind === "node" || row.selection.kind === "chain") && <Button size="xs" variant="light" disabled={c.disabled}
          loading={c.busy === `${row.selection.kind === "node" ? "test" : "test-chain"}:${row.selection.id}`} onClick={() => {
          if (row.selection.kind === "node") void c.testNode(row.selection.id);
          else if (row.selection.kind === "chain") void c.testChain(row.selection.id);
        }}>测试所选出口</Button>}</div>
    </li>)}</ul>
    {!c.upstreamRows.length && <p className="proxy-empty">添加线路后，可在这里指定它的上游出口。</p>}
  </section>;
}
