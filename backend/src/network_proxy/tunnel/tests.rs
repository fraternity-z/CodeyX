use super::*;
use tokio::net::TcpListener;

fn tls_configs(name: &str, trusted: bool) -> (Arc<ClientConfig>, Arc<rustls::ServerConfig>) {
    let rcgen::CertifiedKey { cert, signing_key } =
        rcgen::generate_simple_self_signed(vec![name.into()]).unwrap();
    let key = rustls::pki_types::PrivatePkcs8KeyDer::from(signing_key.serialize_der());
    let server = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(vec![cert.der().clone()], key.into())
    .unwrap();
    let mut roots = RootCertStore::empty();
    if trusted {
        roots.add(cert.der().clone()).unwrap();
    }
    let client =
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth();
    (Arc::new(client), Arc::new(server))
}

#[tokio::test]
async fn https_proxy_verifies_trust_and_hostname_before_sending_authenticated_connect() {
    for mode in ["trusted", "untrusted", "wrong-name"] {
        let name = if mode == "wrong-name" {
            "other.invalid"
        } else {
            "127.0.0.1"
        };
        let (client_config, server_config) = tls_configs(name, mode != "untrusted");
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut first = hop(
            "first",
            ProxyProtocol::Https,
            "127.0.0.1",
            listener.local_addr().unwrap().port(),
        );
        first.credential = Some(ProxyCredential {
            username: "fixture-user".into(),
            password: "fixture-pass".into(),
        });
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let accepted = tokio_rustls::TlsAcceptor::from(server_config)
                .accept(stream)
                .await;
            if mode != "trusted" {
                assert!(accepted.is_err());
                return;
            }
            let mut stream = accepted.unwrap();
            let head = read_head(&mut stream).await;
            assert!(head.starts_with("CONNECT target.invalid:443 HTTP/1.1\r\n"));
            assert!(head.contains(&STANDARD.encode("fixture-user:fixture-pass")));
            stream
                .write_all(b"HTTP/1.1 200 OK\r\n\r\nSECURE")
                .await
                .unwrap();
            stream.shutdown().await.unwrap();
        });
        let connector = TunnelConnector {
            tls: Some(client_config),
            connect_timeout: Duration::from_secs(2),
            handshake_timeout: Duration::from_secs(2),
        };
        let result = connector
            .connect(&[first], Destination::new("target.invalid", 443).unwrap())
            .await;
        if mode == "trusted" {
            let mut stream = result.unwrap();
            let mut bytes = Vec::new();
            stream.read_to_end(&mut bytes).await.unwrap();
            assert_eq!(bytes, b"SECURE");
        } else {
            assert_eq!(result.err().unwrap().kind, FailureKind::Tls);
        }
        server.await.unwrap();
    }
}

#[tokio::test]
async fn named_https_hop_carries_authenticated_socks_handshakes_and_opaque_data() {
    let first = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let second = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let third = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let second_port = second.local_addr().unwrap().port();
    let third_port = third.local_addr().unwrap().port();
    let mut path = [
        hop(
            "first",
            ProxyProtocol::Http,
            "127.0.0.1",
            first.local_addr().unwrap().port(),
        ),
        hop(
            "second",
            ProxyProtocol::Https,
            "second.invalid",
            second_port,
        ),
        hop("third", ProxyProtocol::Socks5, "third.invalid", third_port),
    ];
    path[1].credential = Some(ProxyCredential {
        username: "tls-user".into(),
        password: "tls-secret".into(),
    });
    path[2].credential = Some(ProxyCredential {
        username: "socks-user".into(),
        password: "socks-secret".into(),
    });
    let credential = path[2].credential.clone();
    let (client_config, server_config) = tls_configs("second.invalid", true);
    let a = tokio::spawn(async move {
        let (mut down, _) = first.accept().await.unwrap();
        let head = read_head(&mut down).await;
        assert!(head.starts_with(&format!("CONNECT second.invalid:{second_port} HTTP/1.1")));
        assert!(!head.to_lowercase().contains("authorization"));
        let mut up = TcpStream::connect(("127.0.0.1", second_port))
            .await
            .unwrap();
        down.write_all(b"HTTP/1.1 200 OK\r\n\r\n").await.unwrap();
        tokio::io::copy_bidirectional(&mut down, &mut up)
            .await
            .unwrap();
    });
    let b = tokio::spawn(async move {
        let (socket, _) = second.accept().await.unwrap();
        let mut down = tokio_rustls::TlsAcceptor::from(server_config)
            .accept(socket)
            .await
            .unwrap();
        let head = read_head(&mut down).await;
        assert!(head.starts_with(&format!("CONNECT third.invalid:{third_port} HTTP/1.1")));
        assert!(head.contains(&STANDARD.encode("tls-user:tls-secret")));
        let mut up = TcpStream::connect(("127.0.0.1", third_port)).await.unwrap();
        down.write_all(b"HTTP/1.1 200 OK\r\n\r\n").await.unwrap();
        down.flush().await.unwrap();
        tokio::io::copy_bidirectional(&mut down, &mut up)
            .await
            .unwrap();
    });
    let c = tokio::spawn(async move {
        let (mut stream, _) = third.accept().await.unwrap();
        assert_eq!(
            accept_socks(&mut stream, credential.as_ref()).await,
            Destination::new("target.invalid", 443).unwrap()
        );
        stream.write_all(b"OPAQUE").await.unwrap();
        stream.shutdown().await.unwrap();
    });
    let connector = TunnelConnector {
        tls: Some(client_config),
        connect_timeout: Duration::from_secs(2),
        handshake_timeout: Duration::from_secs(2),
    };
    let mut stream = connector
        .connect(&path, Destination::new("target.invalid", 443).unwrap())
        .await
        .unwrap();
    stream.shutdown().await.unwrap();
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).await.unwrap();
    assert_eq!(bytes, b"OPAQUE");
    drop(stream);
    a.await.unwrap();
    b.await.unwrap();
    c.await.unwrap();
}

fn hop(id: &str, protocol: ProxyProtocol, host: &str, port: u16) -> Hop {
    Hop {
        node: ProxyNode {
            id: id.into(),
            name: id.into(),
            endpoint: ProxyEndpoint {
                protocol,
                host: host.into(),
                port,
                dns: DnsMode::Remote,
            },
            credential_ref: None,
            notes: String::new(),
            enabled: true,
            tags: Vec::new(),
            group: String::new(),
        },
        credential: None,
    }
}

async fn read_head<R: AsyncRead + Unpin>(stream: &mut R) -> String {
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        assert!(head.len() < 16 * 1024);
        head.push(stream.read_u8().await.unwrap());
    }
    String::from_utf8(head).unwrap()
}

async fn accept_socks<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    credential: Option<&ProxyCredential>,
) -> Destination {
    let mut greeting = [0; 3];
    stream.read_exact(&mut greeting).await.unwrap();
    let method = if credential.is_some() { 2 } else { 0 };
    assert_eq!(greeting, [5, 1, method]);
    stream.write_all(&[5, method]).await.unwrap();
    if let Some(expected) = credential {
        assert_eq!(stream.read_u8().await.unwrap(), 1);
        let length = stream.read_u8().await.unwrap();
        let mut user = vec![0; usize::from(length)];
        stream.read_exact(&mut user).await.unwrap();
        let length = stream.read_u8().await.unwrap();
        let mut password = vec![0; usize::from(length)];
        stream.read_exact(&mut password).await.unwrap();
        assert_eq!(user, expected.username.as_bytes());
        assert_eq!(password, expected.password.as_bytes());
        stream.write_all(&[1, 0]).await.unwrap();
    }
    let mut head = [0; 4];
    stream.read_exact(&mut head).await.unwrap();
    assert_eq!(&head[..3], &[5, 1, 0]);
    let host = match head[3] {
        1 => {
            let mut bytes = [0; 4];
            stream.read_exact(&mut bytes).await.unwrap();
            std::net::Ipv4Addr::from(bytes).to_string()
        }
        4 => {
            let mut bytes = [0; 16];
            stream.read_exact(&mut bytes).await.unwrap();
            std::net::Ipv6Addr::from(bytes).to_string()
        }
        3 => {
            let length = stream.read_u8().await.unwrap();
            let mut bytes = vec![0; usize::from(length)];
            stream.read_exact(&mut bytes).await.unwrap();
            String::from_utf8(bytes).unwrap()
        }
        _ => panic!("invalid address family"),
    };
    let port = stream.read_u16().await.unwrap();
    stream
        .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0])
        .await
        .unwrap();
    Destination { host, port }
}

#[tokio::test]
async fn socks_remote_dns_and_ipv4_ipv6_preserve_opaque_bytes() {
    for host in ["target.invalid", "203.0.113.5", "2001:db8::5"] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let path = [hop(
            "first",
            ProxyProtocol::Socks5,
            "127.0.0.1",
            listener.local_addr().unwrap().port(),
        )];
        let destination = Destination::new(host, 443).unwrap();
        let expected = destination.clone();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            assert_eq!(accept_socks(&mut stream, None).await, expected);
            let mut bytes = Vec::new();
            stream.read_to_end(&mut bytes).await.unwrap();
            stream.write_all(&bytes).await.unwrap();
        });
        let mut tunnel = TunnelConnector::for_hops(&path)
            .await
            .unwrap()
            .connect(&path, destination)
            .await
            .unwrap();
        let payload = [0x16, 0x03, 0x03, 0x00, 0x05, 0, 255, 128, 42, 33];
        tunnel.write_all(&payload).await.unwrap();
        tunnel.shutdown().await.unwrap();
        let mut received = Vec::new();
        tunnel.read_to_end(&mut received).await.unwrap();
        assert_eq!(received, payload);
        server.await.unwrap();
    }
}

#[tokio::test]
async fn explicit_local_dns_sends_an_ip_and_authenticated_socks_keeps_whitespace() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut first = hop(
        "first",
        ProxyProtocol::Socks5,
        "127.0.0.1",
        listener.local_addr().unwrap().port(),
    );
    first.node.endpoint.dns = DnsMode::Local;
    first.credential = Some(ProxyCredential {
        username: " user ".into(),
        password: " fake-pass ".into(),
    });
    let credential = first.credential.clone();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let destination = accept_socks(&mut stream, credential.as_ref()).await;
        assert!(destination.host.parse::<IpAddr>().unwrap().is_loopback());
    });
    let path = [first];
    TunnelConnector::for_hops(&path)
        .await
        .unwrap()
        .connect(&path, Destination::new("localhost", 443).unwrap())
        .await
        .unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn mixed_three_hop_chain_authenticates_each_node_in_order_and_keeps_buffered_bytes() {
    let first = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let second = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let third = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let second_port = second.local_addr().unwrap().port();
    let third_port = third.local_addr().unwrap().port();
    let mut path = [
        hop(
            "first",
            ProxyProtocol::Http,
            "127.0.0.1",
            first.local_addr().unwrap().port(),
        ),
        hop(
            "second",
            ProxyProtocol::Socks5,
            "second.invalid",
            second_port,
        ),
        hop("third", ProxyProtocol::Http, "third.invalid", third_port),
    ];
    path[0].credential = Some(ProxyCredential {
        username: "first-user".into(),
        password: "first-pass".into(),
    });
    path[1].credential = Some(ProxyCredential {
        username: "second-user".into(),
        password: "second-pass".into(),
    });
    let credential = path[1].credential.clone();
    let a = tokio::spawn(async move {
        let (mut downstream, _) = first.accept().await.unwrap();
        let head = read_head(&mut downstream).await;
        assert!(head.starts_with(&format!(
            "CONNECT second.invalid:{second_port} HTTP/1.1\r\n"
        )));
        assert!(head.contains(&format!(
            "Proxy-Authorization: Basic {}",
            STANDARD.encode("first-user:first-pass")
        )));
        assert!(!head.contains(&STANDARD.encode("second-user:second-pass")));
        let mut upstream = TcpStream::connect(("127.0.0.1", second_port))
            .await
            .unwrap();
        downstream
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .await
            .unwrap();
        tokio::io::copy_bidirectional(&mut downstream, &mut upstream)
            .await
            .unwrap();
    });
    let b = tokio::spawn(async move {
        let (mut downstream, _) = second.accept().await.unwrap();
        assert_eq!(
            accept_socks(&mut downstream, credential.as_ref()).await,
            Destination {
                host: "third.invalid".into(),
                port: third_port
            }
        );
        let mut upstream = TcpStream::connect(("127.0.0.1", third_port)).await.unwrap();
        tokio::io::copy_bidirectional(&mut downstream, &mut upstream)
            .await
            .unwrap();
    });
    let c = tokio::spawn(async move {
        let (mut stream, _) = third.accept().await.unwrap();
        let head = read_head(&mut stream).await;
        assert!(head.starts_with("CONNECT target.invalid:443 HTTP/1.1\r\n"));
        assert!(!head.to_lowercase().contains("authorization"));
        stream
            .write_all(b"HTTP/1.1 200 OK\r\n\r\nREADY")
            .await
            .unwrap();
        let mut buffer = [0; 4096];
        loop {
            let read = stream.read(&mut buffer).await.unwrap();
            if read == 0 {
                break;
            }
            stream.write_all(&buffer[..read]).await.unwrap();
        }
    });
    let mut tunnel = TunnelConnector::for_hops(&path)
        .await
        .unwrap()
        .connect(&path, Destination::new("target.invalid", 443).unwrap())
        .await
        .unwrap();
    let mut greeting = [0; 5];
    tunnel.read_exact(&mut greeting).await.unwrap();
    assert_eq!(&greeting, b"READY");
    let payload = vec![42; 256 * 1024];
    let (mut read, mut write) = tokio::io::split(tunnel);
    let write_task = tokio::spawn(async move {
        write.write_all(&payload).await.unwrap();
        write.shutdown().await.unwrap();
    });
    let mut received = Vec::new();
    read.read_to_end(&mut received).await.unwrap();
    assert_eq!(received, vec![42; 256 * 1024]);
    write_task.await.unwrap();
    a.await.unwrap();
    b.await.unwrap();
    c.await.unwrap();
}

#[tokio::test]
async fn authentication_downgrade_and_http_rejection_stop_without_direct_connection() {
    for protocol in [ProxyProtocol::Socks5, ProxyProtocol::Http] {
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut first = hop(
            "first",
            protocol,
            "127.0.0.1",
            proxy.local_addr().unwrap().port(),
        );
        first.credential = Some(ProxyCredential {
            username: "fixture-user".into(),
            password: "fixture-secret".into(),
        });
        let server = tokio::spawn(async move {
            let (mut stream, _) = proxy.accept().await.unwrap();
            if protocol == ProxyProtocol::Socks5 {
                let mut greeting = [0; 3];
                stream.read_exact(&mut greeting).await.unwrap();
                stream.write_all(&[5, 0]).await.unwrap();
            } else {
                read_head(&mut stream).await;
                stream
                    .write_all(b"HTTP/1.1 407 fixture-secret\r\n\r\nfixture-secret")
                    .await
                    .unwrap();
            }
        });
        let path = [first];
        let error = TunnelConnector::for_hops(&path)
            .await
            .unwrap()
            .connect(
                &path,
                Destination::new("127.0.0.1", target.local_addr().unwrap().port()).unwrap(),
            )
            .await
            .err()
            .unwrap();
        assert_eq!(error.kind, FailureKind::Authentication);
        assert!(!format!("{error:?} {error}").contains("fixture-secret"));
        assert!(
            timeout(Duration::from_millis(50), target.accept())
                .await
                .is_err()
        );
        server.await.unwrap();
    }
}

#[tokio::test]
async fn stalled_or_malformed_handshakes_are_bounded() {
    for stalled in [false, true] {
        let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let path = [hop(
            "first",
            ProxyProtocol::Http,
            "127.0.0.1",
            proxy.local_addr().unwrap().port(),
        )];
        let server = tokio::spawn(async move {
            let (mut stream, _) = proxy.accept().await.unwrap();
            read_head(&mut stream).await;
            if stalled {
                tokio::time::sleep(Duration::from_secs(10)).await;
            } else {
                let _ = stream.write_all(&vec![b'x'; 17 * 1024]).await;
            }
        });
        let mut connector = TunnelConnector::for_hops(&path).await.unwrap();
        connector.handshake_timeout = Duration::from_millis(100);
        let error = connector
            .connect(&path, Destination::new("target.invalid", 443).unwrap())
            .await
            .err()
            .unwrap();
        assert_eq!(
            error.kind,
            if stalled {
                FailureKind::Timeout
            } else {
                FailureKind::Protocol
            }
        );
        server.abort();
    }
}

#[tokio::test]
async fn invalid_or_disabled_later_hop_fails_before_connecting_first_hop() {
    let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut path = [
        hop(
            "first",
            ProxyProtocol::Socks5,
            "127.0.0.1",
            proxy.local_addr().unwrap().port(),
        ),
        hop("second", ProxyProtocol::Socks5, "second.invalid", 1080),
    ];
    path[1].node.enabled = false;
    let connector = TunnelConnector::for_hops(&path).await.unwrap();
    assert_eq!(
        connector
            .connect(&path, Destination::new("target.invalid", 443).unwrap())
            .await
            .err()
            .unwrap(),
        TunnelError {
            hop: 1,
            kind: FailureKind::Configuration
        }
    );
    assert!(
        timeout(Duration::from_millis(50), proxy.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn https_proxy_never_sends_connect_or_credentials_before_tls_is_established() {
    let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let path = [hop(
        "first",
        ProxyProtocol::Https,
        "127.0.0.1",
        proxy.local_addr().unwrap().port(),
    )];
    let server = tokio::spawn(async move {
        let (mut stream, _) = proxy.accept().await.unwrap();
        let mut bytes = [0; 2048];
        let read = stream.read(&mut bytes).await.unwrap();
        assert_eq!(bytes[0], 0x16);
        assert!(!String::from_utf8_lossy(&bytes[..read]).contains("CONNECT"));
        stream.write_all(b"HTTP/1.1 200 OK\r\n\r\n").await.unwrap();
    });
    let tls =
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(RootCertStore::empty())
            .with_no_client_auth();
    let connector = TunnelConnector {
        tls: Some(Arc::new(tls)),
        connect_timeout: Duration::from_secs(1),
        handshake_timeout: Duration::from_secs(1),
    };
    let error = connector
        .connect(&path, Destination::new("target.invalid", 443).unwrap())
        .await
        .err()
        .unwrap();
    assert_eq!(error.kind, FailureKind::Tls);
    server.await.unwrap();
}
