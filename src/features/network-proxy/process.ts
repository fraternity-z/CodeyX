import { selectionKey, upstreamProblem } from "./upstream";
import type { NetworkProxyConfig, ProcessProxyDraft, ProxySelection } from "./types";

export function selectedProcessProxy(pool: NetworkProxyConfig): ProxySelection {
  return pool.processProxy ?? { kind: "legacy" };
}

export function prepareProcessProxySave(pool: NetworkProxyConfig, draft: ProcessProxyDraft, supported: boolean, captureSupported = false): NetworkProxyConfig {
  if (selectionKey(selectedProcessProxy(pool)) !== selectionKey(draft.original)) throw new Error("启动出口已被其他操作修改，请重新打开后保存");
  if (Boolean(pool.processCapture) !== Boolean(draft.originalCapture)) throw new Error("流量接管设置已被其他操作修改，请重新打开后保存");
  if (draft.capture && (!captureSupported || draft.selection.kind === "legacy")) throw new Error("流量接管需要 Windows x64 宿主和代理池出口");
  if (draft.selection.kind !== "legacy") {
    if (!supported) throw new Error("当前宿主暂不支持从代理池启动 Codex");
    const problem = upstreamProblem(pool, draft.selection);
    if (problem) throw new Error(problem);
  }
  const next = { ...pool };
  if (draft.selection.kind === "legacy") delete next.processProxy;
  else next.processProxy = draft.selection;
  if (draft.capture) next.processCapture = true;
  else delete next.processCapture;
  return next;
}
