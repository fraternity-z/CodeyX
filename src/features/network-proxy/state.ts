import type { CredentialUpdate, NetworkProxyConfig, PoolFilter, ProbeSnapshot, ProxyDraft, ProxyNode } from "./types";
import { policyReferences } from "./policies";

export const EMPTY_POOL: NetworkProxyConfig = { schemaVersion: 1, nodes: [], chains: [] };
export const INITIAL_FILTER: PoolFilter = { query: "", enabled: "all", sort: "saved" };

export function proxyDraft(id: string, node?: ProxyNode): ProxyDraft {
  return { original: node ?? null, id, name: node?.name ?? "", protocol: node?.endpoint.protocol ?? "socks5",
    host: node?.endpoint.host ?? "", port: node ? String(node.endpoint.port) : "1080", dns: node?.endpoint.dns ?? "remote",
    authentication: node?.credentialRef ? "keep" : "clear", username: "", password: "",
    notes: node?.notes ?? "", enabled: node?.enabled ?? false, tags: node?.tags.join(", ") ?? "", group: node?.group ?? "" };
}

export function nodeIdentity(node: ProxyNode): string {
  return JSON.stringify([node.id, node.name, node.endpoint.protocol, node.endpoint.host, node.endpoint.port,
    node.endpoint.dns, node.credentialRef ?? null, node.notes, node.enabled, node.tags, node.group]);
}

export function validateDraft(draft: ProxyDraft): string {
  if (!draft.name.trim() || [...draft.name.trim()].length > 80) return "代理名称必须为 1 到 80 个字符";
  if (!/^\d+$/.test(draft.port) || Number(draft.port) < 1 || Number(draft.port) > 65535) return "端口必须为 1 到 65535 的整数";
  const host = draft.host.trim();
  if (!host || host.length > 253 || /[\s\x00-\x1f\x7f/?#@*%\\]/u.test(host)) return "主机只能填写域名或 IP 地址，不要包含协议、端口、路径或凭据";
  try {
    const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    const url = new URL(`http://${authority}:${draft.port}`);
    if (!url.hostname || url.pathname !== "/" || url.username || url.password) return "主机地址格式无效";
  } catch { return "主机地址格式无效"; }
  if ([...draft.notes].length > 2000 || [...draft.group.trim()].length > 80) return "备注最多 2000 个字符，分组最多 80 个字符";
  const tags = draft.tags.split(/[,，]/u).map(tag => tag.trim()).filter(Boolean);
  if (tags.length > 20 || tags.some(tag => [...tag].length > 32) || new Set(tags).size !== tags.length) return "标签不能重复，最多 20 个，每个最多 32 个字符";
  if (draft.authentication === "replace") {
    const bytes = new TextEncoder();
    if ([draft.username, draft.password].some(value => !value || bytes.encode(value).length > 255)) return "用户名和密码各需 1 到 255 字节，空格会原样保存";
    if (draft.protocol !== "socks5" && draft.username.includes(":")) return "HTTP 和 HTTPS 代理用户名不能包含冒号";
  }
  return "";
}

export function prepareNodeSave(pool: NetworkProxyConfig, draft: ProxyDraft): { config: NetworkProxyConfig; credentials: CredentialUpdate[] } {
  const error = validateDraft(draft);
  if (error) throw new Error(error);
  const existing = pool.nodes.find(node => node.id === draft.id);
  if (draft.original ? !existing || nodeIdentity(existing) !== nodeIdentity(draft.original) : existing) {
    throw new Error("此节点已被其他操作修改或删除，请保留草稿内容并重新打开节点后保存");
  }
  if (!existing && pool.nodes.length >= 256) throw new Error("代理池最多支持 256 个节点");
  const node: ProxyNode = { id: draft.id, name: draft.name.trim(), endpoint: {
    protocol: draft.protocol, host: draft.host.trim(), port: Number(draft.port), dns: draft.protocol === "socks5" ? draft.dns : "remote",
  }, credentialRef: existing?.credentialRef ?? null, notes: draft.notes, enabled: draft.enabled,
  tags: draft.tags.split(/[,，]/u).map(tag => tag.trim()).filter(Boolean), group: draft.group.trim() };
  const credentials: CredentialUpdate[] = draft.authentication === "keep" ? [] : [{ nodeId: node.id,
    change: draft.authentication === "clear" ? { kind: "clear" } : { kind: "replace", username: draft.username, password: draft.password } }];
  return { config: { ...pool, nodes: existing ? pool.nodes.map(value => value.id === node.id ? node : value) : [...pool.nodes, node] }, credentials };
}

export function removeNodes(pool: NetworkProxyConfig, ids: string[]): NetworkProxyConfig {
  if (policyReferences(pool, "node", ids)) throw new Error("所选节点仍被出口策略引用，请先调整规则");
  if (pool.processProxy?.kind === "node" && ids.includes(pool.processProxy.id)) throw new Error("所选节点仍被 Codex 启动出口引用，请先调整启动选择");
  if (pool.chains.some(chain => chain.nodeIds.some(id => ids.includes(id)))) throw new Error("所选节点仍被代理链路引用，请先调整链路");
  if (Object.values(pool.upstreamByProfile ?? {}).some(selection => selection.kind === "node" && ids.includes(selection.id))) throw new Error("所选节点仍被线路出口引用，请先调整上游选择");
  return { ...pool, nodes: pool.nodes.filter(node => !ids.includes(node.id)) };
}

export function currentProbe(node: ProxyNode, probes: Record<string, ProbeSnapshot>): ProxyProbeView {
  const snapshot = Object.prototype.hasOwnProperty.call(probes, node.id) ? probes[node.id] : undefined;
  return snapshot ? { ...snapshot.result, stale: nodeIdentity(snapshot.node) !== nodeIdentity(node) } : null;
}
type ProxyProbeView = (ProbeSnapshot["result"] & { stale: boolean }) | null;

export function visibleNodes(pool: NetworkProxyConfig, filter: PoolFilter, probes: Record<string, ProbeSnapshot>): ProxyNode[] {
  const query = filter.query.trim().toLocaleLowerCase();
  const nodes = pool.nodes.filter(node => (filter.enabled === "all" || node.enabled === (filter.enabled === "enabled"))
    && (!query || [node.name, node.endpoint.host, node.group, ...node.tags].join(" ").toLocaleLowerCase().includes(query)));
  if (filter.sort === "name") nodes.sort((left, right) => left.name.localeCompare(right.name));
  if (filter.sort === "latency") {
    const latency = (node: ProxyNode) => {
      const probe = currentProbe(node, probes);
      return probe?.success && !probe.stale ? probe.elapsedMs : Number.MAX_SAFE_INTEGER;
    };
    nodes.sort((left, right) => latency(left) - latency(right));
  }
  return nodes;
}
