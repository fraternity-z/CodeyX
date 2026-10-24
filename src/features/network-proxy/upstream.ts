import type { Profile } from "../../App.types";
import type { NetworkProxyConfig, ProxySelection, UpstreamDraft } from "./types";

export function selectionKey(selection: ProxySelection): string {
  return selection.kind === "legacy" ? "legacy" : `${selection.kind}:${selection.id}`;
}

export function parseSelection(value: string): ProxySelection {
  if (value === "legacy") return { kind: "legacy" };
  if (value.startsWith("node:") && value.length > 5) return { kind: "node", id: value.slice(5) };
  throw new Error("无效的上游选择");
}

export function selectedUpstream(pool: NetworkProxyConfig, profileId: string): ProxySelection {
  return pool.upstreamByProfile && Object.prototype.hasOwnProperty.call(pool.upstreamByProfile, profileId)
    ? pool.upstreamByProfile[profileId] : { kind: "legacy" };
}

export function upstreamProblem(pool: NetworkProxyConfig, selection: ProxySelection): string {
  if (selection.kind === "legacy") return "";
  if (selection.kind !== "node") return "原代理链路或策略已移除，请选择节点或关闭代理池；新请求将被阻断";
  const node = pool.nodes.find(node => node.id === selection.id);
  return !node ? "出口节点已缺失，新请求将被阻断" : !node.enabled ? "出口节点已禁用，新请求将被阻断" : "";
}

export function upstreamLabel(pool: NetworkProxyConfig, selection: ProxySelection): string {
  if (selection.kind === "legacy") return "沿用线路设置（不使用代理池）";
  return selection.kind === "node" ? pool.nodes.find(node => node.id === selection.id)?.name ?? "节点缺失" : "原选择已移除";
}

export function upstreamEnabled(pool: NetworkProxyConfig, profileId: string): boolean {
  return Object.prototype.hasOwnProperty.call(pool.upstreamEnabledByProfile ?? {}, profileId)
    ? pool.upstreamEnabledByProfile![profileId] : selectedUpstream(pool, profileId).kind !== "legacy";
}

export function prepareUpstreamSave(pool: NetworkProxyConfig, draft: UpstreamDraft, profiles: Profile[], routerEnabled: boolean): NetworkProxyConfig {
  if (selectionKey(selectedUpstream(pool, draft.profileId)) !== selectionKey(draft.original)) throw new Error("此线路出口已被其他操作修改，请重新打开后保存");
  if (upstreamEnabled(pool, draft.profileId) !== draft.originalEnabled) throw new Error("此线路代理开关已被其他操作修改，请重新打开后保存");
  if (draft.enabled) {
    if (draft.selection.kind === "legacy") throw new Error("请选择代理池节点");
    if (!routerEnabled) throw new Error("请先启用本地路由，再选择代理池出口");
    const profile = profiles.find(profile => profile.id === draft.profileId);
    if (!profile) throw new Error("线路当前不可用；可以解除保留的出口选择");
    if (profile.pluginRouteSpec?.transport) throw new Error("此插件自行联网，暂不支持代理池出口");
    const problem = upstreamProblem(pool, draft.selection);
    if (problem) throw new Error(problem);
  }
  const upstreamByProfile = { ...pool.upstreamByProfile, [draft.profileId]: draft.selection };
  if (draft.selection.kind === "legacy") delete upstreamByProfile[draft.profileId];
  return { ...pool, upstreamByProfile, upstreamEnabledByProfile: { ...pool.upstreamEnabledByProfile, [draft.profileId]: draft.enabled } };
}
