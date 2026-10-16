use super::{AppState, argument};
use serde_json::Value;
use std::sync::{Arc, atomic::Ordering};

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
