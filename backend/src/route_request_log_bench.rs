//! Opt-in statistics measurements against synthetic, temporary databases.
use super::*;

#[test]
#[ignore = "opt-in request log statistics benchmark"]
fn statistics_query_benchmark() {
    for rows in [10_000, 100_000, 1_000_000] {
        let directory = tempfile::tempdir().unwrap();
        let sink = SqliteSink::open(&directory.path().join(SQLITE_FILE_NAME), 30).unwrap();
        let now = unix_timestamp_ms();
        let from = now - 30 * DAY_MS;
        sink.connection
            .execute(
                "WITH RECURSIVE ids(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM ids WHERE n+1 < ?1)
             INSERT INTO route_request_logs (
                 request_id, trace_id, timestamp_unix_ms, provider, requested_model,
                 codex_session_id, status, request_protocol, upstream_transport, request_kind,
                 total_duration_ms, router_pre_upstream_ms, upstream_first_byte_ms,
                 ttft_ms, downstream_first_content_ms, queue_delay_ms,
                 input_tokens, output_tokens, total_tokens, usage_reported,
                 fallback_count, subagent, schema_version, codex_session_is_parent,
                 upstream_error_summary
             ) SELECT 'request-' || n, 'trace-' || n, ?2 + n * ?3 / ?1,
                 'provider-' || (n % 10), 'model-' || (n % 100), 'session-' || n,
                 'succeeded', 'sse', 'http_sse', 'responses',
                 1000 + n % 9000, 10, 90, 100, 110, 0,
                 100, 200, CASE WHEN n % 7 != 0 THEN 300 END, n % 7 != 0,
                 0, 0, 12, 0, 'synthetic diagnostic ' || n FROM ids",
                params![rows, from, 30 * DAY_MS],
            )
            .unwrap();
        sink.connection
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); ANALYZE;")
            .unwrap();
        for (name, search, provider, group_by, all_time) in [
            ("range-model", None, None, "model", false),
            ("range-session", None, None, "session", false),
            ("provider", None, Some("provider-1"), "model", false),
            ("search-broad", Some("synthetic"), None, "model", false),
            (
                "search-selective-all-time",
                Some("diagnostic 1234"),
                None,
                "model",
                true,
            ),
        ] {
            let query = RouteRequestLogQuery {
                from_unix_ms: (!all_time).then_some(from),
                to_unix_ms: (!all_time).then_some(now),
                search: search.map(str::to_owned),
                provider: provider.map(str::to_owned),
                group_by: Some(group_by.into()),
                include_daily_trend: true,
                all_time,
                ..Default::default()
            };
            // Each request opens a fresh SQLite page cache; the second also benefits
            // from OS file caching. This does not flush the operating system cache.
            for sample in 0..2 {
                let start = Instant::now();
                let result = query_route_request_log_stats(
                    directory.path(),
                    RouteRequestLogBackend::Sqlite,
                    query.clone(),
                );
                eprintln!(
                    "stats rows={rows} case={name} sample={sample} elapsed_ms={:.2} result={}",
                    start.elapsed().as_secs_f64() * 1000.0,
                    result
                        .as_ref()
                        .map(|stats| stats.summary.total.to_string())
                        .unwrap_or_else(|error| format!("{error:#}"))
                );
            }
            if rows == 1_000_000 {
                let mut filters = query;
                filters.cursor_mode = true;
                filters.from_unix_ms = Some(if all_time { 0 } else { from });
                filters.to_unix_ms = Some(now);
                let (where_clause, values) = sqlite_query_filters(&filters, true);
                let plan = sink
                    .connection
                    .prepare(&format!(
                        "EXPLAIN QUERY PLAN SELECT {} FROM route_request_logs{where_clause}",
                        summary_columns(),
                    ))
                    .unwrap()
                    .query_map(params_from_iter(values.iter()), |row| {
                        row.get::<_, String>(3)
                    })
                    .unwrap()
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .unwrap();
                eprintln!("stats plan case={name}: {}", plan.join("; "));
            }
        }
    }
}
