import { selectionKey, upstreamProblem } from "./upstream";
import type { NetworkProxyConfig, ProcessProxyDraft, ProxySelection } from "./types";

export function selectedProcessProxy(pool: NetworkProxyConfig): ProxySelection {
  return pool.processProxy ?? { kind: "legacy" };
}

export function prepareProcessProxySave(pool: NetworkProxyConfig, draft: ProcessProxyDraft, supported: boolean): NetworkProxyConfig {
  if (selectionKey(selectedProcessProxy(pool)) !== selectionKey(draft.original)) throw new Error("启动出口已被其他操作修改，请重新打开后保存");
  if (draft.selection.kind !== "legacy") {
    if (!supported) throw new Error("当前宿主暂不支持从代理池启动 Codex");
    const problem = upstreamProblem(pool, draft.selection);
    if (problem) throw new Error(problem);
  }
  const next = { ...pool };
  if (draft.selection.kind === "legacy") delete next.processProxy;
  else next.processProxy = draft.selection;
  return next;
}
