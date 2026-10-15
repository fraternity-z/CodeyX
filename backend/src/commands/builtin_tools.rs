//! 内置工具入口：开关接入用户 MCP，项目由 MCP 启动钩子自动识别和维护。
mod runtime;

use super::{AppState, argument, string_argument};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::{Mutex, Semaphore};

const SERVER_ID: &str = "codey_codegraph";

pub(super) struct ToolState {
    operation: Arc<Semaphore>,
    job: Mutex<Option<Value>>,
}

impl Default for ToolState {
    fn default() -> Self {
        Self {
            operation: Arc::new(Semaphore::new(1)),
            job: Mutex::new(None),
        }
    }
}

fn root(state: &AppState) -> Result<PathBuf> {
    Ok(state
        .store
        .path()
        .parent()
        .context("Codey 配置目录无效")?
        .join("builtin-tools/codegraph"))
}

// 每个项目单独原子写入，多个聊天不会互相覆盖最近项目记录。
fn projects(root: &Path) -> Result<Vec<Value>> {
    let entries = match std::fs::read_dir(root.join("projects")) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error).context("无法读取 CodeGraph 项目状态"),
    };
    let mut records = Vec::new();
    for entry in entries.take(1000) {
        let entry = entry?;
        if entry.path().extension().and_then(|value| value.to_str()) != Some("json")
            || !entry.file_type()?.is_file()
        {
            continue;
        }
        let Ok(bytes) = crate::fs_util::read_bounded(&entry.path(), 16 * 1024) else {
            continue;
        };
        let Ok(record) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        if record["projectPath"].is_string()
            && record["updatedAt"].is_u64()
            && matches!(
                record["phase"].as_str(),
                Some("indexing" | "watching" | "failed")
            )
        {
            records.push(record);
        }
    }
    records.sort_by_key(|record| std::cmp::Reverse(record["updatedAt"].as_u64()));
    records.truncate(10);
    Ok(records)
}

async fn extension(state: &Arc<AppState>, request: Value) -> Result<Value> {
    super::extensions::invoke(state, &json!({"request":request}))
        .await
        .map_err(anyhow::Error::msg)
}

fn is_codegraph(id: &str, config: &Value) -> bool {
    let mentions = |text: &str| text.to_ascii_lowercase().contains("codegraph");
    mentions(id)
        || config["command"].as_str().is_some_and(mentions)
        || config["args"]
            .as_array()
            .is_some_and(|args| args.iter().filter_map(Value::as_str).any(mentions))
}

fn is_managed(id: &str, config: &Value, root: &Path) -> bool {
    let expected = runtime::mcp_config(root);
    id == SERVER_ID
        && config["command"] == expected["command"]
        && config.get("cwd").is_none_or(Value::is_null)
        && (config["args"] == expected["args"] || config["args"] == runtime::legacy_mcp_args(root))
}

// 人工配置（包括停用状态）优先，只有 Codey 创建且启动参数未改写的条目可切换。
async fn mcp_status(state: &Arc<AppState>) -> Result<(Value, Value)> {
    let scope = json!({"kind":"user"});
    let inventory = extension(state, json!({"action":"list", "scope":scope})).await?;
    let root = root(state)?;
    let mut managed = None;
    for entry in inventory["mcps"].as_array().context("MCP 清单无效")? {
        let id = entry["id"].as_str().context("MCP 标识无效")?;
        let document =
            extension(state, json!({"action":"get_mcp", "scope":scope, "id":id})).await?;
        let config = &document["configJson"];
        if !is_codegraph(id, config) {
            continue;
        }
        let own = is_managed(id, config, &root);
        let status = json!({"id":id,"enabled":entry["enabled"] == true,"managed":own,
            "automatic":own && config["args"] == runtime::mcp_config(&root)["args"]});
        if !own {
            return Ok((status, inventory));
        }
        managed = Some(status);
    }
    Ok((
        managed.unwrap_or(json!({"enabled":false,"managed":false,"automatic":false})),
        inventory,
    ))
}

async fn status(state: &Arc<AppState>) -> Result<Value> {
    let root = root(state)?;
    let (mcp, _) = mcp_status(state).await?;
    let installed = runtime::installed(&root);
    let projects = tokio::task::spawn_blocking(move || projects(&root)).await??;
    Ok(
        json!({"installed":installed,"version":runtime::VERSION,"projects":projects,"mcp":mcp,
        "job":state.builtin_tools.job.lock().await.clone()}),
    )
}

async fn enable(state: &Arc<AppState>) -> Result<String> {
    let root = root(state)?;
    runtime::install(root.clone(), state.http_client.clone()).await?;
    let launcher_root = root.clone();
    tokio::task::spawn_blocking(move || runtime::prepare_launcher(&launcher_root)).await??;
    // 下载可能耗时，落盘前重新读取并校验，保留期间人工配置的改动。
    let (current, inventory) = mcp_status(state).await?;
    ensure!(
        !current["id"].is_string() || current["managed"] == true,
        "已存在用户管理的 CodeGraph MCP，请在 MCP 管理中处理"
    );
    let config = if current["id"].is_string() {
        let document = extension(state, json!({"action":"get_mcp","id":SERVER_ID})).await?;
        let mut config = document["configJson"].clone();
        ensure!(
            is_managed(SERVER_ID, &config, &root),
            "CodeGraph 配置已被修改，请刷新后重试"
        );
        config["args"] = runtime::mcp_config(&root)["args"].clone();
        config["enabled"] = json!(true);
        config
    } else {
        runtime::mcp_config(&root)
    };
    let saved = extension(
        state,
        json!({"action":"save_mcp","id":SERVER_ID,"createOnly":!current["id"].is_string(),
        "confirmed":true,"revision":inventory["revision"],"configJson":config}),
    )
    .await?;
    Ok(saved["message"]
        .as_str()
        .unwrap_or("配置已保存，请重新打开项目聊天。")
        .into())
}

pub(super) async fn invoke(
    state: &Arc<AppState>,
    args: &Value,
) -> std::result::Result<Value, String> {
    invoke_inner(state, args)
        .await
        .map_err(|error| format!("{error:#}"))
}

async fn invoke_inner(state: &Arc<AppState>, args: &Value) -> Result<Value> {
    let action = string_argument(args, "action").map_err(anyhow::Error::msg)?;
    if action == "status" {
        return status(state).await;
    }
    ensure!(action == "set_enabled", "未知内置工具操作");
    ensure!(!state.is_shutting_down(), "Codey 正在退出，请稍后重试");
    let enabled = argument::<bool>(args, "enabled").map_err(anyhow::Error::msg)?;
    let permit = state
        .builtin_tools
        .operation
        .clone()
        .try_acquire_owned()
        .context("已有 CodeGraph 操作进行中，请等待完成")?;
    let (current, inventory) = mcp_status(state).await?;
    ensure!(
        !current["id"].is_string() || current["managed"] == true,
        "该 CodeGraph MCP 由用户管理，请到 MCP 管理中修改"
    );
    if !enabled {
        let mut message = "CodeGraph 自动接入已关闭。".to_string();
        if current["id"].is_string() {
            let saved = extension(state, json!({"action":"set_mcp_enabled","id":SERVER_ID,"enabled":false,"confirmed":true,"revision":inventory["revision"]})).await?;
            if let Some(saved_message) = saved["message"].as_str() {
                message.push_str(saved_message);
            }
        }
        *state.builtin_tools.job.lock().await = None;
        let mut snapshot = status(state).await?;
        snapshot["message"] = json!(message);
        return Ok(snapshot);
    }
    let job = json!({"id":uuid::Uuid::new_v4().to_string(),"phase":"running","message":"正在准备 CodeGraph 自动接入，首次启用需下载官方运行包…"});
    *state.builtin_tools.job.lock().await = Some(job);
    let worker = Arc::clone(state);
    tokio::spawn(async move {
        let _permit = permit;
        let task_state = Arc::clone(&worker);
        let outcome = tokio::spawn(async move { enable(&task_state).await }).await;
        let mut guard = worker.builtin_tools.job.lock().await;
        if let Some(job) = guard.as_mut() {
            match outcome {
                Ok(Ok(message)) => {
                    job["phase"] = json!("succeeded");
                    job["message"] = json!(format!(
                        "自动接入已启用。{message}项目索引会在后台建立并自动同步。"
                    ));
                }
                result => {
                    job["phase"] = json!("failed");
                    job["message"] = json!(match result {
                        Ok(Err(error)) => format!("{error:#}"),
                        _ => "CodeGraph 接入任务异常退出，请重试".into(),
                    });
                }
            }
        }
    });
    status(state).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_owned_launchers_and_legacy_configs_can_be_migrated() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = runtime::mcp_config(dir.path());
        assert!(is_managed(SERVER_ID, &config, dir.path()));
        assert!(config.get("cwd").is_none());
        config["args"] = runtime::legacy_mcp_args(dir.path());
        assert!(is_managed(SERVER_ID, &config, dir.path()));
        assert!(!is_managed("user", &config, dir.path()));
        config["cwd"] = json!("custom-project");
        assert!(!is_managed(SERVER_ID, &config, dir.path()));
        let user = json!({"command":"node","args":["custom/codegraph.js"]});
        assert!(is_codegraph("custom", &user));
        assert!(!is_managed(SERVER_ID, &user, dir.path()));
        assert!(!is_codegraph("fastctx", &json!({"command":"fastctx"})));
    }

    #[test]
    fn project_records_are_sorted_bounded_and_tolerate_one_damaged_record() {
        let dir = tempfile::tempdir().unwrap();
        assert!(projects(dir.path()).unwrap().is_empty());
        let records = dir.path().join("projects");
        std::fs::create_dir(&records).unwrap();
        for index in 0..12 {
            std::fs::write(
                records.join(format!("{index}.json")),
                serde_json::to_vec(&json!({
                    "projectPath":format!("project-{index}"),"updatedAt":index,"phase":"watching"
                }))
                .unwrap(),
            )
            .unwrap();
        }
        std::fs::write(records.join("broken.json"), b"{").unwrap();
        let list = projects(dir.path()).unwrap();
        assert_eq!(list.len(), 10);
        assert_eq!(list[0]["projectPath"], "project-11");
    }

    #[tokio::test]
    async fn concurrent_enable_operations_are_rejected_until_completion() {
        let state = ToolState::default();
        let permit = state.operation.clone().try_acquire_owned().unwrap();
        assert!(state.operation.try_acquire().is_err());
        drop(permit);
        assert!(state.operation.try_acquire().is_ok());
    }
}
