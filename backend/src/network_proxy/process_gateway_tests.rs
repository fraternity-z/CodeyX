use super::*;
use crate::network_proxy::model::{
    DnsMode, NetworkProxyConfig, ProxyEndpoint, ProxyNode, ProxyProtocol,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn fixture() -> (
    ProcessGateway,
    Arc<EgressPool>,
    NetworkProxyConfig,
    TcpListener,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let policy = NetworkProxyConfig {
        nodes: vec![ProxyNode {
            id: "exit".into(),
            name: "Exit".into(),
            enabled: true,
            credential_ref: None,
            notes: String::new(),
            tags: Vec::new(),
            group: String::new(),
            endpoint: ProxyEndpoint {
                protocol: ProxyProtocol::Http,
                host: "127.0.0.1".into(),
                port: listener.local_addr().unwrap().port(),
                dns: DnsMode::Remote,
            },
        }],
        ..Default::default()
    };
    let temp = tempfile::tempdir().unwrap();
    let service = Arc::new(EgressPool::for_config(
        &temp.path().join("config.json"),
        policy.clone(),
    ));
    let gateway =
        ProcessGateway::start(service.clone(), ProxySelection::Node { id: "exit".into() })
            .await
            .unwrap();
    (gateway, service, policy, listener)
}

fn address(gateway: &ProcessGateway) -> std::net::SocketAddr {
    format!("{}:{}", gateway.auth.host, gateway.auth.port)
        .parse()
        .unwrap()
}

fn authentication(gateway: &ProcessGateway) -> String {
    format!(
        "Basic {}",
        STANDARD.encode(format!(
            "{}:{}",
            gateway.auth.username, gateway.auth.password
        ))
    )
}

async fn head(stream: &mut TcpStream) -> String {
    timeout(Duration::from_secs(3), async {
        let mut bytes = Vec::new();
        while !bytes.ends_with(b"\r\n\r\n") {
            assert!(bytes.len() < 16384);
            bytes.push(stream.read_u8().await.unwrap());
        }
        String::from_utf8(bytes).unwrap()
    })
    .await
    .unwrap()
}

async fn origin(listener: TcpListener, port: u16) -> TcpStream {
    let (mut stream, _) = timeout(Duration::from_secs(3), listener.accept())
        .await
        .unwrap()
        .unwrap();
    assert!(
        head(&mut stream)
            .await
            .starts_with(&format!("CONNECT target.invalid:{port} HTTP/1.1"))
    );
    stream
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await
        .unwrap();
    stream
}

fn client(gateway: &ProcessGateway) -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .proxy(reqwest::Proxy::all(gateway.proxy_url()).unwrap())
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap()
}

#[tokio::test]
async fn private_authentication_and_target_validation_run_before_upstream_io() {
    let (gateway, _, _, listener) = fixture().await;
    assert!(address(&gateway).ip().is_loopback());
    assert!(!format!("{:?}", gateway.auth()).contains(&gateway.auth.password));
    for authorization in [
        String::new(),
        "Proxy-Authorization: Basic d3Jvbmc=\r\n".into(),
        format!(
            "Proxy-Authorization: {}\r\nProxy-Authorization: {}\r\n",
            authentication(&gateway),
            authentication(&gateway)
        ),
    ] {
        let mut socket = TcpStream::connect(address(&gateway)).await.unwrap();
        socket.write_all(format!("GET http://target.invalid/ HTTP/1.1\r\nHost: target.invalid\r\n{authorization}\r\n").as_bytes()).await.unwrap();
        let response = head(&mut socket).await;
        assert!(response.starts_with("HTTP/1.1 407"));
        assert!(response.contains(&gateway.auth.realm));
        assert!(!response.contains(&gateway.auth.password));
    }
    for (method, target) in [
        ("GET", "/relative"),
        ("GET", "ftp://target.invalid/file"),
        ("GET", "http://user:password@target.invalid/"),
        ("CONNECT", "target.invalid:0"),
    ] {
        let mut socket = TcpStream::connect(address(&gateway)).await.unwrap();
        socket.write_all(format!("{method} {target} HTTP/1.1\r\nHost: target.invalid\r\nProxy-Authorization: {}\r\n\r\n", authentication(&gateway)).as_bytes()).await.unwrap();
        assert!(head(&mut socket).await.starts_with("HTTP/1.1 400"));
    }
    assert!(
        timeout(Duration::from_millis(50), listener.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn http_bodies_stream_through_selected_exit_without_forwarding_proxy_credentials() {
    let (gateway, _, _, listener) = fixture().await;
    let serving = tokio::spawn(async move {
        let stream = origin(listener, 80).await;
        let service = service_fn(|request: Request<Incoming>| async move {
            assert_eq!(request.uri().to_string(), "/upload?cursor=a%2Fb");
            assert_eq!(request.headers()["host"], "target.invalid");
            assert_eq!(
                request.headers()["authorization"],
                "Bearer fixture-origin-token"
            );
            assert!(!request.headers().contains_key("proxy-authorization"));
            assert!(!request.headers().contains_key("proxy-connection"));
            assert!(!request.headers().contains_key("x-remove"));
            assert_eq!(
                request.into_body().collect().await.unwrap().to_bytes(),
                "firstsecond"
            );
            let chunks = futures_util::stream::iter([
                Ok::<_, Infallible>(Frame::data(Bytes::from_static(b"part-one"))),
                Ok(Frame::data(Bytes::from_static(b"part-two"))),
            ]);
            Ok::<_, Infallible>(Response::new(http_body_util::StreamBody::new(chunks)))
        });
        let _ = http1::Builder::new()
            .keep_alive(false)
            .serve_connection(TokioIo::new(stream), service)
            .await;
    });
    let body = reqwest::Body::wrap_stream(futures_util::stream::iter([
        Ok::<_, std::io::Error>(Bytes::from_static(b"first")),
        Ok(Bytes::from_static(b"second")),
    ]));
    let response = client(&gateway)
        .post("http://target.invalid/upload?cursor=a%2Fb")
        .header("authorization", "Bearer fixture-origin-token")
        .header("connection", "x-remove")
        .header("x-remove", "hop-local")
        .header("proxy-connection", "keep-alive")
        .body(body)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.text().await.unwrap(), "part-onepart-two");
    serving.await.unwrap();
}

#[tokio::test]
async fn response_stream_arrives_before_the_origin_finishes_and_keeps_its_original_exit() {
    let (gateway, egress, mut policy, listener) = fixture().await;
    let (release, wait) = oneshot::channel();
    let serving = tokio::spawn(async move {
        let mut stream = origin(listener, 80).await;
        assert!(head(&mut stream).await.starts_with("GET /stream HTTP/1.1"));
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\none")
            .await
            .unwrap();
        wait.await.unwrap();
        stream.write_all(b"two").await.unwrap();
    });
    let mut response = client(&gateway)
        .get("http://target.invalid/stream")
        .send()
        .await
        .unwrap();
    assert_eq!(
        &timeout(Duration::from_secs(3), response.chunk())
            .await
            .unwrap()
            .unwrap()
            .unwrap()[..],
        b"one"
    );
    policy.nodes[0].enabled = false;
    egress.configure(policy);
    release.send(()).unwrap();
    assert_eq!(response.text().await.unwrap(), "two");
    serving.await.unwrap();
    assert_eq!(
        client(&gateway)
            .get("http://target.invalid/next")
            .send()
            .await
            .unwrap()
            .status(),
        502
    );
}

#[tokio::test]
async fn separate_process_gateways_do_not_accept_each_others_credentials_and_stop_is_idempotent() {
    let (first, egress, _, _listener) = fixture().await;
    let second = ProcessGateway::start(egress, ProxySelection::Node { id: "exit".into() })
        .await
        .unwrap();
    assert_ne!(address(&first), address(&second));
    assert_ne!(first.auth.password, second.auth.password);
    let mut socket = TcpStream::connect(address(&second)).await.unwrap();
    socket.write_all(format!("CONNECT target.invalid:443 HTTP/1.1\r\nHost: target.invalid\r\nProxy-Authorization: {}\r\n\r\n", authentication(&first)).as_bytes()).await.unwrap();
    assert!(head(&mut socket).await.starts_with("HTTP/1.1 407"));
    let first_address = address(&first);
    first.stop().await;
    first.stop().await;
    assert!(TcpStream::connect(first_address).await.is_err());
    assert!(TcpStream::connect(address(&second)).await.is_ok());
}

#[tokio::test]
async fn connect_is_opaque_and_preserves_half_close() {
    let (gateway, _, _, listener) = fixture().await;
    let serving = tokio::spawn(async move {
        let mut stream = origin(listener, 443).await;
        let mut body = Vec::new();
        stream.read_to_end(&mut body).await.unwrap();
        assert_eq!(body, b"opaque TLS bytes");
        stream.write_all(b"reply after half-close").await.unwrap();
        stream.shutdown().await.unwrap();
    });
    let mut socket = TcpStream::connect(address(&gateway)).await.unwrap();
    socket.write_all(format!("CONNECT target.invalid:443 HTTP/1.1\r\nHost: target.invalid:443\r\nProxy-Authorization: {}\r\n\r\n", authentication(&gateway)).as_bytes()).await.unwrap();
    assert!(head(&mut socket).await.starts_with("HTTP/1.1 200"));
    socket.write_all(b"opaque TLS bytes").await.unwrap();
    socket.shutdown().await.unwrap();
    let mut response = Vec::new();
    timeout(Duration::from_secs(3), socket.read_to_end(&mut response))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response, b"reply after half-close");
    serving.await.unwrap();
}

#[tokio::test]
async fn websocket_upgrade_preserves_duplex_bytes_and_gateway_drop_closes_it() {
    let (gateway, _, _, listener) = fixture().await;
    let serving = tokio::spawn(async move {
        let mut stream = origin(listener, 80).await;
        let request = head(&mut stream).await;
        assert!(request.starts_with("GET /socket HTTP/1.1"));
        assert!(!request.to_ascii_lowercase().contains("proxy-authorization"));
        stream.write_all(b"HTTP/1.1 101 Switching Protocols\r\nConnection: upgrade\r\nUpgrade: websocket\r\n\r\n").await.unwrap();
        let mut bytes = [0; 4];
        stream.read_exact(&mut bytes).await.unwrap();
        assert_eq!(bytes, *b"ping");
        stream.write_all(b"pong").await.unwrap();
        assert_eq!(
            timeout(Duration::from_secs(3), stream.read(&mut bytes))
                .await
                .unwrap()
                .unwrap(),
            0
        );
    });
    let mut socket = TcpStream::connect(address(&gateway)).await.unwrap();
    socket.write_all(format!("GET http://target.invalid/socket HTTP/1.1\r\nHost: target.invalid\r\nConnection: upgrade\r\nUpgrade: websocket\r\nProxy-Authorization: {}\r\n\r\n", authentication(&gateway)).as_bytes()).await.unwrap();
    assert!(head(&mut socket).await.starts_with("HTTP/1.1 101"));
    socket.write_all(b"ping").await.unwrap();
    let mut bytes = [0; 4];
    timeout(Duration::from_secs(3), socket.read_exact(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(bytes, *b"pong");
    let bound = address(&gateway);
    drop(gateway);
    assert_eq!(
        timeout(Duration::from_secs(3), socket.read(&mut bytes))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    serving.await.unwrap();
    assert!(TcpStream::connect(bound).await.is_err());
}

#[tokio::test]
async fn disabled_or_unavailable_exit_blocks_new_requests_without_direct_fallback() {
    let (gateway, egress, mut policy, listener) = fixture().await;
    let client = client(&gateway);
    policy.nodes[0].enabled = false;
    egress.configure(policy.clone());
    assert_eq!(
        client
            .get("http://target.invalid/")
            .send()
            .await
            .unwrap()
            .status(),
        502
    );
    assert!(
        timeout(Duration::from_millis(50), listener.accept())
            .await
            .is_err()
    );
    policy.nodes[0].enabled = true;
    egress.configure(policy);
    drop(listener);
    let direct = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let response = client
        .get(format!("http://{}/", direct.local_addr().unwrap()))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 502);
    assert!(
        timeout(Duration::from_millis(50), direct.accept())
            .await
            .is_err()
    );
}
