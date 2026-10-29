//! 请求日志的只读查询与统计聚合。

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use rusqlite::{Connection, OpenFlags, params_from_iter, types::Value as SqlValue};

use super::{
    DAY_MS, RouteRequestLogAnalytics, RouteRequestLogBackend, RouteRequestLogCursor,
    RouteRequestLogDailyTrend, RouteRequestLogGroup, RouteRequestLogModelPage,
    RouteRequestLogModelQuery, RouteRequestLogQuery, RouteRequestLogQueryItem,
    RouteRequestLogQueryPage, RouteRequestLogSummary, RouteRequestLogTrend, SQLITE_BUSY_TIMEOUT,
    SQLITE_FILE_NAME, lock_unpoisoned, to_i64, unix_timestamp_ms,
};
use crate::sqlite_util::table_columns;

/// 上游响应阶段每秒输出 Token 数，口径与写入侧的 `output_tokens_per_second` 一致。
/// 上游首字节时间以发送上游请求为起点，先加路由前置耗时，再从请求总耗时扣除。
/// 分步减法及非负校验避免非法历史计时与整数加法溢出，条件不足时返回 NULL。
const OUTPUT_SPEED_SQL: &str = "CASE
        WHEN total_duration_ms >= 0
            AND router_pre_upstream_ms >= 0
            AND upstream_first_byte_ms >= 0
            AND router_pre_upstream_ms <= total_duration_ms
            AND upstream_first_byte_ms <= total_duration_ms - router_pre_upstream_ms
            AND output_tokens >= 100
            AND total_duration_ms - router_pre_upstream_ms - upstream_first_byte_ms >= 100
        THEN output_tokens * 1000.0 / (total_duration_ms - router_pre_upstream_ms - upstream_first_byte_ms)
    END";

/// 汇总速度与单条速度口径一致，但按合格请求的输出总量除以生成总时长，
/// 逐条取平均会被短请求带偏。
const OUTPUT_SPEED_VALID_SQL: &str = "total_duration_ms >= 0
            AND router_pre_upstream_ms >= 0
            AND upstream_first_byte_ms >= 0
            AND router_pre_upstream_ms <= total_duration_ms
            AND upstream_first_byte_ms <= total_duration_ms - router_pre_upstream_ms
            AND output_tokens >= 100
            AND total_duration_ms - router_pre_upstream_ms - upstream_first_byte_ms >= 100";

pub(crate) fn query_route_request_logs(
    root: &Path,
    backend: RouteRequestLogBackend,
    query: RouteRequestLogQuery,
) -> anyhow::Result<RouteRequestLogQueryPage> {
    if query.all_time || query.group_sort.is_some() || query.include_daily_trend {
        anyhow::bail!("全部历史、统计排序和每日趋势仅适用于用量统计");
    }
    let query = query.normalize()?;
    if backend == RouteRequestLogBackend::Ndjson {
        return Ok(RouteRequestLogQueryPage {
            status: "unavailable",
            backend: "ndjson",
            queryable: false,
            reason: Some("ndjson_not_queryable"),
            page: query.page,
            page_size: query.page_size,
            total: 0,
            total_pages: 0,
            items: Vec::new(),
            next_cursor: None,
            has_more: false,
        });
    }

    let path = root.join(SQLITE_FILE_NAME);
    if !path.is_file() {
        return Ok(empty_query_page(query.page, query.page_size));
    }
    query_sqlite_route_request_logs(&path, &query)
}

fn query_sqlite_route_request_logs(
    path: &Path,
    query: &RouteRequestLogQuery,
) -> anyhow::Result<RouteRequestLogQueryPage> {
    let mut connection = open_query_connection(path)?;
    let transaction = connection.transaction()?;
    let optional_columns = sqlite_optional_columns(&transaction, path)?;
    let (mut where_clause, mut filter_params) =
        sqlite_query_filters(query, optional_columns.official_account);
    // Legacy page-number callers still receive a precise count. The UI uses cursors.
    let total = if query.cursor_mode {
        0
    } else {
        transaction.query_row(
            &format!("SELECT COUNT(*) FROM route_request_logs{where_clause}"),
            params_from_iter(filter_params.iter()),
            |row| row_u64(row, 0),
        )?
    };
    let total_pages = total.div_ceil(query.page_size);
    let offset = query.page.saturating_sub(1).saturating_mul(query.page_size);
    if let Some(cursor) = &query.cursor {
        where_clause.push_str(" AND (timestamp_unix_ms, request_id) < (?, ?)");
        filter_params.push(SqlValue::Integer(to_i64(cursor.timestamp_unix_ms)));
        filter_params.push(SqlValue::Text(cursor.request_id.clone()));
    }
    let pagination = if query.cursor_mode {
        "LIMIT ?"
    } else {
        "LIMIT ? OFFSET ?"
    };
    let tier_columns = if optional_columns.tiers {
        "requested_service_tier, service_tier"
    } else {
        "NULL, NULL"
    };
    let account_column = if optional_columns.official_account {
        "official_account_id"
    } else {
        "NULL"
    };
    let request_shape_columns = if optional_columns.request_shape {
        "request_input_state, request_input_items, request_has_previous_response_id,
            request_bytes, upstream_input_state, upstream_input_items,
            upstream_has_previous_response_id, upstream_bytes"
    } else {
        "NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL"
    };
    let response_header_column = if optional_columns.response_headers {
        "upstream_response_headers"
    } else {
        "NULL"
    };
    let response_model_column = if optional_columns.response_model {
        "upstream_response_model"
    } else {
        "NULL"
    };
    let select_sql = format!(
        "SELECT
            request_id, trace_id, timestamp_unix_ms, provider, provider_name,
            requested_model, model, reasoning_effort, thinking_budget_tokens,
            ttft_ms, router_pre_upstream_ms, upstream_first_byte_ms,
            downstream_first_content_ms, upstream_header_ms, total_duration_ms, queue_delay_ms,
            input_tokens, output_tokens, cached_input_tokens,
            cache_creation_input_tokens, reasoning_output_tokens, total_tokens,
            usage_reported, usage_unavailable_reason, request_protocol,
            upstream_transport, request_kind, status, status_code,
            upstream_status_code, error_code, completion_reason, fallback_count,
            fallback_reason, upstream_authority,
            upstream_request_id, upstream_protocol, protocol_bridge,
            first_byte_source, subagent, upstream_error_summary,
            codex_session_id, codex_session_is_parent, {tier_columns},
            upstream_request_headers, {account_column}, {request_shape_columns},
            {response_header_column}, {response_model_column},
            {OUTPUT_SPEED_SQL} AS output_tokens_per_second
         FROM route_request_logs{where_clause}
         ORDER BY timestamp_unix_ms DESC, request_id DESC
         {pagination}"
    );
    let mut page_params = filter_params;
    page_params.push(SqlValue::Integer(to_i64(
        query.page_size + u64::from(query.cursor_mode),
    )));
    if !query.cursor_mode {
        page_params.push(SqlValue::Integer(to_i64(offset)));
    }
    let mut statement = transaction.prepare(&select_sql)?;
    let mut items = statement
        .query_map(params_from_iter(page_params), query_item_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    transaction.commit()?;
    let has_more = if query.cursor_mode {
        items.len() > query.page_size as usize
    } else {
        query.page < total_pages
    };
    items.truncate(query.page_size as usize);
    let next_cursor = if has_more {
        items.last().map(|item| RouteRequestLogCursor {
            timestamp_unix_ms: item.timestamp_unix_ms,
            request_id: item.request_id.clone(),
        })
    } else {
        None
    };

    Ok(RouteRequestLogQueryPage {
        status: "ok",
        backend: "sqlite",
        queryable: true,
        reason: None,
        page: query.page,
        page_size: query.page_size,
        total,
        total_pages,
        items,
        next_cursor,
        has_more,
    })
}

fn empty_query_page(page: u64, page_size: u64) -> RouteRequestLogQueryPage {
    RouteRequestLogQueryPage {
        status: "ok",
        backend: "sqlite",
        queryable: true,
        reason: None,
        page,
        page_size,
        total: 0,
        total_pages: 0,
        items: Vec::new(),
        next_cursor: None,
        has_more: false,
    }
}

/// `has_official_account_column` keeps queries working against a database the
/// writer has not migrated yet; the account filter and search fall back to the
/// columns every version ships.
pub(super) fn sqlite_query_filters(
    query: &RouteRequestLogQuery,
    has_official_account_column: bool,
) -> (String, Vec<SqlValue>) {
    let mut clauses: Vec<String> = Vec::new();
    let mut values = Vec::new();
    if let (Some(from), Some(to)) = (query.from_unix_ms, query.to_unix_ms) {
        clauses.push("timestamp_unix_ms >= ? AND timestamp_unix_ms < ?".into());
        values.extend([
            SqlValue::Integer(to_i64(from)),
            SqlValue::Integer(to_i64(to)),
        ]);
    }
    for (column, value) in [
        ("request_id", &query.request_id),
        ("request_kind", &query.request_kind),
        ("codex_session_id", &query.session_id),
    ] {
        if let Some(value) = value {
            clauses.push(format!("{column} = ?"));
            values.push(SqlValue::Text(value.clone()));
        }
    }
    if let Some(search) = &query.search {
        let pattern = format!("%{}%", escape_like_pattern(search));
        let account_search = if has_official_account_column {
            "
              OR COALESCE(official_account_id, '') LIKE ? ESCAPE '\\'"
        } else {
            ""
        };
        let search_clause = format!(
            "(request_id LIKE ? ESCAPE '\\'
              OR trace_id LIKE ? ESCAPE '\\'
              OR COALESCE(provider, '') LIKE ? ESCAPE '\\'
              OR COALESCE(provider_name, '') LIKE ? ESCAPE '\\'
              OR requested_model LIKE ? ESCAPE '\\'
              OR COALESCE(model, '') LIKE ? ESCAPE '\\'
              OR COALESCE(error_code, '') LIKE ? ESCAPE '\\'
              OR COALESCE(upstream_request_id, '') LIKE ? ESCAPE '\\'
              OR COALESCE(upstream_error_summary, '') LIKE ? ESCAPE '\\'
              OR COALESCE(codex_session_id, '') LIKE ? ESCAPE '\\'{account_search})",
        );
        values.extend(
            (0..if has_official_account_column { 11 } else { 10 })
                .map(|_| SqlValue::Text(pattern.clone())),
        );
        clauses.push(search_clause);
    }
    if let Some(provider) = &query.provider {
        if query.cursor_mode {
            clauses.push("provider = ? COLLATE NOCASE".into());
        } else {
            clauses
                .push("(provider = ? COLLATE NOCASE OR provider_name = ? COLLATE NOCASE)".into());
            values.push(SqlValue::Text(provider.clone()));
        }
        values.push(SqlValue::Text(provider.clone()));
    }
    if let Some(model) = &query.model {
        if query.cursor_mode {
            clauses.push("COALESCE(model, requested_model) = ? COLLATE NOCASE".into());
        } else {
            clauses.push("(model = ? COLLATE NOCASE OR requested_model = ? COLLATE NOCASE)".into());
            values.push(SqlValue::Text(model.clone()));
        }
        values.push(SqlValue::Text(model.clone()));
    }
    if let Some(status) = &query.status {
        clauses.push("status = ?".into());
        values.push(SqlValue::Text(status.clone()));
    }
    if let Some(protocol) = &query.protocol {
        clauses.push("upstream_transport = ?".into());
        values.push(SqlValue::Text(protocol.clone()));
    }
    if let Some(account_id) = &query.official_account_id
        && has_official_account_column
    {
        clauses.push("official_account_id = ?".into());
        values.push(SqlValue::Text(account_id.clone()));
    }
    if clauses.is_empty() {
        (String::new(), values)
    } else {
        (format!(" WHERE {}", clauses.join(" AND ")), values)
    }
}

const SUMMARY_TIMINGS: [&str; 7] = [
    "total_duration_ms",
    "COALESCE(downstream_first_content_ms, ttft_ms)",
    "router_pre_upstream_ms",
    "upstream_header_ms",
    "upstream_first_byte_ms",
    "downstream_first_content_ms",
    "queue_delay_ms",
];

fn output_speed_sums() -> [String; 2] {
    [
        "output_tokens",
        "total_duration_ms - router_pre_upstream_ms - upstream_first_byte_ms",
    ]
    .map(|column| format!("SUM(CASE WHEN {OUTPUT_SPEED_VALID_SQL} THEN {column} END)"))
}

pub(super) fn summary_columns() -> String {
    let [
        duration,
        ttft,
        router,
        header,
        first_byte,
        first_content,
        queue,
    ] = SUMMARY_TIMINGS.map(|column| format!("AVG(CASE WHEN {column} >= 0 THEN {column} END)"));
    let [speed_tokens, speed_generation] = output_speed_sums();
    format!(
        "COUNT(*),
    COALESCE(SUM(status = 'succeeded'), 0), COALESCE(SUM(status = 'failed'), 0),
    COALESCE(SUM(status = 'incomplete'), 0), COALESCE(SUM(status = 'cancelled'), 0),
    {duration}, {ttft}, {speed_tokens} * 1000.0 / {speed_generation},
    {router}, {header}, {first_byte}, {first_content}, {queue},
    SUM(input_tokens), SUM(output_tokens), SUM(total_tokens), SUM(cached_input_tokens),
    COALESCE(SUM(usage_reported != 0), 0), COUNT(total_tokens)"
    )
}

pub(super) fn summary_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<RouteRequestLogSummary> {
    let total = row_u64(row, 0)?;
    let succeeded_count = row_u64(row, 1)?;
    Ok(RouteRequestLogSummary {
        total,
        succeeded_count,
        failed_count: row_u64(row, 2)?,
        incomplete_count: row_u64(row, 3)?,
        cancelled_count: row_u64(row, 4)?,
        avg_duration: row.get(5)?,
        avg_ttft: row.get(6)?,
        avg_output_tokens_per_second: row.get(7)?,
        avg_router_pre_upstream: row.get(8)?,
        avg_upstream_header: row.get(9)?,
        avg_upstream_first_byte: row.get(10)?,
        avg_downstream_first_content: row.get(11)?,
        avg_queue_delay: row.get(12)?,
        success_rate: (total > 0).then(|| succeeded_count as f64 * 100.0 / total as f64),
        input_tokens_sum: row_optional_u64(row, 13)?,
        output_tokens_sum: row_optional_u64(row, 14)?,
        total_tokens_sum: row_optional_u64(row, 15)?,
        cached_tokens_sum: row_optional_u64(row, 16)?,
        usage_reported_count: row_u64(row, 17)?,
        total_tokens_known_count: row_u64(row, 18)?,
    })
}

pub(super) fn statistics_bucket_columns() -> String {
    let timings = SUMMARY_TIMINGS
        .map(|column| {
            let value = format!("CASE WHEN {column} >= 0 THEN {column} END");
            format!("TOTAL({value}), COUNT({value})")
        })
        .join(", ");
    let [speed_tokens, speed_generation] = output_speed_sums();
    format!(
        "COUNT(*),
        COALESCE(SUM(status = 'succeeded'), 0), COALESCE(SUM(status = 'failed'), 0),
        COALESCE(SUM(status = 'incomplete'), 0), COALESCE(SUM(status = 'cancelled'), 0),
        COALESCE(SUM(usage_reported != 0), 0), COUNT(total_tokens), {timings},
        SUM(input_tokens), SUM(output_tokens), SUM(total_tokens), SUM(cached_input_tokens),
        {speed_tokens}, {speed_generation}"
    )
}

#[derive(Default)]
struct StatisticsAggregate {
    counts: [u64; 7],
    timings: [(f64, u64); 7],
    token_sums: [Option<i64>; 6],
}

impl StatisticsAggregate {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        let mut aggregate = Self::default();
        let mut index = 0;
        for count in &mut aggregate.counts {
            *count = row_u64(row, index)?;
            index += 1;
        }
        for (sum, count) in &mut aggregate.timings {
            *sum = row.get(index)?;
            *count = row_u64(row, index + 1)?;
            index += 2;
        }
        for sum in &mut aggregate.token_sums {
            *sum = row.get(index)?;
            index += 1;
        }
        Ok(aggregate)
    }

    fn merge(&mut self, other: &Self) -> anyhow::Result<()> {
        for (count, other_count) in self.counts.iter_mut().zip(other.counts) {
            *count += other_count;
        }
        for ((sum, count), (other_sum, other_count)) in self.timings.iter_mut().zip(other.timings) {
            *sum += other_sum;
            *count += other_count;
        }
        // Keep signed sums until aggregation finishes, including NULL and
        // negative legacy token values; reject the same integer limit as SQLite.
        for (sum, other_sum) in self.token_sums.iter_mut().zip(other.token_sums) {
            if let Some(other_sum) = other_sum {
                *sum = Some(
                    sum.unwrap_or(0)
                        .checked_add(other_sum)
                        .ok_or_else(|| anyhow::anyhow!("请求日志聚合值超出 SQLite 整数上限"))?,
                );
            }
        }
        Ok(())
    }

    fn summary(&self) -> RouteRequestLogSummary {
        let [
            total,
            succeeded_count,
            failed_count,
            incomplete_count,
            cancelled_count,
            usage_reported_count,
            total_tokens_known_count,
        ] = self.counts;
        let [
            avg_duration,
            avg_ttft,
            avg_router_pre_upstream,
            avg_upstream_header,
            avg_upstream_first_byte,
            avg_downstream_first_content,
            avg_queue_delay,
        ] = self
            .timings
            .map(|(sum, count)| (count > 0).then(|| sum / count as f64));
        let [
            input_tokens_sum,
            output_tokens_sum,
            total_tokens_sum,
            cached_tokens_sum,
            _,
            _,
        ] = self
            .token_sums
            .map(|sum| sum.map(|value| u64::try_from(value).unwrap_or_default()));
        RouteRequestLogSummary {
            total,
            succeeded_count,
            failed_count,
            incomplete_count,
            cancelled_count,
            avg_duration,
            avg_ttft,
            avg_router_pre_upstream,
            avg_upstream_header,
            avg_upstream_first_byte,
            avg_downstream_first_content,
            avg_queue_delay,
            avg_output_tokens_per_second: self.token_sums[4]
                .zip(self.token_sums[5])
                .map(|(tokens, generation)| tokens as f64 * 1000.0 / generation as f64),
            success_rate: (total > 0).then(|| succeeded_count as f64 * 100.0 / total as f64),
            input_tokens_sum,
            output_tokens_sum,
            total_tokens_sum,
            cached_tokens_sum,
            usage_reported_count,
            total_tokens_known_count,
        }
    }
}

pub(crate) fn query_route_request_log_models(
    root: &Path,
    backend: RouteRequestLogBackend,
    query: RouteRequestLogModelQuery,
) -> anyhow::Result<RouteRequestLogModelPage> {
    let after_model = query.after_model;
    anyhow::ensure!(
        after_model.as_ref().is_none_or(|value| value.len() <= 4096),
        "模型游标过长"
    );
    let query = RouteRequestLogQuery {
        from_unix_ms: query.from_unix_ms,
        to_unix_ms: query.to_unix_ms,
        provider: query.provider,
        official_account_id: query.official_account_id,
        cursor_mode: true,
        ..Default::default()
    }
    .normalize()?;
    let mut result = RouteRequestLogModelPage {
        queryable: backend == RouteRequestLogBackend::Sqlite,
        models: Vec::new(),
        next_cursor: None,
    };
    let path = root.join(SQLITE_FILE_NAME);
    if !result.queryable || !path.is_file() {
        return Ok(result);
    }
    let mut connection = open_query_connection(&path)?;
    let transaction = connection.transaction()?;
    let columns = sqlite_optional_columns(&transaction, &path)?;
    let (mut filter, mut values) = sqlite_query_filters(&query, columns.official_account);
    if query.official_account_id.is_some() && !columns.official_account {
        return Ok(result);
    }
    filter.push_str(if filter.is_empty() {
        " WHERE "
    } else {
        " AND "
    });
    filter.push_str("TRIM(COALESCE(model, requested_model)) <> ''");
    if let Some(after) = after_model {
        filter.push_str(" AND COALESCE(model, requested_model) COLLATE BINARY > ?");
        values.push(SqlValue::Text(after));
    }
    result.models = transaction.prepare(&format!(
        "SELECT DISTINCT COALESCE(model, requested_model) AS model_key FROM route_request_logs{filter} ORDER BY model_key COLLATE BINARY LIMIT 201"
    ))?.query_map(params_from_iter(values.iter()), |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    if result.models.len() > 200 {
        result.models.truncate(200);
        result.next_cursor = result.models.last().cloned();
    }
    Ok(result)
}

pub(crate) fn query_route_request_log_stats(
    root: &Path,
    backend: RouteRequestLogBackend,
    mut query: RouteRequestLogQuery,
) -> anyhow::Result<RouteRequestLogAnalytics> {
    if query.all_time
        && (query.from_unix_ms.is_some()
            || query.to_unix_ms.is_some()
            || query.cursor_mode
            || query.cursor.is_some())
    {
        anyhow::bail!("全部历史统计不能同时指定时间范围或分页游标");
    }
    query.cursor_mode = !query.all_time;
    query.cursor = None;
    let mut query = query.normalize()?;
    let to = query.to_unix_ms.unwrap_or_else(unix_timestamp_ms);
    let from = query
        .from_unix_ms
        .unwrap_or_else(|| to.saturating_sub(DAY_MS));
    let queryable = backend == RouteRequestLogBackend::Sqlite;
    let bucket_ms = if to - from <= 7 * DAY_MS {
        DAY_MS / 24
    } else {
        DAY_MS
    };
    let mut result = RouteRequestLogAnalytics {
        status: if queryable { "ok" } else { "unavailable" },
        backend: if queryable { "sqlite" } else { "ndjson" },
        queryable,
        reason: (!queryable).then_some("ndjson_not_queryable"),
        from_unix_ms: from,
        to_unix_ms: to,
        summary: RouteRequestLogSummary::default(),
        groups: Vec::new(),
        groups_truncated: false,
        trend: Vec::new(),
        daily_trend: Vec::new(),
        bucket_ms,
        database_bytes: fs::metadata(root.join(SQLITE_FILE_NAME))
            .map_or(0, |metadata| metadata.len()),
        wal_bytes: fs::metadata(root.join(format!("{SQLITE_FILE_NAME}-wal")))
            .map_or(0, |metadata| metadata.len()),
    };
    let path = root.join(SQLITE_FILE_NAME);
    if !queryable || !path.is_file() {
        return Ok(result);
    }
    let mut connection = open_query_connection(&path)?;
    let transaction = connection.transaction()?;
    let optional_columns = sqlite_optional_columns(&transaction, &path)?;
    if query.all_time {
        query.cursor_mode = true;
        query.from_unix_ms = Some(0);
        query.to_unix_ms = Some(to);
    }
    let (mut where_clause, mut values) =
        sqlite_query_filters(&query, optional_columns.official_account);
    let summary_columns = summary_columns();
    if query.all_time {
        // MIN can stop at the first matching entry in the timestamp index.
        // Keep the boundary lookup in the same snapshot and exclude future rows.
        let earliest = transaction.query_row(
            &format!("SELECT MIN(timestamp_unix_ms) FROM route_request_logs{where_clause}"),
            params_from_iter(values.iter()),
            |row| row_optional_u64(row, 0),
        )?;
        let Some(earliest) = earliest else {
            transaction.commit()?;
            return Ok(result);
        };
        result.from_unix_ms = earliest;
        query.from_unix_ms = Some(result.from_unix_ms);
        let span = to - result.from_unix_ms;
        result.bucket_ms = if span <= 7 * DAY_MS {
            DAY_MS / 24
        } else {
            span.div_ceil(366 * DAY_MS).max(1) * DAY_MS
        };
        (where_clause, values) = sqlite_query_filters(&query, optional_columns.official_account);
    }
    // The range and adaptive UTC bucket width produce at most 367 buckets.
    let bucket_ms = result.bucket_ms;
    // Each bucket retains metric sums and valid counts, including both TPS
    // operands, so the summary shares this scan without averaging averages.
    let daily_from_trend = query.include_daily_trend && bucket_ms <= DAY_MS;
    let sql = format!(
        "SELECT {}, timestamp_unix_ms / {bucket_ms} * {bucket_ms} AS bucket
        FROM route_request_logs{where_clause} GROUP BY bucket ORDER BY bucket",
        statistics_bucket_columns(),
    );
    let mut totals = StatisticsAggregate::default();
    {
        let mut statement = transaction.prepare(&sql)?;
        let mut rows = statement.query(params_from_iter(values.iter()))?;
        let mut daily_tokens_sum: Option<i64> = None;
        while let Some(row) = rows.next()? {
            let aggregate = StatisticsAggregate::from_row(row)?;
            let summary = aggregate.summary();
            totals.merge(&aggregate)?;
            let trend = RouteRequestLogTrend {
                timestamp_unix_ms: row.get("bucket")?,
                total: summary.total,
                total_tokens_sum: summary.total_tokens_sum,
                avg_duration: summary.avg_duration,
                avg_ttft: summary.avg_ttft,
                avg_output_tokens_per_second: summary.avg_output_tokens_per_second,
                avg_downstream_first_content: summary.avg_downstream_first_content,
            };
            if daily_from_trend {
                let day_timestamp = trend.timestamp_unix_ms / DAY_MS * DAY_MS;
                if result
                    .daily_trend
                    .last()
                    .is_none_or(|day| day.timestamp_unix_ms != day_timestamp)
                {
                    result.daily_trend.push(RouteRequestLogDailyTrend {
                        timestamp_unix_ms: day_timestamp,
                        total: 0,
                        total_tokens_sum: None,
                        total_tokens_known_count: 0,
                    });
                    daily_tokens_sum = None;
                }
                let day = result.daily_trend.last_mut().unwrap();
                day.total += trend.total;
                day.total_tokens_known_count += summary.total_tokens_known_count;
                // Preserve NULL and signed legacy values until the daily sum
                // is complete, matching SQLite SUM followed by row_optional_u64.
                if let Some(tokens) = aggregate.token_sums[2] {
                    daily_tokens_sum = Some(
                        daily_tokens_sum
                            .unwrap_or(0)
                            .checked_add(tokens)
                            .ok_or_else(|| anyhow::anyhow!("每日 token 总数超出统计上限"))?,
                    );
                }
                day.total_tokens_sum = daily_tokens_sum.and_then(|sum| u64::try_from(sum).ok());
            }
            result.trend.push(trend);
        }
    }
    result.summary = totals.summary();
    if result.summary.total == 0 {
        transaction.commit()?;
        return Ok(result);
    }
    if let Some(group_by) = &query.group_by
        && (group_by != "official_account" || optional_columns.official_account)
    {
        let column = match group_by.as_str() {
            "model" => "COALESCE(model, requested_model)",
            "provider" => "provider",
            "status" => "status",
            "protocol" => "upstream_transport",
            "request_kind" => "request_kind",
            "session" => "codex_session_id",
            "official_account" => "official_account_id",
            _ => unreachable!("validated grouping"),
        };
        let order = if query.group_sort.as_deref() == Some("tokens") {
            "SUM(total_tokens) IS NULL, SUM(total_tokens) DESC, group_key"
        } else {
            "COUNT(*) DESC, group_key"
        };
        let sql = format!(
            "SELECT {summary_columns}, COALESCE({column}, '') AS group_key
            FROM route_request_logs{where_clause} GROUP BY group_key
            ORDER BY {order} LIMIT 51"
        );
        result.groups = transaction
            .prepare(&sql)?
            .query_map(params_from_iter(values.iter()), |row| {
                Ok(RouteRequestLogGroup {
                    key: row.get(19)?,
                    summary: summary_from_row(row)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        result.groups_truncated = result.groups.len() > 50;
        result.groups.truncate(50);
    }
    if query.include_daily_trend && !daily_from_trend {
        let sql = format!(
            "SELECT timestamp_unix_ms / {DAY_MS} * {DAY_MS} AS day,
            COUNT(*), SUM(total_tokens), COUNT(total_tokens)
            FROM route_request_logs{where_clause} GROUP BY day ORDER BY day"
        );
        result.daily_trend = transaction
            .prepare(&sql)?
            .query_map(params_from_iter(values.iter()), |row| {
                Ok(RouteRequestLogDailyTrend {
                    timestamp_unix_ms: row_u64(row, 0)?,
                    total: row_u64(row, 1)?,
                    total_tokens_sum: row_optional_u64(row, 2)?,
                    total_tokens_known_count: row_u64(row, 3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
    }
    transaction.commit()?;
    Ok(result)
}

#[derive(Clone, Copy)]
struct RouteRequestLogOptionalColumns {
    /// Billing tier columns used by the pricing estimate.
    tiers: bool,
    /// The per-route official account id.
    official_account: bool,
    /// Request body shape summary columns written for every request.
    request_shape: bool,
    /// 上游响应头列随 schema 版本 11 加入，旧库尚未迁移时按缺失处理。
    response_headers: bool,
    /// 上游回报的实际使用模型列随 schema 版本 12 加入。
    response_model: bool,
}

/// These columns are added by the writer at open time and never dropped, so a
/// positive probe can be remembered per database path. Negative results keep
/// probing: the writer may add the columns while this process is running.
fn sqlite_optional_columns(
    connection: &Connection,
    path: &Path,
) -> rusqlite::Result<RouteRequestLogOptionalColumns> {
    static TIERED_PATHS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    static ACCOUNTED_PATHS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    static SHAPED_PATHS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    static RESPONSE_HEADER_PATHS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    static RESPONSE_MODEL_PATHS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    let tiers_known = sqlite_path_known(&TIERED_PATHS, path);
    let official_known = sqlite_path_known(&ACCOUNTED_PATHS, path);
    let shape_known = sqlite_path_known(&SHAPED_PATHS, path);
    let headers_known = sqlite_path_known(&RESPONSE_HEADER_PATHS, path);
    let model_known = sqlite_path_known(&RESPONSE_MODEL_PATHS, path);
    if tiers_known && official_known && shape_known && headers_known && model_known {
        return Ok(RouteRequestLogOptionalColumns {
            tiers: true,
            official_account: true,
            request_shape: true,
            response_headers: true,
            response_model: true,
        });
    }
    let columns = table_columns(connection, "route_request_logs")?;
    Ok(RouteRequestLogOptionalColumns {
        tiers: sqlite_remember_column(&TIERED_PATHS, path, columns.contains("service_tier")),
        official_account: sqlite_remember_column(
            &ACCOUNTED_PATHS,
            path,
            columns.contains("official_account_id"),
        ),
        request_shape: sqlite_remember_column(
            &SHAPED_PATHS,
            path,
            columns.contains("request_bytes"),
        ),
        response_headers: sqlite_remember_column(
            &RESPONSE_HEADER_PATHS,
            path,
            columns.contains("upstream_response_headers"),
        ),
        response_model: sqlite_remember_column(
            &RESPONSE_MODEL_PATHS,
            path,
            columns.contains("upstream_response_model"),
        ),
    })
}

fn sqlite_path_known(known_paths: &OnceLock<Mutex<HashSet<PathBuf>>>, path: &Path) -> bool {
    let known = known_paths.get_or_init(|| Mutex::new(HashSet::new()));
    lock_unpoisoned(known).contains(path)
}

fn sqlite_remember_column(
    known_paths: &OnceLock<Mutex<HashSet<PathBuf>>>,
    path: &Path,
    exists: bool,
) -> bool {
    if exists {
        let known = known_paths.get_or_init(|| Mutex::new(HashSet::new()));
        lock_unpoisoned(known).insert(path.to_path_buf());
    }
    exists
}

pub(super) fn open_query_connection(path: &Path) -> rusqlite::Result<Connection> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.busy_timeout(SQLITE_BUSY_TIMEOUT)?;
    connection.pragma_update(None, "query_only", "ON")?;
    let deadline = Instant::now() + Duration::from_secs(5);
    connection.progress_handler(10_000, Some(move || Instant::now() >= deadline));
    Ok(connection)
}

fn query_item_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RouteRequestLogQueryItem> {
    Ok(RouteRequestLogQueryItem {
        requested_service_tier: row.get(43)?,
        service_tier: row.get(44)?,
        request_id: row.get(0)?,
        trace_id: row.get(1)?,
        timestamp_unix_ms: row_u64(row, 2)?,
        provider: row.get(3)?,
        provider_name: row.get(4)?,
        requested_model: row.get(5)?,
        model: row.get(6)?,
        reasoning_effort: row.get(7)?,
        thinking_budget_tokens: row_optional_u64(row, 8)?,
        ttft_ms: row_optional_u64(row, 9)?,
        router_pre_upstream_ms: row_optional_u64(row, 10)?,
        upstream_first_byte_ms: row_optional_u64(row, 11)?,
        downstream_first_content_ms: row_optional_u64(row, 12)?,
        upstream_header_ms: row_optional_u64(row, 13)?,
        total_duration_ms: row_u64(row, 14)?,
        queue_delay_ms: row_u64(row, 15)?,
        input_tokens: row_optional_u64(row, 16)?,
        output_tokens: row_optional_u64(row, 17)?,
        cached_input_tokens: row_optional_u64(row, 18)?,
        cache_creation_input_tokens: row_optional_u64(row, 19)?,
        reasoning_output_tokens: row_optional_u64(row, 20)?,
        total_tokens: row_optional_u64(row, 21)?,
        usage_reported: row.get(22)?,
        usage_unavailable_reason: row.get(23)?,
        request_protocol: row.get(24)?,
        upstream_transport: row.get(25)?,
        request_kind: row.get(26)?,
        status: row.get(27)?,
        status_code: row_optional_u16(row, 28)?,
        upstream_status_code: row_optional_u16(row, 29)?,
        error_code: row.get(30)?,
        completion_reason: row.get(31)?,
        fallback_count: row_u32(row, 32)?,
        fallback_reason: row.get(33)?,
        upstream_authority: row.get(34)?,
        upstream_request_id: row.get(35)?,
        upstream_protocol: row.get(36)?,
        protocol_bridge: row.get(37)?,
        first_byte_source: row.get(38)?,
        subagent: row.get(39)?,
        upstream_error_summary: row.get(40)?,
        codex_session_id: row.get(41)?,
        codex_session_is_parent: row.get(42)?,
        upstream_request_headers: row.get(45)?,
        official_account_id: row.get(46)?,
        request_input_state: row.get(47)?,
        request_input_items: row_optional_u64(row, 48)?,
        request_has_previous_response_id: row.get(49)?,
        request_bytes: row_optional_u64(row, 50)?,
        upstream_input_state: row.get(51)?,
        upstream_input_items: row_optional_u64(row, 52)?,
        upstream_has_previous_response_id: row.get(53)?,
        upstream_bytes: row_optional_u64(row, 54)?,
        upstream_response_headers: row.get(55)?,
        upstream_response_model: row.get(56)?,
        output_tokens_per_second: row.get(57)?,
    })
}

fn escape_like_pattern(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        if matches!(character, '\\' | '%' | '_') {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

pub(super) fn row_u64(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<u64> {
    row.get::<_, i64>(index)
        .map(|value| u64::try_from(value).unwrap_or_default())
}

pub(super) fn row_optional_u64(
    row: &rusqlite::Row<'_>,
    index: usize,
) -> rusqlite::Result<Option<u64>> {
    row.get::<_, Option<i64>>(index)
        .map(|value| value.map(|value| u64::try_from(value).unwrap_or_default()))
}

fn row_u32(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<u32> {
    row.get::<_, i64>(index)
        .map(|value| u32::try_from(value).unwrap_or_default())
}

fn row_optional_u16(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<Option<u16>> {
    row.get::<_, Option<i64>>(index)
        .map(|value| value.map(|value| u16::try_from(value).unwrap_or_default()))
}
