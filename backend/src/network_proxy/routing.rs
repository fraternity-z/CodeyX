//! Retired policy DTOs retained for lossless reads and writes of existing settings.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum ProxyTarget {
    Node { id: String },
    Chain { id: String },
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
