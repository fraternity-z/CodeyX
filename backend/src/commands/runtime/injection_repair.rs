use super::*;

fn ensure_repair_available(state: &AppState) -> Result<(), String> {
    if state.is_shutting_down() {
        return Err("Codey 正在退出，无法修复主进程注入".into());
    }
    if state.restart_in_progress.load(Ordering::Acquire) {
        return Err("Codex 正在重启或修复，请稍后重试".into());
    }
    if !cfg!(windows) {
        return Err("主进程注入修复仅支持 Windows 独立安装的 Codex".into());
    }
    ensure_runtime_can_start(state)
}

pub(in crate::commands) async fn schedule_main_process_injection_repair(
    state: &Arc<AppState>,
) -> Result<Value, String> {
    ensure_repair_available(state)?;
    #[cfg(not(windows))]
    unreachable!("unsupported platform rejected before scheduling");
    #[cfg(windows)]
    {
        let mut restart_task = state.restart_task.lock().await;
        ensure_repair_available(state)?;
        let _operation = state
            .runtime_operation
            .try_lock()
            .map_err(|_| "Codex 正在启动、停止或修复，请稍后重试".to_string())?;
        let runtime = state
            .runtime
            .lock()
            .await
            .clone()
            .ok_or("Codex 未运行，请先从 CodeyX 启动 Codex")?;
        ensure_cli_mode(&runtime.maintenance.startup_injection_mode)?;
        let selected_app_path = state.config.read().await.codex_app_path.clone();
        let configured_path = selected_app_path.clone();
        let app_dir = runtime.codex_app_path.clone();
        let plan = tokio::task::spawn_blocking(move || {
            ensure_selected_app_matches_runtime(&configured_path, &app_dir)
                .map_err(anyhow::Error::msg)?;
            crate::electron_fuses::inspector_repair::prepare_inspector_repair(&app_dir)
        })
        .await
        .map_err(|error| format!("检查主进程注入修复条件失败：{error}"))?
        .map_err(|error| format!("无法修复主进程注入：{error:#}"))?;
        if !plan.requires_change() {
            return Err(
                "Inspector 已启用；当前兼容模式不是此安全开关造成，请查看启动错误日志".into(),
            );
        }
        ensure_repair_available(state)?;
        state.restart_in_progress.store(true, Ordering::Release);
        let (cancel, cancel_rx) = oneshot::channel();
        let repair_state = Arc::clone(state);
        let task = tokio::spawn(async move {
            let _restart_guard = RestartInProgressGuard {
                state: Arc::clone(&repair_state),
            };
            if let Err(error) =
                run_scheduled_repair(&repair_state, runtime, selected_app_path, plan, cancel_rx)
                    .await
            {
                *repair_state.startup_error.write().await = Some(error.clone());
                error_log::record_failure(
                    "main_process_injection_repair_failed",
                    "repair_main_process_injection",
                    error.clone(),
                    json!({"recoverable": true}),
                );
                if !repair_state.is_shutting_down() {
                    let current = repair_state.runtime.lock().await.clone();
                    let client_exited = current.as_ref().is_none_or(|runtime| {
                        matches!(runtime.main_process_is_running(), Ok(false))
                    });
                    let recovery = if client_exited {
                        "关闭提示后 CodeyX 将退出。请处理上述问题后重新启动；原始文件备份会保留。"
                    } else {
                        "请处理上述问题后重启 Codex；当前客户端和原始文件备份会保留。"
                    };
                    let dialog = tokio::task::spawn_blocking(move || {
                        rfd::MessageDialog::new()
                            .set_title("CodeyX 主进程注入修复失败")
                            .set_description(format!("{error}\n\n{recovery}"))
                            .set_level(rfd::MessageLevel::Error)
                            .show();
                    });
                    finish_repair_failure(&repair_state, client_exited, async {
                        if let Err(error) = dialog.await {
                            error_log::record_failure(
                                "dialog_failed",
                                "show_injection_repair_failure",
                                error.to_string(),
                                json!({}),
                            );
                        }
                    })
                    .await;
                }
            }
        });
        *restart_task = Some(ScheduledRestart { cancel, task });
        Ok(json!({"status":"repairing"}))
    }
}

#[cfg(any(windows, test))]
fn ensure_cli_mode(mode: &str) -> Result<(), String> {
    match mode {
        "cli" => Ok(()),
        "inspector" | "node_options" => Err("主进程注入已生效，无需修复".into()),
        _ => Err("尚未确认 Codex 主进程注入状态，已取消修复".into()),
    }
}

#[cfg(any(windows, test))]
fn ensure_selected_app_matches_runtime(
    selected: &str,
    running: &std::path::Path,
) -> Result<(), String> {
    let selected =
        codey_runtime_core::app_paths::normalize_codex_app_path(std::path::Path::new(selected))
            .ok_or("无法确认所选 Codex 安装目录，未开始修复")?;
    let selected =
        std::fs::canonicalize(selected).map_err(|_| "无法确认所选 Codex 安装目录，未开始修复")?;
    let running =
        std::fs::canonicalize(running).map_err(|_| "无法确认当前 Codex 安装目录，未开始修复")?;
    if selected != running {
        return Err(
            "所选 Codex 目录与当前运行实例不一致，请先从 CodeyX 重启 Codex 后再修复".into(),
        );
    }
    Ok(())
}

#[cfg(windows)]
async fn run_scheduled_repair(
    state: &Arc<AppState>,
    expected_runtime: Arc<CodeyRuntime>,
    selected_app_path: String,
    plan: crate::electron_fuses::inspector_repair::InspectorRepairPlan,
    mut cancel: oneshot::Receiver<()>,
) -> Result<(), String> {
    let Some(_operation) = wait_for_repair_operation(state, &mut cancel).await else {
        return Ok(());
    };
    let runtime = state.runtime.lock().await.clone();
    if !runtime
        .as_ref()
        .is_some_and(|runtime| Arc::ptr_eq(runtime, &expected_runtime))
    {
        return Err("Codex 运行实例已变化，已取消主进程注入修复".into());
    }
    if state.config.read().await.codex_app_path != selected_app_path {
        return Err("所选 Codex 安装目录已变化，已取消主进程注入修复".into());
    }
    if let Err(error) = stop_runtime_for_restart_locked(state).await {
        preserve_repair_failure(state, expected_runtime.main_process_is_running());
        return Err(format!("停止 Codex 失败，未写入补丁：{error}"));
    }
    // 即使修复失败，旧 Codex 的退出也不能联动关闭保留恢复状态的 CodeyX。
    state.runtime_generation.fetch_add(1, Ordering::AcqRel);
    if state.is_shutting_down() {
        return Ok(());
    }
    let config_write = state.config_write_lock.lock().await;
    if state.is_shutting_down() {
        return Ok(());
    }
    if state.config.read().await.codex_app_path != selected_app_path {
        return Err("所选 Codex 安装目录已变化，未写入补丁；请重新启动 CodeyX".into());
    }
    let outcome = tokio::task::spawn_blocking(move || {
        crate::electron_fuses::inspector_repair::apply_inspector_repair(&plan)
    })
    .await
    .map_err(|error| format!("主进程注入修复任务异常退出：{error}"))?
    .map_err(|error| format!("主进程注入修复失败：{error:#}"))?;
    let _ = codey_runtime_core::diagnostic_log::append_diagnostic_log(
        "launcher.inspector_repair",
        json!({"changed": outcome.changed,
            "binary": outcome.binary, "backup": outcome.backup}),
    );
    drop(config_write);
    if state.is_shutting_down() {
        return Ok(());
    }
    launch_codey_inner_locked(state)
        .await
        .map_err(|error| format!("补丁已写入，但重新启动 Codex 失败：{error:#}"))?;
    let runtime = state.runtime.lock().await.clone();
    if runtime
        .as_ref()
        .is_none_or(|runtime| runtime.maintenance.startup_injection_mode != "inspector")
    {
        return Err(
            "补丁已写入，但未确认 Inspector 主进程注入成功；请查看启动日志，原始文件备份已保留"
                .into(),
        );
    }
    *state.startup_error.write().await = None;
    Ok(())
}

#[cfg(any(windows, test))]
fn preserve_repair_failure(state: &AppState, process_running: anyhow::Result<bool>) {
    // 配置恢复失败时 Codex 可能已经退出，不能让旧退出监听器关闭错误交付窗口。
    if matches!(process_running, Ok(false)) {
        state.runtime_generation.fetch_add(1, Ordering::AcqRel);
    }
}

#[cfg(any(windows, test))]
async fn finish_repair_failure(
    state: &AppState,
    client_exited: bool,
    notice: impl std::future::Future<Output = ()>,
) {
    notice.await;
    if client_exited && !state.is_shutting_down() {
        state.request_shutdown();
    }
}

#[cfg(any(windows, test))]
async fn wait_for_repair_operation<'a>(
    state: &'a AppState,
    cancel: &mut oneshot::Receiver<()>,
) -> Option<tokio::sync::MutexGuard<'a, ()>> {
    tokio::select! {
        _ = tokio::time::sleep(Duration::from_millis(250)) => {},
        _ = &mut *cancel => return None,
    }
    #[cfg(test)]
    state.restart_operation_pending.notify_one();
    let operation = tokio::select! {
        operation = state.runtime_operation.lock() => operation,
        _ = &mut *cancel => return None,
    };
    (!state.is_shutting_down()).then_some(operation)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Arc<AppState> {
        Arc::new(AppState {
            config: tokio::sync::RwLock::new(crate::config::CodeyConfig::default()),
            config_load_error: None,
            ..AppState::default()
        })
    }

    #[test]
    fn only_confirmed_cli_mode_is_repairable() {
        assert!(ensure_cli_mode("cli").is_ok());
        for mode in ["", "unknown", "inspector", "node_options"] {
            assert!(ensure_cli_mode(mode).is_err());
        }
    }

    #[test]
    fn selecting_another_installation_cannot_patch_the_running_client() {
        let temp = tempfile::tempdir().unwrap();
        let running = temp.path().join("running");
        let selected = temp.path().join("selected");
        for directory in [&running, &selected] {
            std::fs::create_dir(directory).unwrap();
            std::fs::write(directory.join("ChatGPT.exe"), b"launcher").unwrap();
        }
        assert!(ensure_selected_app_matches_runtime(running.to_str().unwrap(), &running).is_ok());
        assert!(ensure_selected_app_matches_runtime(selected.to_str().unwrap(), &running).is_err());
        assert!(ensure_selected_app_matches_runtime("", &running).is_err());
        assert!(
            ensure_selected_app_matches_runtime(
                temp.path().join("missing").to_str().unwrap(),
                &running
            )
            .is_err()
        );
    }

    #[tokio::test]
    async fn shutdown_and_duplicate_requests_never_schedule_or_wait_for_runtime_lock() {
        for shutting_down in [false, true] {
            let state = fixture();
            state.shutting_down.store(shutting_down, Ordering::Release);
            state
                .restart_in_progress
                .store(!shutting_down, Ordering::Release);
            let _operation = state.runtime_operation.lock().await;
            for _ in 0..2 {
                assert!(
                    tokio::time::timeout(
                        Duration::from_millis(100),
                        schedule_main_process_injection_repair(&state)
                    )
                    .await
                    .unwrap()
                    .is_err()
                );
                assert!(state.restart_task.lock().await.is_none());
                assert!(state.runtime.lock().await.is_none());
            }
        }
    }

    #[tokio::test]
    async fn no_runtime_never_schedules_a_repair() {
        let state = fixture();
        assert!(
            schedule_main_process_injection_repair(&state)
                .await
                .is_err()
        );
        assert!(!state.restart_in_progress.load(Ordering::Acquire));
        assert!(state.restart_task.lock().await.is_none());
        assert!(state.runtime.lock().await.is_none());
    }

    #[tokio::test]
    async fn cancellation_before_delay_or_while_waiting_never_enters_runtime_operation() {
        for cancel_while_waiting in [false, true] {
            let state = fixture();
            let operation = state.runtime_operation.lock().await;
            let (cancel, mut receiver) = oneshot::channel();
            let pending_state = Arc::clone(&state);
            let pending = tokio::spawn(async move {
                wait_for_repair_operation(&pending_state, &mut receiver)
                    .await
                    .is_none()
            });
            if cancel_while_waiting {
                tokio::time::timeout(
                    Duration::from_secs(1),
                    state.restart_operation_pending.notified(),
                )
                .await
                .unwrap();
            }
            cancel.send(()).unwrap();
            assert!(
                tokio::time::timeout(Duration::from_millis(100), pending)
                    .await
                    .unwrap()
                    .unwrap()
            );
            assert!(state.runtime.lock().await.is_none());
            drop(operation);
        }
    }

    #[tokio::test]
    async fn cleanup_failure_preserves_codey_only_when_codex_exit_is_confirmed() {
        for confirmed_exit in [true, false] {
            let state = fixture();
            state.runtime_generation.store(7, Ordering::Release);
            state.restart_in_progress.store(true, Ordering::Release);
            let (exit, exited) = oneshot::channel();
            let watcher = tokio::spawn(super::super::forward_codex_exit_to_codey_shutdown(
                Arc::clone(&state),
                exited,
                7,
            ));
            preserve_repair_failure(&state, Ok(!confirmed_exit));
            state.restart_in_progress.store(false, Ordering::Release);
            state.restart_settled.notify_waiters();
            exit.send(()).unwrap();
            tokio::time::timeout(Duration::from_secs(1), watcher)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(state.is_shutting_down(), !confirmed_exit);
        }
        let state = fixture();
        state.runtime_generation.store(7, Ordering::Release);
        preserve_repair_failure(&state, Err(anyhow::anyhow!("process query failed")));
        assert_eq!(state.runtime_generation.load(Ordering::Acquire), 7);
    }

    #[tokio::test]
    async fn failure_notice_is_delivered_before_exiting_without_a_client() {
        for client_exited in [true, false] {
            let state = fixture();
            let (shown, received) = oneshot::channel();
            let (acknowledged, closed) = oneshot::channel();
            let pending_state = Arc::clone(&state);
            let pending = tokio::spawn(async move {
                finish_repair_failure(&pending_state, client_exited, async {
                    shown.send(()).unwrap();
                    closed.await.unwrap();
                })
                .await;
            });
            received.await.unwrap();
            assert!(!state.is_shutting_down());
            acknowledged.send(()).unwrap();
            pending.await.unwrap();
            assert_eq!(state.is_shutting_down(), client_exited);
        }
    }
}
