use crate::codex_startup_patch::{
    CLI_WRAPPER_MARKER_ENV, CLI_WRAPPER_OVERRIDES_ENV, CLI_WRAPPER_SOURCE_ENV,
    CLI_WRAPPER_SUBAGENT_ENV, CLI_WRAPPER_TARGET_ENV, CliWrapperMarker, CliWrapperMarkerStatus,
};
use anyhow::{Context, Result};
use std::{
    ffi::OsString,
    io::Read,
    os::windows::process::CommandExt,
    path::Path,
    process::{Child, Command},
    time::{Duration, Instant},
};

const CONTEXT_ENV: &[(&str, &str)] = &[
    ("WSL_DISTRO_NAME", "w"),
    ("WSL_INTEROP", "w"),
    ("USER", "w"),
    ("PWD", "w"),
    ("CODEX_SQLITE_HOME", "p"),
];
const PROXY_ENV: &[&str] = &[
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
];

fn merge_wslenv(current: &str, entries: &[(&str, &str)]) -> String {
    current
        .split(':')
        .filter(|entry| {
            !entry.is_empty()
                && !entries
                    .iter()
                    .any(|(name, _)| entry.split('/').next() == Some(*name))
        })
        .map(str::to_owned)
        .chain(entries.iter().map(|(name, flags)| {
            if flags.is_empty() {
                (*name).to_owned()
            } else {
                format!("{name}/{flags}")
            }
        }))
        .collect::<Vec<_>>()
        .join(":")
}

pub(crate) fn launch_environment() -> Vec<(String, String)> {
    vec![
        (
            "WSLENV".into(),
            merge_wslenv(&std::env::var("WSLENV").unwrap_or_default(), CONTEXT_ENV),
        ),
        // Only Linux-to-Windows interop may populate the origin markers.
        ("WSL_DISTRO_NAME".into(), String::new()),
        ("WSL_INTEROP".into(), String::new()),
    ]
}

pub(crate) async fn recover_startup(
    ui: &crate::native_update_ui::NativeUpdateUi,
    error: &str,
) -> Result<Option<bool>> {
    super::preferences::recover(
        crate::codex_config::codex_home(),
        ui.confirm_wsl_recovery(error),
    )
    .await
}

#[derive(Debug, PartialEq, Eq)]
struct InteropContext {
    distro: OsString,
    user: Option<OsString>,
    cwd: Option<OsString>,
}

fn nonempty(value: Option<OsString>) -> Option<OsString> {
    value.filter(|value| !value.is_empty())
}

impl InteropContext {
    fn from_values(
        distro: Option<OsString>,
        interop: Option<OsString>,
        user: Option<OsString>,
        cwd: Option<OsString>,
    ) -> Result<Option<Self>> {
        let distro = nonempty(distro);
        if distro.is_none() && nonempty(interop).is_none() {
            return Ok(None);
        }
        let distro = distro.context("WSL CLI 调用缺少发行版，已停止启动 Windows 后端")?;
        let cwd = nonempty(cwd);
        anyhow::ensure!(
            cwd.as_ref()
                .is_none_or(|value| value.to_str().is_some_and(|value| value.starts_with('/'))),
            "WSL CLI 调用缺少有效的 Linux 工作目录"
        );
        Ok(Some(Self {
            distro,
            user: nonempty(user),
            cwd,
        }))
    }
}

fn require_elf(path: &Path, label: &str) -> Result<()> {
    anyhow::ensure!(path.is_absolute(), "{label} 必须使用绝对路径");
    let mut signature = [0; 4];
    std::fs::File::open(path)
        .and_then(|mut file| file.read_exact(&mut signature))
        .with_context(|| {
            format!(
                "{label} 缺失（{}）；请构建或安装包含 WSL 组件的 Codey，本地开发运行 pnpm run dev:wsl",
                path.display()
            )
        })?;
    anyhow::ensure!(signature == *b"\x7fELF", "{label} 不是 Linux 可执行程序");
    Ok(())
}

pub(crate) fn spawn_if_requested(
    target: &Path,
    args: &[OsString],
    overrides: &[String],
    app_server: bool,
) -> Result<Option<Child>> {
    let Some(context) = InteropContext::from_values(
        std::env::var_os("WSL_DISTRO_NAME"),
        std::env::var_os("WSL_INTEROP"),
        std::env::var_os("USER"),
        std::env::var_os("PWD"),
    )?
    else {
        return Ok(None);
    };
    let host = std::env::current_exe()?;
    let helper = std::env::var_os("CODEY_WSL_HELPER")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| host.with_file_name("wsl").join("codey"));
    let native = std::env::var_os(CLI_WRAPPER_SOURCE_ENV)
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| target.to_owned())
        .with_file_name("codex");
    require_elf(&helper, "WSL Codey 运行组件")?;
    require_elf(&native, "WSL Codex 后端")?;
    let ready_dir = tempfile::Builder::new()
        .prefix("codey-wsl-ready-")
        .tempdir()?;
    let marker = ready_dir.path().join("ready.json");
    let mut command = Command::new("wsl.exe");
    command.arg("--distribution").arg(context.distro);
    if let Some(user) = context.user {
        command.arg("--user").arg(user);
    }
    command.arg("--cd").arg(match context.cwd {
        Some(cwd) => cwd,
        None => std::env::current_dir()?.into_os_string(),
    });
    // Values and CLI arguments stay separate from shell syntax.
    command
        .args([
            "--exec",
            "/bin/sh",
            "-c",
            "exec \"$CODEY_WSL_HELPER\" \"$@\"",
            "codey-wsl",
        ])
        .args(args)
        .env("CODEY_WSL_HELPER", &helper)
        .env("CODEY_WSL_WINDOWS_HOST", &host)
        .env(CLI_WRAPPER_TARGET_ENV, &native)
        .env(CLI_WRAPPER_OVERRIDES_ENV, serde_json::to_string(overrides)?)
        .env(CLI_WRAPPER_MARKER_ENV, &marker)
        .env(
            CLI_WRAPPER_SUBAGENT_ENV,
            std::env::var_os(CLI_WRAPPER_SUBAGENT_ENV).unwrap_or_else(|| "0".into()),
        )
        .creation_flags(codey_runtime_core::windows_create_no_window());
    let mut entries = vec![
        ("CODEY_WSL_HELPER", "p"),
        ("CODEY_WSL_WINDOWS_HOST", "p"),
        ("CODEY_WSL_CODEGRAPH_ROOT", "p"),
        (CLI_WRAPPER_TARGET_ENV, "p"),
        (CLI_WRAPPER_MARKER_ENV, "p"),
        (CLI_WRAPPER_OVERRIDES_ENV, ""),
        (CLI_WRAPPER_SUBAGENT_ENV, ""),
        ("CODEX_HOME", "p"),
        ("CODEX_SQLITE_HOME", "p"),
    ];
    entries.extend(PROXY_ENV.iter().map(|name| (*name, "")));
    command.env(
        "WSLENV",
        merge_wslenv(&std::env::var("WSLENV").unwrap_or_default(), &entries),
    );
    let mut child = command.spawn().context("启动 WSL CLI 兼容入口失败")?;
    if app_server && let Err(error) = wait_until_ready(&mut child, &marker) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let _ = codey_runtime_core::diagnostic_log::append_diagnostic_log(
        "launcher.wsl_cli_started",
        serde_json::json!({ "processId": child.id(), "appServer": app_server }),
    );
    Ok(Some(child))
}

fn wait_until_ready(child: &mut Child, marker: &Path) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if let Some(marker) = CliWrapperMarker::read(marker)? {
            match marker.status {
                CliWrapperMarkerStatus::Executed => return Ok(()),
                CliWrapperMarkerStatus::Failed => anyhow::bail!(
                    "{}",
                    marker.message.as_deref().unwrap_or("WSL 后端启动失败")
                ),
                CliWrapperMarkerStatus::Launching => {}
            }
        }
        if let Some(status) = child.try_wait()? {
            anyhow::bail!("WSL 后端在就绪前退出（{status}），未启动 Windows 后端");
        }
        anyhow::ensure!(Instant::now() < deadline, "等待 WSL 后端就绪超时");
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(test)]
#[path = "windows_tests.rs"]
mod tests;
