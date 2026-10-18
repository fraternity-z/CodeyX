use std::sync::Arc;

use serde_json::{Value, json};
use tokio::sync::Mutex;

use super::{
    AppState, commit_codey_config_locked, current_fast_context_tools_status,
    embedded_fast_context_tools_enabled, finish_codey_config_save, string_argument,
};
use crate::backup::{self, webdav};

static OPERATION: Mutex<()> = Mutex::const_new(());

pub(super) async fn invoke(state: &Arc<AppState>, args: &Value) -> Result<Value, String> {
    let _operation = OPERATION
        .try_lock()
        .map_err(|_| "备份操作正在进行，请稍后重试")?;
    let action = string_argument(args, "action")?;
    match action.as_str() {
        "export" => Ok(json!({"content": backup::export(state.config.read().await.clone())?})),
        "inspect" => {
            let backup = backup::parse(&string_argument(args, "content")?)?;
            let previous = state.config.read().await.clone();
            let summary = backup.summary(previous.settings_revision);
            backup.prepare(&previous)?;
            Ok(summary)
        }
        "restore" => {
            let backup = backup::parse(&string_argument(args, "content")?)?;
            let revision = args
                .get("settingsRevision")
                .and_then(Value::as_u64)
                .ok_or("缺少配置版本")?;
            let (saved, recovery_path) = restore_config(state, backup, revision).await?;
            let mut result = finish_codey_config_save(state, saved).await?;
            result["recoveryPath"] = json!(recovery_path.to_string_lossy());
            Ok(result)
        }
        "webdav_get" | "webdav_save" => {
            let path = state.store.path().with_file_name("backup-webdav.json");
            let settings = if action == "webdav_save" {
                Some(
                    serde_json::from_value::<webdav::Settings>(
                        args.get("settings").cloned().ok_or("缺少 WebDAV 设置")?,
                    )
                    .map_err(|_| "WebDAV 设置字段无效")?,
                )
            } else {
                None
            };
            tokio::task::spawn_blocking(move || match settings {
                Some(settings) => webdav::save(&path, settings),
                None => webdav::load(&path).map(|settings| settings.public()),
            })
            .await
            .map_err(|_| "读取或保存 WebDAV 设置任务失败")?
        }
        "webdav_upload" | "webdav_download" => {
            let path = state.store.path().with_file_name("backup-webdav.json");
            let settings = tokio::task::spawn_blocking(move || webdav::load(&path))
                .await
                .map_err(|_| "读取 WebDAV 设置任务失败")??;
            let content = if action == "webdav_upload" {
                Some(backup::export(state.config.read().await.clone())?)
            } else {
                None
            };
            let content = webdav::transfer(&settings, content).await?;
            Ok(json!({"status": "ok", "content": content}))
        }
        _ => Err("未知备份操作".into()),
    }
}

async fn restore_config(
    state: &Arc<AppState>,
    backup: backup::Backup,
    revision: u64,
) -> Result<(super::SavedCodeyConfig, std::path::PathBuf), String> {
    let _guard = state.config_write_lock.lock().await;
    let previous = state.config.read().await.clone();
    if revision != previous.settings_revision {
        return Err("配置已被其他操作更新，请重新预览备份后再恢复".into());
    }
    let mut config = backup.prepare(&previous)?;
    let fast_context = current_fast_context_tools_status();
    config.fast_context_tools =
        embedded_fast_context_tools_enabled(config.fast_context_tools, &fast_context);
    let path = state.store.path().to_path_buf();
    let snapshot = previous.clone();
    let recovery_path = tokio::task::spawn_blocking(move || backup::save_recovery(&path, snapshot))
        .await
        .map_err(|_| "保存恢复前备份任务失败，原配置未更改")??;
    let saved = commit_codey_config_locked(state, &previous, config, fast_context).await?;
    Ok((saved, recovery_path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{CodeyConfig, ConfigStore};

    fn state(path: std::path::PathBuf) -> Arc<AppState> {
        Arc::new(AppState {
            store: ConfigStore::new(path),
            config: tokio::sync::RwLock::new(CodeyConfig::default()),
            ..AppState::default()
        })
    }
    fn incoming() -> backup::Backup {
        let config = CodeyConfig {
            stream_max_retries: 3,
            ..CodeyConfig::default()
        };
        backup::parse(&backup::export(config).unwrap()).unwrap()
    }

    #[tokio::test]
    async fn backup_restore_checks_revision_then_snapshots_and_commits() {
        let temp = tempfile::tempdir().unwrap();
        let state = state(temp.path().join("config.json"));
        let previous = state.config.read().await.clone();
        assert!(
            restore_config(&state, incoming(), previous.settings_revision + 1)
                .await
                .is_err()
        );
        assert!(!state.store.path().exists());
        let (saved, path) = restore_config(&state, incoming(), previous.settings_revision)
            .await
            .unwrap();
        let snapshot: Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(
            snapshot["config"]["streamMaxRetries"],
            previous.stream_max_retries
        );
        assert_eq!(saved.config.stream_max_retries, 3);
        assert_eq!(
            saved.config.settings_revision,
            previous.settings_revision + 1
        );
        assert_eq!(state.store.load().unwrap(), *state.config.read().await);
    }

    #[tokio::test]
    async fn backup_restore_failure_does_not_publish_config() {
        let temp = tempfile::tempdir().unwrap();
        let blocker = temp.path().join("blocker");
        std::fs::write(&blocker, "keep").unwrap();
        for path in [
            blocker.join("config.json"),
            temp.path().join("directory.json"),
        ] {
            if path.ends_with("directory.json") {
                std::fs::create_dir(&path).unwrap();
            }
            let state = state(path);
            let previous = state.config.read().await.clone();
            assert!(
                restore_config(&state, incoming(), previous.settings_revision)
                    .await
                    .is_err()
            );
            assert_eq!(*state.config.read().await, previous);
        }
        assert_eq!(std::fs::read_to_string(blocker).unwrap(), "keep");
    }
}
