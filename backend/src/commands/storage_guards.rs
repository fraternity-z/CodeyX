use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak, atomic::Ordering};
use std::time::Duration;

use tokio::sync::oneshot;

use super::AppState;
use crate::{codex_config::codex_home, error_log, trace_log_guard};

const TRACE_GUARD_INTERVAL: Duration = Duration::from_secs(30);

pub(super) struct TraceLogGuardWatcher {
    shutdown: oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
}

pub(super) async fn start_trace_guard_watcher(state: &Arc<AppState>) {
    let mut watcher = state.trace_log_guard_watcher.lock().await;
    if state.is_shutting_down()
        || watcher
            .as_ref()
            .is_some_and(|watcher| !watcher.task.is_finished())
    {
        return;
    }
    let (shutdown, shutdown_rx) = oneshot::channel();
    *watcher = Some(TraceLogGuardWatcher {
        shutdown,
        task: tokio::spawn(watch_trace_guards(
            Arc::downgrade(state),
            codex_home().to_path_buf(),
            shutdown_rx,
            TRACE_GUARD_INTERVAL,
        )),
    });
}

pub(super) async fn stop_trace_guard_watcher(state: &AppState) {
    let mut watcher = state.trace_log_guard_watcher.lock().await;
    if let Some(TraceLogGuardWatcher { shutdown, task }) = watcher.take() {
        let _ = shutdown.send(());
        if let Err(error) = task.await {
            state
                .trace_log_guard_stats
                .record_failure("Trace 日志巡检任务异常退出".into());
            error_log::record_failure(
                "patch_failed",
                "stop_trace_log_guard_watcher",
                error.to_string(),
                serde_json::json!({}),
            );
        }
    }
}

pub(super) async fn trace_guard_watcher_running(state: &AppState) -> bool {
    state
        .trace_log_guard_watcher
        .lock()
        .await
        .as_ref()
        .is_some_and(|watcher| !watcher.task.is_finished())
}

async fn watch_trace_guards(
    state: Weak<AppState>,
    home: PathBuf,
    mut shutdown: oneshot::Receiver<()>,
    check_interval: Duration,
) {
    let mut interval = tokio::time::interval(check_interval);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _ = &mut shutdown => break,
            _ = interval.tick() => {}
        }
        let Some(state) = state.upgrade() else { break };
        let operation = tokio::select! {
            biased;
            _ = &mut shutdown => break,
            operation = state.diagnostic_storage_operation.lock() => operation,
        };
        if state.is_shutting_down() {
            break;
        }
        // Read the saved policy under the same lock used by save and cleanup.
        let enabled = state.config.read().await.disable_trace_log_writes;
        if enabled {
            refresh_trace_guard_locked(&state, &home).await;
        }
        drop(operation);
    }
}

async fn refresh_trace_guard_locked(state: &AppState, home: &Path) {
    state.trace_log_guard_stats.begin_refresh();
    let home = home.to_path_buf();
    let result = tokio::task::spawn_blocking(move || trace_log_guard::configure(&home, true)).await;
    match result {
        Ok(Ok(report)) => {
            state
                .trace_log_write_protection_active
                .store(report.protection_active(true), Ordering::Release);
            state.trace_log_guard_stats.record_success(&report);
        }
        result => {
            let error = match result {
                Ok(Err(error)) => format!("Trace 日志巡检失败：{error:#}"),
                Err(_) => "Trace 日志巡检任务异常退出".into(),
                Ok(Ok(_)) => unreachable!(),
            };
            let changed = state.trace_log_guard_stats.snapshot().errors.first() != Some(&error);
            state
                .trace_log_write_protection_active
                .store(false, Ordering::Release);
            state.trace_log_guard_stats.record_failure(error.clone());
            if changed {
                error_log::record_failure(
                    "patch_failed",
                    "refresh_trace_log_guard",
                    error,
                    serde_json::json!({}),
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{CodeyConfig, ConfigStore};
    use rusqlite::Connection;
    use tokio::sync::RwLock;

    fn fixture(directory: &Path, enabled: bool) -> Arc<AppState> {
        Arc::new(AppState {
            store: ConfigStore::new(directory.join("config.json")),
            config: RwLock::new(CodeyConfig {
                disable_trace_log_writes: enabled,
                protect_crashpad_pending: false,
                ..CodeyConfig::default()
            }),
            config_load_error: None,
            ..AppState::default()
        })
    }

    fn create_database(path: &Path) {
        Connection::open(path)
            .unwrap()
            .execute_batch("CREATE TABLE logs (level TEXT NOT NULL)")
            .unwrap();
    }

    async fn start_at(state: &Arc<AppState>, home: &Path) {
        let (shutdown, shutdown_rx) = oneshot::channel();
        *state.trace_log_guard_watcher.lock().await = Some(TraceLogGuardWatcher {
            shutdown,
            task: tokio::spawn(watch_trace_guards(
                Arc::downgrade(state),
                home.to_path_buf(),
                shutdown_rx,
                Duration::from_millis(5),
            )),
        });
    }

    async fn wait_until(condition: impl Fn() -> bool) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !condition() {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .expect("Trace protection should reach the expected state");
    }

    #[tokio::test]
    async fn watcher_protects_databases_created_after_start_and_stops_cleanly() {
        let directory = tempfile::tempdir().unwrap();
        let state = fixture(directory.path(), true);
        let first = directory.path().join("logs_1.sqlite");
        create_database(&first);
        start_at(&state, directory.path()).await;
        wait_until(|| state.trace_log_guard_stats.snapshot().log_tables_found == 1).await;

        let second = directory.path().join("logs_2.sqlite");
        create_database(&second);
        wait_until(|| state.trace_log_guard_stats.snapshot().log_tables_found == 2).await;
        stop_trace_guard_watcher(&state).await;

        assert!(!trace_guard_watcher_running(&state).await);
        for path in [first, second] {
            assert_eq!(
                Connection::open(path)
                    .unwrap()
                    .execute("INSERT INTO logs VALUES ('TRACE')", [])
                    .unwrap(),
                0
            );
        }
        assert!(
            state
                .trace_log_write_protection_active
                .load(Ordering::Acquire)
        );
    }

    #[tokio::test]
    async fn watcher_reports_failure_and_recovers_without_losing_last_success() {
        let directory = tempfile::tempdir().unwrap();
        let state = fixture(directory.path(), true);
        create_database(&directory.path().join("logs_1.sqlite"));
        start_at(&state, directory.path()).await;
        wait_until(|| {
            state
                .trace_log_guard_stats
                .snapshot()
                .last_successful_at
                .is_some()
        })
        .await;
        let successful_at = state.trace_log_guard_stats.snapshot().last_successful_at;
        let second = directory.path().join("logs_2.sqlite");
        std::fs::write(&second, b"invalid sqlite").unwrap();
        wait_until(|| !state.trace_log_guard_stats.snapshot().errors.is_empty()).await;
        assert_eq!(
            state.trace_log_guard_stats.snapshot().last_successful_at,
            successful_at
        );
        assert!(
            !state
                .trace_log_write_protection_active
                .load(Ordering::Acquire)
        );

        // Repair under the production lock so the watcher never sees a half-built schema.
        let operation = state.diagnostic_storage_operation.lock().await;
        std::fs::remove_file(&second).unwrap();
        create_database(&second);
        drop(operation);
        wait_until(|| {
            let snapshot = state.trace_log_guard_stats.snapshot();
            snapshot.log_tables_found == 2 && snapshot.errors.is_empty()
        })
        .await;
        assert!(
            state
                .trace_log_write_protection_active
                .load(Ordering::Acquire)
        );
        stop_trace_guard_watcher(&state).await;
    }

    #[tokio::test]
    async fn queued_check_reads_policy_saved_while_waiting_and_cannot_reenable_it() {
        let directory = tempfile::tempdir().unwrap();
        let state = fixture(directory.path(), true);
        let path = directory.path().join("logs_1.sqlite");
        create_database(&path);
        trace_log_guard::configure(directory.path(), true).unwrap();
        let operation = state.diagnostic_storage_operation.lock().await;
        start_at(&state, directory.path()).await;
        wait_until(|| Arc::strong_count(&state) > 1).await;

        let mut disabled = state.config.read().await.clone();
        disabled.disable_trace_log_writes = false;
        trace_log_guard::configure(directory.path(), false).unwrap();
        state.store.save(&disabled).unwrap();
        *state.config.write().await = disabled;
        drop(operation);
        // The queued check acquires this FIFO mutex before the test does.
        drop(state.diagnostic_storage_operation.lock().await);
        stop_trace_guard_watcher(&state).await;

        assert!(!state.store.load().unwrap().disable_trace_log_writes);
        assert_eq!(
            Connection::open(path)
                .unwrap()
                .execute("INSERT INTO logs VALUES ('TRACE')", [])
                .unwrap(),
            1
        );
        assert_eq!(state.trace_log_guard_stats.snapshot().captured_at, 0);
    }

    #[tokio::test]
    async fn missing_log_directory_is_not_created_and_stop_cancels_a_queued_check() {
        let directory = tempfile::tempdir().unwrap();
        let home = directory.path().join("missing");
        let state = fixture(directory.path(), true);
        start_at(&state, &home).await;
        wait_until(|| state.trace_log_guard_stats.snapshot().captured_at > 0).await;
        stop_trace_guard_watcher(&state).await;
        assert!(!home.exists());
        assert_eq!(state.trace_log_guard_stats.snapshot().databases_found, 0);
        assert!(
            !state
                .trace_log_write_protection_active
                .load(Ordering::Acquire)
        );

        let _operation = state.diagnostic_storage_operation.lock().await;
        start_at(&state, &home).await;
        wait_until(|| Arc::strong_count(&state) > 1).await;
        tokio::time::timeout(Duration::from_secs(1), stop_trace_guard_watcher(&state))
            .await
            .unwrap();
        assert!(!trace_guard_watcher_running(&state).await);
    }

    #[tokio::test]
    async fn disabled_watcher_start_is_idempotent_and_shutdown_prevents_restart() {
        let directory = tempfile::tempdir().unwrap();
        let state = fixture(directory.path(), false);
        start_trace_guard_watcher(&state).await;
        let first_task = state
            .trace_log_guard_watcher
            .lock()
            .await
            .as_ref()
            .unwrap()
            .task
            .id();
        start_trace_guard_watcher(&state).await;
        assert_eq!(
            state
                .trace_log_guard_watcher
                .lock()
                .await
                .as_ref()
                .unwrap()
                .task
                .id(),
            first_task
        );
        stop_trace_guard_watcher(&state).await;
        state.shutting_down.store(true, Ordering::Release);
        start_trace_guard_watcher(&state).await;
        assert!(!trace_guard_watcher_running(&state).await);
    }
}
