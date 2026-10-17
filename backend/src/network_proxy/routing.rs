//! Pure, ordered destination rules. Matching never performs DNS or network I/O.
use super::{
    model::{NetworkProxyConfig, ProxySelection, validate_id},
    tunnel::Destination,
};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, net::IpAddr};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum ProxyTarget {
    Node { id: String },
    Chain { id: String },
}
impl ProxyTarget {
    pub(crate) fn selection(&self) -> ProxySelection {
        match self {
            Self::Node { id } => ProxySelection::Node { id: id.clone() },
            Self::Chain { id } => ProxySelection::Chain { id: id.clone() },
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum FailureAction {
    #[default]
    Stop,
    Next,
    Direct,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum ProxyAction {
    #[default]
    Block,
    Direct,
    Proxy {
        targets: Vec<ProxyTarget>,
        #[serde(default, rename = "onFailure")]
        on_failure: FailureAction,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum HostMatch {
    Any,
    Exact { value: String },
    Suffix { value: String },
    Cidr { value: String },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProxyRule {
    pub id: String,
    pub enabled: bool,
    pub host: HostMatch,
    /// Empty means any port; no implicit destination name resolution for CIDRs.
    #[serde(default)]
    pub ports: Vec<u16>,
    pub action: ProxyAction,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProxyPolicy {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    /// Explicit persisted consent; defaults to false even for imported settings.
    #[serde(default)]
    pub allow_direct: bool,
    #[serde(default)]
    pub rules: Vec<ProxyRule>,
    #[serde(default)]
    pub default_action: ProxyAction,
}

impl ProxyPolicy {
    pub(crate) fn action(&self, destination: &Destination) -> &ProxyAction {
        self.rules
            .iter()
            .find(|rule| {
                rule.enabled
                    && (rule.ports.is_empty() || rule.ports.contains(&destination.port))
                    && rule.host.matches(&destination.host)
            })
            .map(|rule| &rule.action)
            .unwrap_or(&self.default_action)
    }
    pub(crate) fn actions(&self) -> impl Iterator<Item = &ProxyAction> {
        self.rules
            .iter()
            .map(|rule| &rule.action)
            .chain(std::iter::once(&self.default_action))
    }
}

fn canonical_host(value: &str) -> Result<String, String> {
    let host = Destination::new(value, 443)?.host;
    let host = host.strip_suffix('.').unwrap_or(&host).to_string();
    if host.parse::<IpAddr>().is_err()
        && host.split('.').any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    {
        return Err("规则主机包含无效的域名标签".into());
    }
    Ok(host)
}

fn comparable_host(host: &str) -> String {
    host.parse::<std::net::Ipv6Addr>()
        .ok()
        .and_then(|ip| ip.to_ipv4_mapped())
        .map(|ip| ip.to_string())
        .unwrap_or_else(|| host.to_string())
}

impl HostMatch {
    fn validate(&self) -> Result<(), String> {
        match self {
            Self::Any => Ok(()),
            Self::Exact { value } => canonical_host(value).map(|_| ()),
            Self::Suffix { value } => {
                let host = canonical_host(value)?;
                if host.parse::<IpAddr>().is_ok() {
                    return Err("域名后缀不能是 IP 地址".into());
                }
                Ok(())
            }
            Self::Cidr { value } => cidr(value).map(|_| ()),
        }
    }
    fn matches(&self, host: &str) -> bool {
        if matches!(self, Self::Any) {
            return true;
        }
        let Ok(host) = canonical_host(host) else {
            return false;
        };
        match self {
            Self::Any => true,
            Self::Exact { value } => canonical_host(value)
                .is_ok_and(|value| comparable_host(&value) == comparable_host(&host)),
            Self::Suffix { value } => canonical_host(value)
                .is_ok_and(|value| host == value || host.ends_with(&format!(".{value}"))),
            Self::Cidr { value } => match (cidr(value), host.parse::<IpAddr>()) {
                (Ok((network, prefix)), Ok(address)) => {
                    let address = match (network, address) {
                        (IpAddr::V4(_), IpAddr::V6(ip)) => {
                            ip.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(address)
                        }
                        _ => address,
                    };
                    let (network, width) = ip_bits(network);
                    let (address, address_width) = ip_bits(address);
                    width == address_width
                        && mask(network, prefix, width) == mask(address, prefix, width)
                }
                _ => false,
            },
        }
    }
}

fn ip_bits(ip: IpAddr) -> (u128, u8) {
    match ip {
        IpAddr::V4(ip) => (u32::from(ip).into(), 32),
        IpAddr::V6(ip) => (u128::from(ip), 128),
    }
}
fn mask(bits: u128, prefix: u8, width: u8) -> u128 {
    if prefix == 0 {
        0
    } else {
        bits >> (width - prefix)
    }
}
fn cidr(value: &str) -> Result<(IpAddr, u8), String> {
    let invalid = || "网段须为有效的 IPv4/IPv6 CIDR，且地址必须为网段起点".to_string();
    let (ip, prefix) = value.split_once('/').ok_or_else(invalid)?;
    let ip: IpAddr = ip.parse().map_err(|_| invalid())?;
    let prefix: u8 = prefix.parse().map_err(|_| invalid())?;
    let (bits, width) = ip_bits(ip);
    if prefix > width
        || (prefix == 0 && bits != 0)
        || (prefix > 0 && (mask(bits, prefix, width) << (width - prefix)) != bits)
    {
        return Err(invalid());
    }
    Ok((ip, prefix))
}

pub(super) fn validate_policies(pool: &NetworkProxyConfig) -> Result<(), String> {
    if pool.policies.len() > 64 {
        return Err("最多支持 64 个出口策略".into());
    }
    let mut ids = HashSet::new();
    for policy in &pool.policies {
        validate_id(&policy.id)?;
        if !ids.insert(&policy.id) {
            return Err("出口策略 ID 重复".into());
        }
        if policy.name.trim().is_empty() || policy.name.chars().count() > 80 {
            return Err("策略名称必须为 1 到 80 个字符".into());
        }
        if policy.rules.len() > 64 {
            return Err("每个出口策略最多支持 64 条规则".into());
        }
        let mut rules = HashSet::new();
        for rule in &policy.rules {
            validate_id(&rule.id)?;
            if !rules.insert(&rule.id) {
                return Err("规则 ID 重复".into());
            }
            rule.host.validate()?;
            if rule.ports.len() > 32
                || rule.ports.contains(&0)
                || rule.ports.iter().collect::<HashSet<_>>().len() != rule.ports.len()
            {
                return Err("规则端口须唯一且在 1 到 65535 之间，最多 32 个".into());
            }
        }
        for action in policy.actions() {
            let needs_direct = match action {
                ProxyAction::Direct => true,
                ProxyAction::Block => false,
                ProxyAction::Proxy {
                    targets,
                    on_failure,
                } => {
                    if targets.is_empty()
                        || targets.len() > 4
                        || targets.iter().collect::<HashSet<_>>().len() != targets.len()
                    {
                        return Err("出口候选须唯一且为 1 到 4 个节点或链路".into());
                    }
                    if *on_failure == FailureAction::Stop && targets.len() != 1 {
                        return Err("停止策略只允许一个出口；多个出口须显式选择依次切换".into());
                    }
                    for target in targets {
                        pool.validate_selection_reference(&target.selection())?;
                    }
                    *on_failure == FailureAction::Direct
                }
            };
            if needs_direct && !policy.allow_direct {
                return Err("直连或回退直连需要显式允许暴露本机出口".into());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
