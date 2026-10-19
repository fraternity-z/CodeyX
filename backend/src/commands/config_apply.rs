use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ApplyPhase {
    Pending,
    Applying,
    Applied,
    Failed,
    RestartRequired,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ConfigApplyStatus {
    settings_revision: u64,
    phase: ApplyPhase,
    #[serde(skip)]
    runtime_generation: u64,
    #[serde(flatten)]
    outcome: Value,
}

impl ConfigApplyStatus {
    fn pending(revision: u64) -> Self {
        Self {
            settings_revision: revision,
            phase: ApplyPhase::Pending,
            runtime_generation: 0,
            outcome: json!({}),
        }
    }

    fn complete(revision: u64, runtime_generation: u64, mut outcome: Value) -> Self {
        let phase = if outcome["modelHotReloadError"].is_string()
            || outcome["routeRequestLogHealth"] == "failed"
            || outcome["subagentConfigHealth"] == "restart_required"
            || outcome["applyError"].is_string()
        {
            ApplyPhase::Failed
        } else if outcome["restartRequired"] == true {
            ApplyPhase::RestartRequired
        } else {
            ApplyPhase::Applied
        };
        // 运行状态只携带应用结果，不缓存或广播整份配置及其凭据。
        if let Some(fields) = outcome.as_object_mut() {
            fields.remove("config");
            fields.remove("status");
        }
        Self {
            settings_revision: revision,
            phase,
            runtime_generation,
            outcome,
        }
    }
}

#[derive(Default)]
pub(super) struct ConfigApplyQueue {
    pending: Option<SavedCodeyConfig>,
    running: bool,
    status: Option<ConfigApplyStatus>,
}

#[cfg(test)]
pub(super) fn status(state: &AppState) -> Option<ConfigApplyStatus> {
    state
        .config_apply
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .status
        .clone()
}

pub(super) fn runtime_status(
    state: &AppState,
    running: bool,
    restart_required: bool,
) -> (Option<ConfigApplyStatus>, bool) {
    let mut queue = state
        .config_apply
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if let Some(status) = &mut queue.status {
        if matches!(status.phase, ApplyPhase::Pending | ApplyPhase::Applying) {
            return (Some(status.clone()), false);
        }
        if matches!(
            status.phase,
            ApplyPhase::RestartRequired | ApplyPhase::Failed
        ) && running
            && !restart_required
            && !state.is_shutting_down()
            && !state.restart_in_progress.load(Ordering::Acquire)
            && state.runtime_generation.load(Ordering::Acquire) > status.runtime_generation
        {
            status.phase = ApplyPhase::Applied;
            status.outcome = json!({"restartRequired": false});
        }
    }
    (queue.status.clone(), restart_required)
}

pub(super) async fn finish_codey_config_save(
    state: &Arc<AppState>,
    saved: SavedCodeyConfig,
) -> Result<Value, String> {
    let pending = ConfigApplyStatus::pending(saved.config.settings_revision);
    let response = json!({
        "status": "ok",
        "config": redacted_config(&saved.config),
        "fastContextToolsStatus": saved.fast_context_tools_status,
        "configApply": pending,
    });
    let mut queue = state
        .config_apply
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if queue
        .status
        .as_ref()
        .is_some_and(|status| status.settings_revision >= pending.settings_revision)
    {
        return Ok(response);
    }
    queue.status = Some(pending);
    queue.pending = Some(saved);
    if !queue.running {
        queue.running = true;
        tokio::spawn(run(Arc::clone(state)));
    }
    Ok(response)
}

async fn run(state: Arc<AppState>) {
    loop {
        // 配置写锁只用于取得最新快照；热更新与后续保存分别推进。
        let saved = {
            let _write = state.config_write_lock.lock().await;
            let config = state.config.read().await.clone();
            let mut queue = state
                .config_apply
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let Some(mut saved) = queue.pending.take() else {
                queue.running = false;
                return;
            };
            saved.config = config;
            saved.reconcile_subagent_config = saved.config.subagent_optimization;
            let mut status = ConfigApplyStatus::pending(saved.config.settings_revision);
            status.phase = ApplyPhase::Applying;
            queue.status = Some(status);
            saved
        };
        let revision = saved.config.settings_revision;
        let generation = state.runtime_generation.load(Ordering::Acquire);
        let apply_state = Arc::clone(&state);
        let outcome = tokio::spawn(async move {
            if apply_state.is_shutting_down() {
                return json!({"restartRequired": true});
            }
            let (models, provider) = tokio::join!(
                current_model_state_async(&saved.config),
                current_provider_status_async(&saved.config),
            );
            finish_committed_config_save(&apply_state, saved, models, provider).await
        })
        .await
        .unwrap_or_else(|_| {
            let error = "后台应用配置任务异常退出，请重新保存或重启 Codex";
            error_log::record_failure(
                "config_apply_failed",
                "apply_saved_config",
                error,
                json!({"settingsRevision": revision}),
            );
            json!({"applyError": error, "restartRequired": true})
        });

        let _write = state.config_write_lock.lock().await;
        let latest = state.config.read().await.clone();
        let mut queue = state
            .config_apply
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if latest.settings_revision > revision && queue.pending.is_none() {
            // 局部配置命令也可能推进版本，不能让其取代尚未应用的设置。
            queue.status = Some(ConfigApplyStatus::pending(latest.settings_revision));
            queue.pending = Some(SavedCodeyConfig {
                reconcile_subagent_config: latest.subagent_optimization,
                config: latest,
                fast_context_tools_status: current_fast_context_tools_status(),
            });
        }
        if queue.pending.is_none() {
            queue.status = Some(ConfigApplyStatus::complete(revision, generation, outcome));
        }
    }
}

// 提交之后的状态查询失败只降低响应完整性，不再改变已保存结果。
pub(super) async fn finish_committed_config_save(
    state: &Arc<AppState>,
    saved: SavedCodeyConfig,
    model_state: Result<model_catalog::ModelSelectionState, String>,
    provider_status: Result<codex_provider::ProviderStatus, String>,
) -> Value {
    sync_waiting_webhook_watcher(state).await;
    sync_wechat_claw_service(state).await;
    let runtime = state.runtime.lock().await.clone();
    let protection = state.config.read().await.protect_crashpad_pending;
    if let Some(runtime) = runtime {
        runtime.set_crashpad_pending_protection(protection);
    }
    schedule_crashpad_pending_refresh(state, protection);
    let model_hot_reload = hot_reload_runtime_models(state).await;
    let route_request_log_hot_reload = hot_reload_runtime_request_log(state, &saved.config).await;
    let subagent_hot_reload = if saved.reconcile_subagent_config {
        hot_reload_runtime_subagent_config(state, &saved.config).await
    } else {
        SubagentHotReloadOutcome::default()
    };
    let restart_required = subagent_hot_reload.requires_restart()
        || runtime_config_requires_restart(state, &saved.config).await;
    let warnings = [
        model_state
            .as_ref()
            .err()
            .map(|error| format!("模型状态未刷新：{error}")),
        provider_status
            .as_ref()
            .err()
            .map(|error| format!("当前线路状态未刷新：{error}")),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    model_hot_reload.add_to_response(json!({
        "status": "ok",
        "config": redacted_config(&saved.config),
        "providerStatus": provider_status.ok(),
        "modelState": model_state.ok(),
        "warning": if warnings.is_empty() { None } else { Some(warnings.join("；")) },
        "fastContextToolsStatus": saved.fast_context_tools_status,
        "restartRequired": restart_required,
        "routeRequestLogHotReloaded": route_request_log_hot_reload.reloaded(),
        "routeRequestLogHealth": route_request_log_hot_reload.health(),
        "routeRequestLogHotReloadError": route_request_log_hot_reload.error(),
        "subagentConfigHotReloaded": subagent_hot_reload.reloaded(),
        "subagentConfigRepaired": subagent_hot_reload.repaired(),
        "subagentConfigHealth": subagent_hot_reload.health(),
        "subagentConfigRepairReasons": subagent_hot_reload.repair_reasons(),
        "subagentConfigHotReloadError": subagent_hot_reload.error(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(directory: &tempfile::TempDir) -> Arc<AppState> {
        Arc::new(AppState {
            store: ConfigStore::new(directory.path().join("config.json")),
            config: RwLock::new(CodeyConfig {
                protect_crashpad_pending: false,
                ..CodeyConfig::default()
            }),
            config_load_error: None,
            ..AppState::default()
        })
    }

    async fn wait_until(state: &AppState, phase: ApplyPhase) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if status(state).is_some_and(|status| status.phase == phase) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("configuration application should reach the expected phase");
    }

    #[tokio::test]
    async fn saves_return_while_apply_is_blocked_and_only_latest_pending_version_survives() {
        let directory = tempfile::tempdir().unwrap();
        let state = fixture(&directory);
        let runtime_guard = state.runtime_operation.lock().await;
        let mut config = state.config.read().await.clone();
        config.slim_codex_pet = !config.slim_codex_pet;
        let response =
            tokio::time::timeout(Duration::from_secs(2), save_codey_config(&state, config))
                .await
                .expect("persistence must not wait for runtime application")
                .unwrap();
        assert_eq!(response["configApply"]["phase"], "pending");
        assert_eq!(state.store.load().unwrap().settings_revision, 1);
        wait_until(&state, ApplyPhase::Applying).await;

        for revision in 2..=3 {
            let mut config = state.config.read().await.clone();
            config.stream_max_retries += 1;
            let saved =
                tokio::time::timeout(Duration::from_secs(2), save_codey_config(&state, config))
                    .await
                    .unwrap()
                    .unwrap();
            assert_eq!(saved["config"]["settingsRevision"], revision);
        }
        {
            let queue = state.config_apply.lock().unwrap();
            assert!(queue.running);
            assert_eq!(queue.pending.as_ref().unwrap().config.settings_revision, 3);
            assert_eq!(queue.status.as_ref().unwrap().settings_revision, 3);
        }
        assert!(
            !runtime_status(&state, true, true).1,
            "pending application must not ask for a premature restart"
        );
        drop(runtime_guard);
        wait_until(&state, ApplyPhase::Applied).await;
        assert_eq!(status(&state).unwrap().settings_revision, 3);
        let public = serde_json::to_value(status(&state)).unwrap();
        assert!(public.get("config").is_none());
        assert_eq!(state.store.load().unwrap(), *state.config.read().await);
    }

    #[tokio::test]
    async fn failed_persistence_does_not_enqueue_or_publish_a_new_revision() {
        let directory = tempfile::tempdir().unwrap();
        let state = fixture(&directory);
        std::fs::create_dir(state.store.path()).unwrap();
        let config = state.config.read().await.clone();
        assert!(save_codey_config(&state, config.clone()).await.is_err());
        assert_eq!(*state.config.read().await, config);
        assert!(status(&state).is_none());
        assert!(!state.config_apply.lock().unwrap().running);
    }

    #[tokio::test]
    async fn late_enqueue_cannot_replace_newer_application_and_shutdown_does_not_apply() {
        let directory = tempfile::tempdir().unwrap();
        let state = fixture(&directory);
        let _guard = state.config_write_lock.lock().await;
        let input = state.config.read().await.clone();
        let first = save_codey_config_locked(&state, CodeyConfigSaveInput::complete(input))
            .await
            .unwrap();
        let input = state.config.read().await.clone();
        let second = save_codey_config_locked(&state, CodeyConfigSaveInput::complete(input))
            .await
            .unwrap();
        finish_codey_config_save(&state, second).await.unwrap();
        finish_codey_config_save(&state, first).await.unwrap();
        assert_eq!(
            state
                .config_apply
                .lock()
                .unwrap()
                .pending
                .as_ref()
                .unwrap()
                .config
                .settings_revision,
            2
        );
        state.request_shutdown();
        drop(_guard);
        wait_until(&state, ApplyPhase::RestartRequired).await;
        assert_eq!(status(&state).unwrap().settings_revision, 2);
    }

    #[test]
    fn application_outcomes_keep_failure_and_restart_distinct_without_config_secrets() {
        for (outcome, expected) in [
            (json!({}), ApplyPhase::Applied),
            (
                json!({"restartRequired": true}),
                ApplyPhase::RestartRequired,
            ),
            (
                json!({"modelHotReloadError": "mock", "restartRequired": true}),
                ApplyPhase::Failed,
            ),
            (
                json!({"routeRequestLogHealth": "failed"}),
                ApplyPhase::Failed,
            ),
            (
                json!({"subagentConfigHealth": "restart_required"}),
                ApplyPhase::Failed,
            ),
            (json!({"applyError": "mock"}), ApplyPhase::Failed),
        ] {
            let mut outcome = outcome;
            outcome["config"] = json!({"apiKey": "test-only"});
            outcome["status"] = json!("ok");
            let status = ConfigApplyStatus::complete(7, 0, outcome);
            assert_eq!(status.phase, expected);
            let public = serde_json::to_value(status).unwrap();
            assert_eq!(public["settingsRevision"], 7);
            assert!(public.get("config").is_none());
            assert!(public.get("status").is_none());
        }
    }

    #[tokio::test]
    async fn newer_partial_commit_is_applied_even_without_another_full_save() {
        let directory = tempfile::tempdir().unwrap();
        let state = fixture(&directory);
        let runtime_guard = state.runtime_operation.lock().await;
        let input = state.config.read().await.clone();
        save_codey_config(&state, input).await.unwrap();
        wait_until(&state, ApplyPhase::Applying).await;
        {
            let _write = state.config_write_lock.lock().await;
            let mut latest = state.config.read().await.clone();
            latest.settings_revision += 1;
            latest.stream_max_retries += 1;
            let latest = save_config_to_store(&state, latest).await.unwrap();
            *state.config.write().await = latest;
        }
        drop(runtime_guard);
        wait_until(&state, ApplyPhase::Applied).await;
        assert_eq!(status(&state).unwrap().settings_revision, 2);
    }

    #[test]
    fn successful_new_runtime_resolves_failure_but_stopped_or_restarting_runtime_does_not() {
        let directory = tempfile::tempdir().unwrap();
        let state = fixture(&directory);
        state.config_apply.lock().unwrap().status = Some(ConfigApplyStatus::complete(
            1,
            2,
            json!({"applyError": "mock", "restartRequired": true}),
        ));
        state.runtime_generation.store(3, Ordering::Release);
        assert_eq!(
            runtime_status(&state, false, false).0.unwrap().phase,
            ApplyPhase::Failed
        );
        state.restart_in_progress.store(true, Ordering::Release);
        assert_eq!(
            runtime_status(&state, true, false).0.unwrap().phase,
            ApplyPhase::Failed
        );
        state.restart_in_progress.store(false, Ordering::Release);
        let status = runtime_status(&state, true, false).0.unwrap();
        assert_eq!(status.phase, ApplyPhase::Applied);
        assert!(status.outcome.get("applyError").is_none());
        assert_eq!(
            runtime_status(&state, false, false).0.unwrap().phase,
            ApplyPhase::Applied
        );
    }
}
