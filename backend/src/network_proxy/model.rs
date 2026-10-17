use std::collections::HashSet;
use std::net::IpAddr;

use serde::{Deserialize, Serialize};

pub(crate) const MAX_NODES: usize = 256;
pub(crate) const MAX_CHAINS: usize = 128;
pub(crate) const MAX_CHAIN_HOPS: usize = 3;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProxyProtocol {
    #[default]
    Socks5,
    Http,
    Https,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DnsMode {
    Local,
    #[default]
    Remote,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProxyEndpoint {
    pub protocol: ProxyProtocol,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub dns: DnsMode,
}

impl ProxyEndpoint {
    pub(crate) fn url(&self) -> Result<reqwest::Url, String> {
        if self.port == 0 {
            return Err("代理端口必须在 1 到 65535 之间".into());
        }
        if self.host.is_empty()
            || self.host.len() > 253
            || self
                .host
                .chars()
                .any(|c| c.is_whitespace() || c.is_control())
            || self.host.contains(['/', '?', '#', '@', '*', '%', '\\'])
        {
            return Err("代理主机必须是有效的域名或 IP 地址，不能包含路径或凭据".into());
        }
        let host = if self.host.starts_with('[') || self.host.ends_with(']') {
            self.host
                .strip_prefix('[')
                .and_then(|host| host.strip_suffix(']'))
                .filter(|host| host.parse::<std::net::Ipv6Addr>().is_ok())
                .ok_or("代理 IPv6 地址格式无效")?
        } else {
            &self.host
        };
        let host = match host.parse::<IpAddr>() {
            Ok(ip) if ip.is_unspecified() || ip.is_multicast() => {
                return Err("代理主机不能是未指定地址或组播地址".into());
            }
            Ok(IpAddr::V6(ip)) => format!("[{ip}]"),
            _ => self.host.clone(),
        };
        // HTTP URL parsing canonicalizes IDNA hosts, including for SOCKS endpoints.
        let mut url = reqwest::Url::parse(&format!("http://{host}:{}", self.port))
            .map_err(|_| "代理主机格式无效".to_string())?;
        if url.host_str().is_none() || url.path() != "/" || !url.username().is_empty() {
            return Err("代理主机格式无效".into());
        }
        // Validate after URL canonicalization as well: 0, 0xe0000001 and mapped
        // IPv6 literals must not bypass the unspecified/multicast checks.
        if parsed_ip(url.host_str().unwrap())
            .is_some_and(|ip| ip.is_unspecified() || ip.is_multicast())
        {
            return Err("代理主机不能是未指定地址或组播地址".into());
        }
        let scheme = match (self.protocol, self.dns) {
            (ProxyProtocol::Socks5, DnsMode::Remote) => "socks5h",
            (ProxyProtocol::Socks5, DnsMode::Local) => "socks5",
            (ProxyProtocol::Http, _) => "http",
            (ProxyProtocol::Https, _) => "https",
        };
        if self.protocol != ProxyProtocol::Socks5 && self.dns != DnsMode::Remote {
            return Err("HTTP 和 HTTPS 代理使用代理端解析".into());
        }
        // Changing from a special to a non-special URL scheme is disallowed by URL;
        // construct the final authority from the validated, canonical HTTP host.
        let authority = format!("{}:{}", url.host_str().unwrap(), self.port);
        url = reqwest::Url::parse(&format!("{scheme}://{authority}"))
            .map_err(|_| "代理地址格式无效".to_string())?;
        Ok(url)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProxyNode {
    pub id: String,
    pub name: String,
    pub endpoint: ProxyEndpoint,
    #[serde(default)]
    pub credential_ref: Option<String>,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub group: String,
}

impl ProxyNode {
    pub(crate) fn validate(&self) -> Result<(), String> {
        validate_id(&self.id)?;
        if self.name.trim().is_empty() || self.name.chars().count() > 80 {
            return Err("代理名称必须为 1 到 80 个字符".into());
        }
        self.endpoint.url()?;
        if let Some(reference) = &self.credential_ref {
            uuid::Uuid::parse_str(reference).map_err(|_| "代理凭据引用无效".to_string())?;
        }
        if self.notes.chars().count() > 2000 || self.group.chars().count() > 80 {
            return Err("代理备注不能超过 2000 个字符，分组不能超过 80 个字符".into());
        }
        let mut tags = HashSet::new();
        if self.tags.len() > 20
            || self
                .tags
                .iter()
                .any(|tag| tag.trim().is_empty() || tag.chars().count() > 32 || !tags.insert(tag))
        {
            return Err("代理标签须唯一且非空，最多 20 个，每个不超过 32 个字符".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProxyChain {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub node_ids: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum ProxySelection {
    /// Preserve the old caller's proxy behavior. Never a failure fallback.
    #[default]
    Legacy,
    Node {
        id: String,
    },
    Chain {
        id: String,
    },
    Policy {
        id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NetworkProxyConfig {
    #[serde(default = "schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub nodes: Vec<ProxyNode>,
    #[serde(default)]
    pub chains: Vec<ProxyChain>,
    #[serde(default)]
    pub policies: Vec<super::routing::ProxyPolicy>,
    /// An explicit selection overrides the route's legacy manual proxy. Absence
    /// preserves old behavior; it is never a fallback after a proxy failure.
    #[serde(default)]
    pub upstream_by_profile: std::collections::BTreeMap<String, ProxySelection>,
    /// Applied to the next managed Codex launch, independently of model routes.
    #[serde(default)]
    pub process_proxy: ProxySelection,
}

fn schema_version() -> u32 {
    1
}

impl Default for NetworkProxyConfig {
    fn default() -> Self {
        Self {
            schema_version: schema_version(),
            nodes: Vec::new(),
            chains: Vec::new(),
            policies: Vec::new(),
            upstream_by_profile: std::collections::BTreeMap::new(),
            process_proxy: ProxySelection::Legacy,
        }
    }
}

impl NetworkProxyConfig {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.schema_version != schema_version() {
            return Err("网络代理配置版本不受支持，请使用兼容版本打开；原配置不会被覆盖".into());
        }
        if self.nodes.len() > MAX_NODES || self.chains.len() > MAX_CHAINS {
            return Err("代理池最多支持 256 个节点和 128 条链路".into());
        }
        let mut ids = HashSet::new();
        for node in &self.nodes {
            node.validate()?;
            if !ids.insert(&node.id) {
                return Err("代理节点 ID 重复".into());
            }
        }
        let mut chain_ids = HashSet::new();
        for chain in &self.chains {
            validate_id(&chain.id)?;
            if !chain_ids.insert(&chain.id) {
                return Err("代理链路 ID 重复".into());
            }
            if chain.name.trim().is_empty() || chain.name.chars().count() > 80 {
                return Err("链路名称必须为 1 到 80 个字符".into());
            }
            if chain.node_ids.is_empty() || chain.node_ids.len() > MAX_CHAIN_HOPS {
                return Err("代理链路需要 1 到 3 个上游节点".into());
            }
            let mut endpoints = HashSet::new();
            for (index, id) in chain.node_ids.iter().enumerate() {
                let node = self.node(id)?;
                let url = node.endpoint.url()?;
                let host = url
                    .host_str()
                    .unwrap()
                    .trim_end_matches('.')
                    .to_ascii_lowercase();
                let host = parsed_ip(&host).map(|ip| ip.to_string()).unwrap_or(host);
                if !endpoints.insert((host.clone(), node.endpoint.port)) {
                    return Err("代理链路不能重复经过同一端点".into());
                }
                if index > 0
                    && (host == "localhost"
                        || host.ends_with(".localhost")
                        || parsed_ip(&host).is_some_and(|ip| ip.is_loopback()))
                {
                    return Err("回环代理只能作为第一跳，后续节点的回环地址不代表本机".into());
                }
            }
        }
        super::routing::validate_policies(self)?;
        if self.upstream_by_profile.len() > 256 {
            return Err("最多支持 256 条线路的上游选择".into());
        }
        for (profile, selection) in &self.upstream_by_profile {
            if profile.is_empty()
                || profile.len() > 256
                || profile.trim() != profile
                || profile.chars().any(char::is_control)
            {
                return Err("上游代理的线路标识无效".into());
            }
            self.validate_selection_reference(selection)?;
        }
        self.validate_selection_reference(&self.process_proxy)?;
        Ok(())
    }

    pub(super) fn validate_selection_reference(
        &self,
        selection: &ProxySelection,
    ) -> Result<(), String> {
        match selection {
            ProxySelection::Legacy => {}
            ProxySelection::Node { id } => {
                self.node(id)?;
            }
            ProxySelection::Chain { id } => {
                if !self.chains.iter().any(|chain| &chain.id == id) {
                    return Err("所选代理链路不存在，请先调整线路或启动出口引用".into());
                }
            }
            ProxySelection::Policy { id } => {
                self.policy(id)?;
            }
        }
        Ok(())
    }

    pub(crate) fn has_process_proxy(&self) -> bool {
        !matches!(self.process_proxy, ProxySelection::Legacy)
    }

    pub(crate) fn policy(&self, id: &str) -> Result<&super::routing::ProxyPolicy, String> {
        self.policies
            .iter()
            .find(|policy| policy.id == id)
            .ok_or_else(|| "出口策略不存在，请先调整引用".into())
    }

    pub(crate) fn validate_active_selection(
        &self,
        selection: &ProxySelection,
    ) -> Result<(), String> {
        if let ProxySelection::Policy { id } = selection {
            self.validate()?;
            if !self.policy(id)?.enabled {
                return Err("出口策略已禁用，连接已阻断".into());
            }
        } else {
            self.resolve(selection)?;
        }
        Ok(())
    }

    pub(crate) fn uses_pool(&self, profile: &str) -> bool {
        self.upstream_by_profile
            .get(profile)
            .is_some_and(|selection| !matches!(selection, ProxySelection::Legacy))
    }

    pub(crate) fn has_upstream_bindings(&self) -> bool {
        self.upstream_by_profile
            .values()
            .any(|selection| !matches!(selection, ProxySelection::Legacy))
    }

    pub(crate) fn node(&self, id: &str) -> Result<&ProxyNode, String> {
        self.nodes
            .iter()
            .find(|node| node.id == id)
            .ok_or_else(|| "代理节点不存在或仍被链路引用，请先调整引用".into())
    }

    /// Only an explicit Legacy selection may return None. A missing/disabled node
    /// is always an error, never a request to reconnect directly.
    pub(crate) fn resolve(
        &self,
        selection: &ProxySelection,
    ) -> Result<Option<Vec<ProxyNode>>, String> {
        self.resolve_nodes(selection, false)
    }

    /// A manual diagnostic may inspect a disabled node/chain without enabling it.
    pub(crate) fn test_nodes(&self, selection: &ProxySelection) -> Result<Vec<ProxyNode>, String> {
        self.resolve_nodes(selection, true)?
            .ok_or_else(|| "请指定要测试的代理节点或链路".into())
    }

    fn resolve_nodes(
        &self,
        selection: &ProxySelection,
        allow_disabled: bool,
    ) -> Result<Option<Vec<ProxyNode>>, String> {
        self.validate()?;
        let ids = match selection {
            ProxySelection::Legacy => return Ok(None),
            ProxySelection::Policy { .. } => {
                return Err("出口策略需要根据目标地址选择，不能作为固定节点测试".into());
            }
            ProxySelection::Node { id } => vec![id],
            ProxySelection::Chain { id } => {
                let chain = self
                    .chains
                    .iter()
                    .find(|chain| &chain.id == id)
                    .ok_or("代理链路不存在")?;
                if !allow_disabled && !chain.enabled {
                    return Err("代理链路已禁用，连接已阻断".into());
                }
                chain.node_ids.iter().collect()
            }
        };
        let nodes = ids
            .into_iter()
            .map(|id| {
                let node = self.node(id)?;
                if !allow_disabled && !node.enabled {
                    return Err("代理节点已禁用，连接已阻断".into());
                }
                Ok(node.clone())
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(Some(nodes))
    }
}

pub(super) fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 80
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("代理标识必须由 1 到 80 个字母、数字、下划线或连字符组成".into());
    }
    Ok(())
}

fn parsed_ip(host: &str) -> Option<IpAddr> {
    host.trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
        .ok()
        .map(|ip| match ip {
            IpAddr::V6(ip) => ip
                .to_ipv4_mapped()
                .map(IpAddr::V4)
                .unwrap_or(IpAddr::V6(ip)),
            ip => ip,
        })
}

#[cfg(test)]
mod tests;
