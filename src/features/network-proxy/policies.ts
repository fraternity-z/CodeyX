import type { NetworkProxyConfig, PolicyDraft, ProxyAction, ProxyPolicy, ProxyTarget, RuleDraft } from "./types";

export function policyDraft(id: string, policy?: ProxyPolicy): PolicyDraft {
  const value: ProxyPolicy = policy ? structuredClone(policy) : { id, name: "", enabled: false, allowDirect: false, rules: [], defaultAction: { kind: "block" } };
  return { ...value, original: policy ?? null, rules: value.rules.map(rule => ({ ...rule, ports: rule.ports.join(", ") })) };
}
export function ruleDraft(id: string): RuleDraft {
  return { id, enabled: true, host: { kind: "exact", value: "" }, ports: "", action: { kind: "block" } };
}
export function policyActions(policy: Pick<ProxyPolicy, "defaultAction"> & { rules: { action: ProxyAction }[] }): ProxyAction[] {
  return [...policy.rules.map(rule => rule.action), policy.defaultAction];
}
export function policyReferences(pool: NetworkProxyConfig, kind: ProxyTarget["kind"], ids: string[]): boolean {
  return (pool.policies ?? []).some(policy => policyActions(policy).some(action => action.kind === "proxy" && action.targets.some(target => target.kind === kind && ids.includes(target.id))));
}

function validCidr(value: string): boolean {
  const parts = value.split("/");
  if (parts.length !== 2 || !/^\d+$/.test(parts[1])) return false;
  const [address] = parts, prefix = Number(parts[1]);
  let bits: bigint, width: number;
  try {
    if (address.includes(":")) {
      const host = new URL(`http://[${address}]`).hostname.slice(1, -1);
      const [left, right] = host.split("::").map(part => part ? part.split(":") : []);
      const segments = right ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
      if (segments.length !== 8) return false;
      bits = segments.reduce((result, segment) => (result << 16n) + BigInt(`0x${segment}`), 0n); width = 128;
    } else {
      const octets = address.split(".");
      if (octets.length !== 4 || octets.some(part => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) return false;
      bits = octets.reduce((result, part) => (result << 8n) + BigInt(part), 0n); width = 32;
    }
    if (prefix > width) return false;
    const shift = BigInt(width - prefix);
    return ((bits >> shift) << shift) === bits;
  } catch { return false; }
}

export function validatePolicyDraft(pool: NetworkProxyConfig, draft: PolicyDraft): string {
  if (!draft.name.trim() || [...draft.name.trim()].length > 80) return "策略名称必须为 1 到 80 个字符";
  if (draft.rules.length > 64) return "每个策略最多支持 64 条规则";
  for (const [index, rule] of draft.rules.entries()) {
    const prefix = `第 ${index + 1} 条规则：`;
    if (rule.host.kind !== "any") {
      const value = rule.host.value.trim();
      if (rule.host.kind === "cidr") {
        if (!validCidr(value)) return `${prefix}请填写 IPv4/IPv6 网段起点与前缀长度`;
      } else {
        if (!value || value.length > 253 || /[\s\x00-\x1f\x7f/?#@*%\\]/u.test(value)) return `${prefix}请填写有效域名或 IP，不含通配符、路径或凭据`;
        try {
          const url = new URL(`http://${value.includes(":") && !value.startsWith("[") ? `[${value}]` : value}`);
          if (!url.hostname || url.port || url.pathname !== "/") return `${prefix}主机格式无效`;
          if (!url.hostname.includes(":") && url.hostname.replace(/\.$/, "").split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return `${prefix}域名标签无效`;
          if (rule.host.kind === "suffix" && (url.hostname.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname))) return `${prefix}域名后缀不能是 IP 地址`;
        } catch { return `${prefix}主机格式无效`; }
      }
    }
    const ports = rule.ports.trim() ? rule.ports.split(/[,，]/u).map(port => port.trim()) : [];
    if (ports.length > 32 || ports.some(port => !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) || new Set(ports.map(Number)).size !== ports.length)
      return `${prefix}端口须唯一且在 1 到 65535 之间，以逗号分隔，最多 32 个`;
  }
  for (const action of policyActions(draft)) {
    if ((action.kind === "direct" || (action.kind === "proxy" && action.onFailure === "direct")) && !draft.allowDirect) return "直连或回退直连需要勾选允许暴露本机出口";
    if (action.kind === "proxy") {
      if (!action.targets.length || action.targets.length > 4 || new Set(action.targets.map(target => `${target.kind}:${target.id}`)).size !== action.targets.length) return "出口候选须唯一且为 1 到 4 个节点或链路";
      if (action.onFailure === "stop" && action.targets.length !== 1) return "停止策略只允许一个出口";
      for (const target of action.targets) {
        if (!(target.kind === "node" ? pool.nodes : pool.chains).some(value => value.id === target.id)) return "请选择已存在的节点或链路";
      }
    }
  }
  return "";
}

export function preparePolicySave(pool: NetworkProxyConfig, draft: PolicyDraft): NetworkProxyConfig {
  const error = validatePolicyDraft(pool, draft); if (error) throw new Error(error);
  const existing = (pool.policies ?? []).find(policy => policy.id === draft.id);
  if (draft.original ? !existing || JSON.stringify(existing) !== JSON.stringify(draft.original) : existing) throw new Error("此策略已被其他操作修改或删除，请重新打开后保存");
  if (!existing && (pool.policies?.length ?? 0) >= 64) throw new Error("最多支持 64 个出口策略");
  const value: ProxyPolicy = { id: draft.id, name: draft.name.trim(), enabled: draft.enabled, allowDirect: draft.allowDirect,
    defaultAction: structuredClone(draft.defaultAction), rules: draft.rules.map(rule => ({ ...structuredClone(rule),
      host: rule.host.kind === "any" ? rule.host : { ...rule.host, value: rule.host.value.trim() },
      ports: rule.ports.trim() ? rule.ports.split(/[,，]/u).map(port => Number(port.trim())) : [],
    })) };
  return { ...pool, policies: existing ? pool.policies!.map(policy => policy.id === value.id ? value : policy) : [...(pool.policies ?? []), value] };
}
export function removePolicy(pool: NetworkProxyConfig, id: string): NetworkProxyConfig {
  if ([pool.processProxy, ...Object.values(pool.upstreamByProfile ?? {})].some(selection => selection?.kind === "policy" && selection.id === id)) throw new Error("策略仍被启动或线路出口引用，请先调整出口选择");
  return { ...pool, policies: (pool.policies ?? []).filter(policy => policy.id !== id) };
}
