use super::*;
use rusqlite::Connection;

fn create_log_database(home: &Path) -> PathBuf {
    let path = home.join("logs_1.sqlite");
    Connection::open(&path)
        .unwrap()
        .execute_batch("CREATE TABLE logs (level TEXT NOT NULL)")
        .unwrap();
    path
}

#[tokio::test]
async fn trace_rollback_restores_enabled_protection_from_the_database_report() {
    let directory = tempfile::tempdir().unwrap();
    let path = create_log_database(directory.path());
    let stats = trace_log_guard::TraceLogGuardStatsHandle::default();
    let protection_active = AtomicBool::new(false);
    // The attempted save has already disabled the previously enabled guard.
    trace_log_guard::configure(directory.path(), true).unwrap();
    trace_log_guard::configure(directory.path(), false).unwrap();

    let error = rollback_trace_log_guard(
        directory.path().to_path_buf(),
        true,
        "保存配置失败".into(),
        &protection_active,
        &stats,
    )
    .await;

    assert_eq!(error, "保存配置失败");
    assert!(protection_active.load(Ordering::Acquire));
    assert_eq!(
        Connection::open(path)
            .unwrap()
            .execute("INSERT INTO logs VALUES ('TRACE')", [])
            .unwrap(),
        0
    );
    let snapshot = stats.snapshot();
    assert_eq!(snapshot.databases_found, 1);
    assert_eq!(snapshot.log_tables_found, 1);
    assert!(snapshot.last_successful_at.is_some());
    assert_eq!(snapshot.errors, [error]);
}

#[tokio::test]
async fn trace_rollback_restores_disabled_protection_from_the_database_report() {
    let directory = tempfile::tempdir().unwrap();
    let path = create_log_database(directory.path());
    let stats = trace_log_guard::TraceLogGuardStatsHandle::default();
    let protection_active = AtomicBool::new(true);
    trace_log_guard::configure(directory.path(), true).unwrap();

    let error = rollback_trace_log_guard(
        directory.path().to_path_buf(),
        false,
        "保存配置失败".into(),
        &protection_active,
        &stats,
    )
    .await;

    assert_eq!(error, "保存配置失败");
    assert!(!protection_active.load(Ordering::Acquire));
    assert_eq!(
        Connection::open(path)
            .unwrap()
            .execute("INSERT INTO logs VALUES ('TRACE')", [])
            .unwrap(),
        1
    );
    assert_eq!(stats.snapshot().errors, [error]);
}

#[tokio::test]
async fn trace_rollback_failure_clears_active_and_preserves_both_errors() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("logs_1.sqlite"), b"invalid sqlite").unwrap();
    let stats = trace_log_guard::TraceLogGuardStatsHandle::default();
    stats.record_success(&trace_log_guard::TraceLogGuardReport {
        databases_found: 1,
        log_tables_found: 1,
        changed: 0,
    });
    let last_successful_at = stats.snapshot().last_successful_at;
    let protection_active = AtomicBool::new(true);

    let error = rollback_trace_log_guard(
        directory.path().to_path_buf(),
        true,
        "保存配置失败".into(),
        &protection_active,
        &stats,
    )
    .await;

    assert!(error.starts_with("保存配置失败；回滚 Trace 日志保护也失败："));
    assert!(!protection_active.load(Ordering::Acquire));
    let snapshot = stats.snapshot();
    assert_eq!(snapshot.last_successful_at, last_successful_at);
    assert_eq!(snapshot.errors, [error]);
}
