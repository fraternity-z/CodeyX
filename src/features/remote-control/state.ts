import type { RemoteDraft, RemoteSnapshot, RemoteStatus } from "./types";

export function remoteStartOptions(draft: RemoteDraft) {
  const port = Number(draft.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口须为 1–65535 的整数");
  if (draft.connection === "custom" && !draft.publicUrl.trim()) throw new Error("请输入已转发到本机服务的 HTTPS 地址");
  return { bindAddress: draft.bindAddress, port, publicUrl: draft.connection === "custom" ? draft.publicUrl : "", tunnel: draft.connection === "tunnel" };
}

export function adoptRemoteStatus(previous: RemoteSnapshot, status: RemoteStatus): RemoteSnapshot {
  return {
    status,
    url: status.urls.includes(previous.url) ? previous.url : status.tunnel?.status === "starting" ? "" : status.urls[0] || "",
    pairing: previous.pairing && status.running && status.urls.some(url => previous.pairing!.url.startsWith(`${url}/#pair=`)) ? previous.pairing : null,
  };
}
