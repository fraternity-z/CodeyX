use super::{AppState, argument};
use serde_json::Value;
use std::sync::{Arc, atomic::Ordering};

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn conversation_stats_bridge_rejects_invalid_session_ids() {
        let directory = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState {
            store: crate::config::ConfigStore::new(directory.path().join("config.json")),
            config: tokio::sync::RwLock::new(crate::config::CodeyConfig::default()),
            ..AppState::default()
        });
        for payload in [
            serde_json::json!({}),
            serde_json::json!({"sessionId": 42}),
            serde_json::json!({"sessionId": "../../outside"}),
            serde_json::json!({"sessionId": "local:invalid"}),
        ] {
            let result = state.bridge_request("/session/stats".into(), payload).await;
            assert_eq!(
                result,
                serde_json::json!({"status": "failed", "message": "会话 ID 无效"})
            );
        }
    }
}

pub(super) async fn stats(state: &Arc<AppState>, args: &Value) -> Value {
    let session_id = super::bridge_string(args, "sessionId");
    let session_id = session_id
        .strip_prefix("local:")
        .unwrap_or(&session_id)
        .trim();
    if uuid::Uuid::parse_str(session_id).is_err() {
        return super::api_error_message("会话 ID 无效");
    }
    let registry = state
        .runtime
        .lock()
        .await
        .as_ref()
        .and_then(|runtime| runtime.conversation_stats_registry());
    let (snapshot, codegraph) = tokio::join!(
        crate::conversation_stats::snapshot_with_history(
            crate::codex_config::codex_home().to_path_buf(),
            session_id.to_owned(),
            registry,
        ),
        super::builtin_tools::session_status(state, session_id)
    );
    // 项目状态读取失败不影响统计，也不把旧索引状态误报为仍然生效。
    let codegraph = codegraph.unwrap_or_else(|_| Some(serde_json::json!({"phase":"unavailable"})));
    serde_json::json!({ "status": "ok", "stats": snapshot, "codegraph": codegraph })
}

pub(super) async fn invoke(
    state: &Arc<AppState>,
    command: &str,
    args: &Value,
) -> Result<Value, String> {
    // 与重启串行，避免启动维护和实时删除同时操作同一批文件。
    let _operation = state.runtime_operation.lock().await;
    if state.is_shutting_down() || state.restart_in_progress.load(Ordering::Acquire) {
        return Err("Codey 正在退出或重启，请稍后重新操作".into());
    }
    let request = if command == "delete_codex_sessions" {
        Some(argument::<crate::session_management::DeleteRequest>(
            args, "request",
        )?)
    } else {
        None
    };
    tokio::task::spawn_blocking(move || {
        let home = crate::codex_config::codex_home();
        let result = match request {
            Some(request) => {
                serde_json::to_value(crate::session_management::remove(home, request)?)
            }
            None => serde_json::to_value(crate::session_management::list(home)?),
        };
        result.map_err(anyhow::Error::from)
    })
    .await
    .map_err(|_| "会话管理任务异常退出，请刷新确认清理结果".to_string())?
    .map_err(|error| format!("{error:#}"))
}
