use super::*;

#[tokio::test]
async fn startup_finishes_confirmed_session_cleanup_before_rebuilding_indexes() {
    let temp = tempfile::tempdir().unwrap();
    let id = "11111111-1111-4111-8111-111111111111";
    let folder = temp.path().join("archived_sessions");
    std::fs::create_dir(&folder).unwrap();
    let rollout = folder.join(format!("rollout-test-{id}.jsonl"));
    std::fs::write(
        &rollout,
        serde_json::json!({"type":"session_meta","payload":{"id":id}}).to_string(),
    )
    .unwrap();
    std::fs::write(
        temp.path().join("session_index.jsonl"),
        format!("{}\n", serde_json::json!({"id":id,"thread_name":"fixture"})),
    )
    .unwrap();
    let pending = temp.path().join(".codey-session-cleanup-v1.json");
    std::fs::write(
        &pending,
        serde_json::json!({"version":1,"ids":[id]}).to_string(),
    )
    .unwrap();
    run_startup_session_maintenance(temp.path()).await.unwrap();
    assert!(!rollout.exists());
    assert!(!pending.exists());
    assert!(
        std::fs::read_to_string(temp.path().join("session_index.jsonl"))
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn startup_leaves_legacy_message_deletions_inactive() {
    let temp = tempfile::tempdir().unwrap();
    let id = "11111111-1111-4111-8111-111111111111";
    let folder = temp.path().join("sessions");
    std::fs::create_dir(&folder).unwrap();
    let rollout = folder.join(format!("rollout-test-{id}.jsonl"));
    let contents = format!(
        "{}\n{}\n{}\n",
        serde_json::json!({"type": "session_meta", "payload": {"id": id}}),
        serde_json::json!({"type": "turn_context", "payload": {"turn_id": "turn-1"}}),
        serde_json::json!({"type": "turn_context", "payload": {"turn_id": "turn-2"}}),
    );
    std::fs::write(&rollout, &contents).unwrap();
    let directory = temp.path().join(".codey-message-delete-tombstones-v1");
    std::fs::create_dir(&directory).unwrap();
    let record = directory.join("legacy.json");
    let deletion =
        serde_json::json!({"version": 1, "sessionId": id, "messageId": "turn-1"}).to_string();
    std::fs::write(&record, &deletion).unwrap();

    run_startup_session_maintenance(temp.path()).await.unwrap();

    assert_eq!(std::fs::read_to_string(&rollout).unwrap(), contents);
    assert_eq!(std::fs::read_to_string(&record).unwrap(), deletion);
    assert!(
        !temp
            .path()
            .join(".codey-message-delete-tombstones-v1.lock")
            .exists()
    );
}

#[tokio::test]
async fn startup_does_not_claim_success_when_session_cleanup_is_incomplete() {
    let temp = tempfile::tempdir().unwrap();
    let pending = temp.path().join(".codey-session-cleanup-v1.json");
    std::fs::write(&pending, "{broken").unwrap();
    assert!(run_startup_session_maintenance(temp.path()).await.is_err());
    assert!(pending.exists());
}

#[tokio::test]
async fn pet_state_failure_does_not_abort_startup_or_replace_state() {
    for slim_codex_pet in [true, false] {
        let temp = tempfile::tempdir().unwrap();
        let primary = temp.path().join(".codex-global-state.json");
        let backup = temp.path().join(".codex-global-state.json.bak");
        std::fs::write(&primary, b"{broken").unwrap();
        std::fs::write(&backup, b"{also broken").unwrap();
        let config = CodeyConfig {
            slim_codex_pet,
            ..CodeyConfig::default()
        };

        let patch = prepare_startup_patches(temp.path(), &config).await.unwrap();

        assert_ne!(patch.debug_port, 0);
        assert_eq!(std::fs::read(&primary).unwrap(), b"{broken");
        assert_eq!(std::fs::read(&backup).unwrap(), b"{also broken");
    }
}

#[tokio::test]
async fn debug_port_failure_aborts_before_startup_patches() {
    let temp = tempfile::tempdir().unwrap();
    let config = CodeyConfig::default();
    let result = prepare_startup_patches_with_port_selector(temp.path(), &config, || {
        Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "loopback binding denied",
        ))
    })
    .await;
    let error = match result {
        Ok(_) => panic!("startup should fail without a debug port"),
        Err(error) => error,
    };
    assert!(format!("{error:#}").contains("loopback binding denied"));
    assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
}

#[tokio::test]
async fn debug_port_zero_never_reaches_startup_command() {
    let temp = tempfile::tempdir().unwrap();
    let result =
        prepare_startup_patches_with_port_selector(temp.path(), &CodeyConfig::default(), || Ok(0))
            .await;
    assert!(result.is_err());
    assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
}

#[test]
fn maintenance_status_exposes_structured_session_metrics() {
    let cleanup = Ok(SessionIndexCleanupReport {
        scanned_entries: 5,
        live_threads: 3,
        pruned_entries: 2,
        backup_dir: None,
    });

    let summary = session_maintenance_summary(&cleanup);
    let status = MaintenanceStatus {
        session_status: summary.status,
        session_files_fixed: summary.files_fixed,
        sqlite_rows_updated: summary.sqlite_rows_updated,
        ghost_tasks_pruned: summary.ghost_tasks_pruned,
        performance_status: "ready".to_string(),
        performance_detail: String::new(),
        startup_injection_mode: "node_options".to_string(),
    };
    let value = serde_json::to_value(status).unwrap();

    assert_eq!(value["sessionFilesFixed"], 0);
    assert_eq!(value["sqliteRowsUpdated"], 0);
    assert_eq!(value["ghostTasksPruned"], 2);
    assert_eq!(value["startupInjectionMode"], "node_options");
}

#[test]
fn startup_without_provider_rewrites_is_still_ready() {
    let cleanup = Ok(SessionIndexCleanupReport {
        scanned_entries: 0,
        live_threads: 0,
        pruned_entries: 0,
        backup_dir: None,
    });

    let summary = session_maintenance_summary(&cleanup);

    assert_eq!(summary.status, "ready");
    assert_eq!(summary.files_fixed, 0);
    assert_eq!(summary.sqlite_rows_updated, 0);
}

#[test]
fn runtime_config_matches_agrees_with_from_config_equality() {
    let mut applied = CodeyConfig::default();
    applied.profiles[0].name = "主线路".to_string();
    applied
        .selected_models_by_provider
        .insert("openai".to_string(), vec!["gpt-6-astra".to_string()]);
    applied.subagent_model = "gpt-6-astra".to_string();
    let models = RuntimeModelConfig::from_config(&applied);
    let subagent = RuntimeSubagentConfig::from_config(&applied);
    assert!(models.matches(&applied));
    assert!(subagent.matches(&applied));

    let mut changed = applied.clone();
    changed.profiles[0].enabled = !changed.profiles[0].enabled;
    assert_eq!(
        models.matches(&changed),
        models == RuntimeModelConfig::from_config(&changed)
    );
    assert!(!models.matches(&changed));

    let mut changed = applied.clone();
    changed.default_model = "gpt-5.6-luna".to_string();
    assert!(!models.matches(&changed));

    let mut changed = applied.clone();
    changed.profiles.push(changed.profiles[0].clone());
    assert!(!models.matches(&changed));

    let mut changed = applied.clone();
    changed.subagent_reasoning_effort = format!("{}-changed", applied.subagent_reasoning_effort);
    assert_eq!(
        subagent.matches(&changed),
        subagent == RuntimeSubagentConfig::from_config(&changed)
    );
    assert!(!subagent.matches(&changed));
}
