use super::*;
use crate::network_proxy::{
    egress::EgressPool,
    model::{NetworkProxyConfig, ProxyNode, ProxySelection},
};
use tokio::time::timeout;

fn pool(profile: &str, port: u16) -> NetworkProxyConfig {
    let node: ProxyNode = serde_json::from_value(json!({
        "id":"exit", "name":"Exit", "endpoint":{"protocol":"http", "host":"127.0.0.1", "port":port, "dns":"remote"},
        "credentialRef":null, "notes":"", "enabled":true, "tags":[], "group":""
    })).unwrap();
    NetworkProxyConfig {
        nodes: vec![node],
        upstream_by_profile: [(
            profile.to_owned(),
            ProxySelection::Node { id: "exit".into() },
        )]
        .into(),
        ..Default::default()
    }
}

async fn respond_via_proxy(listener: TcpListener, authority: String) {
    let (mut stream, _) = listener.accept().await.unwrap();
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        assert!(head.len() < 16_384);
        head.push(stream.read_u8().await.unwrap());
    }
    assert!(
        String::from_utf8(head)
            .unwrap()
            .starts_with(&format!("CONNECT {authority} HTTP/1.1"))
    );
    stream
        .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
        .await
        .unwrap();
    let request = read_http_request(&mut stream).await.unwrap();
    assert_eq!(request.method, "POST");
    assert_eq!(
        incoming_header(&request, "authorization"),
        Some("Bearer sk-upstream")
    );
    assert!(incoming_header(&request, "proxy-authorization").is_none());
    write_json_response(
        &mut stream,
        200,
        &json!({"id":"through-pool", "object":"response", "status":"completed", "output":[]}),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn network_proxy_routes_use_pool_over_manual_and_block_disabled_or_failed_nodes() {
    let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target_address = target.local_addr().unwrap();
    let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (mut config, provider, model) = tests::router_config(format!("http://{target_address}/v1"));
    config.profiles[0].upstream_proxy = "http://127.0.0.1:9".into();
    config.network_proxy = pool(&config.profiles[0].id, proxy.local_addr().unwrap().port());
    let directory = tempfile::tempdir().unwrap();
    let egress = Arc::new(EgressPool::for_config(
        &directory.path().join("config.json"),
        config.network_proxy.clone(),
    ));
    let router = LocalRouter::start_with_egress(&config, Arc::default(), egress.clone())
        .await
        .unwrap();
    let endpoint = router.endpoint();
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let request =
        || {
            client.post(format!("{}/responses", endpoint.base_url)).bearer_auth(&endpoint.token)
        .json(&json!({"model":model_alias(&provider, &model), "stream":false, "input":"test"}))
        };
    let serving = tokio::spawn(respond_via_proxy(proxy, target_address.to_string()));
    let response = request().send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(
        response.json::<Value>().await.unwrap()["id"],
        "through-pool"
    );
    serving.await.unwrap();

    let mut policy = config.network_proxy.clone();
    policy.nodes[0].enabled = false;
    egress.configure(policy.clone());
    let response = request().send().await.unwrap();
    assert_eq!(response.status(), 502);
    assert!(response.text().await.unwrap().contains("阻断"));
    policy.nodes[0].enabled = true;
    egress.configure(policy);
    assert_eq!(request().send().await.unwrap().status(), 424);
    // Both the explicit legacy proxy and the reachable direct target stay unused.
    assert!(
        timeout(Duration::from_millis(100), target.accept())
            .await
            .is_err()
    );
    router.stop().await.unwrap();
}

#[tokio::test]
async fn network_proxy_hot_selection_does_not_use_stale_websocket_capability() {
    let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = target.local_addr().unwrap();
    let (mut config, provider, model) = tests::router_config(format!("http://{address}/v1"));
    config.profiles[0].supports_websockets = true;
    let directory = tempfile::tempdir().unwrap();
    let egress = Arc::new(EgressPool::for_config(
        &directory.path().join("config.json"),
        config.network_proxy.clone(),
    ));
    let router = LocalRouter::start_with_egress(&config, Arc::default(), egress.clone())
        .await
        .unwrap();
    // Publish only egress, leaving the existing router's WS-capable snapshot intact.
    let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
    egress.configure(pool(
        &config.profiles[0].id,
        proxy.local_addr().unwrap().port(),
    ));
    let serving = tokio::spawn(respond_via_proxy(proxy, address.to_string()));
    let mut socket = tests::connect_router_websocket(&router.endpoint()).await;
    socket.send(WebSocketMessage::Text(json!({"type":"response.create", "model":model_alias(&provider, &model), "stream":true, "input":"test"}).to_string().into())).await.unwrap();
    let mut completed = false;
    for _ in 0..10 {
        let frame = timeout(Duration::from_secs(5), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        if let WebSocketMessage::Text(text) = frame {
            let event: Value = serde_json::from_str(&text).unwrap();
            if event["type"] == "response.completed" {
                completed = true;
                break;
            }
            assert_ne!(event["type"], "error", "{event}");
        }
    }
    assert!(completed);
    serving.await.unwrap();
    assert!(
        timeout(Duration::from_millis(100), target.accept())
            .await
            .is_err()
    );
    socket.close(None).await.unwrap();
    router.stop().await.unwrap();
}
