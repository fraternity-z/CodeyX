use super::*;
use crate::network_proxy::{egress::EgressPool, process_gateway::ProcessGateway};

#[tokio::test]
async fn process_proxy_remains_on_failed_cleanup_and_closes_after_confirmed_stop() {
    let directory = tempfile::tempdir().unwrap();
    let config: CodeyConfig = serde_json::from_value(serde_json::json!({
        "networkProxy": {"nodes":[{"id":"exit","name":"Exit","enabled":true,
            "endpoint":{"protocol":"socks5","host":"proxy.invalid","port":1080}}],
            "processProxy":{"kind":"node","id":"exit"}}
    }))
    .unwrap();
    let service = Arc::new(EgressPool::for_config(
        &directory.path().join("config.json"),
        config.network_proxy.clone(),
    ));
    let gateway = ProcessGateway::start(service, config.network_proxy.process_proxy.clone())
        .await
        .unwrap();
    let auth = gateway.auth();
    let address = (auth.host.as_str(), auth.port);
    let mut runtime = CodeyRuntime::for_model_delivery_test(config, "", None);
    runtime.process_proxy = Some(gateway);
    assert!(
        runtime
            .stop_with_cleanup(async { anyhow::bail!("fixture cleanup failure") }, async {
                panic!("must not restore")
            })
            .await
            .is_err()
    );
    assert!(tokio::net::TcpStream::connect(address).await.is_ok());
    runtime
        .stop_with_cleanup(async { Ok(()) }, async { Ok(()) })
        .await
        .unwrap();
    assert!(tokio::net::TcpStream::connect(address).await.is_err());
    runtime
        .stop_with_cleanup(async { Ok(()) }, async { Ok(()) })
        .await
        .unwrap();
}
