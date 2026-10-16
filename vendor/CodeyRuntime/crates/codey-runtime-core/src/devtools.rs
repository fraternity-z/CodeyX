//! Shared wire protocol for renderer CDP and the main-process Inspector.
//! Sessions own their events and capabilities; this layer never replays commands.

use std::time::Duration;

use anyhow::Context;
use futures_util::{Sink, SinkExt, Stream, StreamExt};
use serde::Serialize;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

pub const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

pub type ConnectedSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FailureKind {
    Connection,
    Closed,
    Timeout,
    InvalidMessage,
    UnsupportedMethod,
    InvalidParameters,
    ContextLost,
    Rejected,
    ScriptException,
}

/// Only protocol metadata is retained. Expressions, response data and remote
/// exception descriptions can contain credentials and must not enter logs.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolFailure {
    pub stage: &'static str,
    pub method: Option<String>,
    pub command_id: Option<u64>,
    pub kind: FailureKind,
    pub code: Option<i64>,
}

impl ProtocolFailure {
    pub fn new(
        stage: &'static str,
        kind: FailureKind,
        method: Option<&str>,
        id: Option<u64>,
    ) -> Self {
        Self {
            stage,
            kind,
            method: method.map(str::to_owned),
            command_id: id,
            code: None,
        }
    }

    pub fn requires_reconnect(&self) -> bool {
        matches!(
            self.kind,
            FailureKind::Connection | FailureKind::Closed | FailureKind::ContextLost
        )
    }

    /// Setup may be attempted again after a transport failure. This is never
    /// permission to replay a business operation whose result is uncertain.
    pub fn retryable_setup(&self) -> bool {
        self.requires_reconnect() || self.kind == FailureKind::Timeout
    }
}

impl std::fmt::Display for ProtocolFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "DevTools {}", self.stage)?;
        if let Some(method) = &self.method {
            write!(f, " {method}")?;
        }
        if let Some(id) = self.command_id {
            write!(f, " id {id}")?;
        }
        write!(f, " failed ({:?}", self.kind)?;
        if let Some(code) = self.code {
            write!(f, ", code {code}")?;
        }
        write!(f, ")")
    }
}

impl std::error::Error for ProtocolFailure {}

pub async fn connect_websocket(websocket_url: &str) -> anyhow::Result<ConnectedSocket> {
    let candidates = websocket_connect_candidates(websocket_url);
    let attempt_timeout = connect_attempt_timeout(candidates.len());
    let mut last_error = None;
    for candidate in &candidates {
        // Keep the large TLS handshake future off the Windows startup stack.
        let connect = Box::pin(tokio_tungstenite::connect_async(candidate.as_str()));
        match tokio::time::timeout(attempt_timeout, connect).await {
            Ok(Ok((socket, _))) => return Ok(socket),
            Ok(Err(error)) => {
                last_error = Some(anyhow::Error::new(error).context(ProtocolFailure::new(
                    "connect",
                    FailureKind::Connection,
                    None,
                    None,
                )));
            }
            Err(error) => {
                last_error = Some(anyhow::Error::new(error).context(ProtocolFailure::new(
                    "connect",
                    FailureKind::Timeout,
                    None,
                    None,
                )));
            }
        }
    }
    Err(last_error.expect("at least one connection candidate"))
}

fn connect_attempt_timeout(candidate_count: usize) -> Duration {
    CONNECT_TIMEOUT / candidate_count.max(1) as u32
}

fn websocket_connect_candidates(websocket_url: &str) -> Vec<String> {
    let trimmed = websocket_url.trim();
    let Some((scheme, rest)) = trimmed.split_once("://") else {
        return vec![trimmed.to_string()];
    };
    let (authority, path) = match rest.find(['/', '?', '#']) {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, ""),
    };
    // Do not rewrite credentials or TLS host identity.
    if scheme != "ws" || authority.contains('@') {
        return vec![trimmed.to_string()];
    }
    let (host, port) = split_authority_host_port(authority);
    let mut candidates = Vec::with_capacity(2);
    if host.eq_ignore_ascii_case("localhost") || host == "[::1]" {
        let port = port.map_or(String::new(), |port| format!(":{port}"));
        candidates.push(format!("ws://127.0.0.1{port}{path}"));
    }
    candidates.push(trimmed.to_string());
    candidates.dedup();
    candidates
}

fn split_authority_host_port(authority: &str) -> (&str, Option<&str>) {
    if let Some(rest) = authority.strip_prefix('[') {
        return match rest.split_once(']') {
            Some((host, tail)) => (
                &authority[..host.len() + 2],
                tail.strip_prefix(':').filter(|p| !p.is_empty()),
            ),
            None => (authority, None),
        };
    }
    match authority.rsplit_once(':') {
        Some((host, port)) if !host.is_empty() && !port.is_empty() => (host, Some(port)),
        _ => (authority, None),
    }
}

pub async fn send_command<S>(
    socket: &mut S,
    id: u64,
    method: &str,
    params: Value,
) -> anyhow::Result<()>
where
    S: Sink<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    tokio::time::timeout(
        COMMAND_TIMEOUT,
        socket.send(Message::Text(
            json!({"id": id, "method": method, "params": params})
                .to_string()
                .into(),
        )),
    )
    .await
    .context(ProtocolFailure::new(
        "send",
        FailureKind::Timeout,
        Some(method),
        Some(id),
    ))?
    .context(ProtocolFailure::new(
        "send",
        FailureKind::Connection,
        Some(method),
        Some(id),
    ))
}

pub async fn read_message<S>(socket: &mut S) -> anyhow::Result<Option<Value>>
where
    S: Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + Sink<Message>
        + Unpin,
    <S as Sink<Message>>::Error: std::error::Error + Send + Sync + 'static,
{
    loop {
        match socket.next().await {
            Some(Ok(Message::Text(text))) => {
                let value: Value = serde_json::from_str(&text).map_err(|_| {
                    ProtocolFailure::new("receive", FailureKind::InvalidMessage, None, None)
                })?;
                if !value.is_object() {
                    return Err(ProtocolFailure::new(
                        "receive",
                        FailureKind::InvalidMessage,
                        None,
                        None,
                    )
                    .into());
                }
                return Ok(Some(value));
            }
            Some(Ok(Message::Close(_))) | None => return Ok(None),
            Some(Ok(Message::Ping(_))) => {
                tokio::time::timeout(COMMAND_TIMEOUT, socket.flush())
                    .await
                    .context(ProtocolFailure::new(
                        "receive",
                        FailureKind::Timeout,
                        None,
                        None,
                    ))?
                    .context(ProtocolFailure::new(
                        "receive",
                        FailureKind::Connection,
                        None,
                        None,
                    ))?;
            }
            Some(Ok(Message::Binary(_))) => {
                return Err(ProtocolFailure::new(
                    "receive",
                    FailureKind::InvalidMessage,
                    None,
                    None,
                )
                .into());
            }
            Some(Ok(_)) => {}
            Some(Err(error)) => {
                return Err(anyhow::Error::new(error).context(ProtocolFailure::new(
                    "receive",
                    FailureKind::Connection,
                    None,
                    None,
                )));
            }
        }
    }
}

pub fn command_result(response: Value, method: &str, id: u64) -> anyhow::Result<Value> {
    if response.get("id").and_then(Value::as_u64) != Some(id) {
        return Err(ProtocolFailure::new(
            "command",
            FailureKind::InvalidMessage,
            Some(method),
            Some(id),
        )
        .into());
    }
    if let Some(error) = response.get("error").filter(|error| !error.is_null()) {
        let code = error.get("code").and_then(Value::as_i64);
        let message = error.get("message").and_then(Value::as_str).unwrap_or("");
        let kind = match code {
            Some(-32601) => FailureKind::UnsupportedMethod,
            Some(-32602) => FailureKind::InvalidParameters,
            Some(-32000)
                if [
                    "Cannot find context",
                    "Execution context was destroyed",
                    "Inspected target navigated or closed",
                    "Cannot find default execution context",
                ]
                .iter()
                .any(|reason| message.starts_with(reason)) =>
            {
                FailureKind::ContextLost
            }
            _ => FailureKind::Rejected,
        };
        return Err(ProtocolFailure {
            stage: "command",
            method: Some(method.to_string()),
            command_id: Some(id),
            kind,
            code,
        }
        .into());
    }
    if !response.get("result").is_some_and(Value::is_object) {
        return Err(ProtocolFailure::new(
            "command",
            FailureKind::InvalidMessage,
            Some(method),
            Some(id),
        )
        .into());
    }
    Ok(response)
}

pub fn ensure_evaluate_succeeded(response: Value) -> anyhow::Result<Value> {
    if response
        .pointer("/result/exceptionDetails")
        .is_some_and(|v| !v.is_null())
    {
        return Err(ProtocolFailure::new(
            "evaluate",
            FailureKind::ScriptException,
            Some("Runtime.evaluate"),
            response.get("id").and_then(Value::as_u64),
        )
        .into());
    }
    Ok(response)
}

#[cfg(test)]
mod tests;
