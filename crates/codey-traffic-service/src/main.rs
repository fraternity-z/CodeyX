#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("traffic.service_failed: {error}");
        std::process::exit(1);
    }
}

async fn run() -> anyhow::Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args == ["--version"] {
        println!(
            "codey-traffic-service {} protocol 1",
            env!("CARGO_PKG_VERSION")
        );
        return Ok(());
    }
    anyhow::ensure!(
        args.len() == 4 && args[0] == "--session" && args[2] == "--controller",
        "用法：codey-traffic-service --session <UUID> --controller <PID>；由 CodeyX 启动，凭据不通过命令行传入"
    );
    let session =
        uuid::Uuid::parse_str(&args[1]).map_err(|_| anyhow::anyhow!("代理服务会话标识无效"))?;
    let controller = args[3]
        .parse::<u32>()
        .map_err(|_| anyhow::anyhow!("代理服务控制进程无效"))?;
    #[cfg(windows)]
    return codey_traffic_service::run(session, controller).await;
    #[cfg(not(windows))]
    {
        let _ = (session, controller);
        anyhow::bail!("当前接管服务仅支持 Windows；其他平台保留既有代理行为")
    }
}
