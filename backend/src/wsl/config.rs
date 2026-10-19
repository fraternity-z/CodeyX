use anyhow::{Context, Result};
use std::path::Path;
use toml_edit::{DocumentMut, InlineTable, Value};

#[cfg(test)]
#[path = "config_tests.rs"]
mod config_tests;

#[cfg(target_os = "linux")]
pub(super) fn map_windows_path(path: &str) -> Result<String> {
    if !is_windows_path(path) {
        anyhow::ensure!(
            Path::new(path).is_absolute(),
            "WSL 运行时文件必须使用绝对路径"
        );
        return Ok(path.to_owned());
    }
    wslpath("-u", path)
}

#[cfg(target_os = "linux")]
pub(super) fn wslpath(direction: &str, path: &str) -> Result<String> {
    let output = std::process::Command::new("wslpath")
        .args([direction, path])
        .output()
        .context("运行 wslpath 失败")?;
    anyhow::ensure!(output.status.success(), "转换 WSL 运行时路径失败");
    let value = String::from_utf8(output.stdout).context("wslpath 返回了无效编码")?;
    let value = value.trim_end_matches(['\r', '\n']);
    anyhow::ensure!(!value.is_empty(), "wslpath 返回了空路径");
    Ok(value.to_owned())
}

pub(super) fn is_windows_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    (bytes.len() > 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\'))
        || path.starts_with("\\\\")
}

pub(super) fn map_overrides(
    overrides: &[String],
    fastctx: &Path,
    windows_host: &Path,
    mut map_path: impl FnMut(&str) -> Result<String>,
) -> Result<Vec<String>> {
    overrides
        .iter()
        .map(|entry| {
            let Some((key, raw)) = entry.split_once('=') else {
                return Ok(entry.clone());
            };
            let key = key.trim();
            let is_path = key == "model_catalog_json"
                || (key.starts_with("agents.") && key.ends_with(".config_file"));
            if !is_path && key != "mcp_servers.codey_fastctx.command" && key != "hooks.state" {
                return Ok(entry.clone());
            }
            let mut parsed: DocumentMut = format!("value={raw}")
                .parse()
                .map_err(|_| anyhow::anyhow!("WSL 运行时配置 {key} 格式无效"))?;
            if key == "hooks.state" {
                let states = parsed["value"]
                    .as_inline_table()
                    .context("WSL hook 信任配置必须是内联表")?;
                let mapped = map_hook_states(states, windows_host, &mut map_path)?;
                parsed["value"] = toml_edit::value(Value::InlineTable(mapped));
            } else {
                let path = parsed["value"]
                    .as_str()
                    .with_context(|| format!("WSL 运行时配置 {key} 必须为字符串"))?;
                let mapped = if key == "mcp_servers.codey_fastctx.command" {
                    fastctx.to_string_lossy().into_owned()
                } else {
                    map_path(path)?
                };
                parsed["value"] = toml_edit::value(mapped);
            }
            Ok(format!(
                "{key}={}",
                parsed["value"].as_value().context("WSL 运行时配置值无效")?
            ))
        })
        .collect()
}

fn map_hook_states(
    states: &InlineTable,
    windows_host: &Path,
    map_path: &mut impl FnMut(&str) -> Result<String>,
) -> Result<InlineTable> {
    let mut mapped = InlineTable::new();
    for (key, state) in states {
        let parts = key.rsplitn(4, ':').collect::<Vec<_>>();
        anyhow::ensure!(parts.len() == 4, "WSL hook 信任标识无效");
        let handler_index: usize = parts[0].parse().context("WSL hook 索引无效")?;
        let group_index: usize = parts[1].parse().context("WSL hook 组索引无效")?;
        let event = parts[2];
        let path = map_path(parts[3])?;
        let contents = crate::fs_util::read_bounded(Path::new(&path), 4 * 1024 * 1024)
            .context("读取 WSL hook 配置失败")?;
        let hooks: serde_json::Value =
            serde_json::from_slice(&contents).context("WSL hook 配置格式无效")?;
        let event_name = event
            .split('_')
            .map(|part| {
                let mut chars = part.chars();
                chars
                    .next()
                    .map(|first| first.to_ascii_uppercase().to_string() + chars.as_str())
                    .unwrap_or_default()
            })
            .collect::<String>();
        let group = &hooks["hooks"][&event_name][group_index];
        let hook = &group["hooks"][handler_index];
        let command = hook["command"].as_str().context("缺少 WSL hook 命令")?;
        let windows_command = hook["commandWindows"]
            .as_str()
            .context("缺少 Windows hook 命令")?;
        let timeout = hook["timeout"].as_u64().context("缺少 WSL hook 超时")?;
        let matcher = group["matcher"].as_str();
        let state = state.as_inline_table().context("WSL hook 信任状态无效")?;
        let trusted_hash = state.get("trusted_hash").and_then(Value::as_str);
        let known_command = [
            crate::subagent_gate::HOOK_ARGUMENT,
            crate::subagent_gate::COMBINED_HOOK_ARGUMENT,
            crate::fastctx_route_gate::HOOK_ARGUMENT,
            crate::conversation_git::tracking::HOOK_ARGUMENT,
        ]
        .iter()
        .any(|argument| {
            command == crate::subagent_gate::windows_posix_hook_command(windows_host, argument)
        });
        anyhow::ensure!(
            known_command
                && hook["type"] == "command"
                && hook.get("async").and_then(serde_json::Value::as_bool) != Some(true)
                && trusted_hash
                    == Some(
                        crate::subagent_gate::hook_trust_hash(
                            event,
                            matcher,
                            windows_command,
                            timeout
                        )
                        .as_str()
                    ),
            "WSL hook 内容与 Codey 受信任配置不一致；请重新通过 Codey 启动"
        );
        let mut state = state.clone();
        state.insert(
            "trusted_hash",
            Value::from(crate::subagent_gate::hook_trust_hash(
                event, matcher, command, timeout,
            )),
        );
        mapped.insert(
            format!("{path}:{event}:{group_index}:{handler_index}"),
            Value::InlineTable(state),
        );
    }
    Ok(mapped)
}

pub(super) async fn map_loopback_url<F, Fut>(value: &str, port: F) -> Result<String>
where
    F: FnOnce(u16) -> Fut,
    Fut: std::future::Future<Output = Result<u16>>,
{
    let Ok(mut url) = reqwest::Url::parse(value) else {
        return Ok(value.to_owned());
    };
    if !matches!(url.host_str(), Some("127.0.0.1" | "localhost")) {
        return Ok(value.to_owned());
    }
    let original = url
        .port_or_known_default()
        .context("WSL 回环 URL 缺少端口")?;
    url.set_host(Some("127.0.0.1"))
        .map_err(|_| anyhow::anyhow!("WSL 回环 URL 主机无效"))?;
    url.set_port(Some(port(original).await?))
        .map_err(|_| anyhow::anyhow!("WSL 回环 URL 端口无效"))?;
    Ok(url.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_runtime_file_paths_are_mapped() {
        let original = vec![
            r#"model_catalog_json="C:\\Users\\user\\catalog.json""#.to_owned(),
            r#"agents.worker.config_file="C:/roles/worker.toml""#.to_owned(),
            r#"mcp_servers.codey_fastctx.command="C:/tools/fastctx.exe""#.to_owned(),
            r#"developer_instructions="Do not alter C:/project in text""#.to_owned(),
        ];
        let mapped = map_overrides(
            &original,
            Path::new("/opt/codey-fastctx"),
            Path::new("C:/Codey.exe"),
            |path| Ok(format!("/mapped/{}", path.replace('\\', "/"))),
        )
        .unwrap();
        assert!(mapped[0].contains("/mapped/C:/Users/user/catalog.json"));
        assert!(mapped[1].contains("/mapped/C:/roles/worker.toml"));
        assert_eq!(
            mapped[2],
            r#"mcp_servers.codey_fastctx.command="/opt/codey-fastctx""#
        );
        assert_eq!(mapped[3], original[3]);
    }

    #[test]
    fn invalid_runtime_paths_fail_without_echoing_values() {
        let error = map_overrides(
            &["model_catalog_json=123".into()],
            Path::new("/fastctx"),
            Path::new("C:/Codey.exe"),
            |_| unreachable!(),
        )
        .unwrap_err();
        assert!(error.to_string().contains("model_catalog_json"));
        assert!(!error.to_string().contains("123"));
    }

    #[test]
    fn detects_absolute_windows_paths_only() {
        for path in [r"C:\Users\test", "d:/work", r"\\wsl.localhost\Ubuntu\home"] {
            assert!(is_windows_path(path));
        }
        for path in ["/home/user", "C:relative", "relative/path", ""] {
            assert!(!is_windows_path(path));
        }
    }

    #[tokio::test]
    async fn loopback_bridge_preserves_url_components_and_remote_urls() {
        let mapped = map_loopback_url("http://127.0.0.1:4321/v1?foo=1", |port| async move {
            assert_eq!(port, 4321);
            Ok(5678)
        })
        .await
        .unwrap();
        assert_eq!(mapped, "http://127.0.0.1:5678/v1?foo=1");
        let remote = "https://api.example.test/v1";
        assert_eq!(
            map_loopback_url(remote, |_| async {
                panic!("remote URL must not be tunneled")
            })
            .await
            .unwrap(),
            remote
        );
    }
}
