use std::{net::SocketAddr, time::Duration};

use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

use crate::protocol::Start;

/// The only outbound dial is to the authenticated local gateway. In particular,
/// connection/authentication failures never dial the original destination.
pub(crate) async fn connect(config: &Start, target: SocketAddr) -> Result<TcpStream, &'static str> {
    config.validate()?;
    if target.port() == 0 || target.ip().is_unspecified() || target.ip().is_multicast() {
        return Err("代理目标无效");
    }
    tokio::time::timeout(Duration::from_secs(10), handshake(config, target))
        .await
        .map_err(|_| "本地代理入口连接超时")?
}

async fn handshake(config: &Start, target: SocketAddr) -> Result<TcpStream, &'static str> {
    let mut socket = TcpStream::connect(config.gateway)
        .await
        .map_err(|_| "本地代理入口不可达")?;
    socket
        .write_all(&[5, 1, 2])
        .await
        .map_err(|_| "本地代理握手失败")?;
    let mut reply = [0; 2];
    socket
        .read_exact(&mut reply)
        .await
        .map_err(|_| "本地代理握手失败")?;
    if reply != [5, 2] {
        return Err("本地代理未启用凭据验证");
    }
    let mut auth = vec![1, config.username.len() as u8];
    auth.extend_from_slice(config.username.as_bytes());
    auth.push(config.password.len() as u8);
    auth.extend_from_slice(config.password.as_bytes());
    socket
        .write_all(&auth)
        .await
        .map_err(|_| "本地代理认证失败")?;
    socket
        .read_exact(&mut reply)
        .await
        .map_err(|_| "本地代理认证失败")?;
    if reply != [1, 0] {
        return Err("本地代理认证失败");
    }
    let mut request = vec![5, 1, 0];
    match target.ip() {
        std::net::IpAddr::V4(ip) => {
            request.push(1);
            request.extend_from_slice(&ip.octets());
        }
        std::net::IpAddr::V6(ip) => {
            request.push(4);
            request.extend_from_slice(&ip.octets());
        }
    }
    request.extend_from_slice(&target.port().to_be_bytes());
    socket
        .write_all(&request)
        .await
        .map_err(|_| "本地代理连接失败")?;
    let mut header = [0; 4];
    socket
        .read_exact(&mut header)
        .await
        .map_err(|_| "本地代理连接失败")?;
    if header[..3] != [5, 0, 0] {
        return Err("上游代理拒绝连接");
    }
    let bytes = match header[3] {
        1 => 6,
        4 => 18,
        3 => {
            let length = socket.read_u8().await.map_err(|_| "本地代理响应无效")?;
            if length == 0 {
                return Err("本地代理响应无效");
            }
            length as usize + 2
        }
        _ => return Err("本地代理响应无效"),
    };
    let mut bound = vec![0; bytes];
    socket
        .read_exact(&mut bound)
        .await
        .map_err(|_| "本地代理响应无效")?;
    Ok(socket)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    async fn fixture(mode: u8, target: SocketAddr) -> (Start, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = Start {
            version: 1,
            gateway: listener.local_addr().unwrap(),
            username: "u".into(),
            password: "p".into(),
        };
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut greeting = [0; 3];
            socket.read_exact(&mut greeting).await.unwrap();
            assert_eq!(greeting, [5, 1, 2]);
            socket.write_all(&[5, mode]).await.unwrap();
            if mode != 2 {
                return;
            }
            let mut auth = [0; 5];
            socket.read_exact(&mut auth).await.unwrap();
            assert_eq!(auth, [1, 1, b'u', 1, b'p']);
            socket.write_all(&[1, 0]).await.unwrap();
            let mut request = vec![0; if target.is_ipv4() { 10 } else { 22 }];
            socket.read_exact(&mut request).await.unwrap();
            assert_eq!(
                &request[..4],
                &[5, 1, 0, if target.is_ipv4() { 1 } else { 4 }]
            );
            assert_eq!(&request[request.len() - 2..], &target.port().to_be_bytes());
            let ip = match target.ip() {
                std::net::IpAddr::V4(ip) => ip.octets().to_vec(),
                std::net::IpAddr::V6(ip) => ip.octets().to_vec(),
            };
            assert_eq!(&request[4..request.len() - 2], ip.as_slice());
            socket
                .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 1])
                .await
                .unwrap();
            socket.write_all(b"opaque TLS bytes").await.unwrap();
        });
        (config, task)
    }

    #[tokio::test]
    async fn forwards_ipv4_and_ipv6_without_resolving_names_or_intercepting_tls() {
        for target in ["192.0.2.7:443", "[2001:db8::7]:443"] {
            let target = target.parse().unwrap();
            let (config, task) = fixture(2, target).await;
            let mut stream = connect(&config, target).await.unwrap();
            let mut bytes = Vec::new();
            stream.read_to_end(&mut bytes).await.unwrap();
            assert_eq!(bytes, b"opaque TLS bytes");
            task.await.unwrap();
        }
    }

    #[tokio::test]
    async fn never_dials_the_target_when_gateway_refuses_authentication() {
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (config, task) = fixture(0, target.local_addr().unwrap()).await;
        assert!(
            connect(&config, target.local_addr().unwrap())
                .await
                .is_err()
        );
        task.await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(50), target.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test(start_paused = true)]
    async fn stalled_handshake_is_bounded() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = Start {
            version: 1,
            gateway: listener.local_addr().unwrap(),
            username: "u".into(),
            password: "p".into(),
        };
        let task =
            tokio::spawn(async move { connect(&config, "192.0.2.1:443".parse().unwrap()).await });
        let (_peer, _) = listener.accept().await.unwrap();
        tokio::time::advance(Duration::from_secs(11)).await;
        assert_eq!(task.await.unwrap().unwrap_err(), "本地代理入口连接超时");
    }

    #[tokio::test]
    async fn auth_failures_and_invalid_responses_never_return_a_tunnel() {
        for (auth, response, expected) in [
            ([1, 1], vec![], "本地代理认证失败"),
            ([2, 0], vec![], "本地代理认证失败"),
            ([1, 0], vec![5, 2, 0, 1], "上游代理拒绝连接"),
            ([1, 0], vec![5, 0, 1, 1], "上游代理拒绝连接"),
            ([1, 0], vec![5, 0, 0, 9], "本地代理响应无效"),
            ([1, 0], vec![5, 0, 0, 3, 0], "本地代理响应无效"),
            ([1, 0], vec![5, 0, 0, 4, 0], "本地代理响应无效"),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let config = Start {
                version: 1,
                gateway: listener.local_addr().unwrap(),
                username: "u".into(),
                password: "p".into(),
            };
            let task = tokio::spawn(async move {
                let (mut peer, _) = listener.accept().await.unwrap();
                let mut greeting = [0; 3];
                peer.read_exact(&mut greeting).await.unwrap();
                peer.write_all(&[5, 2]).await.unwrap();
                let mut credential = [0; 5];
                peer.read_exact(&mut credential).await.unwrap();
                peer.write_all(&auth).await.unwrap();
                if auth != [1, 0] {
                    return;
                }
                let mut target = [0; 10];
                peer.read_exact(&mut target).await.unwrap();
                peer.write_all(&response).await.unwrap();
            });
            assert_eq!(
                connect(&config, "192.0.2.1:443".parse().unwrap())
                    .await
                    .unwrap_err(),
                expected
            );
            task.await.unwrap();
        }
    }

    #[tokio::test]
    async fn invalid_targets_are_rejected_before_contacting_the_gateway() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = Start {
            version: 1,
            gateway: listener.local_addr().unwrap(),
            username: "u".into(),
            password: "p".into(),
        };
        for target in [
            "0.0.0.0:443",
            "[::]:443",
            "192.0.2.1:0",
            "224.0.0.1:443",
            "[ff02::1]:443",
        ] {
            assert_eq!(
                connect(&config, target.parse().unwrap()).await.unwrap_err(),
                "代理目标无效"
            );
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(30), listener.accept())
                .await
                .is_err()
        );
    }
}
