//! Codex-scoped network policy. Configuration contains secret references only.
pub(crate) mod egress;
mod forwarding;
pub(crate) mod gateway;
pub(crate) mod model;
pub(crate) mod probe;
#[cfg(windows)]
pub(crate) mod process_capture;
pub(crate) mod process_gateway;
pub(crate) mod routing;
pub(crate) mod secrets;
pub(crate) mod tunnel;

pub(crate) use model::NetworkProxyConfig;
