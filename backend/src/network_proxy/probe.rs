use std::net::IpAddr;
use std::time::{Duration, Instant};

use serde::Serialize;

use super::model::{ProxyNode, ProxySelection};
use super::secrets::ProxyCredential;
use super::{
    gateway::Gateway,
    tunnel::{FailureKind, Hop},
};

pub(crate) const EXIT_PROBE_URL: &str = "https://api.ipify.org?format=json";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbeResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chain_id: Option<String>,
    pub success: bool,
    pub tested_at: String,
    pub elapsed_ms: u64,
    pub exit_ip: Option<String>,
    pub error_code: Option<&'static str>,
    pub message: &'static str,
    pub failed_hop: Option<usize>,
}

pub(crate) async fn test_node(
    node: &ProxyNode,
    credential: Option<ProxyCredential>,
) -> Result<ProbeResult, String> {
    test_at(node, credential, EXIT_PROBE_URL).await
}

async fn test_at(
    node: &ProxyNode,
    credential: Option<ProxyCredential>,
    target: &str,
) -> Result<ProbeResult, String> {
    test_hops_at(
        &ProxySelection::Node {
            id: node.id.clone(),
        },
        vec![Hop {
            node: node.clone(),
            credential,
        }],
        target,
    )
    .await
}

async fn test_hops_at(
    selection: &ProxySelection,
    mut hops: Vec<Hop>,
    target: &str,
) -> Result<ProbeResult, String> {
    let (node_id, chain_id) = match selection {
        ProxySelection::Node { id } => (Some(id.clone()), None),
        ProxySelection::Chain { id } => (None, Some(id.clone())),
        ProxySelection::Legacy | ProxySelection::Policy { .. } => {
            return Err("请指定要测试的代理节点或链路".into());
        }
    };
    for hop in &mut hops {
        hop.node.validate()?;
        if hop.node.credential_ref.is_some() && hop.credential.is_none() {
            return Err("代理需要认证，但保存的凭据不可用；测试已停止".into());
        }
        // Explicit tests may exercise disabled nodes without changing their eligibility.
        hop.node.enabled = true;
    }
    let connect_budget = Duration::from_secs(5 + 5 * hops.len().min(3) as u64);
    let gateway = Gateway::start(hops).await?;
    let proxy = reqwest::Proxy::all(gateway.proxy_url()).map_err(|_| "代理测试入口无法使用")?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .proxy(proxy)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(connect_budget)
        .timeout(connect_budget + Duration::from_secs(10))
        .build()
        .map_err(|_| "代理测试客户端创建失败")?;
    let started = Instant::now();
    let outcome = async {
        let response = client.get(target).send().await.map_err(|error| {
            if let Some(failure) = gateway.last_error() {
                return match failure.kind {
                    FailureKind::Authentication => {
                        ("authenticationFailed", "代理认证失败或认证方式不受支持")
                    }
                    FailureKind::Tls => ("proxyTlsFailed", "HTTPS 代理证书校验或 TLS 握手失败"),
                    FailureKind::Timeout => ("timeout", "代理连接或握手超时"),
                    FailureKind::Connect => ("connectFailed", "无法连接代理节点"),
                    FailureKind::Dns => ("dnsFailed", "本机域名解析失败"),
                    FailureKind::Rejected => ("proxyRejected", "代理拒绝建立目标连接"),
                    FailureKind::Configuration => ("invalidConfiguration", "节点配置或凭据不可用"),
                    FailureKind::Protocol | FailureKind::Io => {
                        ("proxyProtocolFailed", "代理协议异常或连接提前中断")
                    }
                };
            }
            if error.is_timeout() {
                ("timeout", "代理测试超时")
            } else if error.is_connect() {
                (
                    "connectFailed",
                    "代理连接、认证或 TLS 握手失败，请检查节点设置",
                )
            } else {
                ("requestFailed", "代理测试请求失败")
            }
        })?;
        if response.status() == reqwest::StatusCode::PROXY_AUTHENTICATION_REQUIRED {
            return Err(("authenticationFailed", "代理认证失败，请检查用户名和密码"));
        }
        if !response.status().is_success() {
            return Err((
                "probeRejected",
                "出口检测服务拒绝请求，不能据此判断代理不可用",
            ));
        }
        let bytes = crate::http_response::read_bounded_body(response, 4096, "出口检测")
            .await
            .map_err(|_| ("invalidProbeResponse", "出口检测响应不完整或超过大小限制"))?;
        let value: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|_| ("invalidProbeResponse", "出口检测响应格式无效"))?;
        value
            .get("ip")
            .and_then(|ip| ip.as_str())
            .and_then(|ip| ip.parse::<IpAddr>().ok())
            .map(|ip| ip.to_string())
            .ok_or(("invalidProbeResponse", "出口检测未返回有效 IP 地址"))
    }
    .await;
    let (exit_ip, error_code, message) = match outcome {
        Ok(ip) => (Some(ip), None, "代理访问成功；出口 IP 为本次检测观测值"),
        Err((code, message)) => (None, Some(code), message),
    };
    Ok(ProbeResult {
        node_id,
        chain_id,
        success: error_code.is_none(),
        tested_at: chrono::Utc::now().to_rfc3339(),
        elapsed_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        exit_ip,
        error_code,
        message,
        failed_hop: if error_code.is_some() {
            gateway.last_error().map(|error| error.hop + 1)
        } else {
            None
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network_proxy::model::{DnsMode, ProxyEndpoint, ProxyProtocol};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    async fn read_head(stream: &mut tokio::net::TcpStream) -> String {
        let mut bytes = Vec::new();
        while !bytes.ends_with(b"\r\n\r\n") {
            assert!(bytes.len() < 4096);
            bytes.push(stream.read_u8().await.unwrap());
        }
        String::from_utf8(bytes).unwrap()
    }

    fn node(port: u16) -> ProxyNode {
        ProxyNode {
            id: "probe".into(),
            name: "probe".into(),
            endpoint: ProxyEndpoint {
                protocol: ProxyProtocol::Http,
                host: "127.0.0.1".into(),
                port,
                dns: DnsMode::Remote,
            },
            credential_ref: None,
            enabled: false,
            notes: String::new(),
            tags: Vec::new(),
            group: String::new(),
        }
    }

    #[tokio::test]
    async fn test_uses_selected_proxy_and_does_not_enable_node() {
        let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let node = node(proxy.local_addr().unwrap().port());
        let server = tokio::spawn(async move {
            let (mut socket, _) = proxy.accept().await.unwrap();
            assert!(
                read_head(&mut socket)
                    .await
                    .starts_with("CONNECT target.invalid:80 HTTP/1.1")
            );
            socket
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .await
                .unwrap();
            assert!(
                read_head(&mut socket)
                    .await
                    .starts_with("GET /echo HTTP/1.1")
            );
            let body = r#"{"ip":"203.0.113.5"}"#;
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });
        let result = test_at(&node, None, "http://target.invalid/echo")
            .await
            .unwrap();
        server.await.unwrap();
        assert!(result.success);
        assert_eq!(result.exit_ip.as_deref(), Some("203.0.113.5"));
        assert!(!node.enabled);
    }

    #[tokio::test]
    async fn unavailable_proxy_does_not_connect_to_reachable_target() {
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let unavailable = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let node = node(unavailable.local_addr().unwrap().port());
        drop(unavailable);
        let result = test_at(
            &node,
            None,
            &format!("http://{}/", target.local_addr().unwrap()),
        )
        .await
        .unwrap();
        assert!(!result.success);
        assert!(
            tokio::time::timeout(Duration::from_millis(50), target.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn authentication_failure_never_echoes_remote_body_or_credentials() {
        let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let node = node(proxy.local_addr().unwrap().port());
        let server = tokio::spawn(async move {
            let (mut socket, _) = proxy.accept().await.unwrap();
            read_head(&mut socket).await;
            socket.write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 6\r\nConnection: close\r\n\r\nsecret").await.unwrap();
        });
        let result = test_at(
            &node,
            Some(ProxyCredential {
                username: "fake-user".into(),
                password: "fake-secret".into(),
            }),
            "http://target.invalid/",
        )
        .await
        .unwrap();
        server.await.unwrap();
        assert_eq!(result.error_code, Some("authenticationFailed"));
        assert!(!serde_json::to_string(&result).unwrap().contains("secret"));
    }
}
