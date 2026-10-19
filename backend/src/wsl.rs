//! Codex Desktop's local WSL transport uses native Linux tools and a stdio
//! tunnel to the Windows loopback router, including under WSL NAT networking.
use anyhow::{Context, Result};
use std::{net::Ipv4Addr, time::Duration};
use tokio::io::AsyncWriteExt;

#[cfg(any(target_os = "linux", test))]
mod codegraph;
#[cfg(any(target_os = "linux", test))]
mod config;
#[cfg(any(windows, test))]
mod preferences;
#[cfg(target_os = "linux")]
mod runtime;
#[cfg(windows)]
pub(crate) mod windows;

const TCP_ARGUMENT: &str = "--codey-wsl-tcp";

pub(crate) fn run_if_requested() -> Result<bool> {
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    #[cfg(windows)]
    if args.first().is_some_and(|arg| arg == "--codey-wsl-status") {
        anyhow::ensure!(args.len() == 1, "WSL 设置查询不接受额外参数");
        println!(
            "{}",
            preferences::Preferences::load(crate::codex_config::codex_home())?.enabled()?
        );
        return Ok(true);
    }
    #[cfg(target_os = "linux")]
    if codegraph::run_if_requested(&args)? {
        return Ok(true);
    }
    if args.first().is_some_and(|arg| arg == TCP_ARGUMENT) {
        anyhow::ensure!(args.len() == 2, "WSL 回环转发需要一个端口参数");
        let port = args[1]
            .to_str()
            .and_then(|value| value.parse::<u16>().ok())
            .filter(|port| *port != 0)
            .context("WSL 回环转发端口必须在 1–65535 之间")?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let result = runtime.block_on(relay_loopback(port));
        // Tokio's stdin worker can still be waiting when the peer closes.
        runtime.shutdown_background();
        result?;
        return Ok(true);
    }
    #[cfg(target_os = "linux")]
    if std::env::var_os("CODEY_WSL_HELPER").is_some()
        && std::env::var_os("CODEY_CODEX_CLI_WRAPPER_TARGET").is_some()
    {
        return runtime::run(args);
    }
    Ok(false)
}

async fn relay_loopback(port: u16) -> Result<()> {
    let stream = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port)),
    )
    .await
    .context("连接 Windows 回环服务超时")?
    .context("连接 Windows 回环服务失败")?;
    let (mut reader, mut writer) = stream.into_split();
    let upstream = async {
        tokio::io::copy(&mut tokio::io::stdin(), &mut writer).await?;
        writer.shutdown().await
    };
    let downstream = async {
        tokio::io::copy(&mut reader, &mut tokio::io::stdout()).await?;
        tokio::io::stdout().flush().await
    };
    tokio::pin!(upstream);
    tokio::pin!(downstream);
    tokio::select! {
        result = &mut downstream => result?,
        result = &mut upstream => {
            result?;
            downstream.await?;
        }
    }
    Ok(())
}
