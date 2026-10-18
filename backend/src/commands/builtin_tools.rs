//! 内置工具入口：开关接入用户 MCP，项目由 MCP 启动钩子自动识别和维护。
mod ponytail;
mod runtime;

use super::{AppState, argument, string_argument};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::{Mutex, Semaphore};

const SERVER_ID: &str = "codey_codegraph";

pub(super) struct ToolState {
    operation: Arc<Semaphore>,
    job: Mutex<Option<Value>>,
    ponytail_operation: Arc<Semaphore>,
    ponytail_job: Mutex<Option<Value>>,
}

impl Default for ToolState {
    fn default() -> Self {
        Self {
            operation: Arc::new(Semaphore::new(1)),
            job: Mutex::new(None),
            ponytail_operation: Arc::new(Semaphore::new(1)),
            ponytail_job: Mutex::new(None),
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

fn canonical_directory(path: &Path) -> Option<PathBuf> {
    (path.is_absolute() && path.is_dir())
        .then(|| path.canonicalize().ok())
        .flatten()
}

fn workspace_roots(home: &Path, codex_home: &Path) -> Result<Vec<PathBuf>> {
    let location = codex_home.join(".codex-global-state.json");
    if !location
        .try_exists()
        .context("无法读取 Codex 工作区项目清单")?
    {
        return Ok(Vec::new());
    }
    let bytes = crate::fs_util::read_bounded(&location, 16 * 1024 * 1024)
        .context("无法读取 Codex 工作区项目清单")?;
    // 忽略无关状态中的孤立 UTF-16 代理字符，与 Codex 全局状态读取约定一致。
    let state: BTreeMap<String, Box<serde_json::value::RawValue>> = serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("Codex 工作区项目清单格式无效"))?;
    let mut candidates = Vec::new();
    if let Some(projects) = state.get("local-projects") {
        let projects: Value =
            serde_json::from_str(projects.get()).context("Codex 工作区项目清单格式无效")?;
        for project in projects
            .as_object()
            .context("Codex 工作区项目清单格式无效")?
            .values()
        {
            if let Some(roots) = project["rootPaths"].as_array() {
                candidates.extend(roots.iter().filter_map(Value::as_str).map(PathBuf::from));
            }
        }
    } else if let Some(roots) = state.get("electron-saved-workspace-roots") {
        let roots: Value =
            serde_json::from_str(roots.get()).context("Codex 工作区项目清单格式无效")?;
        candidates.extend(
            roots
                .as_array()
                .context("Codex 工作区项目清单格式无效")?
                .iter()
                .filter_map(Value::as_str)
                .map(PathBuf::from),
        );
    }
    let default_home = home.join(".codex");
    let excluded: Vec<_> = [home, codex_home, default_home.as_path()]
        .into_iter()
        .filter_map(canonical_directory)
        .collect();
    let mut roots = Vec::new();
    for path in candidates
        .iter()
        .filter_map(|path| canonical_directory(path))
    {
        if path.parent().is_some() && !excluded.contains(&path) && !roots.contains(&path) {
            roots.push(path);
        }
    }
    Ok(roots)
}

// 每个项目单独原子写入；展示时核对当前工作区，保留磁盘上的历史记录和索引。
fn projects(root: &Path, home: &Path, codex_home: &Path) -> Result<Vec<Value>> {
    let entries = match std::fs::read_dir(root.join("projects")) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error).context("无法读取 CodeGraph 项目状态"),
    };
    let allowed = workspace_roots(home, codex_home)?;
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
        if record["projectPath"]
            .as_str()
            .and_then(|path| canonical_directory(Path::new(path)))
            .is_some_and(|path| allowed.contains(&path))
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
    let projects = tokio::task::spawn_blocking(move || {
        let user = directories::BaseDirs::new().context("无法确定当前用户目录")?;
        projects(&root, user.home_dir(), crate::codex_config::codex_home())
    })
    .await??;
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
        if config["env"].is_null() {
            config["env"] = json!({});
        }
        config["env"]
            .as_object_mut()
            .context("CodeGraph 环境配置无效，请检查 MCP 配置")?
            .entry("CODEX_HOME")
            .or_insert_with(|| json!(crate::codex_config::codex_home()));
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
    if args["tool"] == "ponytail" {
        return ponytail::invoke(state, args).await;
    }
    ensure!(args.get("tool").is_none(), "未知内置工具");
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
        assert_eq!(
            config["env"]["CODEX_HOME"],
            json!(crate::codex_config::codex_home())
        );
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
        let home = dir.path().join("home");
        let codex_home = home.join(".codex");
        std::fs::create_dir_all(&codex_home).unwrap();
        assert!(projects(dir.path(), &home, &codex_home).unwrap().is_empty());
        let records = dir.path().join("projects");
        std::fs::create_dir(&records).unwrap();
        let mut roots = Vec::new();
        for index in 0..12 {
            let project = dir.path().join(format!("project-{index}"));
            std::fs::create_dir(&project).unwrap();
            std::fs::write(
                records.join(format!("{index}.json")),
                serde_json::to_vec(&json!({
                    "projectPath":project,"updatedAt":index,"phase":"watching"
                }))
                .unwrap(),
            )
            .unwrap();
            roots.push(project);
        }
        let state_path = codex_home.join(".codex-global-state.json");
        std::fs::write(
            &state_path,
            json!({"local-projects":{"p":{"rootPaths":roots}}}).to_string(),
        )
        .unwrap();
        std::fs::write(records.join("broken.json"), b"{").unwrap();
        // 旧版误收录的聊天目录不能占用最近项目名额，即使已有索引。
        for (index, path) in [
            codex_home.clone(),
            home.join("Documents/Codex/chat"),
            home.join("AppData/Local/Programs/Codex"),
        ]
        .iter()
        .enumerate()
        {
            std::fs::create_dir_all(path.join(".codegraph")).unwrap();
            std::fs::write(
                records.join(format!("unlisted-{index}.json")),
                json!({"projectPath":path,"updatedAt":100 + index,"phase":"failed"}).to_string(),
            )
            .unwrap();
        }
        let list = projects(dir.path(), &home, &codex_home).unwrap();
        assert_eq!(list.len(), 10);
        assert_eq!(list[0]["projectPath"], json!(roots[11]));
        roots.pop();
        std::fs::write(
            &state_path,
            json!({"local-projects":{"p":{"rootPaths":roots}}}).to_string(),
        )
        .unwrap();
        let list = projects(dir.path(), &home, &codex_home).unwrap();
        assert_eq!(list[0]["projectPath"], json!(roots[10]));
        assert!(records.join("11.json").is_file());
        assert!(codex_home.join(".codegraph").is_dir());
    }

    #[test]
    fn workspace_roots_use_saved_projects_and_exclude_special_directories() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let default_home = home.join(".codex");
        let codex_home = dir.path().join("custom-codex");
        let project = dir.path().join("中文 project");
        let other = dir.path().join("other");
        for path in [&default_home, &codex_home, &project, &other] {
            std::fs::create_dir_all(path).unwrap();
        }
        let disk = dir.path().ancestors().last().unwrap();
        let state = json!({"local-projects":{
            "p":{"rootPaths":[project,other,project,home,codex_home,default_home,disk,"relative",null,dir.path().join("missing")]},
            "invalid":{"rootPaths":"relative"}
        },"electron-saved-workspace-roots":[dir.path()]});
        let state_path = codex_home.join(".codex-global-state.json");
        std::fs::write(&state_path, state.to_string()).unwrap();
        assert_eq!(
            workspace_roots(&home, &codex_home).unwrap(),
            vec![
                project.canonicalize().unwrap(),
                other.canonicalize().unwrap()
            ]
        );
        std::fs::write(
            &state_path,
            json!({"electron-saved-workspace-roots":[project]}).to_string(),
        )
        .unwrap();
        assert_eq!(
            workspace_roots(&home, &codex_home).unwrap(),
            vec![project.canonicalize().unwrap()]
        );
        std::fs::write(
            &state_path,
            json!({"local-projects":{},"electron-saved-workspace-roots":[project]}).to_string(),
        )
        .unwrap();
        assert!(workspace_roots(&home, &codex_home).unwrap().is_empty());
        std::fs::write(&state_path, r#"{"local-projects":{},"unrelated":"\ud800"}"#).unwrap();
        assert!(workspace_roots(&home, &codex_home).unwrap().is_empty());
    }

    #[test]
    fn missing_or_invalid_workspace_state_never_authorizes_projects() {
        let dir = tempfile::tempdir().unwrap();
        assert!(workspace_roots(dir.path(), dir.path()).unwrap().is_empty());
        let location = dir.path().join(".codex-global-state.json");
        for contents in [
            "{",
            "null",
            "[]",
            r#""private-state""#,
            r#"{"local-projects":null}"#,
            r#"{"local-projects":[]}"#,
            r#"{"electron-saved-workspace-roots":{}}"#,
            r#"{"electron-saved-workspace-roots":null}"#,
        ] {
            std::fs::write(&location, contents).unwrap();
            let error = workspace_roots(dir.path(), dir.path()).unwrap_err();
            assert!(!format!("{error:#}").contains("private-state"));
        }
        std::fs::write(&location, vec![b' '; 16 * 1024 * 1024 + 1]).unwrap();
        assert!(workspace_roots(dir.path(), dir.path()).is_err());
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
