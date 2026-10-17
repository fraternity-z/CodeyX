import type { Profile } from "../../App.types";
import type { NetworkProxyConfig, ProxySelection, UpstreamDraft } from "./types";
import { policyReferences } from "./policies";

export function selectionKey(selection: ProxySelection): string {
  return selection.kind === "legacy" ? "legacy" : `${selection.kind}:${selection.id}`;
}

export function parseSelection(value: string): ProxySelection {
  if (value === "legacy") return { kind: "legacy" };
  if (value.startsWith("node:") && value.length > 5) return { kind: "node", id: value.slice(5) };
  if (value.startsWith("chain:") && value.length > 6) return { kind: "chain", id: value.slice(6) };
  if (value.startsWith("policy:") && value.length > 7) return { kind: "policy", id: value.slice(7) };
  throw new Error("无效的上游选择");
}

export function selectedUpstream(pool: NetworkProxyConfig, profileId: string): ProxySelection {
  return pool.upstreamByProfile && Object.prototype.hasOwnProperty.call(pool.upstreamByProfile, profileId)
    ? pool.upstreamByProfile[profileId] : { kind: "legacy" };
}

export function upstreamProblem(pool: NetworkProxyConfig, selection: ProxySelection): string {
  if (selection.kind === "legacy") return "";
  if (selection.kind === "policy") {
    const policy = pool.policies?.find(policy => policy.id === selection.id);
    return !policy ? "出口策略已缺失，新连接将被阻断" : !policy.enabled ? "出口策略已禁用，新连接将被阻断" : "";
  }
  if (selection.kind === "node") {
    const node = pool.nodes.find(node => node.id === selection.id);
    return !node ? "出口节点已缺失，新请求将被阻断" : !node.enabled ? "出口节点已禁用，新请求将被阻断" : "";
  }
  const chain = pool.chains.find(chain => chain.id === selection.id);
  if (!chain) return "出口链路已缺失，新请求将被阻断";
  if (!chain.enabled) return "出口链路已禁用，新请求将被阻断";
  return chain.nodeIds.some(id => !pool.nodes.find(node => node.id === id)?.enabled) ? "链路存在缺失或禁用节点，新请求将被阻断" : "";
}

export function upstreamLabel(pool: NetworkProxyConfig, selection: ProxySelection): string {
  if (selection.kind === "legacy") return "沿用线路设置（不使用代理池）";
  if (selection.kind === "policy") return pool.policies?.find(policy => policy.id === selection.id)?.name ?? "策略缺失";
  return selection.kind === "node" ? pool.nodes.find(node => node.id === selection.id)?.name ?? "节点缺失"
    : pool.chains.find(chain => chain.id === selection.id)?.name ?? "链路缺失";
}

export function prepareUpstreamSave(pool: NetworkProxyConfig, draft: UpstreamDraft, profiles: Profile[], routerEnabled: boolean): NetworkProxyConfig {
  if (selectionKey(selectedUpstream(pool, draft.profileId)) !== selectionKey(draft.original)) throw new Error("此线路出口已被其他操作修改，请重新打开后保存");
  if (draft.selection.kind !== "legacy") {
    if (!routerEnabled) throw new Error("请先启用本地路由，再选择代理池出口");
    const profile = profiles.find(profile => profile.id === draft.profileId);
    if (!profile) throw new Error("线路当前不可用；可以解除保留的出口选择");
    if (profile.pluginRouteSpec?.transport) throw new Error("此插件自行联网，暂不支持代理池出口");
    const problem = upstreamProblem(pool, draft.selection);
    if (problem) throw new Error(problem);
  }
  const upstreamByProfile = { ...pool.upstreamByProfile, [draft.profileId]: draft.selection };
  if (draft.selection.kind === "legacy") delete upstreamByProfile[draft.profileId];
  return { ...pool, upstreamByProfile };
}

export function removeChain(pool: NetworkProxyConfig, id: string): NetworkProxyConfig {
  if (policyReferences(pool, "chain", [id])) throw new Error("链路仍被出口策略引用，请先调整规则");
  if (pool.processProxy?.kind === "chain" && pool.processProxy.id === id) throw new Error("链路仍被 Codex 启动出口引用，请先调整启动选择");
  if (Object.values(pool.upstreamByProfile ?? {}).some(selection => selection.kind === "chain" && selection.id === id)) throw new Error("链路仍被线路出口引用，请先调整上游选择");
  return { ...pool, chains: pool.chains.filter(chain => chain.id !== id) };
}
