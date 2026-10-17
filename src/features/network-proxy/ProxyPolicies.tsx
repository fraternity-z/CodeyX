import { Badge, Button, Input } from "../../components/ui";
import type { HostMatch, NetworkProxyConfig, ProxyAction, ProxyTarget, RuleDraft } from "./types";
import type { useNetworkProxyController } from "./useNetworkProxyController";

type Controller = ReturnType<typeof useNetworkProxyController>;

function ActionEditor({ label, action, pool, onChange }: { label: string; action: ProxyAction; pool: NetworkProxyConfig; onChange: (action: ProxyAction) => void }) {
  return <div className="proxy-action-editor proxy-editor-wide">
    <label>{label}<select aria-label={label} value={action.kind} onChange={event => onChange(event.target.value === "proxy"
      ? { kind: "proxy", targets: [{ kind: "node", id: "" }], onFailure: "stop" } : { kind: event.target.value as "block" | "direct" })}>
      <option value="block">阻断连接</option><option value="proxy">通过代理</option><option value="direct">直连目标</option>
    </select></label>
    {action.kind === "proxy" && <>
      <label>故障处理<select aria-label={`${label}故障处理`} value={action.onFailure} onChange={event => {
        const onFailure = event.target.value as "stop" | "next" | "direct";
        onChange({ ...action, onFailure, targets: onFailure === "stop" ? action.targets.slice(0, 1) : action.targets });
      }}><option value="stop">停止连接，保持固定出口</option><option value="next">按候选顺序切换，全部失败则停止</option><option value="direct">按候选顺序尝试，全部失败后直连</option></select></label>
      <ol className="proxy-chain-hops" aria-label={`${label}候选出口`}>{action.targets.map((target, index) => <li key={index}>
        <label>候选 {index + 1}<select aria-label={`${label}候选 ${index + 1}`} value={`${target.kind}:${target.id}`} onChange={event => {
          const [kind, id] = event.target.value.split(":") as [ProxyTarget["kind"], string];
          onChange({ ...action, targets: action.targets.map((old, at) => at === index ? { kind, id } : old) });
        }}><option value="node:">选择节点或链路</option>
          <optgroup label="代理节点">{pool.nodes.map(node => <option key={node.id} value={`node:${node.id}`}>{node.name}{node.enabled ? "" : " · 已禁用"}</option>)}</optgroup>
          <optgroup label="代理链路">{pool.chains.map(chain => <option key={chain.id} value={`chain:${chain.id}`}>{chain.name}{chain.enabled ? "" : " · 已禁用"}</option>)}</optgroup>
        </select></label>
        <div className="proxy-actions">
          <Button size="xs" variant="light" disabled={index === 0} aria-label={`${label}上移候选 ${index + 1}`} onClick={() => {
            const targets = [...action.targets]; [targets[index - 1], targets[index]] = [targets[index], targets[index - 1]]; onChange({ ...action, targets });
          }}>上移</Button>
          <Button size="xs" variant="light" disabled={action.targets.length === 1} aria-label={`${label}移除候选 ${index + 1}`} onClick={() => onChange({ ...action, targets: action.targets.filter((_, at) => at !== index) })}>移除</Button>
        </div>
      </li>)}</ol>
      <div><Button size="xs" variant="light" disabled={action.onFailure === "stop" || action.targets.length >= 4} onClick={() => onChange({ ...action, targets: [...action.targets, { kind: "node", id: "" }] })}>添加{label}候选</Button></div>
    </>}
  </div>;
}

function PolicyEditor({ controller: c }: { controller: Controller }) {
  const draft = c.policyDraft;
  if (!draft) return null;
  const changeRule = (id: string, update: Partial<RuleDraft>) => c.changePolicy("rules", draft.rules.map(rule => rule.id === id ? { ...rule, ...update } : rule));
  return <form className="proxy-editor" aria-label="出口策略编辑" onSubmit={event => { event.preventDefault(); void c.savePolicy(); }}>
    <h4>{draft.original ? "编辑出口策略" : "新增出口策略"}</h4>
    <fieldset disabled={c.draftDisabled} className="proxy-editor-grid">
      <label className="proxy-editor-wide">策略名称<Input autoFocus aria-label="策略名称" maxLength={80} value={draft.name} onChange={event => c.changePolicy("name", event.target.value)} /></label>
      <label className="proxy-check proxy-editor-wide"><input type="checkbox" checked={draft.enabled} onChange={event => c.changePolicy("enabled", event.target.checked)} />允许选择此策略</label>
      <label className="proxy-check proxy-editor-wide"><input type="checkbox" checked={draft.allowDirect} onChange={event => c.changePolicy("allowDirect", event.target.checked)} />允许此策略直连并暴露本机出口及本地 DNS 查询</label>
      <ol className="proxy-policy-rules proxy-editor-wide" aria-label="有序出口规则">{draft.rules.map((rule, index) => <li key={rule.id}>
        <div className="proxy-actions"><strong>规则 {index + 1}</strong>
          <Button size="xs" variant="light" disabled={index === 0} onClick={() => c.moveRule(index, -1)} aria-label={`上移规则 ${index + 1}`}>上移</Button>
          <Button size="xs" variant="light" disabled={index === draft.rules.length - 1} onClick={() => c.moveRule(index, 1)} aria-label={`下移规则 ${index + 1}`}>下移</Button>
          <Button size="xs" variant="destructive-light" onClick={() => c.changePolicy("rules", draft.rules.filter(value => value.id !== rule.id))} aria-label={`删除规则 ${index + 1}`}>移除</Button>
        </div>
        <div className="proxy-editor-grid">
          <label>目标匹配<select aria-label={`规则 ${index + 1}匹配方式`} value={rule.host.kind} onChange={event => {
            const kind = event.target.value as HostMatch["kind"];
            changeRule(rule.id, { host: kind === "any" ? { kind } : { kind, value: "" } });
          }}><option value="exact">完整域名或 IP</option><option value="suffix">域名及其子域名</option><option value="cidr">IP 网段（CIDR）</option><option value="any">所有目标</option></select></label>
          {rule.host.kind !== "any" && <label>匹配值<Input aria-label={`规则 ${index + 1}匹配值`} value={rule.host.value} onChange={event => changeRule(rule.id, { host: { ...rule.host, value: event.target.value } as HostMatch })} /></label>}
          <label>目标端口<Input aria-label={`规则 ${index + 1}端口`} placeholder="留空为全部，例如 80, 443" value={rule.ports} onChange={event => changeRule(rule.id, { ports: event.target.value })} /></label>
          <label className="proxy-check"><input type="checkbox" aria-label={`启用规则 ${index + 1}`} checked={rule.enabled} onChange={event => changeRule(rule.id, { enabled: event.target.checked })} />启用规则</label>
          <ActionEditor label={`规则 ${index + 1}动作`} action={rule.action} pool={c.pool} onChange={action => changeRule(rule.id, { action })} />
        </div>
      </li>)}</ol>
      <div className="proxy-editor-wide"><Button size="xs" variant="light" disabled={draft.rules.length >= 64} onClick={c.addRule}>添加规则</Button></div>
      <ActionEditor label="未命中规则时" action={draft.defaultAction} pool={c.pool} onChange={action => c.changePolicy("defaultAction", action)} />
    </fieldset>
    <p className="proxy-help">从上到下采用首条匹配规则；域名匹配不区分大小写，网段只匹配请求中的 IP，不额外查询 DNS。规则只影响已接入的流量。</p>
    <p className="proxy-help">只在隧道建立期间切换，最多 4 个候选、总计 30 秒；超时即停止，不重放已发送的请求。认证、证书和配置错误始终停止。切换出口可能改变 IP，固定 IP 场景请选择停止连接。</p>
    {c.policyDraftError && <p className="proxy-help" role="alert">{c.policyDraftError}</p>}
    <div className="proxy-actions"><Button size="xs" type="submit" disabled={c.disabled || Boolean(c.policyDraftError)} loading={c.busy === "save-policy"}>保存策略</Button>
      <Button size="xs" variant="light" disabled={c.busy !== null} onClick={c.cancelPolicy}>取消策略编辑</Button></div>
  </form>;
}

export function ProxyPolicies({ controller: c }: { controller: Controller }) {
  if (c.remote) return null;
  return <section className="proxy-pool" aria-labelledby="proxy-policies-title">
    <div className="proxy-pool-heading"><div><h3 id="proxy-policies-title" className="settings-section-heading">规则与故障策略</h3>
      <p className="proxy-help">按目标选择出口、阻断或显式直连；保存后还需在启动出口或线路出口中选择此策略。</p></div>
      <Button size="xs" disabled={c.disabled || c.editing} onClick={() => c.openPolicy()}>新增策略</Button></div>
    <PolicyEditor controller={c} />
    {c.deletePolicyId && <div role="alert" className="proxy-confirm"><p>确认删除策略“{c.pool.policies?.find(policy => policy.id === c.deletePolicyId)?.name}”？节点和链路会保留。</p>
      <div className="proxy-actions"><Button size="xs" variant="destructive" disabled={c.disabled} onClick={() => void c.confirmDeletePolicy()}>确认删除策略</Button>
        <Button size="xs" variant="light" disabled={c.busy !== null} onClick={c.cancelDeletePolicy}>取消删除策略</Button></div></div>}
    <ul className="proxy-node-list" aria-label="出口策略列表">{(c.pool.policies ?? []).map(policy => <li key={policy.id} className="proxy-node">
      <div className="proxy-node-details"><div className="proxy-actions"><strong>{policy.name}</strong><Badge variant={policy.enabled ? "success" : "secondary"}>{policy.enabled ? "已启用" : "已禁用"}</Badge>
        <Badge variant="secondary">{policy.allowDirect ? "允许直连" : "禁止直连"}</Badge></div>
        <p className="proxy-help">{policy.rules.filter(rule => rule.enabled).length} 条启用规则 · 未命中时{policy.defaultAction.kind === "block" ? "阻断" : policy.defaultAction.kind === "direct" ? "直连" : "通过代理"}</p></div>
      <div className="proxy-actions"><Button size="xs" variant="light" disabled={c.disabled || c.editing} onClick={() => c.openPolicy(policy.id)}>编辑策略 {policy.name}</Button>
        <Button size="xs" variant="light" disabled={c.disabled || c.editing} onClick={() => void c.setPolicyEnabled(policy.id, !policy.enabled)}>{policy.enabled ? "禁用策略" : "启用策略"}</Button>
        <Button size="xs" variant="destructive-light" disabled={c.disabled || c.editing} onClick={() => c.requestDeletePolicy(policy.id)}>删除策略</Button></div>
    </li>)}</ul>
    {!c.pool.policies?.length && <p className="proxy-empty">尚未配置出口策略。现有固定节点与链路选择保持原有行为。</p>}
  </section>;
}
