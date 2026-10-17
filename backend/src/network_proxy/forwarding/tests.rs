use super::*;
use crate::network_proxy::{gateway::Gateway, secrets::ProxyCredential};
use serde_json::json;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

struct NoSecrets;
impl SecretStore for NoSecrets {
    fn read(&self, _: &str, _: &str) -> Result<ProxyCredential, String> {
        panic!("unexpected vault read")
    }
    fn write(&self, _: &str, _: &str, _: &ProxyCredential) -> Result<(), String> {
        panic!("unexpected vault write")
    }
    fn remove(&self, _: &str, _: &str) -> Result<(), String> {
        panic!("unexpected vault delete")
    }
}
fn policy(ports: &[u16], mode: &str, allow: bool) -> NetworkProxyConfig {
    serde_json::from_value(json!({"nodes":ports.iter().enumerate().map(|(index,port)|json!({
        "id":format!("n{index}"),"name":"Fixture","enabled":true,"endpoint":{"protocol":"http","host":"127.0.0.1","port":port}
    })).collect::<Vec<_>>(),"policies":[{"id":"work","name":"Work","enabled":true,"allowDirect":allow,
        "defaultAction":{"kind":"proxy","targets":(0..ports.len()).map(|index|json!({"kind":"node","id":format!("n{index}")})).collect::<Vec<_>>(),"onFailure":mode}}]})).unwrap()
}
async fn head(stream: &mut TcpStream) -> String {
    let mut bytes = vec![];
    while !bytes.ends_with(b"\r\n\r\n") {
        bytes.push(stream.read_u8().await.unwrap());
        assert!(bytes.len() < 16384);
    }
    String::from_utf8(bytes).unwrap()
}
async fn closed_port() -> u16 {
    let socket = TcpListener::bind("127.0.0.1:0").await.unwrap();
    socket.local_addr().unwrap().port()
}

#[tokio::test]
async fn explicit_switch_uses_ordered_second_exit_before_forwarding_any_application_bytes() {
    let first = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let second = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let pool = policy(
        &[
            first.local_addr().unwrap().port(),
            second.local_addr().unwrap().port(),
        ],
        "next",
        false,
    );
    let forwarder = Forwarder::policy(pool, "work", Arc::new(NoSecrets)).unwrap();
    let server = tokio::spawn(async move {
        let (mut rejected, _) = first.accept().await.unwrap();
        assert!(
            head(&mut rejected)
                .await
                .starts_with("CONNECT target.invalid:443 HTTP/1.1")
        );
        rejected
            .write_all(b"HTTP/1.1 503 Unavailable\r\n\r\n")
            .await
            .unwrap();
        let mut byte = [0; 1];
        assert_eq!(rejected.read(&mut byte).await.unwrap(), 0);
        let (mut accepted, _) = second.accept().await.unwrap();
        assert!(
            head(&mut accepted)
                .await
                .starts_with("CONNECT target.invalid:443 HTTP/1.1")
        );
        accepted
            .write_all(b"HTTP/1.1 200 OK\r\n\r\n")
            .await
            .unwrap();
        let mut message = [0; 4];
        accepted.read_exact(&mut message).await.unwrap();
        assert_eq!(&message, b"POST");
        accepted.write_all(b"done").await.unwrap();
    });
    let mut tunnel = forwarder
        .connect(Destination::new("target.invalid", 443).unwrap())
        .await
        .unwrap();
    tunnel.write_all(b"POST").await.unwrap();
    let mut reply = [0; 4];
    tunnel.read_exact(&mut reply).await.unwrap();
    assert_eq!(&reply, b"done");
    server.await.unwrap();
}

#[tokio::test]
async fn authentication_and_configuration_failures_never_allow_switch_or_direct() {
    let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let next = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let pool = policy(
        &[
            proxy.local_addr().unwrap().port(),
            next.local_addr().unwrap().port(),
        ],
        "direct",
        true,
    );
    let forwarder = Forwarder::policy(pool.clone(), "work", Arc::new(NoSecrets)).unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = proxy.accept().await.unwrap();
        head(&mut stream).await;
        stream
            .write_all(b"HTTP/1.1 407 Auth required\r\n\r\n")
            .await
            .unwrap();
    });
    let destination = Destination::new("127.0.0.1", target.local_addr().unwrap().port()).unwrap();
    let error = forwarder.connect(destination.clone()).await.err().unwrap();
    assert_eq!(error.kind, FailureKind::Authentication);
    server.await.unwrap();
    let mut disabled = pool;
    disabled.nodes[0].enabled = false;
    let forwarder = Forwarder::policy(disabled, "work", Arc::new(NoSecrets)).unwrap();
    assert_eq!(
        forwarder.connect(destination).await.err().unwrap().kind,
        FailureKind::Configuration
    );
    assert!(
        timeout(Duration::from_millis(50), target.accept())
            .await
            .is_err()
    );
    assert!(
        timeout(Duration::from_millis(50), next.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn tls_failure_does_not_downgrade_to_another_exit_or_direct() {
    let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let next = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut pool = policy(
        &[
            proxy.local_addr().unwrap().port(),
            next.local_addr().unwrap().port(),
        ],
        "direct",
        true,
    );
    pool.nodes[0].endpoint.protocol = crate::network_proxy::model::ProxyProtocol::Https;
    let forwarder = Forwarder::policy(pool, "work", Arc::new(NoSecrets)).unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = proxy.accept().await.unwrap();
        let mut record = [0; 5];
        stream.read_exact(&mut record).await.unwrap();
        assert_eq!(record[0], 22); // A TLS handshake, never cleartext CONNECT.
        stream.write_all(b"not-tls").await.unwrap();
    });
    let destination = Destination::new("127.0.0.1", target.local_addr().unwrap().port()).unwrap();
    assert_eq!(
        forwarder.connect(destination).await.err().unwrap().kind,
        FailureKind::Tls
    );
    server.await.unwrap();
    assert!(
        timeout(Duration::from_millis(50), next.accept())
            .await
            .is_err()
    );
    assert!(
        timeout(Duration::from_millis(50), target.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn only_explicit_direct_policy_can_reach_target_after_proxy_failure() {
    let port = closed_port().await;
    let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let destination = Destination::new("127.0.0.1", target.local_addr().unwrap().port()).unwrap();
    for mode in ["stop", "next"] {
        let forwarder =
            Forwarder::policy(policy(&[port], mode, false), "work", Arc::new(NoSecrets)).unwrap();
        assert_eq!(
            forwarder
                .connect(destination.clone())
                .await
                .err()
                .unwrap()
                .kind,
            FailureKind::Connect
        );
        assert!(
            timeout(Duration::from_millis(30), target.accept())
                .await
                .is_err()
        );
    }
    assert!(
        Forwarder::policy(
            policy(&[port], "direct", false),
            "work",
            Arc::new(NoSecrets)
        )
        .is_err()
    );
    let forwarder =
        Forwarder::policy(policy(&[port], "direct", true), "work", Arc::new(NoSecrets)).unwrap();
    let mut tunnel = forwarder.connect(destination).await.unwrap();
    tunnel.write_all(b"authorized").await.unwrap();
    let (mut stream, _) = target.accept().await.unwrap();
    let mut payload = [0; 10];
    stream.read_exact(&mut payload).await.unwrap();
    assert_eq!(&payload, b"authorized");
}

#[tokio::test]
async fn socks_ingress_applies_block_rules_before_network_and_does_not_replay_broken_stream() {
    let first = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let next = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut pool = policy(
        &[
            first.local_addr().unwrap().port(),
            next.local_addr().unwrap().port(),
        ],
        "next",
        false,
    );
    pool.policies[0].rules = serde_json::from_value(json!([{"id":"blocked","enabled":true,"host":{"kind":"suffix","value":"blocked.invalid"},"action":{"kind":"block"}}])).unwrap();
    let gateway =
        Gateway::start_forwarder(Forwarder::policy(pool, "work", Arc::new(NoSecrets)).unwrap())
            .await
            .unwrap();
    let client = reqwest::Client::builder()
        .no_proxy()
        .proxy(reqwest::Proxy::all(gateway.proxy_url()).unwrap())
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap();
    assert!(client.get("http://blocked.invalid/").send().await.is_err());
    assert_eq!(gateway.last_error().unwrap().kind, FailureKind::Blocked);
    assert!(
        timeout(Duration::from_millis(30), first.accept())
            .await
            .is_err()
    );
    let serving = tokio::spawn(async move {
        let (mut stream, _) = first.accept().await.unwrap();
        head(&mut stream).await;
        stream.write_all(b"HTTP/1.1 200 OK\r\n\r\n").await.unwrap();
        assert!(head(&mut stream).await.starts_with("POST /submit"));
        let mut bytes = [0; 7];
        stream.read_exact(&mut bytes).await.unwrap();
        assert_eq!(&bytes, b"payload");
    });
    assert!(
        client
            .post("http://target.invalid/submit")
            .body("payload")
            .send()
            .await
            .is_err()
    );
    serving.await.unwrap();
    assert!(
        timeout(Duration::from_millis(50), next.accept())
            .await
            .is_err()
    );
}
