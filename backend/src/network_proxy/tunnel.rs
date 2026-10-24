//! Ordered, opaque TCP tunnels. No target TLS termination or direct fallback.
use std::{fmt, net::IpAddr, sync::Arc, time::Duration};

use base64::{Engine, engine::general_purpose::STANDARD};
use rustls::{ClientConfig, RootCertStore, pki_types::ServerName};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::{TcpStream, lookup_host};
use tokio::time::timeout;

use super::model::{DnsMode, MAX_CHAIN_HOPS, ProxyEndpoint, ProxyNode, ProxyProtocol};
use super::secrets::ProxyCredential;

pub(crate) trait TunnelIo: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> TunnelIo for T {}
pub(crate) type Tunnel = Box<dyn TunnelIo>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Destination {
    pub host: String,
    pub port: u16,
}

impl Destination {
    pub(crate) fn new(host: &str, port: u16) -> Result<Self, String> {
        let endpoint = ProxyEndpoint {
            protocol: ProxyProtocol::Http,
            host: host.into(),
            port,
            dns: DnsMode::Remote,
        };
        let url = endpoint.url()?;
        Ok(Self {
            host: url
                .host_str()
                .unwrap()
                .trim_start_matches('[')
                .trim_end_matches(']')
                .to_string(),
            port,
        })
    }

    fn authority(&self) -> String {
        if self.host.contains(':') {
            format!("[{}]:{}", self.host, self.port)
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Hop {
    pub node: ProxyNode,
    pub credential: Option<ProxyCredential>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FailureKind {
    Configuration,
    Connect,
    Timeout,
    Dns,
    Authentication,
    Tls,
    Protocol,
    Rejected,
    Io,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TunnelError {
    pub hop: usize,
    pub kind: FailureKind,
}

impl fmt::Display for TunnelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let reason = match self.kind {
            FailureKind::Configuration => "节点配置或凭据不可用",
            FailureKind::Connect => "无法连接代理节点",
            FailureKind::Timeout => "连接或握手超时",
            FailureKind::Dns => "本机域名解析失败",
            FailureKind::Authentication => "代理认证失败或认证方式不受支持",
            FailureKind::Tls => "HTTPS 代理证书校验或 TLS 握手失败",
            FailureKind::Protocol => "代理返回的协议数据无效",
            FailureKind::Rejected => "代理拒绝建立目标连接",
            FailureKind::Io => "连接在握手完成前中断",
        };
        write!(f, "代理链路第 {} 跳：{reason}；连接已停止", self.hop + 1)
    }
}
impl std::error::Error for TunnelError {}

pub(crate) struct TunnelConnector {
    tls: Option<Arc<ClientConfig>>,
    connect_timeout: Duration,
    handshake_timeout: Duration,
}

impl TunnelConnector {
    pub(crate) async fn for_hops(hops: &[Hop]) -> Result<Self, String> {
        let tls = if hops
            .iter()
            .any(|hop| hop.node.endpoint.protocol == ProxyProtocol::Https)
        {
            Some(
                tokio::task::spawn_blocking(native_tls_config)
                    .await
                    .map_err(|_| "读取系统证书的任务异常退出")??,
            )
        } else {
            None
        };
        Ok(Self {
            tls,
            connect_timeout: Duration::from_secs(5),
            handshake_timeout: Duration::from_secs(5),
        })
    }

    pub(crate) async fn connect(
        &self,
        hops: &[Hop],
        destination: Destination,
    ) -> Result<Tunnel, TunnelError> {
        let error = |hop, kind| TunnelError { hop, kind };
        if hops.is_empty() || hops.len() > MAX_CHAIN_HOPS {
            return Err(error(0, FailureKind::Configuration));
        }
        let destination = Destination::new(&destination.host, destination.port)
            .map_err(|_| error(0, FailureKind::Configuration))?;
        // Validate the complete path before opening even the first socket.
        for (index, hop) in hops.iter().enumerate() {
            if hop.node.validate().is_err()
                || !hop.node.enabled
                || (hop.node.credential_ref.is_some() && hop.credential.is_none())
                || hop
                    .credential
                    .as_ref()
                    .is_some_and(|value| value.validate_for(hop.node.endpoint.protocol).is_err())
            {
                return Err(error(index, FailureKind::Configuration));
            }
        }
        let first = &hops[0].node.endpoint;
        let address = Destination::new(&first.host, first.port)
            .map_err(|_| error(0, FailureKind::Configuration))?;
        let socket = timeout(
            self.connect_timeout,
            TcpStream::connect((address.host.as_str(), address.port)),
        )
        .await
        .map_err(|_| error(0, FailureKind::Timeout))?
        .map_err(|_| error(0, FailureKind::Connect))?;
        let _ = socket.set_nodelay(true);
        let mut stream: Tunnel = Box::new(socket);
        for (index, hop) in hops.iter().enumerate() {
            let target = match hops.get(index + 1) {
                Some(next) => Destination::new(&next.node.endpoint.host, next.node.endpoint.port)
                    .map_err(|_| error(index + 1, FailureKind::Configuration))?,
                None => destination.clone(),
            };
            stream = timeout(self.handshake_timeout, self.handshake(stream, hop, target))
                .await
                .map_err(|_| error(index, FailureKind::Timeout))?
                .map_err(|kind| error(index, kind))?;
        }
        Ok(stream)
    }

    async fn handshake(
        &self,
        mut stream: Tunnel,
        hop: &Hop,
        destination: Destination,
    ) -> Result<Tunnel, FailureKind> {
        if hop.node.endpoint.protocol == ProxyProtocol::Https {
            let tls = self.tls.clone().ok_or(FailureKind::Configuration)?;
            let proxy = Destination::new(&hop.node.endpoint.host, hop.node.endpoint.port)
                .map_err(|_| FailureKind::Configuration)?;
            let name = ServerName::try_from(proxy.host).map_err(|_| FailureKind::Configuration)?;
            // This may wrap a tunnel through previous hops, including another TLS proxy.
            stream = Box::new(
                tokio_rustls::TlsConnector::from(tls)
                    .connect(name, stream)
                    .await
                    .map_err(|_| FailureKind::Tls)?,
            );
        }
        if hop.node.endpoint.protocol == ProxyProtocol::Socks5 {
            socks_connect(&mut stream, hop, destination).await?;
            Ok(stream)
        } else {
            http_connect(stream, hop.credential.as_ref(), &destination).await
        }
    }
}

fn native_tls_config() -> Result<Arc<ClientConfig>, String> {
    let certificates = rustls_native_certs::load_native_certs();
    let mut roots = RootCertStore::empty();
    for certificate in certificates.certs {
        let _ = roots.add(certificate);
    }
    if roots.is_empty() {
        return Err("系统信任证书不可用，HTTPS 代理连接已停止".into());
    }
    let mut config =
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .map_err(|_| "TLS 协议初始化失败")?
            .with_root_certificates(roots)
            .with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(config))
}

async fn socks_connect(
    stream: &mut Tunnel,
    hop: &Hop,
    mut destination: Destination,
) -> Result<(), FailureKind> {
    let method = if hop.credential.is_some() { 2 } else { 0 };
    stream
        .write_all(&[5, 1, method])
        .await
        .map_err(|_| FailureKind::Io)?;
    stream.flush().await.map_err(|_| FailureKind::Io)?;
    let mut selected = [0; 2];
    stream
        .read_exact(&mut selected)
        .await
        .map_err(|_| FailureKind::Io)?;
    if selected != [5, method] {
        return Err(FailureKind::Authentication);
    }
    if let Some(credential) = &hop.credential {
        let mut auth = vec![1, credential.username.len() as u8];
        auth.extend_from_slice(credential.username.as_bytes());
        auth.push(credential.password.len() as u8);
        auth.extend_from_slice(credential.password.as_bytes());
        stream.write_all(&auth).await.map_err(|_| FailureKind::Io)?;
        stream.flush().await.map_err(|_| FailureKind::Io)?;
        stream
            .read_exact(&mut selected)
            .await
            .map_err(|_| FailureKind::Io)?;
        if selected != [1, 0] {
            return Err(FailureKind::Authentication);
        }
    }
    if hop.node.endpoint.dns == DnsMode::Local && destination.host.parse::<IpAddr>().is_err() {
        let address = lookup_host((destination.host.as_str(), destination.port))
            .await
            .map_err(|_| FailureKind::Dns)?
            .next()
            .ok_or(FailureKind::Dns)?;
        destination.host = address.ip().to_string();
    }
    let mut request = vec![5, 1, 0];
    match destination.host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            request.push(1);
            request.extend_from_slice(&ip.octets());
        }
        Ok(IpAddr::V6(ip)) => {
            request.push(4);
            request.extend_from_slice(&ip.octets());
        }
        Err(_) => {
            if destination.host.len() > 255 {
                return Err(FailureKind::Configuration);
            }
            request.extend_from_slice(&[3, destination.host.len() as u8]);
            request.extend_from_slice(destination.host.as_bytes());
        }
    }
    request.extend_from_slice(&destination.port.to_be_bytes());
    stream
        .write_all(&request)
        .await
        .map_err(|_| FailureKind::Io)?;
    stream.flush().await.map_err(|_| FailureKind::Io)?;
    let mut reply = [0; 4];
    stream
        .read_exact(&mut reply)
        .await
        .map_err(|_| FailureKind::Io)?;
    if reply[0] != 5 || reply[2] != 0 {
        return Err(FailureKind::Protocol);
    }
    if reply[1] != 0 {
        return Err(FailureKind::Rejected);
    }
    let length = match reply[3] {
        1 => 4,
        4 => 16,
        3 => {
            let length = stream.read_u8().await.map_err(|_| FailureKind::Io)?;
            if length == 0 {
                return Err(FailureKind::Protocol);
            }
            usize::from(length)
        }
        _ => return Err(FailureKind::Protocol),
    };
    let mut bound = vec![0; length + 2];
    stream
        .read_exact(&mut bound)
        .await
        .map_err(|_| FailureKind::Io)?;
    Ok(())
}

async fn http_connect(
    mut stream: Tunnel,
    credential: Option<&ProxyCredential>,
    destination: &Destination,
) -> Result<Tunnel, FailureKind> {
    let authority = destination.authority();
    let mut request = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n");
    if let Some(credential) = credential {
        let token = STANDARD.encode(format!("{}:{}", credential.username, credential.password));
        request.push_str(&format!("Proxy-Authorization: Basic {token}\r\n"));
    }
    request.push_str("\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|_| FailureKind::Io)?;
    stream.flush().await.map_err(|_| FailureKind::Io)?;
    // Retain bytes delivered together with the CONNECT response (e.g. a target banner).
    let mut stream = BufReader::new(stream);
    let mut consumed = 0;
    for _ in 0..4 {
        let mut head = Vec::new();
        loop {
            if consumed >= 16 * 1024 {
                return Err(FailureKind::Protocol);
            }
            head.push(stream.read_u8().await.map_err(|_| FailureKind::Io)?);
            consumed += 1;
            if head.ends_with(b"\r\n\r\n") {
                break;
            }
        }
        let line = head
            .split(|byte| *byte == b'\n')
            .next()
            .ok_or(FailureKind::Protocol)?;
        let line = std::str::from_utf8(line).map_err(|_| FailureKind::Protocol)?;
        let mut parts = line.split_ascii_whitespace();
        if !matches!(parts.next(), Some("HTTP/1.1" | "HTTP/1.0")) {
            return Err(FailureKind::Protocol);
        }
        let code = parts
            .next()
            .filter(|part| part.len() == 3)
            .and_then(|part| part.parse::<u16>().ok())
            .ok_or(FailureKind::Protocol)?;
        match code {
            200..=299 => return Ok(Box::new(stream)),
            407 => return Err(FailureKind::Authentication),
            100 | 102 | 103 => continue,
            _ => return Err(FailureKind::Rejected),
        }
    }
    Err(FailureKind::Protocol)
}

#[cfg(test)]
mod tests;
