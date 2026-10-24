import { selectionKey } from "./upstream";
import type { NetworkProxyConfig, ProxySelection } from "./types";

export function ProxySelectionField({ label, legacyLabel, selection, pool, onChange }: {
  label: string; legacyLabel?: string; selection: ProxySelection; pool: NetworkProxyConfig; onChange: (value: string) => void;
}) {
  return <label className="proxy-editor-wide">{label}
    <select aria-label={label} value={selectionKey(selection)} onChange={event => onChange(event.target.value)}>
      <option value="legacy" disabled={!legacyLabel}>{legacyLabel ?? "请选择节点"}</option>
      {selection.kind !== "legacy" && (selection.kind !== "node" || !pool.nodes.some(node => node.id === selection.id)) && <option value={selectionKey(selection)} disabled>原选择已移除，请重新选择</option>}
      <optgroup label="代理池节点">{pool.nodes.map(node => <option value={`node:${node.id}`} key={node.id} disabled={!node.enabled}>{node.name}{node.enabled ? "" : " · 已禁用"}</option>)}</optgroup>
    </select>
  </label>;
}
