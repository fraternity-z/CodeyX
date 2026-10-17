//! Connection selection happens before any application bytes enter a tunnel.
use super::{
    egress::prepare_hops,
    model::NetworkProxyConfig,
    routing::{FailureAction, ProxyAction, ProxyPolicy, ProxyTarget},
    secrets::SecretStore,
    tunnel::{Destination, FailureKind, Hop, Tunnel, TunnelConnector, TunnelError},
};
use std::{sync::Arc, time::Duration};
use tokio::{net::TcpStream, sync::OnceCell, time::timeout};

pub(super) struct FixedForwarder {
    connector: TunnelConnector,
    hops: Vec<Hop>,
}
impl FixedForwarder {
    async fn new(hops: Vec<Hop>) -> Result<Self, String> {
        if hops.is_empty() {
            return Err("代理链路为空，不能启动转发".into());
        }
        Ok(Self {
            connector: TunnelConnector::for_hops(&hops).await?,
            hops,
        })
    }
}

pub(super) enum Forwarder {
    Fixed(FixedForwarder),
    Policy {
        pool: Arc<NetworkProxyConfig>,
        policy: ProxyPolicy,
        store: Arc<dyn SecretStore + Send + Sync>,
        targets: Vec<(ProxyTarget, OnceCell<FixedForwarder>)>,
    },
}

impl Forwarder {
    pub(super) async fn fixed(hops: Vec<Hop>) -> Result<Self, String> {
        Ok(Self::Fixed(FixedForwarder::new(hops).await?))
    }
    pub(super) fn policy(
        pool: NetworkProxyConfig,
        id: &str,
        store: Arc<dyn SecretStore + Send + Sync>,
    ) -> Result<Self, String> {
        pool.validate()?;
        let policy = pool.policy(id)?.clone();
        if !policy.enabled {
            return Err("出口策略已禁用，连接已阻断".into());
        }
        let mut targets = Vec::new();
        for action in policy.actions() {
            if let ProxyAction::Proxy {
                targets: choices, ..
            } = action
            {
                for target in choices {
                    if !targets.iter().any(|(existing, _)| existing == target) {
                        targets.push((target.clone(), OnceCell::new()));
                    }
                }
            }
        }
        Ok(Self::Policy {
            pool: Arc::new(pool),
            policy,
            store,
            targets,
        })
    }

    pub(super) async fn connect(&self, destination: Destination) -> Result<Tunnel, TunnelError> {
        let configuration = || TunnelError {
            hop: 0,
            kind: FailureKind::Configuration,
        };
        let destination =
            Destination::new(&destination.host, destination.port).map_err(|_| configuration())?;
        let Self::Policy {
            pool,
            policy,
            store,
            targets,
        } = self
        else {
            let Self::Fixed(fixed) = self else {
                unreachable!()
            };
            return fixed.connector.connect(&fixed.hops, destination).await;
        };
        timeout(Duration::from_secs(30), async {
            match policy.action(&destination) {
                ProxyAction::Block => Err(TunnelError {
                    hop: 0,
                    kind: FailureKind::Blocked,
                }),
                ProxyAction::Direct if policy.allow_direct => direct(destination).await,
                ProxyAction::Direct => Err(configuration()),
                ProxyAction::Proxy {
                    targets: choices,
                    on_failure,
                } => {
                    let mut last = configuration();
                    for target in choices {
                        let (_, cell) = targets
                            .iter()
                            .find(|(choice, _)| choice == target)
                            .ok_or_else(configuration)?;
                        let fixed = cell
                            .get_or_try_init(|| async {
                                let nodes = pool
                                    .resolve(&target.selection())?
                                    .ok_or("出口节点配置无效")?;
                                FixedForwarder::new(prepare_hops(nodes, store.clone()).await?).await
                            })
                            .await
                            .map_err(|_: String| configuration())?;
                        match fixed
                            .connector
                            .connect(&fixed.hops, destination.clone())
                            .await
                        {
                            Ok(tunnel) => return Ok(tunnel),
                            Err(error) => {
                                // Never turn a credential/certificate/configuration error into
                                // weaker routing; only transport failures may change exits.
                                let retryable = matches!(
                                    error.kind,
                                    FailureKind::Connect
                                        | FailureKind::Timeout
                                        | FailureKind::Dns
                                        | FailureKind::Io
                                        | FailureKind::Rejected
                                );
                                if !retryable || *on_failure == FailureAction::Stop {
                                    return Err(error);
                                }
                                last = error;
                            }
                        }
                    }
                    if *on_failure == FailureAction::Direct && policy.allow_direct {
                        direct(destination).await
                    } else {
                        Err(last)
                    }
                }
            }
        })
        .await
        .map_err(|_| TunnelError {
            hop: 0,
            kind: FailureKind::Timeout,
        })?
    }
}

async fn direct(destination: Destination) -> Result<Tunnel, TunnelError> {
    let socket = timeout(
        Duration::from_secs(5),
        TcpStream::connect((destination.host.as_str(), destination.port)),
    )
    .await
    .map_err(|_| TunnelError {
        hop: 0,
        kind: FailureKind::Timeout,
    })?
    .map_err(|_| TunnelError {
        hop: 0,
        kind: FailureKind::Connect,
    })?;
    let _ = socket.set_nodelay(true);
    Ok(Box::new(socket))
}

#[cfg(test)]
mod tests;
