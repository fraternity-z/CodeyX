use std::{net::SocketAddr, sync::Arc};

use mitmproxy::messages::{ConnectionId, TransportCommand, TransportEvent};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{mpsc, oneshot},
    task::JoinSet,
};

use crate::{protocol::Start, socks};

struct Stream {
    id: ConnectionId,
    commands: mpsc::UnboundedSender<TransportCommand>,
}

impl Drop for Stream {
    fn drop(&mut self) {
        let _ = self
            .commands
            .send(TransportCommand::CloseConnection(self.id, false));
    }
}

async fn forward(
    stream: Stream,
    target: SocketAddr,
    config: Arc<Start>,
) -> Result<(), &'static str> {
    let socket = socks::connect(&config, target).await?;
    let (mut read, mut write) = socket.into_split();
    let to_gateway = async {
        loop {
            let (tx, rx) = oneshot::channel();
            stream
                .commands
                .send(TransportCommand::ReadData(stream.id, 32 * 1024, tx))
                .map_err(|_| "代理流已关闭")?;
            let bytes = rx.await.map_err(|_| "代理流读取失败")?;
            if bytes.is_empty() {
                write.shutdown().await.map_err(|_| "代理流关闭失败")?;
                return Ok::<_, &'static str>(());
            }
            write
                .write_all(&bytes)
                .await
                .map_err(|_| "代理流写入失败")?;
        }
    };
    let from_gateway = async {
        let mut bytes = vec![0; 32 * 1024];
        loop {
            let n = read
                .read(&mut bytes)
                .await
                .map_err(|_| "代理入口读取失败")?;
            if n == 0 {
                stream
                    .commands
                    .send(TransportCommand::CloseConnection(stream.id, true))
                    .map_err(|_| "代理流已关闭")?;
                return Ok::<_, &'static str>(());
            }
            stream
                .commands
                .send(TransportCommand::WriteData(stream.id, bytes[..n].to_vec()))
                .map_err(|_| "代理流已关闭")?;
            let (tx, rx) = oneshot::channel();
            stream
                .commands
                .send(TransportCommand::DrainWriter(stream.id, tx))
                .map_err(|_| "代理流已关闭")?;
            rx.await.map_err(|_| "代理流写入失败")?;
        }
    };
    tokio::try_join!(to_gateway, from_gateway)?;
    Ok(())
}

pub(super) async fn run(
    mut events: mpsc::Receiver<TransportEvent>,
    commands: mpsc::UnboundedSender<TransportCommand>,
    config: Arc<Start>,
) {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            event = events.recv() => {
                let Some(TransportEvent::ConnectionEstablished { connection_id, dst_addr, command_tx, .. }) = event else { break; };
                let stream = Stream { id: connection_id, commands: command_tx.unwrap_or_else(|| commands.clone()) };
                // QUIC and arbitrary UDP are blocked rather than silently sent
                // directly. TCP DNS can use the same opaque SOCKS route.
                if !connection_id.is_tcp() || connections.len() >= 64 { continue; }
                connections.spawn(forward(stream, dst_addr, config.clone()));
            }
            result = connections.join_next(), if !connections.is_empty() => {
                if let Some(Ok(Err(code))) = result {
                    // Only our static errors, never payloads, addresses or credentials.
                    eprintln!("traffic.connection_failed: {code}");
                }
            }
        }
    }
    connections.shutdown().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use mitmproxy::messages::ConnectionIdGenerator;
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn udp_is_closed_without_contacting_the_gateway() {
        let gateway = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = Arc::new(Start {
            version: 1,
            gateway: gateway.local_addr().unwrap(),
            username: "u".into(),
            password: "p".into(),
        });
        let (event_tx, event_rx) = mpsc::channel(1);
        let (command_tx, mut command_rx) = mpsc::unbounded_channel();
        let id = ConnectionIdGenerator::udp().next_id();
        event_tx
            .send(TransportEvent::ConnectionEstablished {
                connection_id: id,
                src_addr: "192.0.2.1:1234".parse().unwrap(),
                dst_addr: "192.0.2.2:443".parse().unwrap(),
                tunnel_info: mitmproxy::messages::TunnelInfo::None,
                command_tx: None,
            })
            .await
            .unwrap();
        drop(event_tx);
        run(event_rx, command_tx, config).await;
        assert!(
            matches!(command_rx.recv().await, Some(TransportCommand::CloseConnection(actual, false)) if actual == id)
        );
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), gateway.accept())
                .await
                .is_err()
        );
    }
}
