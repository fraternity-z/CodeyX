mod capture;
mod job;
mod priority;
mod streams;

use std::{os::windows::io::AsRawHandle, sync::Arc, time::Duration};

use anyhow::{Context, Result};
use tokio::{io::AsyncReadExt, net::windows::named_pipe::ClientOptions, sync::mpsc};
use windows::Win32::{Foundation::HANDLE, System::Pipes::GetNamedPipeServerProcessId};

use crate::protocol::{self, Reply, Start};

/// Connect only to the caller's private, per-launch pipe. An empty job is a
/// prerequisite: the launcher must wait for Ready before assigning/resuming Codex.
/// WinDivert loads its signed driver on demand; system proxy, routes and
/// certificates are not changed.
pub async fn run(session: uuid::Uuid, controller_pid: u32) -> Result<()> {
    anyhow::ensure!(
        controller_pid > 4 && controller_pid != std::process::id(),
        "代理服务控制进程无效"
    );
    let pipe = protocol::pipe_name(session).map_err(anyhow::Error::msg)?;
    let mut control = ClientOptions::new()
        .open(pipe)
        .context("无法连接 CodeyX 代理控制通道")?;
    let mut owner = 0;
    unsafe { GetNamedPipeServerProcessId(HANDLE(control.as_raw_handle()), &mut owner) }
        .context("无法核验 CodeyX 代理控制通道")?;
    anyhow::ensure!(
        owner == controller_pid,
        "代理控制通道不属于本次启动的 CodeyX"
    );
    let config: Start =
        tokio::time::timeout(Duration::from_secs(10), protocol::read_frame(&mut control))
            .await
            .context("读取代理启动配置超时")?
            .map_err(anyhow::Error::msg)?;
    config.validate().map_err(anyhow::Error::msg)?;
    let job = Arc::new(job::Job::open(
        &protocol::job_name(session).map_err(anyhow::Error::msg)?,
    )?);
    anyhow::ensure!(job.empty()?, "代理进程组必须为空，不能接管正在运行的应用");
    let (transport_tx, transport_rx) = mpsc::channel(64);
    let (command_tx, command_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, shutdown_rx) = mitmproxy::shutdown::channel();
    let (mut network, net_tx, mut net_rx) =
        mitmproxy::network::add_network_layer(transport_tx, command_rx, shutdown_rx);
    let mut capture = capture::Capture::start(job.clone())?;
    let mut forwarding = tokio::spawn(streams::run(transport_rx, command_tx, Arc::new(config)));
    protocol::write_frame(
        &mut control,
        &Reply::Ready {
            version: protocol::VERSION,
        },
    )
    .await
    .map_err(anyhow::Error::msg)?;
    let result = {
        let capture_loop = capture.forward(&net_tx, &mut net_rx);
        tokio::pin!(capture_loop);
        let mut stop = [0u8; 1];
        tokio::select! {
            result = &mut capture_loop => result,
            result = &mut network => match result { Ok(Ok(())) => Ok(()), _ => Err(anyhow::anyhow!("代理网络引擎已停止")) },
            _ = &mut forwarding => Err(anyhow::anyhow!("代理转发服务已停止")),
            _ = control.read(&mut stop) => Ok(()),
        }
    };
    // Keep the capture engine alive while terminating the owned job. Never
    // automatically restart unproxied clients after a component failure.
    capture.begin_shutdown();
    let cleanup = {
        let stop = job.stop_clients();
        tokio::pin!(stop);
        tokio::select! {
            result = &mut stop => result,
            _ = capture.forward(&net_tx, &mut net_rx) => stop.await,
        }
    };
    if cleanup.is_err() {
        // Retain capture handles on cleanup failure. Killing this process is not
        // a proven leak-free shutdown; the verification guide states that limit.
        let _ = protocol::write_frame(
            &mut control,
            &Reply::Failed {
                code: "CLIENT_STOP_FAILED".into(),
            },
        )
        .await;
        // Keep passing unrelated traffic while retrying cleanup; do not hold
        // every application's network queue just because our job failed to stop.
        loop {
            let retry = async {
                tokio::time::sleep(Duration::from_secs(1)).await;
                job.stop_clients().await
            };
            tokio::pin!(retry);
            let result = tokio::select! {
                result = &mut retry => result,
                _ = capture.forward(&net_tx, &mut net_rx) => retry.await,
            };
            if result.is_ok() {
                break;
            }
        }
    }
    let _ = shutdown_tx.send(());
    forwarding.abort();
    network.abort();
    capture.stop();
    let reply = if result.is_ok() {
        Reply::Stopped
    } else {
        Reply::Failed {
            code: "CAPTURE_STOPPED".into(),
        }
    };
    let _ = protocol::write_frame(&mut control, &reply).await;
    result
}
