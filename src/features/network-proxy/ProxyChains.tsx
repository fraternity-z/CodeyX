import { IconArrowDown, IconArrowUp, IconPlus } from "@tabler/icons-react";
import { Badge, Button, Input } from "../../components/ui";
import type { useNetworkProxyController } from "./useNetworkProxyController";

type Controller = ReturnType<typeof useNetworkProxyController>;

function ChainEditor({ controller: c }: { controller: Controller }) {
  const draft = c.chainDraft;
  if (!draft) return null;
  return <form className="proxy-editor" aria-label="代理链路编辑" onSubmit={event => { event.preventDefault(); void c.saveChainDraft(); }}>
    <h4>{draft.original ? "编辑代理链路" : "新增代理链路"}</h4>
    <fieldset disabled={c.draftDisabled} className="proxy-editor-grid">
      <label className="proxy-editor-wide">链路名称<Input aria-label="链路名称" value={draft.name} maxLength={80} autoFocus
        onChange={event => c.changeChainDraft("name", event.target.value)} /></label>
      <ol className="proxy-chain-hops proxy-editor-wide" aria-label="有序代理节点">
        {draft.nodeIds.map((id, index) => <li key={index}>
          <label>第 {index + 1} 跳<select aria-label={`第 ${index + 1} 跳节点`} value={id}
            onChange={event => c.changeChainDraft("nodeIds", draft.nodeIds.map((old, position) => position === index ? event.target.value : old))}>
            <option value="">选择代理池节点</option>
            {c.pool.nodes.map(node => <option key={node.id} value={node.id}>{node.name} · {node.endpoint.protocol.toUpperCase()}{node.enabled ? "" : " · 已禁用"}</option>)}
          </select></label>
          <div className="proxy-actions">
            <Button size="xs" variant="light" disabled={index === 0} aria-label={`上移第 ${index + 1} 跳`} onClick={() => c.moveHop(index, -1)}><IconArrowUp size={13} aria-hidden="true" /></Button>
            <Button size="xs" variant="light" disabled={index === draft.nodeIds.length - 1} aria-label={`下移第 ${index + 1} 跳`} onClick={() => c.moveHop(index, 1)}><IconArrowDown size={13} aria-hidden="true" /></Button>
            <Button size="xs" variant="destructive-light" aria-label={`移除第 ${index + 1} 跳`} onClick={() => c.changeChainDraft("nodeIds", draft.nodeIds.filter((_, position) => position !== index))}>移除</Button>
          </div>
        </li>)}
      </ol>
      <div className="proxy-editor-wide"><Button size="xs" variant="light" disabled={draft.nodeIds.length >= 3 || !c.pool.nodes.length}
        onClick={() => c.changeChainDraft("nodeIds", [...draft.nodeIds, ""])}>添加一跳</Button></div>
      <label className="proxy-check proxy-editor-wide"><input type="checkbox" checked={draft.enabled}
        onChange={event => c.changeChainDraft("enabled", event.target.checked)} />允许选择此链路</label>
    </fieldset>
    <p className="proxy-help">第一跳由本机连接，后续节点通过上一跳连接。目标域名按每一跳的 DNS 设置解析；禁用节点可手动测试，但不能用于正式转发。</p>
    {c.chainDraftError && <p className="proxy-help" id="proxy-chain-draft-error">{c.chainDraftError}</p>}
    <div className="proxy-actions">
      <Button size="xs" type="submit" disabled={c.disabled || Boolean(c.chainDraftError)} loading={c.busy === "save-chain"}
        aria-describedby={c.chainDraftError ? "proxy-chain-draft-error" : undefined}>保存链路</Button>
      <Button size="xs" variant="light" disabled={c.busy !== null} onClick={c.cancelChainDraft}>取消链路编辑</Button>
    </div>
  </form>;
}

export function ProxyChains({ controller: c }: { controller: Controller }) {
  if (c.remote) return null;
  return <section className="proxy-pool" aria-labelledby="proxy-chains-title">
    <div className="proxy-pool-heading">
      <div><h3 id="proxy-chains-title" className="settings-section-heading">代理链路</h3>
        <p className="proxy-help">{c.pool.chains.length} 条链路 · 按顺序通过最多 3 个节点。</p></div>
      <Button size="xs" disabled={c.disabled || c.editing || !c.pool.nodes.length} onClick={() => c.openChain()}><IconPlus size={14} aria-hidden="true" />新增链路</Button>
    </div>
    <p className="proxy-help">保存后可在下方设为线路出口。测试只通过指定链路访问上述出口检测服务，任一节点失败即停止，不会切换节点或回退直连。</p>
    <ChainEditor controller={c} />
    {c.deleteChainId && <div role="alert" className="proxy-confirm">
      <p>确认删除链路“{c.pool.chains.find(chain => chain.id === c.deleteChainId)?.name}”？代理池节点会保留。</p>
      <div className="proxy-actions"><Button size="xs" variant="destructive" disabled={c.disabled} loading={c.busy === "delete-chain"}
        onClick={() => void c.confirmDeleteChain()}>确认删除链路</Button>
        <Button size="xs" variant="light" disabled={c.busy !== null} onClick={c.cancelDeleteChain}>取消删除链路</Button></div>
    </div>}
    <ul className="proxy-node-list" aria-label="代理链路列表">
      {c.chainRows.map(({ chain, probe }) => <li className="proxy-node" key={chain.id}>
        <div className="proxy-node-details">
          <div className="proxy-actions"><strong>{chain.name}</strong><Badge variant={chain.enabled ? "success" : "secondary"}>{chain.enabled ? "已启用" : "已禁用"}</Badge></div>
          <p className="proxy-chain-path">CodeyX → {chain.nodeIds.map(id => c.pool.nodes.find(node => node.id === id)?.name ?? "节点缺失").join(" → ")} → 目标服务</p>
          {probe ? <div className="proxy-probe" role="status">
            <span>{probe.stale ? "链路或节点已变化，请重新测试" : probe.errorCode === "resultUnavailable" ? "未取得链路测试结果" : probe.success ? "链路检测成功" : "链路检测失败"} · {probe.elapsedMs} ms</span>
            {probe.failedHop != null && <span>失败位置：第 {probe.failedHop} 跳</span>}
            {probe.exitIp && <span>链路出口：{probe.exitIp}</span>}<span>{probe.message}</span>
            {probe.errorCode && <code>{probe.errorCode}</code>}<time dateTime={probe.testedAt}>{new Date(probe.testedAt).toLocaleString()}</time>
          </div> : <p className="proxy-help">尚未测试</p>}
        </div>
        <div className="proxy-actions">
          <Button size="xs" variant="light" disabled={c.disabled} loading={c.busy === `test-chain:${chain.id}`} onClick={() => void c.testChain(chain.id)}>测试链路 {chain.name}</Button>
          <Button size="xs" variant="light" disabled={c.disabled || c.editing} onClick={() => c.openChain(chain.id)}>编辑链路 {chain.name}</Button>
          <Button size="xs" variant="light" disabled={c.disabled || c.editing} onClick={() => void c.setChainEnabled(chain.id, !chain.enabled)}>{chain.enabled ? "禁用链路" : "启用链路"}</Button>
          <Button size="xs" variant="destructive-light" disabled={c.disabled || c.editing} onClick={() => c.requestDeleteChain(chain.id)}>删除链路</Button>
        </div>
      </li>)}
    </ul>
    {!c.pool.chains.length && <p className="proxy-empty">先添加代理池节点，再按所需顺序组成链路。</p>}
  </section>;
}
