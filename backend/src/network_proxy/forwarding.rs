//! A selected node is the only explicit exit; failures never become direct traffic.
use super::tunnel::{Destination, Hop, Tunnel, TunnelConnector, TunnelError};

pub(super) struct Forwarder {
    connector: TunnelConnector,
    hops: Vec<Hop>,
}

impl Forwarder {
    pub(super) async fn fixed(hops: Vec<Hop>) -> Result<Self, String> {
        if hops.len() != 1 {
            return Err("请选择一个代理节点；多跳链路已移除".into());
        }
        Ok(Self {
            connector: TunnelConnector::for_hops(&hops).await?,
            hops,
        })
    }

    pub(super) async fn connect(&self, destination: Destination) -> Result<Tunnel, TunnelError> {
        self.connector.connect(&self.hops, destination).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn only_single_node_forwarding_is_supported() {
        let hop = Hop {
            node: serde_json::from_value(serde_json::json!({
                "id":"node", "name":"Node", "enabled":true,
                "endpoint":{"protocol":"http", "host":"127.0.0.1", "port":1080}
            }))
            .unwrap(),
            credential: None,
        };
        assert!(Forwarder::fixed(vec![]).await.is_err());
        assert!(
            Forwarder::fixed(vec![hop.clone(), hop.clone()])
                .await
                .is_err()
        );
        assert!(Forwarder::fixed(vec![hop]).await.is_ok());
    }
}
