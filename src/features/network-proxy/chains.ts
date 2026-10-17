import { nodeIdentity } from "./state";
import type { ChainDraft, ChainProbeSnapshot, NetworkProxyConfig, ProxyChain } from "./types";

export function chainDraft(id: string, chain?: ProxyChain): ChainDraft {
  return { id, original: chain ?? null, name: chain?.name ?? "", enabled: chain?.enabled ?? false, nodeIds: [...(chain?.nodeIds ?? [])] };
}

function chainIdentity(chain: ProxyChain): string {
  return JSON.stringify([chain.id, chain.name, chain.enabled, chain.nodeIds]);
}

export function validateChainDraft(pool: NetworkProxyConfig, draft: ChainDraft): string {
  if (!draft.name.trim() || [...draft.name.trim()].length > 80) return "链路名称必须为 1 到 80 个字符";
  if (!draft.nodeIds.length || draft.nodeIds.length > 3) return "代理链路需要 1 到 3 个上游节点";
  const endpoints = new Set<string>();
  for (const [index, id] of draft.nodeIds.entries()) {
    const node = pool.nodes.find(node => node.id === id);
    if (!node) return "请选择代理池中存在的节点";
    const raw = node.endpoint.host;
    let host: string;
    try {
      host = new URL(`http://${raw.includes(":") && !raw.startsWith("[") ? `[${raw}]` : raw}`).hostname
        .replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
    } catch { return "链路中有无效的代理主机，请先修正节点"; }
    const endpoint = `${host}:${node.endpoint.port}`;
    if (endpoints.has(endpoint)) return "代理链路不能重复经过同一端点";
    endpoints.add(endpoint);
    if (index > 0 && (host === "localhost" || host.endsWith(".localhost") || /^(127\.|::1$|::ffff:7f[0-9a-f]{2}:)/.test(host)))
      return "回环代理只能作为第一跳，后续节点的回环地址不代表本机";
  }
  return "";
}

export function prepareChainSave(pool: NetworkProxyConfig, draft: ChainDraft): NetworkProxyConfig {
  const error = validateChainDraft(pool, draft);
  if (error) throw new Error(error);
  const existing = pool.chains.find(chain => chain.id === draft.id);
  if (draft.original ? !existing || chainIdentity(existing) !== chainIdentity(draft.original) : existing)
    throw new Error("此链路已被其他操作修改或删除，请保留草稿内容并重新打开链路后保存");
  if (!existing && pool.chains.length >= 128) throw new Error("代理池最多支持 128 条链路");
  const chain: ProxyChain = { id: draft.id, name: draft.name.trim(), enabled: draft.enabled, nodeIds: [...draft.nodeIds] };
  return { ...pool, chains: existing ? pool.chains.map(value => value.id === chain.id ? chain : value) : [...pool.chains, chain] };
}

export function moveChainNode(ids: string[], index: number, direction: -1 | 1): string[] {
  const target = index + direction;
  if (index < 0 || index >= ids.length || target < 0 || target >= ids.length) return ids;
  const next = [...ids]; [next[index], next[target]] = [next[target], next[index]]; return next;
}

export function currentChainProbe(pool: NetworkProxyConfig, chain: ProxyChain, probes: Record<string, ChainProbeSnapshot>) {
  const snapshot = Object.prototype.hasOwnProperty.call(probes, chain.id) ? probes[chain.id] : undefined;
  if (!snapshot) return null;
  const nodes = chain.nodeIds.map(id => pool.nodes.find(node => node.id === id));
  return { ...snapshot.result, stale: chainIdentity(chain) !== chainIdentity(snapshot.chain)
    || nodes.length !== snapshot.nodes.length || nodes.some((node, index) => !node || nodeIdentity(node) !== nodeIdentity(snapshot.nodes[index])) };
}
