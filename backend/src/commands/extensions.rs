use serde_json::{Value, json};
use std::sync::{Arc, atomic::Ordering};

use super::{AppState, argument};

fn paths(state: &AppState) -> anyhow::Result<(std::path::PathBuf, std::path::PathBuf)> {
    let user_home = directories::BaseDirs::new()
        .ok_or_else(|| anyhow::anyhow!("无法确定当前用户目录"))?
        .home_dir()
        .to_path_buf();
    let data_dir = state
        .store
        .path()
        .parent()
        .ok_or_else(|| anyhow::anyhow!("Codey 配置目录无效"))?
        .join("codex-extensions");
    Ok((data_dir, user_home))
}

pub(super) async fn mcp_status_configurations(
    state: &AppState,
) -> anyhow::Result<Vec<anyhow::Result<Value>>> {
    if state.is_shutting_down() || state.restart_in_progress.load(Ordering::Acquire) {
        anyhow::bail!("Codey 正在退出或重启，请稍后重新操作");
    }
    let (data_dir, user_home) = paths(state)?;
    crate::codex_extensions::mcp_status_configurations(
        crate::codex_config::codex_home().to_path_buf(),
        data_dir,
        user_home,
    )
    .await
}

// Caller owns runtime_operation, so stop cannot remove a newer generation's discovery.
pub(super) async fn ensure_scheduler(state: &AppState) -> anyhow::Result<()> {
    let mut scheduler = state.mcp_scheduler.lock().await;
    if scheduler.is_none() {
        let (data_dir, user_home) = paths(state)?;
        let service = codey_codex_extensions::ExtensionService::new(
            crate::codex_config::codex_home().to_path_buf(),
            data_dir.clone(),
            user_home.clone(),
        );
        if !service.mcp_scheduler_enabled()? {
            return Ok(());
        }
        *scheduler = Some(
            crate::mcp_scheduler::start(
                crate::codex_config::codex_home().to_path_buf(),
                data_dir,
                user_home,
            )
            .await?,
        );
    }
    Ok(())
}

pub(super) async fn stop_scheduler(state: &AppState) {
    let mut scheduler = state.mcp_scheduler.lock().await;
    if let Some(current) = scheduler.take() {
        current.stop().await;
    }
}

fn scoped_status(mut status: Value, config_path: &Value) -> Value {
    if let Some(pools) = status["pools"].as_array_mut() {
        pools.retain(|pool| &pool["sourcePath"] == config_path);
    }
    status
}

pub(super) async fn prepare_shared_fastctx(state: &AppState, enabled: bool) -> anyhow::Result<()> {
    let (data_dir, user_home) = paths(state)?;
    let command = if enabled {
        crate::codex_config::fastctx_server_command().ok()
    } else {
        None
    };
    let _write = state.config_write_lock.lock().await;
    tokio::task::spawn_blocking(move || {
        crate::codex_config::prepare_shared_fastctx(
            crate::codex_config::codex_home(),
            data_dir,
            user_home,
            command.as_deref(),
        )
    })
    .await??;
    Ok(())
}

/// 仅在这里取得宿主路径和生命周期状态；扩展模块不依赖 AppState。
pub(super) async fn invoke(state: &Arc<AppState>, args: &Value) -> Result<Value, String> {
    let request = argument::<Value>(args, "request")?;
    let scheduler_toggle = request["action"] == "set_mcp_scheduler_enabled";
    let scope = request
        .get("scope")
        .cloned()
        .unwrap_or(json!({"kind":"user"}));
    let reload_mcp = matches!(
        request["action"].as_str(),
        Some(
            "save_mcp"
                | "set_mcp_sharing"
                | "set_mcp_enabled"
                | "set_mcps_enabled"
                | "remove_mcp"
                | "set_mcp_scheduler_enabled"
        )
    );
    if state.is_shutting_down() || state.restart_in_progress.load(Ordering::Acquire) {
        return Err("Codey 正在退出或重启，请稍后重新操作".into());
    }
    let (data_dir, user_home) = paths(state).map_err(|error| error.to_string())?;
    if request["action"] == "release_mcp_idle" {
        let _operation = state.runtime_operation.lock().await;
        let scheduler = state.mcp_scheduler.lock().await;
        let released = if let Some(scheduler) = scheduler.as_ref() {
            scheduler.release_idle().await
        } else {
            0
        };
        return Ok(
            json!({"status":"success","released":released,"message":"已释放空闲共享实例，忙碌实例继续运行。"}),
        );
    }
    if request["action"] == "mcp_sharing_status" {
        // The service validates/canonicalizes the scope; never trust a supplied sourcePath.
        let inventory = crate::codex_extensions::dispatch(
            crate::codex_config::codex_home().to_path_buf(), data_dir, user_home,
            json!({"action":"list","scope":request.get("scope").cloned().unwrap_or(json!({"kind":"user"}))}),
        ).await.map_err(|error| error.to_string())?;
        let scheduler = state.mcp_scheduler.lock().await;
        let mut status = scoped_status(
            scheduler
                .as_ref()
                .map_or(json!({"pools":[]}), |s| s.status()),
            &inventory["configPath"],
        );
        status["enabled"] = inventory["mcpSchedulerEnabled"].clone();
        return Ok(status);
    }
    let _operation = if reload_mcp {
        Some(state.runtime_operation.lock().await)
    } else {
        None
    };
    if state.is_shutting_down() || state.restart_in_progress.load(Ordering::Acquire) {
        return Err("Codey 正在退出或重启，请稍后重新操作".into());
    }
    let _write = if reload_mcp {
        Some(state.config_write_lock.lock().await)
    } else {
        None
    };
    let mut result = crate::codex_extensions::dispatch(
        crate::codex_config::codex_home().to_path_buf(),
        data_dir.clone(),
        user_home.clone(),
        request,
    )
    .await
    .map_err(|error| error.to_string())?;
    drop(_write);
    if scheduler_toggle && result["inventory"]["mcpSchedulerEnabled"] == true {
        let fastctx_enabled = state.config.read().await.fast_context_tools;
        if let Err(_error) = prepare_shared_fastctx(state, fastctx_enabled).await {
            result["applyStatus"] = json!("reload-failed");
            result["message"] =
                json!("共享器设置已保存，内置 FastCtx 配置准备失败，请重启 Codey 后重试。");
            return Ok(result);
        }
        result["inventory"] = crate::codex_extensions::dispatch(
            crate::codex_config::codex_home().to_path_buf(),
            data_dir,
            user_home,
            json!({"action":"list","scope":scope}),
        )
        .await
        .map_err(|error| error.to_string())?;
    }
    if reload_mcp {
        if let Err(_error) = ensure_scheduler(state).await {
            result["applyStatus"] = json!("reload-failed");
            result["message"] = json!("配置已保存，但 MCP 调度器未能启动，请重启 Codey 后重试。");
            return Ok(result);
        }
        if let Some(scheduler) = state.mcp_scheduler.lock().await.as_ref() {
            scheduler.reconcile().await;
            if scheduler_toggle && result["inventory"]["mcpSchedulerEnabled"] == false {
                scheduler.release_idle().await;
            }
        }
    }
    if reload_mcp
        && (result["applyStatus"] == "reload-required" || result["applyStatus"] == "unchanged")
    {
        // 配置事务已完成；刷新失败也必须返回已保存的清单，避免重复导入。
        let runtime = state.runtime.lock().await.clone();
        if let Some(runtime) = runtime {
            let websocket_url = runtime.renderer_websocket_url().await;
            let reloaded = tokio::time::timeout(
                std::time::Duration::from_secs(25),
                crate::cdp::reload_mcp_servers(&websocket_url),
            )
            .await;
            if matches!(reloaded, Ok(Ok(()))) {
                result["applyStatus"] = json!("applied");
                result["message"] = json!("配置已保存，下一轮对话生效。");
            } else {
                result["applyStatus"] = json!("reload-failed");
                result["message"] = json!("配置已保存，未能确认自动刷新，请重启 Codex。");
            }
        } else {
            result["applyStatus"] = json!("pending-runtime");
            result["message"] = json!("配置已保存，Codex 下次启动时生效。");
        }
    }
    if scheduler_toggle && state.runtime.lock().await.is_some() {
        result["message"] = json!(format!(
            "{} 内置 FastCtx 的启动覆盖需重启 Codex 后生效，已有共享会话在重连前继续使用共享器。",
            result["message"].as_str().unwrap_or("共享器设置已保存。")
        ));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn release_idle_reports_success_when_no_scheduler_is_running() {
        let state = Arc::new(AppState {
            config: tokio::sync::RwLock::new(crate::config::CodeyConfig::default()),
            ..AppState::default()
        });
        let result = invoke(&state, &json!({"request":{"action":"release_mcp_idle"}}))
            .await
            .unwrap();
        assert_eq!(result["status"], "success");
        assert_eq!(result["released"], 0);
    }

    #[test]
    fn sharing_status_excludes_other_project_pools() {
        let status = scoped_status(
            json!({"pools":[
                {"sourcePath":"/project/a/.codex/config.toml","id":"a"},
                {"sourcePath":"/project/b/.codex/config.toml","id":"b"}
            ]}),
            &json!("/project/a/.codex/config.toml"),
        );
        assert_eq!(status["pools"].as_array().unwrap().len(), 1);
        assert_eq!(status["pools"][0]["id"], "a");
        assert!(!status.to_string().contains("/project/b"));
    }

    #[tokio::test]
    async fn scheduler_holder_stop_removes_discovery_and_allows_restart() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().canonicalize().unwrap();
        let data = home.join("extensions");
        let state = AppState {
            config: tokio::sync::RwLock::new(crate::config::CodeyConfig::default()),
            ..AppState::default()
        };
        *state.mcp_scheduler.lock().await = Some(
            crate::mcp_scheduler::start(home.clone(), data.clone(), home.clone())
                .await
                .unwrap(),
        );
        assert!(data.join("mcp-scheduler.json").exists());
        stop_scheduler(&state).await;
        assert!(state.mcp_scheduler.lock().await.is_none());
        assert!(!data.join("mcp-scheduler.json").exists());
        *state.mcp_scheduler.lock().await = Some(
            crate::mcp_scheduler::start(home.clone(), data.clone(), home)
                .await
                .unwrap(),
        );
        assert!(data.join("mcp-scheduler.json").exists());
        stop_scheduler(&state).await;
        stop_scheduler(&state).await;
        assert!(!data.join("mcp-scheduler.json").exists());
    }
}
