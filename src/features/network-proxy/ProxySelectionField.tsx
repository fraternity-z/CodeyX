import { selectionKey } from "./upstream";
import type { NetworkProxyConfig, ProxySelection } from "./types";

export function ProxySelectionField({ label, legacyLabel, selection, pool, onChange }: {
  label: string; legacyLabel: string; selection: ProxySelection; pool: NetworkProxyConfig; onChange: (value: string) => void;
}) {
  return <label className="proxy-editor-wide">出口方式
    <select aria-label={label} value={selectionKey(selection)} onChange={event => onChange(event.target.value)}>
      <option value="legacy">{legacyLabel}</option>
      <optgroup label="代理池节点">{pool.nodes.map(node => <option value={`node:${node.id}`} key={node.id} disabled={!node.enabled}>{node.name}{node.enabled ? "" : " · 已禁用"}</option>)}</optgroup>
      <optgroup label="代理链路">{pool.chains.map(chain => <option value={`chain:${chain.id}`} key={chain.id} disabled={!chain.enabled}>{chain.name}{chain.enabled ? "" : " · 已禁用"}</option>)}</optgroup>
      <optgroup label="按规则选择">{(pool.policies ?? []).map(policy => <option value={`policy:${policy.id}`} key={policy.id} disabled={!policy.enabled}>{policy.name}{policy.allowDirect ? " · 允许直连" : ""}{policy.enabled ? "" : " · 已禁用"}</option>)}</optgroup>
    </select>
  </label>;
}
