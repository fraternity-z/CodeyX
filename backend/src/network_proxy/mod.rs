//! Codex-scoped network policy. Configuration contains secret references only.
pub(crate) mod egress;
pub(crate) mod gateway;
mod forwarding;
pub(crate) mod model;
pub(crate) mod probe;
pub(crate) mod process_gateway;
pub(crate) mod routing;
pub(crate) mod secrets;
pub(crate) mod tunnel;

pub(crate) use model::NetworkProxyConfig;
