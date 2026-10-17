//! Per-lease loopback SOCKS ingress for Codey-owned HTTP clients. The random
//! credential is kept in memory; no system proxy, route or firewall is changed.
use std::{
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::Duration,
};

use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Semaphore,
    task::{JoinHandle, JoinSet},
    time::timeout,
};

use super::{
    forwarding::Forwarder,
    tunnel::{Destination, Hop, Tunnel, TunnelError},
};

pub(crate) struct Gateway {
    address: SocketAddr,
    password: String,
    task: JoinHandle<()>,
    last_error: Arc<Mutex<Option<TunnelError>>>,
    forwarder: Arc<Forwarder>,
}

impl Gateway {
    pub(crate) async fn start(hops: Vec<Hop>) -> Result<Self, String> {
        Self::start_forwarder(Forwarder::fixed(hops).await?).await
    }

    pub(super) async fn start_forwarder(forwarder: Forwarder) -> Result<Self, String> {
        let forwarder = Arc::new(forwarder);
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|_| "无法启动本地代理入口，请检查端口权限")?;
        let address = listener
            .local_addr()
            .map_err(|_| "无法读取本地代理入口地址")?;
        let password = uuid::Uuid::new_v4().simple().to_string();
        let secret = password.clone();
        let serving = forwarder.clone();
        let last_error = Arc::new(Mutex::new(None));
        let errors = last_error.clone();
        let task = tokio::spawn(async move {
            let limit = Arc::new(Semaphore::new(64));
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((socket, peer)) = accepted else { break; };
                        if !peer.ip().is_loopback() { continue; }
                        let Ok(permit) = limit.clone().try_acquire_owned() else { continue; };
                        let forwarder = serving.clone(); let secret = secret.clone(); let errors = errors.clone();
                        connections.spawn(async move {
                            let _permit = permit;
                            serve(socket, &secret, &forwarder, errors).await;
                        });
                    }
                    _ = connections.join_next(), if !connections.is_empty() => {}
                }
            }
            // Dropping this JoinSet, including when the owner aborts us, closes every stream.
        });
        Ok(Self {
            address,
            password,
            task,
            last_error,
            forwarder,
        })
    }

    pub(crate) async fn connect(&self, destination: Destination) -> Result<Tunnel, TunnelError> {
        self.forwarder.connect(destination).await
    }

    pub(crate) fn proxy_url(&self) -> String {
        format!("socks5h://codeyx:{}@{}", self.password, self.address)
    }

    pub(crate) fn last_error(&self) -> Option<TunnelError> {
        self.last_error
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn serve(
    mut downstream: TcpStream,
    password: &str,
    forwarder: &Forwarder,
    errors: Arc<Mutex<Option<TunnelError>>>,
) {
    let destination = match timeout(
        Duration::from_secs(10),
        read_request(&mut downstream, password),
    )
    .await
    {
        Ok(Ok(destination)) => destination,
        _ => return,
    };
    let mut upstream = match forwarder.connect(destination).await {
        Ok(stream) => stream,
        Err(error) => {
            *errors
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(error);
            let _ = downstream.write_all(&[5, 1, 0, 1, 0, 0, 0, 0, 0, 0]).await;
            return;
        }
    };
    if downstream
        .write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
        .await
        .is_err()
    {
        return;
    }
    // Bidirectional copy provides bounded buffers, backpressure and TCP half-close.
    // The caller controls request/idle timeouts; long-lived streams are not cut off here.
    let _ = tokio::io::copy_bidirectional(&mut downstream, &mut upstream).await;
}

async fn read_request(stream: &mut TcpStream, password: &str) -> Result<Destination, ()> {
    let mut header = [0; 2];
    stream.read_exact(&mut header).await.map_err(|_| ())?;
    if header[0] != 5 || header[1] == 0 {
        return Err(());
    }
    let mut methods = vec![0; usize::from(header[1])];
    stream.read_exact(&mut methods).await.map_err(|_| ())?;
    if !methods.contains(&2) {
        let _ = stream.write_all(&[5, 255]).await;
        return Err(());
    }
    stream.write_all(&[5, 2]).await.map_err(|_| ())?;
    if stream.read_u8().await.map_err(|_| ())? != 1 {
        return Err(());
    }
    let user = read_octets(stream).await?;
    let supplied = read_octets(stream).await?;
    if user != b"codeyx" || !constant_time_equal(&supplied, password.as_bytes()) {
        let _ = stream.write_all(&[1, 1]).await;
        return Err(());
    }
    stream.write_all(&[1, 0]).await.map_err(|_| ())?;
    let mut request = [0; 4];
    stream.read_exact(&mut request).await.map_err(|_| ())?;
    if request[0] != 5 || request[1] != 1 || request[2] != 0 {
        let _ = stream.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await;
        return Err(());
    }
    let host = match request[3] {
        1 => {
            let mut ip = [0; 4];
            stream.read_exact(&mut ip).await.map_err(|_| ())?;
            std::net::Ipv4Addr::from(ip).to_string()
        }
        4 => {
            let mut ip = [0; 16];
            stream.read_exact(&mut ip).await.map_err(|_| ())?;
            std::net::Ipv6Addr::from(ip).to_string()
        }
        3 => String::from_utf8(read_octets(stream).await?).map_err(|_| ())?,
        _ => return Err(()),
    };
    let port = stream.read_u16().await.map_err(|_| ())?;
    Destination::new(&host, port).map_err(|_| ())
}

async fn read_octets(stream: &mut TcpStream) -> Result<Vec<u8>, ()> {
    let length = stream.read_u8().await.map_err(|_| ())?;
    if length == 0 {
        return Err(());
    }
    let mut bytes = vec![0; usize::from(length)];
    stream.read_exact(&mut bytes).await.map_err(|_| ())?;
    Ok(bytes)
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network_proxy::{
        model::{DnsMode, ProxyEndpoint, ProxyNode, ProxyProtocol},
        tunnel::FailureKind,
    };

    async fn start() -> (Gateway, TcpListener) {
        let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let node = ProxyNode {
            id: "node".into(),
            name: "node".into(),
            enabled: true,
            credential_ref: None,
            notes: String::new(),
            tags: Vec::new(),
            group: String::new(),
            endpoint: ProxyEndpoint {
                protocol: ProxyProtocol::Http,
                host: "127.0.0.1".into(),
                port: proxy.local_addr().unwrap().port(),
                dns: DnsMode::Remote,
            },
        };
        (
            Gateway::start(vec![Hop {
                node,
                credential: None,
            }])
            .await
            .unwrap(),
            proxy,
        )
    }

    #[tokio::test]
    async fn loopback_gateway_requires_its_private_credential_before_touching_upstream() {
        let (gateway, proxy) = start().await;
        assert!(gateway.address.ip().is_loopback());
        let mut socket = TcpStream::connect(gateway.address).await.unwrap();
        socket.write_all(&[5, 1, 0]).await.unwrap();
        let mut reply = [0; 2];
        socket.read_exact(&mut reply).await.unwrap();
        assert_eq!(reply, [5, 255]);
        let wrong = gateway
            .proxy_url()
            .replace(&gateway.password, "wrong-password");
        let client = reqwest::Client::builder()
            .no_proxy()
            .proxy(reqwest::Proxy::all(wrong).unwrap())
            .timeout(Duration::from_secs(1))
            .build()
            .unwrap();
        assert!(client.get("http://target.invalid/").send().await.is_err());
        assert!(
            timeout(Duration::from_millis(50), proxy.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn lease_drop_closes_listener_and_active_tunnels() {
        let (gateway, proxy) = start().await;
        let address = gateway.address;
        let client = reqwest::Client::builder()
            .no_proxy()
            .proxy(reqwest::Proxy::all(gateway.proxy_url()).unwrap())
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        let request =
            tokio::spawn(async move { client.get("http://target.invalid/").send().await });
        let (mut upstream, _) = timeout(Duration::from_secs(1), proxy.accept())
            .await
            .unwrap()
            .unwrap();
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            head.push(upstream.read_u8().await.unwrap());
        }
        upstream
            .write_all(b"HTTP/1.1 200 OK\r\n\r\n")
            .await
            .unwrap();
        let mut received = [0; 4096];
        assert!(upstream.read(&mut received).await.unwrap() > 0);
        drop(gateway);
        assert_eq!(
            timeout(Duration::from_secs(1), upstream.read(&mut received))
                .await
                .unwrap()
                .unwrap(),
            0
        );
        assert!(request.await.unwrap().is_err());
        assert!(TcpStream::connect(address).await.is_err());
    }

    #[tokio::test]
    async fn unavailable_proxy_records_failure_without_contacting_target() {
        let (gateway, proxy) = start().await;
        drop(proxy);
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = reqwest::Client::builder()
            .no_proxy()
            .proxy(reqwest::Proxy::all(gateway.proxy_url()).unwrap())
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        assert!(
            client
                .get(format!("http://{}/", target.local_addr().unwrap()))
                .send()
                .await
                .is_err()
        );
        assert_eq!(gateway.last_error().unwrap().kind, FailureKind::Connect);
        assert!(
            timeout(Duration::from_millis(50), target.accept())
                .await
                .is_err()
        );
    }
}
