#[cfg(target_os = "linux")]
use anyhow::Context;
use anyhow::Result;
use std::path::Path;
use toml_edit::DocumentMut;

const ARGUMENT: &str = "--codey-wsl-codegraph";

// Only Codey's unchanged managed launcher may be translated; user MCPs stay user-owned.
pub(super) fn overrides(
    document: &DocumentMut,
    root: &Path,
    helper: &Path,
    mut map: impl FnMut(&str) -> Result<String>,
) -> Result<Vec<String>> {
    let Some(server) = document
        .get("mcp_servers")
        .and_then(|v| v.get("codey_codegraph"))
    else {
        return Ok(Vec::new());
    };
    if server.get("enabled").and_then(|v| v.as_bool()) == Some(false) || server.get("cwd").is_some()
    {
        return Ok(Vec::new());
    }
    let Some(command) = server.get("command").and_then(|v| v.as_str()) else {
        return Ok(Vec::new());
    };
    if !command.ends_with("node.exe")
        || (!Path::new(command).is_absolute() && !super::config::is_windows_path(command))
    {
        return Ok(Vec::new());
    }
    let Some(args) = server.get("args").and_then(|v| v.as_array()) else {
        return Ok(Vec::new());
    };
    let bundle = crate::codegraph_runtime::bundle(root);
    if Path::new(&map(command)?) != bundle.join("node.exe") || args.len() != 4 {
        return Ok(Vec::new());
    }
    if args.get(0).and_then(|v| v.as_str()) != Some("--liftoff-only")
        || args.get(1).and_then(|v| v.as_str()) != Some("--disable-warning=ExperimentalWarning")
    {
        return Ok(Vec::new());
    }
    for (index, expected) in [
        (2, root.join("auto-mcp-v1.cjs")),
        (3, bundle.join("lib/dist/bin/codegraph.js")),
    ] {
        let Some(value) = args.get(index).and_then(|v| v.as_str()) else {
            return Ok(Vec::new());
        };
        if Path::new(&map(value)?) != expected {
            return Ok(Vec::new());
        }
    }
    let mut result = vec![
        format!(
            "mcp_servers.codey_codegraph.command={}",
            toml_edit::Value::from(helper.to_string_lossy().as_ref())
        ),
        format!("mcp_servers.codey_codegraph.args=[\"{ARGUMENT}\"]"),
        "mcp_servers.codey_codegraph.startup_timeout_sec=660".into(),
    ];
    if let Some(home) = server
        .get("env")
        .and_then(|v| v.get("CODEX_HOME"))
        .and_then(|v| v.as_str())
    {
        result.push(format!(
            "mcp_servers.codey_codegraph.env.CODEX_HOME={}",
            toml_edit::Value::from(map(home)?)
        ));
    }
    Ok(result)
}

#[cfg(target_os = "linux")]
pub(super) fn run_if_requested(args: &[std::ffi::OsString]) -> Result<bool> {
    if args.first().is_none_or(|arg| arg != ARGUMENT) {
        return Ok(false);
    }
    anyhow::ensure!(args.len() == 1, "WSL CodeGraph 启动参数无效");
    use crate::codegraph_runtime as runtime;
    use std::os::unix::{fs::OpenOptionsExt, process::CommandExt};
    let root = crate::config::default_config_path()
        .parent()
        .context("Codey 配置目录无效")?
        .join("builtin-tools/codegraph");
    std::fs::create_dir_all(&root).context("创建 WSL CodeGraph 目录失败")?;
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(root.join("install.lock"))?;
    fs2::FileExt::lock_exclusive(&lock).context("等待 WSL CodeGraph 安装失败")?;
    let executor = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    executor.block_on(runtime::install(root.clone(), reqwest::Client::new()))?;
    runtime::prepare_launcher(&root)?;
    drop(executor);
    drop(lock);
    let config = runtime::mcp_config(&root);
    let args = config["args"]
        .as_array()
        .context("WSL CodeGraph 参数无效")?;
    let error = std::process::Command::new(runtime::executable(&root))
        .args(args.iter().filter_map(serde_json::Value::as_str))
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .exec();
    Err(error).context("启动 Linux CodeGraph 失败")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wsl_maps_only_the_managed_enabled_launcher() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let config = crate::codegraph_runtime::mcp_config(root);
        let mut document = DocumentMut::new();
        let server = &mut document["mcp_servers"]["codey_codegraph"];
        server["command"] = toml_edit::value(
            crate::codegraph_runtime::bundle(root)
                .join("node.exe")
                .to_str()
                .unwrap(),
        );
        server["args"] = toml_edit::value(
            config["args"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap())
                .collect::<toml_edit::Array>(),
        );
        server["env"]["CODEX_HOME"] = toml_edit::value("C:/codex");
        let map = |value: &str| {
            Ok(if value == "C:/codex" {
                "/mnt/c/codex".into()
            } else {
                value.into()
            })
        };
        let mapped = overrides(&document, root, Path::new("/opt/codey"), map).unwrap();
        assert_eq!(mapped.len(), 4);
        assert!(mapped[0].contains("/opt/codey"));
        assert!(mapped[3].contains("/mnt/c/codex"));
        for (key, value) in [
            ("enabled", toml_edit::value(false)),
            ("cwd", toml_edit::value("/custom")),
            ("command", toml_edit::value("/custom/node")),
        ] {
            let mut changed = document.clone();
            changed["mcp_servers"]["codey_codegraph"][key] = value;
            assert!(
                overrides(&changed, root, Path::new("/opt/codey"), map)
                    .unwrap()
                    .is_empty()
            );
        }
        document["mcp_servers"]["codey_codegraph"]["args"][2] =
            toml_edit::value("/user/launcher.cjs");
        assert!(
            overrides(&document, root, Path::new("/opt/codey"), map)
                .unwrap()
                .is_empty()
        );
        assert!(
            overrides(
                &DocumentMut::new(),
                root,
                Path::new("/opt/codey"),
                |_| unreachable!()
            )
            .unwrap()
            .is_empty()
        );
    }
}
