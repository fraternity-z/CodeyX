import type { ConfigSaveResult } from "../../App.types";

export type ProxyProtocol = "socks5" | "http" | "https";
export type ProxyNode = {
  id: string;
  name: string;
  endpoint: { protocol: ProxyProtocol; host: string; port: number; dns: "local" | "remote" };
  credentialRef: string | null;
  notes: string;
  enabled: boolean;
  tags: string[];
  group: string;
};
export type ProxyChain = { id: string; name: string; enabled: boolean; nodeIds: string[] };
export type ProxyTarget = { kind: "node" | "chain"; id: string };
export type ProxySelection = { kind: "legacy" } | { kind: "node" | "chain" | "policy"; id: string };
export type ProxyAction = { kind: "block" | "direct" } | { kind: "proxy"; targets: ProxyTarget[]; onFailure: "stop" | "next" | "direct" };
export type HostMatch = { kind: "any" } | { kind: "exact" | "suffix" | "cidr"; value: string };
export type ProxyRule = { id: string; enabled: boolean; host: HostMatch; ports: number[]; action: ProxyAction };
export type ProxyPolicy = { id: string; name: string; enabled: boolean; allowDirect: boolean; rules: ProxyRule[]; defaultAction: ProxyAction };
export type UpstreamDraft = { profileId: string; original: ProxySelection; selection: ProxySelection; originalEnabled: boolean; enabled: boolean };
export type ProcessProxyDraft = { original: ProxySelection; selection: ProxySelection; enabled: boolean; originalCapture?: boolean; capture?: boolean };
export type NetworkProxyConfig = { schemaVersion: number; nodes: ProxyNode[]; chains: ProxyChain[]; policies?: ProxyPolicy[]; upstreamByProfile?: Record<string, ProxySelection>; upstreamEnabledByProfile?: Record<string, boolean>; processProxy?: ProxySelection; processCapture?: boolean };
export type CredentialUpdate = {
  nodeId: string;
  change: { kind: "clear" } | { kind: "replace"; username: string; password: string };
};
export type ProxyDraft = {
  original: ProxyNode | null;
  id: string;
  name: string;
  protocol: ProxyProtocol;
  host: string;
  port: string;
  dns: "local" | "remote";
  authentication: "keep" | "replace" | "clear";
  username: string;
  password: string;
  notes: string;
  enabled: boolean;
  tags: string;
  group: string;
};
export type ProxyProbe = {
  nodeId: string;
  success: boolean;
  testedAt: string;
  elapsedMs: number;
  exitIp: string | null;
  errorCode: string | null;
  message: string;
  failedHop?: number | null;
};
export type ProbeSnapshot = { node: ProxyNode; result: ProxyProbe };
export type PoolSnapshot = ConfigSaveResult & { probeUrl: string; launchProxyPoolSupported?: boolean; trafficCaptureSupported?: boolean; trafficCaptureAvailable?: boolean };
export type PoolFilter = { query: string; enabled: "all" | "enabled" | "disabled"; sort: "saved" | "name" | "latency" };
