use super::config::{map_overrides, map_windows_path};
use anyhow::{Context, Result};
use std::{
    ffi::OsString,
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::{
    io::AsyncWriteExt,
    net::{TcpListener, TcpStream},
    task::JoinSet,
};

struct Bridges {
    host: PathBuf,
    ports: std::collections::HashMap<u16, u16>,
    tasks: JoinSet<()>,
}

impl Bridges {
    async fn port(&mut self, port: u16) -> Result<u16> {
        if let Some(mapped) = self.ports.get(&port) {
            return Ok(*mapped);
        }
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .context("创建 WSL 本地回环转发失败")?;
        let mapped = listener.local_addr()?.port();
        let host = self.host.clone();
        self.tasks.spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else { break };
                        if connections.len() < 64 {
                            let host = host.clone();
                            connections.spawn(async move { let _ = bridge_connection(stream, &host, port).await; });
                        }
                    }
                    _ = connections.join_next(), if !connections.is_empty() => {}
                }
            }
        });
        self.ports.insert(port, mapped);
        Ok(mapped)
    }

    async fn url(&mut self, value: &str) -> Result<String> {
        super::config::map_loopback_url(value, |port| self.port(port)).await
    }
}

async fn bridge_connection(stream: TcpStream, host: &Path, port: u16) -> Result<()> {
    let mut child = tokio::process::Command::new(host)
        .args([super::TCP_ARGUMENT, &port.to_string()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .context("启动 Windows 回环转发失败")?;
    let mut input = child.stdin.take().context("Windows 转发输入不可用")?;
    let mut output = child.stdout.take().context("Windows 转发输出不可用")?;
    let (mut reader, mut writer) = stream.into_split();
    let upstream = async {
        tokio::io::copy(&mut reader, &mut input).await?;
        input.shutdown().await
    };
    let downstream = async {
        tokio::io::copy(&mut output, &mut writer).await?;
        writer.shutdown().await
    };
    tokio::pin!(upstream);
    tokio::pin!(downstream);
    tokio::select! {
        result = &mut downstream => result?,
        result = &mut upstream => { result?; downstream.await?; }
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
    Ok(())
}

fn require_elf(path: &Path, label: &str) -> Result<()> {
    anyhow::ensure!(path.is_absolute(), "{label} 必须使用 Linux 绝对路径");
    let mut signature = [0_u8; 4];
    std::fs::File::open(path)
        .and_then(|mut file| file.read_exact(&mut signature))
        .with_context(|| format!("读取 {label} 失败；请安装包含 WSL 组件的 Codey"))?;
    anyhow::ensure!(&signature == b"\x7fELF", "{label} 不是 Linux 可执行程序");
    Ok(())
}

pub(super) fn run(args: Vec<OsString>) -> Result<bool> {
    use crate::codex_startup_patch::{
        CliWrapperMarker, CliWrapperMarkerStatus, cli_wrapper_marker_path_from_env,
    };
    let marker =
        cli_wrapper_marker_path_from_env(std::env::var_os("CODEY_CODEX_CLI_WRAPPER_MARKER"));
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;
    let result = runtime.block_on(run_backend(args, marker.as_deref()));
    runtime.shutdown_background();
    match result {
        Ok(status) => std::process::exit(status.code().unwrap_or(1)),
        Err(error) => {
            if let Some(path) = marker {
                let mut failure = CliWrapperMarker::new(CliWrapperMarkerStatus::Failed);
                failure.message = Some(format!("{error:#}"));
                failure.retryable = Some(false);
                let _ = failure.write(&path);
            }
            Err(error)
        }
    }
}

async fn run_backend(
    args: Vec<OsString>,
    marker: Option<&Path>,
) -> Result<std::process::ExitStatus> {
    use crate::codex_startup_patch::{
        CliWrapperMarker, CliWrapperMarkerStatus, local_router_runtime_enabled,
        rewrite_app_server_args, route_local_app_server_input,
    };
    let executable = std::env::current_exe()?;
    let target = PathBuf::from(
        std::env::var_os("CODEY_CODEX_CLI_WRAPPER_TARGET").context("缺少 WSL Codex 后端路径")?,
    );
    require_elf(&target, "WSL Codex 后端")?;
    anyhow::ensure!(
        target.canonicalize()? != executable.canonicalize()?,
        "WSL Codex 后端不能指向 Codey 自身"
    );
    let app_server = args.iter().any(|arg| arg == "app-server");
    let host = PathBuf::from(
        std::env::var_os("CODEY_WSL_WINDOWS_HOST").context("缺少 Windows Codey 路径")?,
    );
    anyhow::ensure!(
        host.is_absolute() && host.is_file(),
        "Windows Codey 回环转发程序不存在"
    );
    let mut bridges = Bridges {
        host,
        ports: Default::default(),
        tasks: JoinSet::new(),
    };
    let mut overrides = Vec::new();
    let mut proxy_env = Vec::new();
    if app_server {
        if let Some(path) = marker {
            CliWrapperMarker::new(CliWrapperMarkerStatus::Launching).write(path)?;
        }
        let raw = std::env::var("CODEY_CODEX_CLI_WRAPPER_OVERRIDES")
            .context("缺少 WSL Codey 运行时配置")?;
        let supplied: Vec<String> =
            serde_json::from_str(&raw).context("WSL Codey 运行时配置格式无效")?;
        let fastctx = executable.with_file_name("codey-fastctx");
        if supplied
            .iter()
            .any(|value| value.starts_with("mcp_servers.codey_fastctx.command="))
        {
            require_elf(&fastctx, "WSL FastCtx")?;
        }
        let windows_host = super::config::wslpath("-w", &bridges.host.to_string_lossy())?;
        overrides = map_overrides(
            &supplied,
            &fastctx,
            Path::new(&windows_host),
            map_windows_path,
        )?;
        if let Some(root) = std::env::var_os("CODEY_WSL_CODEGRAPH_ROOT") {
            let path = crate::codex_config::codex_home().join("config.toml");
            if path.try_exists()? {
                let bytes = crate::fs_util::read_bounded(&path, 4 * 1024 * 1024)?;
                let document = std::str::from_utf8(&bytes)
                    .context("Codex 配置编码无效")?
                    .parse::<toml_edit::DocumentMut>()
                    .map_err(|_| anyhow::anyhow!("Codex 配置格式无效"))?;
                overrides.extend(super::codegraph::overrides(
                    &document,
                    Path::new(&root),
                    &executable,
                    map_windows_path,
                )?);
            }
        }
        for entry in &mut overrides {
            if let Some((key, value)) = entry.split_once('=')
                && key.trim() == "model_providers.codey_router.base_url"
            {
                let parsed: toml_edit::DocumentMut = format!("value={value}")
                    .parse()
                    .map_err(|_| anyhow::anyhow!("Codey 路由 URL 配置格式无效"))?;
                let url = parsed["value"]
                    .as_str()
                    .context("Codey 路由 URL 必须为字符串")?;
                *entry = format!("{key}={}", toml_edit::Value::from(bridges.url(url).await?));
            }
        }
        for key in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ] {
            if let Ok(value) = std::env::var(key) {
                proxy_env.push((key, bridges.url(&value).await?));
            }
        }
        for key in ["NO_PROXY", "no_proxy"] {
            let value = std::env::var(key).unwrap_or_default();
            proxy_env.push((key, format!("{value},127.0.0.1,localhost,::1")));
        }
    }
    let routed = local_router_runtime_enabled(&overrides);
    let mut command = tokio::process::Command::new(&target);
    command
        .args(rewrite_app_server_args(&args, &overrides)?)
        .envs(proxy_env)
        .env_remove("CODEX_CLI_PATH")
        .env_remove("NODE_OPTIONS")
        .env_remove("CODEY_CODEX_CLI_WRAPPER_TARGET")
        .env_remove("CODEY_CODEX_CLI_WRAPPER_OVERRIDES")
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    if std::env::var("CODEY_CODEX_CLI_WRAPPER_SUBAGENT").as_deref() == Ok("1") {
        command
            .env(crate::subagent_gate::RUNTIME_ACTIVE_ENV, "1")
            .env(
                crate::subagent_gate::RUNTIME_ID_ENV,
                uuid::Uuid::new_v4().to_string(),
            );
    }
    // Reuse the existing provider rewrite; Linux path-bearing JSON stays intact.
    let mut relay = None;
    if routed {
        let (reader, writer) = std::os::unix::net::UnixStream::pair()?;
        command.stdin(Stdio::from(std::os::fd::OwnedFd::from(reader)));
        relay = Some((writer, overrides));
    } else {
        command.stdin(Stdio::inherit());
    }
    let mut child = command.spawn().context("启动 Linux Codex 后端失败")?;
    if let Some((writer, overrides)) = relay {
        std::thread::spawn(move || {
            let _ = route_local_app_server_input(std::io::stdin().lock(), writer, &overrides);
        });
    }
    if app_server && let Some(path) = marker {
        CliWrapperMarker::new(CliWrapperMarkerStatus::Executed).write(path)?;
    }
    let status = child.wait().await.context("等待 Linux Codex 后端失败")?;
    bridges.tasks.shutdown().await;
    Ok(status)
}
