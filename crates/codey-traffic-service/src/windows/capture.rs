//! Process attribution follows mitmproxy's Windows redirector design:
//! https://github.com/mitmproxy/mitmproxy_rs/tree/51fe2b7c5aa8439c162abb665db61c6669d146d6/mitmproxy-windows/redirector
//! Unlike name/substring matching, ownership is checked against one Windows Job.
//! The kernel component is the existing signed WinDivert driver, unmodified.

use std::{
    collections::HashMap,
    ffi::CString,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result};
use internet_packet::{ConnectionId, InternetPacket, TransportProtocol};
use lru_time_cache::LruCache;
use mitmproxy::messages::{NetworkCommand, NetworkEvent, SmolPacket, TunnelInfo};
use tokio::sync::mpsc;
use windivert_sys::{
    self as api, WinDivertEvent, WinDivertFlags, WinDivertLayer, address::WINDIVERT_ADDRESS,
};

use super::{job::Job, priority::Priority};

struct Handle {
    native: windows_48::Win32::Foundation::HANDLE,
    _priority: Arc<Priority>,
}

impl Handle {
    fn open(
        filter: &str,
        layer: WinDivertLayer,
        priority: Arc<Priority>,
        flags: WinDivertFlags,
    ) -> Result<Self> {
        let filter = CString::new(filter)?;
        let handle = unsafe { api::WinDivertOpen(filter.as_ptr(), layer, priority.value, flags) };
        if handle.is_invalid() {
            return Err(std::io::Error::last_os_error())
                .context("无法启动流量捕获组件，请检查管理员权限、WinDivert 文件和安全软件提示");
        }
        Ok(Self {
            native: handle,
            _priority: priority,
        })
    }

    fn recv(&self, bytes: &mut [u8]) -> Result<(usize, WINDIVERT_ADDRESS)> {
        let mut address = WINDIVERT_ADDRESS::default();
        let mut size = 0;
        let buffer = if bytes.is_empty() {
            std::ptr::null_mut()
        } else {
            bytes.as_mut_ptr().cast()
        };
        let ok = unsafe {
            api::WinDivertRecv(
                self.native,
                buffer,
                bytes.len() as u32,
                &mut size,
                &mut address,
            )
        };
        anyhow::ensure!(ok.as_bool(), "流量捕获组件接收失败");
        anyhow::ensure!(size as usize <= bytes.len(), "流量捕获组件返回无效长度");
        Ok((size as usize, address))
    }

    fn send(&self, address: &WINDIVERT_ADDRESS, bytes: &[u8]) -> Result<()> {
        let mut sent = 0;
        let ok = unsafe {
            api::WinDivertSend(
                self.native,
                bytes.as_ptr().cast(),
                bytes.len() as u32,
                &mut sent,
                address,
            )
        };
        anyhow::ensure!(
            ok.as_bool() && sent as usize == bytes.len(),
            "流量捕获组件转发失败"
        );
        Ok(())
    }

    fn stop(&self) {
        unsafe {
            api::WinDivertShutdown(self.native, api::WinDivertShutdownMode::Both);
        }
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            api::WinDivertClose(self.native);
        }
    }
}

struct Packet {
    address: WINDIVERT_ADDRESS,
    bytes: Vec<u8>,
}
enum Event {
    Socket(WINDIVERT_ADDRESS),
    Packet(Packet),
    Failed,
}
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Action {
    Pass,
    Capture(u32),
}
struct Pending {
    packets: Vec<Packet>,
    bytes: usize,
    created: std::time::Instant,
}

pub(super) struct Capture {
    job: Arc<Job>,
    sockets: Arc<Handle>,
    packets: Arc<Handle>,
    events: mpsc::Receiver<Event>,
    flows: LruCache<ConnectionId, Action>,
    pending: HashMap<ConnectionId, Pending>,
    pending_bytes: usize,
    stopping: bool,
}

impl Capture {
    pub(super) fn start(job: Arc<Job>) -> Result<Self> {
        let priority = Arc::new(Priority::reserve()?);
        let sockets = Arc::new(Handle::open(
            "tcp || udp",
            WinDivertLayer::Socket,
            priority.clone(),
            WinDivertFlags::new().set_recv_only().set_sniff(),
        )?);
        let packets = Arc::new(Handle::open(
            "outbound && !loopback && ((ip && remoteAddr < 224.0.0.0) || (ipv6 && remoteAddr < ff00::)) && (tcp || udp)",
            WinDivertLayer::Network,
            priority,
            WinDivertFlags::new(),
        )?);
        let mut flows =
            LruCache::with_expiry_duration_and_capacity(Duration::from_secs(600), 65536);
        // The managed job is empty until Ready. Existing connections belong to
        // other applications, and must retain their original packets and routes.
        for entry in mitmproxy::windows::network::network_table().context("读取现有网络连接失败")?
        {
            if !entry.remote_addr.ip().is_unspecified() {
                if let Ok(proto) = TransportProtocol::try_from(entry.protocol) {
                    remember_flow(
                        &mut flows,
                        ConnectionId {
                            proto,
                            src: entry.local_addr,
                            dst: entry.remote_addr,
                        },
                        Action::Pass,
                    );
                }
            }
        }
        let (tx, events) = mpsc::channel(512);
        let socket_handle = sockets.clone();
        let socket_tx = tx.clone();
        std::thread::Builder::new()
            .name("codeyx-traffic-sockets".into())
            .spawn(move || {
                loop {
                    match socket_handle.recv(&mut []) {
                        Ok((_, address)) => {
                            if socket_tx.blocking_send(Event::Socket(address)).is_err() {
                                break;
                            }
                        }
                        Err(_) => {
                            let _ = socket_tx.blocking_send(Event::Failed);
                            break;
                        }
                    }
                }
            })
            .context("启动流量进程识别线程失败")?;
        let packet_handle = packets.clone();
        if let Err(error) = std::thread::Builder::new()
            .name("codeyx-traffic-packets".into())
            .spawn(move || {
                let mut bytes = vec![0; 65575];
                loop {
                    match packet_handle.recv(&mut bytes) {
                        Ok((size, address)) => {
                            if tx
                                .blocking_send(Event::Packet(Packet {
                                    address,
                                    bytes: bytes[..size].to_vec(),
                                }))
                                .is_err()
                            {
                                break;
                            }
                        }
                        Err(_) => {
                            let _ = tx.blocking_send(Event::Failed);
                            break;
                        }
                    }
                }
            })
        {
            sockets.stop();
            return Err(error).context("启动流量捕获线程失败");
        }
        Ok(Self {
            job,
            sockets,
            packets,
            events,
            flows,
            pending: HashMap::new(),
            pending_bytes: 0,
            stopping: false,
        })
    }

    pub(super) async fn forward(
        &mut self,
        net: &mpsc::Sender<NetworkEvent>,
        output: &mut mpsc::Receiver<NetworkCommand>,
    ) -> Result<()> {
        let mut output_open = true;
        let mut expiry = tokio::time::interval(Duration::from_secs(1));
        loop {
            tokio::select! {
                event = self.events.recv() => match event {
                    Some(Event::Packet(packet)) => self.packet(packet, net).await?,
                    Some(Event::Socket(address)) => self.socket(address, net).await?,
                    _ => anyhow::bail!("流量捕获组件已停止"),
                },
                command = output.recv(), if output_open => match command {
                    Some(NetworkCommand::SendPacket(packet)) => {
                        let mut address = WINDIVERT_ADDRESS::default();
                        address.set_outbound(true);
                        self.packets.send(&address, &packet.into_inner())?;
                    }
                    None if self.stopping => output_open = false,
                    None => anyhow::bail!("代理网络引擎已停止"),
                },
                _ = expiry.tick(), if !self.stopping => {
                    if self.pending.values().any(|pending| pending.created.elapsed() > Duration::from_secs(5)) {
                        anyhow::bail!("代理连接所属进程识别超时");
                    }
                }
            }
        }
    }

    async fn packet(&mut self, packet: Packet, net: &mpsc::Sender<NetworkEvent>) -> Result<()> {
        // Do not expose malformed packets or payloads in diagnostics.
        let Ok(parsed) = InternetPacket::try_from(packet.bytes.clone()) else {
            return Ok(());
        };
        let id = parsed.connection_id();
        if id.proto == TransportProtocol::Tcp && !(parsed.tcp_syn() && !parsed.tcp_ack()) {
            if let Some(action) = self.flows.get(&id).copied() {
                return self.apply(packet, action, net).await;
            }
        }
        // Refresh SYN owners even if a previous socket used the same tuple: a
        // new SYN may precede its CONNECT event. Refresh UDP on every packet too.
        let table =
            mitmproxy::windows::network::network_table().context("无法核验网络连接所属进程")?;
        let mut action = None;
        for entry in table {
            // A higher-priority instance's synthetic TCP reply can enter this
            // handle before its socket event. It must pass back to the client.
            if id.proto == TransportProtocol::Tcp
                && TransportProtocol::try_from(entry.protocol).ok() == Some(id.proto)
                && entry.local_addr == id.dst
                && entry.remote_addr == id.src
            {
                action = Some(Action::Pass);
                break;
            }
            if TransportProtocol::try_from(entry.protocol).ok() != Some(id.proto)
                || entry.local_addr.port() != id.src.port()
                || !(entry.local_addr.ip() == id.src.ip() || entry.local_addr.ip().is_unspecified())
                || (id.proto == TransportProtocol::Tcp && entry.remote_addr != id.dst)
            {
                continue;
            }
            let candidate = if self.job.contains(entry.pid)? {
                Action::Capture(entry.pid)
            } else {
                Action::Pass
            };
            if action.is_some_and(|previous| previous != candidate) {
                anyhow::bail!("无法唯一确认网络连接所属进程");
            }
            action = Some(candidate);
        }
        if let Some(action) = action {
            if id.proto == TransportProtocol::Tcp {
                self.flows.insert(id.clone(), action);
            }
            return self.apply(packet, action, net).await;
        }
        // A network event can precede its socket event. Never infer direct from
        // a missing owner. Bound buffering; a missing event stops this session.
        if self.pending.len() >= 256 || self.pending_bytes + packet.bytes.len() > 8 * 1024 * 1024 {
            anyhow::bail!("代理进程识别队列已满");
        }
        let pending = self.pending.entry(id).or_insert(Pending {
            packets: Vec::new(),
            bytes: 0,
            created: std::time::Instant::now(),
        });
        if pending.bytes + packet.bytes.len() > 65575 {
            anyhow::bail!("代理连接识别超时");
        }
        pending.bytes += packet.bytes.len();
        self.pending_bytes += packet.bytes.len();
        pending.packets.push(packet);
        Ok(())
    }

    async fn socket(
        &mut self,
        address: WINDIVERT_ADDRESS,
        net: &mpsc::Sender<NetworkEvent>,
    ) -> Result<()> {
        if !matches!(
            address.event(),
            WinDivertEvent::SocketConnect | WinDivertEvent::SocketAccept
        ) {
            return Ok(());
        }
        // This event came from the SOCKET layer, which selects this union member.
        let socket = unsafe { address.union_field.Socket };
        let Ok(proto) = TransportProtocol::try_from(socket.protocol) else {
            return Ok(());
        };
        let id = ConnectionId {
            proto,
            src: SocketAddr::new(
                address_ip(socket.local_addr, address.ipv6()),
                socket.local_port,
            ),
            dst: SocketAddr::new(
                address_ip(socket.remote_addr, address.ipv6()),
                socket.remote_port,
            ),
        };
        let action = if matches!(address.event(), WinDivertEvent::SocketConnect)
            && self.job.contains(socket.process_id)?
        {
            Action::Capture(socket.process_id)
        } else {
            Action::Pass
        };
        remember_flow(&mut self.flows, id.clone(), action);
        for (id, action) in [(id.reverse(), Action::Pass), (id, action)] {
            if let Some(pending) = self.pending.remove(&id) {
                self.pending_bytes -= pending.bytes;
                for packet in pending.packets {
                    self.apply(packet, action, net).await?;
                }
            }
        }
        Ok(())
    }

    async fn apply(
        &self,
        packet: Packet,
        action: Action,
        net: &mpsc::Sender<NetworkEvent>,
    ) -> Result<()> {
        match action {
            // Same-handle reinjection continues at lower priorities. A separate
            // send-only handle could skip a concurrent instance's capture.
            Action::Pass => self.packets.send(&packet.address, &packet.bytes),
            Action::Capture(pid) => {
                if self.stopping {
                    return Ok(());
                }
                let Ok(mut parsed) = InternetPacket::try_from(packet.bytes) else {
                    return Ok(());
                };
                if parsed.protocol() == TransportProtocol::Udp {
                    return Ok(());
                }
                if !packet.address.ipchecksum() {
                    parsed.recalculate_ip_checksum();
                }
                if !packet.address.tcpchecksum() {
                    parsed.recalculate_tcp_checksum();
                }
                let Ok(packet) = SmolPacket::try_from(parsed.inner().to_vec()) else {
                    return Ok(());
                };
                match net.try_send(NetworkEvent::ReceivePacket {
                    packet,
                    tunnel_info: TunnelInfo::LocalRedirector {
                        pid: Some(pid),
                        process_name: None,
                        remote_endpoint: None,
                    },
                }) {
                    Ok(()) | Err(mpsc::error::TrySendError::Full(_)) => Ok(()),
                    Err(mpsc::error::TrySendError::Closed(_)) => {
                        Err(anyhow::anyhow!("代理网络引擎已停止"))
                    }
                }
            }
        }
    }

    pub(super) fn begin_shutdown(&mut self) {
        self.stopping = true;
    }

    pub(super) fn stop(&mut self) {
        self.events.close();
        self.sockets.stop();
        self.packets.stop();
    }
}

fn remember_flow(flows: &mut LruCache<ConnectionId, Action>, id: ConnectionId, action: Action) {
    flows.insert(id.reverse(), Action::Pass);
    flows.insert(id, action);
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop();
    }
}

fn address_ip(words: [u32; 4], ipv6: bool) -> IpAddr {
    if ipv6 {
        IpAddr::V6(Ipv6Addr::from(
            words
                .into_iter()
                .rev()
                .fold(0u128, |ip, word| (ip << 32) | u128::from(word)),
        ))
    } else {
        IpAddr::V4(Ipv4Addr::from(words[0]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windivert_addresses_use_host_order_words() {
        assert_eq!(
            address_ip([0xc0000201, 0, 0, 0], false).to_string(),
            "192.0.2.1"
        );
        assert_eq!(
            address_ip([1, 0, 0, 0x20010db8], true).to_string(),
            "2001:db8::1"
        );
    }

    #[test]
    fn reverse_packets_pass_and_new_owners_replace_stale_flow_decisions() {
        let mut flows = LruCache::with_capacity(16);
        let id = ConnectionId {
            proto: TransportProtocol::Tcp,
            src: "192.0.2.1:12345".parse().unwrap(),
            dst: "198.51.100.1:443".parse().unwrap(),
        };
        remember_flow(&mut flows, id.clone(), Action::Capture(123));
        assert_eq!(flows.get(&id), Some(&Action::Capture(123)));
        assert_eq!(flows.get(&id.reverse()), Some(&Action::Pass));
        remember_flow(&mut flows, id.clone(), Action::Pass);
        assert_eq!(flows.get(&id), Some(&Action::Pass));
        assert_eq!(flows.get(&id.reverse()), Some(&Action::Pass));
    }
}
