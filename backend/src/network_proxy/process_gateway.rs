//! Authenticated loopback HTTP/SOCKS ingress for the Codex launch environment
//! and the traffic helper. Pool policy is resolved before each connection;
//! upstream failures never become direct I/O. Process isolation belongs to the
//! helper, not this gateway.
use std::{
    convert::Infallible,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::Duration,
};

use base64::{Engine, engine::general_purpose::STANDARD};
use bytes::Bytes;
use http_body::{Body, Frame, SizeHint};
use http_body_util::{BodyExt, Full, combinators::UnsyncBoxBody};
use hyper::{
    Method, Request, Response, StatusCode, Uri,
    body::Incoming,
    client::conn::http1 as client_http1,
    header::{HeaderMap, HeaderName, HeaderValue},
    server::conn::http1,
    service::service_fn,
    upgrade::OnUpgrade,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::{
    io::AsyncWriteExt,
    net::{TcpListener, TcpStream},
    sync::{Semaphore, oneshot},
    task::{JoinHandle, JoinSet},
    time::timeout,
};

use super::{
    egress::{EgressPool, ProxyLease},
    model::ProxySelection,
    tunnel::{Destination, Tunnel},
};

type BoxError = Box<dyn std::error::Error + Send + Sync>;
type ReplyBody = UnsyncBoxBody<Bytes, BoxError>;
type RelaySender = Arc<Mutex<Option<oneshot::Sender<Relay>>>>;

/// Only a temporary local credential is passed to Codex. Pool credentials are
/// never exposed to the renderer, child-process environment or startup script.
#[derive(Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProcessProxyAuth {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub realm: String,
}

impl std::fmt::Debug for ProcessProxyAuth {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProcessProxyAuth")
            .field("host", &self.host)
            .field("port", &self.port)
            .finish_non_exhaustive()
    }
}

struct ContextState {
    auth: ProcessProxyAuth,
    expected_auth: Vec<u8>,
    egress: Arc<EgressPool>,
    selection: ProxySelection,
}

pub(crate) struct ProcessGateway {
    auth: ProcessProxyAuth,
    task: Mutex<Option<JoinHandle<()>>>,
    #[cfg(windows)]
    capture: Mutex<Option<super::process_capture::CaptureSession>>,
}

impl ProcessGateway {
    pub(crate) async fn start(
        egress: Arc<EgressPool>,
        selection: ProxySelection,
    ) -> Result<Self, String> {
        // Validate the selection and unlock any credentials before a child is launched.
        egress.for_selection(&selection).await?;
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|_| "无法启动 Codex 本机代理入口，请检查端口权限")?;
        let address = listener
            .local_addr()
            .map_err(|_| "无法读取 Codex 本机代理入口地址")?;
        let auth = ProcessProxyAuth {
            host: address.ip().to_string(),
            port: address.port(),
            username: "codeyx".into(),
            password: uuid::Uuid::new_v4().simple().to_string(),
            realm: format!("codeyx-{}", uuid::Uuid::new_v4().simple()),
        };
        let state = Arc::new(ContextState {
            expected_auth: format!("{}:{}", auth.username, auth.password).into_bytes(),
            auth: auth.clone(),
            egress,
            selection,
        });
        let task = tokio::spawn(async move {
            let limit = Arc::new(Semaphore::new(64));
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((socket, peer)) = accepted else { break; };
                        if !peer.ip().is_loopback() { continue; }
                        let Ok(permit) = limit.clone().try_acquire_owned() else { continue; };
                        let state = state.clone();
                        connections.spawn(async move {
                            let _permit = permit;
                            serve(socket, state).await;
                        });
                    }
                    _ = connections.join_next(), if !connections.is_empty() => {}
                }
            }
        });
        Ok(Self {
            auth,
            task: Mutex::new(Some(task)),
            #[cfg(windows)]
            capture: Mutex::new(None),
        })
    }

    pub(crate) fn auth(&self) -> ProcessProxyAuth {
        self.auth.clone()
    }

    #[cfg(windows)]
    pub(crate) async fn enable_capture(&self) -> anyhow::Result<()> {
        let capture = super::process_capture::CaptureSession::start(self.auth()).await?;
        *self.capture.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(capture);
        Ok(())
    }

    #[cfg(windows)]
    pub(crate) fn capture_scope(&self) -> Option<codey_traffic_service::client::ProcessScope> {
        self.capture.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref().map(super::process_capture::CaptureSession::scope)
    }

    pub(crate) fn proxy_url(&self) -> String {
        format!(
            "http://{}:{}@{}:{}",
            self.auth.username, self.auth.password, self.auth.host, self.auth.port
        )
    }

    pub(crate) fn server_url(&self) -> String {
        format!("http://{}:{}", self.auth.host, self.auth.port)
    }

    pub(crate) async fn stop(&self) {
        #[cfg(windows)]
        {
            let capture = self.capture.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
            if let Some(mut capture) = capture {
                // Runtime cleanup has already confirmed that its Codex processes
                // stopped. The session's drop guard also stops its owned Job.
                let _ = capture.stop().await;
            }
        }
        let task = self
            .task
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(task) = task {
            task.abort();
            let _ = task.await;
        }
    }
}

impl Drop for ProcessGateway {
    fn drop(&mut self) {
        if let Some(task) = self
            .task
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            task.abort();
        }
    }
}

async fn serve(socket: TcpStream, state: Arc<ContextState>) {
    let _ = socket.set_nodelay(true);
    let mut first = [0; 1];
    if !matches!(
        timeout(Duration::from_secs(10), socket.peek(&mut first)).await,
        Ok(Ok(1))
    ) {
        return;
    }
    if first[0] == 5 {
        serve_socks(socket, state).await;
        return;
    }
    let (sender, receiver) = oneshot::channel();
    let sender = Arc::new(Mutex::new(Some(sender)));
    let service = service_fn(move |request| handle(request, state.clone(), sender.clone()));
    if http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(Duration::from_secs(10))
        .max_buf_size(16 * 1024)
        .serve_connection(TokioIo::new(socket), service)
        .with_upgrades()
        .await
        .is_err()
    {
        return;
    }
    // The parent task owns the upgraded tunnel too. Aborting the gateway drops
    // this future and every stream, rather than detaching upgrade relay tasks.
    if let Ok(relay) = receiver.await {
        relay.run().await;
    }
}

async fn serve_socks(mut downstream: TcpStream, state: Arc<ContextState>) {
    let Ok(Ok(destination)) = timeout(
        Duration::from_secs(10),
        super::gateway::read_request(&mut downstream, &state.auth.password),
    )
    .await
    else {
        return;
    };
    if is_self_destination(&destination, &state.auth) {
        let _ = downstream.write_all(&[5, 2, 0, 1, 0, 0, 0, 0, 0, 0]).await;
        return;
    }
    // Re-resolve each request. Holding a cached lease here would keep using a
    // removed/disabled node after the user changes the pool configuration.
    let Ok(lease) = state.egress.for_selection(&state.selection).await else {
        let _ = downstream.write_all(&[5, 1, 0, 1, 0, 0, 0, 0, 0, 0]).await;
        return;
    };
    let Ok(mut upstream) = lease.connect(destination).await else {
        let _ = downstream.write_all(&[5, 1, 0, 1, 0, 0, 0, 0, 0, 0]).await;
        return;
    };
    if downstream
        .write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
        .await
        .is_ok()
    {
        let _ = tokio::io::copy_bidirectional(&mut downstream, &mut upstream).await;
    }
}

fn is_self_destination(destination: &Destination, auth: &ProcessProxyAuth) -> bool {
    destination.port == auth.port
        && (destination.host == auth.host || destination.host.eq_ignore_ascii_case("localhost"))
}

async fn handle(
    mut request: Request<Incoming>,
    state: Arc<ContextState>,
    relay: RelaySender,
) -> Result<Response<ReplyBody>, Infallible> {
    if !authenticated(request.headers(), &state.expected_auth) {
        let mut response = reply(
            StatusCode::PROXY_AUTHENTICATION_REQUIRED,
            "本机代理需要认证",
        );
        response.headers_mut().insert(
            "proxy-authenticate",
            HeaderValue::from_str(&format!("Basic realm=\"{}\"", state.auth.realm)).unwrap(),
        );
        return Ok(response);
    }
    let (destination, authority, path) = match destination(request.method(), request.uri()) {
        Ok(target) => target,
        Err(()) => return Ok(reply(StatusCode::BAD_REQUEST, "代理目标地址无效")),
    };
    // Refuse obvious self-loops even if a selected first hop is a local proxy.
    if is_self_destination(&destination, &state.auth) {
        return Ok(reply(StatusCode::BAD_REQUEST, "代理入口不能作为目标"));
    }
    let websocket = request
        .headers()
        .get("upgrade")
        .is_some_and(|value| value.as_bytes().eq_ignore_ascii_case(b"websocket"));
    if request.method() != Method::CONNECT
        && request.headers().contains_key("upgrade")
        && !websocket
    {
        return Ok(reply(StatusCode::NOT_IMPLEMENTED, "不支持此连接升级协议"));
    }
    if clean_headers(request.headers_mut(), websocket).is_err() {
        return Ok(reply(StatusCode::BAD_REQUEST, "代理请求头无效"));
    }
    let lease = match state.egress.for_selection(&state.selection).await {
        Ok(lease) => lease,
        Err(_) => return Ok(reply(StatusCode::BAD_GATEWAY, "启动出口不可用，连接已阻断")),
    };
    let upstream = match lease.connect(destination).await {
        Ok(stream) => stream,
        Err(_) => {
            return Ok(reply(
                StatusCode::BAD_GATEWAY,
                "代理链路未能建立，连接已阻断",
            ));
        }
    };
    if request.method() == Method::CONNECT {
        let relay_value = Relay {
            downstream: hyper::upgrade::on(&mut request),
            upstream: RelayUpstream::Tunnel(upstream),
            _lease: lease,
        };
        if !send_relay(&relay, relay_value) {
            return Ok(reply(StatusCode::BAD_GATEWAY, "代理连接已关闭"));
        }
        return Ok(empty_reply(StatusCode::OK));
    }
    let downstream_upgrade = websocket.then(|| hyper::upgrade::on(&mut request));
    *request.uri_mut() = path;
    request.headers_mut().insert("host", authority);
    let (mut client, connection) = match client_http1::handshake(TokioIo::new(upstream)).await {
        Ok(connection) => connection,
        Err(_) => return Ok(reply(StatusCode::BAD_GATEWAY, "代理目标连接失败")),
    };
    let driver = AbortDriver(tokio::spawn(async move {
        let _ = connection.with_upgrades().await;
    }));
    let mut response = match client.send_request(request).await {
        Ok(response) => response,
        Err(_) => return Ok(reply(StatusCode::BAD_GATEWAY, "代理目标响应失败")),
    };
    if response.status() == StatusCode::SWITCHING_PROTOCOLS {
        let Some(downstream) = downstream_upgrade else {
            return Ok(reply(StatusCode::BAD_GATEWAY, "目标返回了未请求的连接升级"));
        };
        if !response
            .headers()
            .get("upgrade")
            .is_some_and(|value| value.as_bytes().eq_ignore_ascii_case(b"websocket"))
        {
            return Ok(reply(StatusCode::BAD_GATEWAY, "目标连接升级无效"));
        }
        if clean_headers(response.headers_mut(), true).is_err() {
            return Ok(reply(StatusCode::BAD_GATEWAY, "目标响应头无效"));
        }
        let upstream = hyper::upgrade::on(&mut response);
        if !send_relay(
            &relay,
            Relay {
                downstream,
                upstream: RelayUpstream::Upgrade(upstream, driver),
                _lease: lease,
            },
        ) {
            return Ok(reply(StatusCode::BAD_GATEWAY, "代理连接已关闭"));
        }
        let (parts, _) = response.into_parts();
        return Ok(Response::from_parts(parts, empty_body()));
    }
    if clean_headers(response.headers_mut(), false).is_err() {
        return Ok(reply(StatusCode::BAD_GATEWAY, "目标响应头无效"));
    }
    let (parts, incoming) = response.into_parts();
    Ok(Response::from_parts(
        parts,
        ForwardBody {
            incoming,
            _driver: driver,
            _lease: lease,
        }
        .boxed_unsync(),
    ))
}

fn authenticated(headers: &HeaderMap, expected: &[u8]) -> bool {
    if headers.get_all("proxy-authorization").iter().count() != 1 {
        return false;
    }
    let Some(value) = headers
        .get("proxy-authorization")
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let Some((scheme, value)) = value.split_once(' ') else {
        return false;
    };
    if !scheme.eq_ignore_ascii_case("basic") {
        return false;
    }
    let Ok(supplied) = STANDARD.decode(value) else {
        return false;
    };
    supplied.len() == expected.len()
        && supplied
            .iter()
            .zip(expected)
            .fold(0_u8, |diff, (left, right)| diff | (left ^ right))
            == 0
}

fn destination(method: &Method, uri: &Uri) -> Result<(Destination, HeaderValue, Uri), ()> {
    if method == Method::CONNECT {
        let authority: hyper::http::uri::Authority = uri.to_string().parse().map_err(|_| ())?;
        if authority.as_str().contains('@') {
            return Err(());
        }
        let destination =
            Destination::new(authority.host(), authority.port_u16().ok_or(())?).map_err(|_| ())?;
        return Ok((
            destination,
            HeaderValue::from_static("unused"),
            Uri::from_static("/"),
        ));
    }
    let url = reqwest::Url::parse(&uri.to_string()).map_err(|_| ())?;
    if !matches!(url.scheme(), "http" | "ws")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(());
    }
    let destination = Destination::new(
        url.host_str().ok_or(())?,
        url.port_or_known_default().ok_or(())?,
    )
    .map_err(|_| ())?;
    let authority = HeaderValue::from_str(uri.authority().ok_or(())?.as_str()).map_err(|_| ())?;
    let path = uri
        .path_and_query()
        .map_or("/", |path| path.as_str())
        .parse()
        .map_err(|_| ())?;
    Ok((destination, authority, path))
}

fn clean_headers(headers: &mut HeaderMap, websocket: bool) -> Result<(), ()> {
    let named = headers
        .get_all("connection")
        .iter()
        .map(|value| value.to_str().map(str::to_owned).map_err(|_| ()))
        .collect::<Result<Vec<_>, _>>()?;
    for names in named {
        for name in names
            .split(',')
            .map(str::trim)
            .filter(|name| !name.is_empty())
        {
            let name = HeaderName::from_bytes(name.as_bytes()).map_err(|_| ())?;
            headers.remove(name);
        }
    }
    for name in [
        "proxy-authorization",
        "proxy-authenticate",
        "proxy-connection",
        "connection",
        "keep-alive",
        "transfer-encoding",
        "te",
        "trailer",
        "upgrade",
    ] {
        headers.remove(name);
    }
    if websocket {
        headers.insert("connection", HeaderValue::from_static("upgrade"));
        headers.insert("upgrade", HeaderValue::from_static("websocket"));
    }
    Ok(())
}

fn empty_body() -> ReplyBody {
    Full::new(Bytes::new())
        .map_err(|never| -> BoxError { match never {} })
        .boxed_unsync()
}
fn empty_reply(status: StatusCode) -> Response<ReplyBody> {
    let mut response = Response::new(empty_body());
    *response.status_mut() = status;
    response
}
fn reply(status: StatusCode, message: &'static str) -> Response<ReplyBody> {
    let mut response = Response::new(
        Full::new(Bytes::from_static(message.as_bytes()))
            .map_err(|never| -> BoxError { match never {} })
            .boxed_unsync(),
    );
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert("connection", HeaderValue::from_static("close"));
    response.headers_mut().insert(
        "content-type",
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    response
}

struct AbortDriver(JoinHandle<()>);
impl Drop for AbortDriver {
    fn drop(&mut self) {
        self.0.abort();
    }
}

struct ForwardBody {
    incoming: Incoming,
    _driver: AbortDriver,
    _lease: ProxyLease,
}
impl Body for ForwardBody {
    type Data = Bytes;
    type Error = BoxError;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, BoxError>>> {
        Pin::new(&mut self.incoming)
            .poll_frame(context)
            .map(|frame| {
                frame.map(|result| result.map_err(|_| std::io::Error::other("代理响应中断").into()))
            })
    }
    fn is_end_stream(&self) -> bool {
        self.incoming.is_end_stream()
    }
    fn size_hint(&self) -> SizeHint {
        self.incoming.size_hint()
    }
}

enum RelayUpstream {
    Tunnel(Tunnel),
    Upgrade(OnUpgrade, AbortDriver),
}
struct Relay {
    downstream: OnUpgrade,
    upstream: RelayUpstream,
    _lease: ProxyLease,
}

fn send_relay(sender: &RelaySender, relay: Relay) -> bool {
    sender
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take()
        .is_some_and(|sender| sender.send(relay).is_ok())
}

impl Relay {
    async fn run(self) {
        let Ok(Ok(downstream)) = timeout(Duration::from_secs(10), self.downstream).await else {
            return;
        };
        let mut downstream = TokioIo::new(downstream);
        match self.upstream {
            RelayUpstream::Tunnel(mut upstream) => {
                let _ = tokio::io::copy_bidirectional(&mut downstream, &mut upstream).await;
            }
            RelayUpstream::Upgrade(upstream, _driver) => {
                let Ok(Ok(upstream)) = timeout(Duration::from_secs(10), upstream).await else {
                    return;
                };
                let _ = tokio::io::copy_bidirectional(&mut downstream, &mut TokioIo::new(upstream))
                    .await;
            }
        }
    }
}

#[cfg(test)]
#[path = "process_gateway_tests.rs"]
mod tests;
