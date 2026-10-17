use super::{AppState, open_system_browser};
use crate::config::RouteRequestLogBackend;
use crate::route_request_log::{self, RouteRequestLogModelQuery, RouteRequestLogQuery};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};

pub(super) async fn invoke(
    state: &Arc<AppState>,
    command: &str,
    args: &Value,
) -> Result<Value, String> {
    match command {
        "open_route_request_logs" => {
            open_route_request_logs(state, args.get("theme").and_then(Value::as_str)).await
        }
        "query_route_request_logs" => {
            let query = query_argument(args, "请求日志查询")?;
            QueryContext::from_state(state).await.logs(query).await
        }
        "query_route_request_log_models" => {
            let query = query_argument(args, "模型候选查询")?;
            QueryContext::from_state(state).await.models(query).await
        }
        "query_route_request_log_stats" => {
            let query = query_argument(args, "请求日志统计")?;
            let mut value = QueryContext::from_state(state).await.stats(query).await?;
            let runtime = state.runtime.lock().await.clone();
            if let Some(runtime) = runtime {
                value["recordingHealth"] = serde_json::to_value(runtime.request_log_health().await)
                    .map_err(|error| format!("请求日志状态序列化失败：{error}"))?;
            }
            Ok(value)
        }
        "clear_route_request_logs" => clear_route_request_logs(state).await,
        _ => Err(format!("未知请求日志命令：{command}")),
    }
}

fn query_argument<T: DeserializeOwned>(args: &Value, operation: &str) -> Result<T, String> {
    serde_json::from_value(args.clone()).map_err(|error| format!("{operation}参数无效：{error}"))
}

// 查询只捕获一次配置，不持有 AppState 或锁进入阻塞线程；测试可注入临时目录。
struct QueryContext {
    root: PathBuf,
    backend: RouteRequestLogBackend,
}

impl QueryContext {
    async fn from_state(state: &AppState) -> Self {
        let backend = state.config.read().await.route_request_log.backend;
        Self {
            root: codey_runtime_core::paths::default_app_state_dir(),
            backend,
        }
    }

    async fn logs(self, query: RouteRequestLogQuery) -> Result<Value, String> {
        let page = tokio::task::spawn_blocking(move || {
            route_request_log::query_route_request_logs(&self.root, self.backend, query)
        })
        .await
        .map_err(|error| format!("请求日志查询任务异常退出：{error}"))?
        .map_err(|error| format!("查询请求日志失败：{error:#}"))?;
        serde_json::to_value(page).map_err(|error| format!("请求日志查询结果序列化失败：{error}"))
    }

    async fn models(self, query: RouteRequestLogModelQuery) -> Result<Value, String> {
        tokio::task::spawn_blocking(move || {
            route_request_log::query_route_request_log_models(&self.root, self.backend, query)
                .and_then(|page| serde_json::to_value(page).map_err(Into::into))
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result.map_err(|error| format!("查询模型候选失败：{error:#}")))
    }

    async fn stats(self, query: RouteRequestLogQuery) -> Result<Value, String> {
        let stats = tokio::task::spawn_blocking(move || {
            route_request_log::query_route_request_log_stats(&self.root, self.backend, query)
        })
        .await
        .map_err(|error| format!("请求日志统计任务异常退出：{error}"))?
        .map_err(|error| format!("查询请求日志统计失败：{error:#}"))?;
        serde_json::to_value(stats).map_err(|error| format!("请求日志统计序列化失败：{error}"))
    }
}

async fn open_route_request_logs(
    state: &Arc<AppState>,
    theme: Option<&str>,
) -> Result<Value, String> {
    let endpoint = state
        .runtime
        .lock()
        .await
        .as_ref()
        .and_then(|runtime| runtime.local_router_endpoint())
        .ok_or_else(|| "本地路由尚未运行，无法打开请求日志".to_string())?;
    let url = endpoint.request_log_url(theme);
    tokio::task::spawn_blocking(move || open_system_browser(&url))
        .await
        .map_err(|error| format!("打开系统浏览器任务异常退出：{error}"))??;
    Ok(json!({"status":"ok"}))
}

async fn clear_route_request_logs(state: &Arc<AppState>) -> Result<Value, String> {
    // Keep the runtime decision stable while the controller serializes the
    // writer shutdown/delete/restart sequence. This does not stop or lock the
    // request forwarding task itself.
    let _runtime_operation = state.runtime_operation.lock().await;
    let runtime = state.runtime.lock().await.clone();
    let recording_enabled = {
        let config = state.config.read().await;
        config.route_request_log.enabled
            && config.route_request_log.sample_rate_per_million > 0
            && config.local_router_enabled
    };
    let result = if let Some(runtime) = runtime
        && let Some(result) = runtime.clear_request_logs().await
    {
        result
    } else {
        let root = codey_runtime_core::paths::default_app_state_dir();
        match tokio::task::spawn_blocking(move || {
            route_request_log::clear_route_request_log_files(&root, recording_enabled)
        })
        .await
        {
            Ok(result) => result,
            Err(error) => route_request_log::RouteRequestLogClearResult::failed(
                recording_enabled,
                format!("请求日志清理任务异常退出：{error}"),
            ),
        }
    };
    serde_json::to_value(result).map_err(|error| format!("请求日志清理结果序列化失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> Arc<AppState> {
        Arc::new(AppState {
            config: tokio::sync::RwLock::new(crate::config::CodeyConfig::default()),
            ..AppState::default()
        })
    }

    #[tokio::test]
    async fn request_log_commands_preserve_parameter_error_envelopes() {
        let state = state();
        for (command, prefix) in [
            ("query_route_request_logs", "请求日志查询参数无效："),
            ("query_route_request_log_models", "模型候选查询参数无效："),
            ("query_route_request_log_stats", "请求日志统计参数无效："),
        ] {
            let value = super::super::invoke_api(&state, command, json!({"fromUnixMs": []})).await;
            assert_eq!(value["status"], "failed");
            assert!(value["message"].as_str().unwrap().starts_with(prefix));
        }
    }

    #[tokio::test]
    async fn request_log_open_requires_running_router() {
        let value = super::super::invoke_api(&state(), "open_route_request_logs", json!({})).await;
        assert_eq!(value["status"], "failed");
        assert_eq!(value["message"], "本地路由尚未运行，无法打开请求日志");
        assert!(invoke(&state(), "unsupported", &json!({})).await.is_err());
    }

    #[tokio::test]
    async fn request_log_queries_preserve_empty_and_unavailable_results() {
        let temp = tempfile::tempdir().unwrap();
        for backend in [
            RouteRequestLogBackend::Ndjson,
            RouteRequestLogBackend::Sqlite,
        ] {
            let context = || QueryContext {
                root: temp.path().to_path_buf(),
                backend,
            };
            let queryable = backend == RouteRequestLogBackend::Sqlite;
            let page = context()
                .logs(RouteRequestLogQuery::default())
                .await
                .unwrap();
            assert_eq!(page["queryable"], queryable);
            assert_eq!(page["pageSize"], 25);
            assert_eq!(page["total"], 0);
            assert_eq!(page["items"], json!([]));
            assert_eq!(page["nextCursor"], Value::Null);
            let models = context()
                .models(serde_json::from_value(json!({})).unwrap())
                .await
                .unwrap();
            assert_eq!(
                models,
                json!({"queryable": queryable, "models": [], "nextCursor": null})
            );
            let stats = context()
                .stats(RouteRequestLogQuery::default())
                .await
                .unwrap();
            assert_eq!(stats["queryable"], queryable);
            assert_eq!(stats["total"], 0);
            assert!(stats.get("summary").is_none());
            assert_eq!(stats["groups"], json!([]));
            assert!(stats.get("recordingHealth").is_none());
        }
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn request_log_queries_reject_invalid_domain_values_before_storage_access() {
        let temp = tempfile::tempdir().unwrap();
        let context = || QueryContext {
            root: temp.path().to_path_buf(),
            backend: RouteRequestLogBackend::Sqlite,
        };
        let error = context()
            .logs(RouteRequestLogQuery {
                page: 0,
                ..Default::default()
            })
            .await
            .unwrap_err();
        assert!(error.starts_with("查询请求日志失败：页码"), "{error}");
        let error = context()
            .stats(RouteRequestLogQuery {
                all_time: true,
                from_unix_ms: Some(1),
                ..Default::default()
            })
            .await
            .unwrap_err();
        assert!(
            error.starts_with("查询请求日志统计失败：全部历史统计"),
            "{error}"
        );
        let query = serde_json::from_value(json!({"afterModel": "x".repeat(4097)})).unwrap();
        let error = context().models(query).await.unwrap_err();
        assert_eq!(error, "查询模型候选失败：模型游标过长");
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn request_log_queries_report_corrupt_storage_without_replacing_it() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("route-requests.sqlite3");
        let content = b"invalid database fixture";
        std::fs::write(&path, content).unwrap();
        let context = || QueryContext {
            root: temp.path().to_path_buf(),
            backend: RouteRequestLogBackend::Sqlite,
        };
        assert!(
            context()
                .logs(RouteRequestLogQuery::default())
                .await
                .unwrap_err()
                .starts_with("查询请求日志失败：")
        );
        assert!(
            context()
                .stats(RouteRequestLogQuery::default())
                .await
                .unwrap_err()
                .starts_with("查询请求日志统计失败：")
        );
        assert!(
            context()
                .models(serde_json::from_value(json!({})).unwrap())
                .await
                .unwrap_err()
                .starts_with("查询模型候选失败：")
        );
        assert_eq!(std::fs::read(path).unwrap(), content);
    }
}
