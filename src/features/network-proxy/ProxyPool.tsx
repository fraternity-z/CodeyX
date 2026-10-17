import { IconPlus, IconRefresh } from "@tabler/icons-react";
import { Badge, Button, Input, PasswordInput, TextArea } from "../../components/ui";
import type { useNetworkProxyController } from "./useNetworkProxyController";
import type { PoolFilter, ProxyDraft } from "./types";

type Controller = ReturnType<typeof useNetworkProxyController>;

function NodeEditor({ controller: c }: { controller: Controller }) {
  const draft = c.draft;
  if (!draft) return null;
  const busy = c.busy !== null;
  return <form className="proxy-editor" aria-label="代理节点编辑" autoComplete="off"
    onSubmit={event => { event.preventDefault(); void c.saveDraft(); }}>
    <div className="proxy-pool-heading">
      <h4>{draft.original ? "编辑代理" : "新增代理"}</h4>
      <span className="text-xs text-muted">保存不会改变现有出口</span>
    </div>
    <fieldset disabled={c.draftDisabled} className="proxy-editor-grid">
      <label>代理名称<Input aria-label="代理名称" value={draft.name} maxLength={80} autoFocus
        onChange={event => c.changeDraft("name", event.target.value)} /></label>
      <label>协议<select aria-label="代理协议" value={draft.protocol}
        onChange={event => c.changeDraft("protocol", event.target.value as ProxyDraft["protocol"])}>
        <option value="socks5">SOCKS5</option><option value="http">HTTP</option><option value="https">HTTPS</option>
      </select></label>
      <label>主机地址<Input aria-label="代理主机" value={draft.host} placeholder="域名或 IPv4 / IPv6 地址" spellCheck={false}
        onChange={event => c.changeDraft("host", event.target.value)} /></label>
      <label>端口<Input aria-label="代理端口" inputMode="numeric" value={draft.port}
        onChange={event => c.changeDraft("port", event.target.value)} /></label>
      <label>目标域名解析<select aria-label="目标域名解析" value={draft.dns} disabled={draft.protocol !== "socks5"}
        onChange={event => c.changeDraft("dns", event.target.value as ProxyDraft["dns"])}>
        <option value="remote">代理端解析</option><option value="local">本机解析（会使用本机 DNS）</option>
      </select></label>
      <label>认证<select aria-label="代理认证" value={draft.authentication}
        onChange={event => c.changeDraft("authentication", event.target.value as ProxyDraft["authentication"])}>
        {draft.original?.credentialRef && <option value="keep">保留已保存凭据 · ••••••••</option>}
        <option value="clear">不使用认证</option><option value="replace">填写新的用户名和密码</option>
      </select></label>
      {draft.authentication === "replace" && <>
        <label>用户名<Input aria-label="代理用户名" autoComplete="off" spellCheck={false} value={draft.username}
          onChange={event => c.changeDraft("username", event.target.value)} /></label>
        <label>密码<PasswordInput aria-label="代理密码" autoComplete="new-password" value={draft.password}
          onChange={event => c.changeDraft("password", event.target.value)} /></label>
      </>}
      <label>分组<Input aria-label="代理分组" maxLength={80} value={draft.group}
        onChange={event => c.changeDraft("group", event.target.value)} /></label>
      <label>标签<Input aria-label="代理标签" value={draft.tags} placeholder="用逗号分隔"
        onChange={event => c.changeDraft("tags", event.target.value)} /></label>
      <label className="proxy-editor-wide">备注<TextArea aria-label="代理备注" rows={2} maxLength={2000} value={draft.notes}
        onChange={event => c.changeDraft("notes", event.target.value)} /></label>
      <label className="proxy-check proxy-editor-wide"><input type="checkbox" checked={draft.enabled}
        onChange={event => c.changeDraft("enabled", event.target.checked)} />允许选择此节点（不会自动切换出口）</label>
    </fieldset>
    <p className="proxy-help">用户名和密码保存在本机系统密钥库中，编辑时不回显。凭据不可用时连接会停止。</p>
    <p className="proxy-help">首个代理的域名由本机解析；目标域名按所选方式解析。
      {draft.protocol !== "https" && draft.authentication !== "clear" && " HTTP 与 SOCKS5 不加密代理认证，远程节点应使用可信网络。"}</p>
    {c.draftError && <p className="proxy-help" id="proxy-draft-error">{c.draftError}</p>}
    <div className="proxy-actions">
      <Button size="xs" type="submit" disabled={c.disabled || Boolean(c.draftError)} loading={c.busy === "save"}
        aria-describedby={c.draftError ? "proxy-draft-error" : undefined}>保存到代理池</Button>
      <Button size="xs" variant="light" disabled={busy} onClick={c.cancelDraft}>取消编辑</Button>
    </div>
  </form>;
}

export function ProxyPool({ controller: c }: { controller: Controller }) {
  const editing = c.editing;
  return <section className="proxy-pool" aria-labelledby="proxy-pool-title">
    <div className="proxy-pool-heading">
      <div><h3 id="proxy-pool-title" className="settings-section-heading">代理池</h3>
        <p className="proxy-help">{c.pool.nodes.length} 个节点 · 保存常用代理，支持 SOCKS5、HTTP 和 HTTPS。</p></div>
      {!c.remote && <div className="proxy-actions">
        <Button size="xs" variant="light" disabled={c.busy !== null || c.loading} loading={c.loading} onClick={c.refresh}>
          <IconRefresh size={14} aria-hidden="true" />刷新代理池</Button>
        <Button size="xs" disabled={c.disabled || editing} onClick={() => c.openNode()}><IconPlus size={14} aria-hidden="true" />新增代理</Button>
      </div>}
    </div>
    {c.remote ? <p role="note">请在电脑端管理代理池和本机凭据。</p> : <>
      <p className="proxy-help">仅点击“测试”时，才通过该节点访问 {c.probeUrl || "出口检测服务"}。
        检测会向服务提供方暴露代理出口 IP；耗时包含连接与检测请求，结果不保证出口长期固定。添加或测试节点不会改变线路的上游代理。</p>
      {c.error && <div role="alert" className="text-danger">{c.error}{!c.ready && " 请刷新代理池确认保存结果后继续；草稿会保留。"}</div>}
      {c.notice && <div role="status" className="text-xs">{c.notice}</div>}
      <NodeEditor controller={c} />
      <div className="proxy-filters">
        <Input aria-label="搜索代理" placeholder="搜索名称、主机、分组或标签" value={c.filter.query}
          onChange={event => c.changeFilter("query", event.target.value)} />
        <select aria-label="代理状态筛选" value={c.filter.enabled}
          onChange={event => c.changeFilter("enabled", event.target.value as PoolFilter["enabled"])}>
          <option value="all">全部状态</option><option value="enabled">已启用</option><option value="disabled">已禁用</option>
        </select>
        <select aria-label="代理排序" value={c.filter.sort}
          onChange={event => c.changeFilter("sort", event.target.value as PoolFilter["sort"])}>
          <option value="saved">添加顺序</option><option value="name">名称排序</option><option value="latency">测试耗时</option>
        </select>
      </div>
      {c.selectedIds.length > 0 && <div className="proxy-actions" aria-label="代理批量操作">
        <span>已选 {c.selectedIds.length} 个</span>
        <Button size="xs" variant="light" disabled={c.disabled || editing} onClick={() => void c.setEnabled(c.selectedIds, true)}>批量启用</Button>
        <Button size="xs" variant="light" disabled={c.disabled || editing} onClick={() => void c.setEnabled(c.selectedIds, false)}>批量禁用</Button>
        <Button size="xs" variant="destructive-light" disabled={c.disabled || editing} onClick={() => c.requestDelete(c.selectedIds)}>批量删除</Button>
      </div>}
      {c.deleteIds.length > 0 && <div className="proxy-confirm" role="alert">
        <p>确认从代理池删除 {c.deleteIds.length} 个节点？已有备份引用的凭据会保留，以便恢复配置。</p>
        <div className="proxy-actions">
          <Button size="xs" variant="destructive" disabled={c.disabled} loading={c.busy === "delete"} onClick={() => void c.confirmDelete()}>确认删除代理</Button>
          <Button size="xs" variant="light" disabled={c.busy !== null} onClick={c.cancelDelete}>取消删除</Button>
        </div>
      </div>}
      <ul className="proxy-node-list" aria-label="代理节点列表">
        {c.rows.map(({ node, probe }) => <li className="proxy-node" key={node.id}>
          <div className="proxy-node-main">
            <input type="checkbox" aria-label={`选择代理 ${node.name}`} checked={c.selectedIds.includes(node.id)}
              disabled={c.disabled || editing} onChange={() => c.toggleSelected(node.id)} />
            <div className="proxy-node-details">
              <div className="proxy-actions"><strong>{node.name}</strong><Badge variant={node.enabled ? "success" : "secondary"}>{node.enabled ? "已启用" : "已禁用"}</Badge></div>
              <code>{node.endpoint.protocol.toUpperCase()} · {node.endpoint.host} · {node.endpoint.port}</code>
              <p className="proxy-help">{node.endpoint.dns === "remote" ? "代理端 DNS" : "本机 DNS"} · {node.credentialRef ? "已保存认证凭据" : "无需认证"}
                {node.group && ` · ${node.group}`}{node.tags.length > 0 && ` · ${node.tags.join(" / ")}`}</p>
              {node.notes && <p className="proxy-help">{node.notes}</p>}
              {probe ? <div className="proxy-probe" role="status">
                <span>{probe.stale ? "配置已变化，请重新测试" : probe.errorCode === "resultUnavailable" ? "未取得测试结果" : probe.success ? "检测成功" : "检测失败"} · {probe.elapsedMs} ms</span>
                {probe.exitIp && <span>观测出口：{probe.exitIp}</span>}
                <span>{probe.message}</span>
                {probe.errorCode && <code>{probe.errorCode}</code>}
                <time dateTime={probe.testedAt}>{new Date(probe.testedAt).toLocaleString()}</time>
              </div> : <p className="proxy-help">尚未测试</p>}
            </div>
          </div>
          <div className="proxy-actions">
            <Button size="xs" variant="light" disabled={c.disabled} loading={c.busy === `test:${node.id}`} onClick={() => void c.testNode(node.id)}>测试 {node.name}</Button>
            <Button size="xs" variant="light" disabled={c.disabled || editing} onClick={() => c.openNode(node.id)}>编辑 {node.name}</Button>
            <Button size="xs" variant="light" disabled={c.disabled || editing} onClick={() => void c.setEnabled([node.id], !node.enabled)}>{node.enabled ? "禁用" : "启用"}</Button>
            <Button size="xs" variant="destructive-light" disabled={c.disabled || editing} onClick={() => c.requestDelete([node.id])}>删除</Button>
          </div>
        </li>)}
      </ul>
      {!c.rows.length && <p className="proxy-empty">{c.pool.nodes.length ? "没有匹配的代理" : c.loading ? "正在读取代理池…" : "尚未添加代理。新增节点后可测试连通性与出口 IP。"}</p>}
    </>}
  </section>;
}
