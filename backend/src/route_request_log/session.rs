use super::*;

#[cfg(test)]
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct SessionRecordedTiming {
    pub requests: u64,
    pub model_duration_ms: Option<u64>,
    pub average_ttft_ms: Option<f64>,
    pub timing_request_count: u64,
    pub ttft_sample_count: u64,
}

/// 会话平均速度使用同一批请求的输出量和生成时长，不对单步 TPS 求平均。
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct SessionGenerationTotals {
    pub output_tokens: f64,
    pub generation_ms: f64,
    pub requests: u64,
}

impl SessionGenerationTotals {
    pub(crate) fn add(&mut self, other: Self) {
        self.output_tokens += other.output_tokens;
        self.generation_ms += other.generation_ms;
        self.requests = self.requests.saturating_add(other.requests);
    }

    pub(crate) fn speed(self) -> Option<f64> {
        if self.requests == 0 || self.generation_ms <= 0.0 {
            return None;
        }
        let speed = self.output_tokens * 1000.0 / self.generation_ms;
        (speed.is_finite() && speed >= 0.0).then_some(speed)
    }

    pub(crate) fn from_entry(entry: &RouteRequestLogEntry) -> Option<Self> {
        let generation_ms = entry
            .total_duration_ms
            .checked_sub(entry.router_pre_upstream_ms?)?
            .checked_sub(entry.upstream_first_byte_ms?)?;
        (generation_ms > 0).then_some(Self {
            output_tokens: entry.token_usage.output_tokens? as f64,
            generation_ms: generation_ms as f64,
            requests: 1,
        })
    }
}

/// 只统计保留的自身生成请求；缺失、采样或已清理的日志不补零，不宣称全会话覆盖。
#[cfg(test)]
pub(crate) fn session_recorded_timing(
    root: &Path,
    session_id: &str,
    boundary: Option<&crate::conversation_stats::RuntimeHistoryBoundary>,
) -> Option<SessionRecordedTiming> {
    let path = root.join(SQLITE_FILE_NAME);
    if !path.is_file() {
        return None;
    }
    let connection = open_query_connection(&path).ok()?;
    let (sql, values) = session_timing_query(session_id, boundary);
    connection
        .query_row(&sql, params_from_iter(values), |row| {
            Ok(SessionRecordedTiming {
                requests: row.get(0)?,
                model_duration_ms: row.get(1)?,
                average_ttft_ms: row.get(2)?,
                timing_request_count: row.get(3)?,
                ttft_sample_count: row.get(4)?,
            })
        })
        .ok()
        .filter(|value| value.requests > 0)
}

#[cfg(test)]
fn session_timing_query(
    session_id: &str,
    boundary: Option<&crate::conversation_stats::RuntimeHistoryBoundary>,
) -> (String, Vec<SqlValue>) {
    let mut sql = String::from("SELECT COUNT(*),
          SUM(CASE WHEN router_pre_upstream_ms >= 0 AND total_duration_ms >= router_pre_upstream_ms
              THEN total_duration_ms - router_pre_upstream_ms END),
          AVG(CASE WHEN downstream_first_content_ms >= 0 AND downstream_first_content_ms <= total_duration_ms
              THEN downstream_first_content_ms END),
          COUNT(CASE WHEN router_pre_upstream_ms >= 0 AND total_duration_ms >= router_pre_upstream_ms THEN 1 END),
          COUNT(CASE WHEN downstream_first_content_ms >= 0 AND downstream_first_content_ms <= total_duration_ms THEN 1 END)
         FROM route_request_logs INDEXED BY idx_route_request_logs_session_time
         WHERE codex_session_id IN (?, ?) AND request_kind = 'responses'
           AND COALESCE(codex_session_is_parent, 0) = 0 AND timestamp_unix_ms >= 0");
    let mut values = vec![
        SqlValue::Text(session_id.to_owned()),
        SqlValue::Text(format!("local:{session_id}")),
    ];
    append_runtime_history_boundary(&mut sql, &mut values, boundary);
    (sql, values)
}

/// 只读聚合历史与运行期边界之前的合格请求。短回复与零输出也参与累计，
/// 但缺 usage、缺计时、逆序计时和零生成时长不能进入分子或分母。
#[cfg(test)]
pub(crate) fn session_recorded_average(
    root: &Path,
    session_id: &str,
    boundary: Option<&crate::conversation_stats::RuntimeHistoryBoundary>,
) -> Option<SessionGenerationTotals> {
    let path = root.join(SQLITE_FILE_NAME);
    if !path.is_file() {
        return None;
    }
    let connection = open_query_connection(&path).ok()?;
    let (sql, values) = session_average_query(session_id, boundary);
    connection
        .query_row(&sql, params_from_iter(values), |row| {
            Ok(SessionGenerationTotals {
                output_tokens: row.get(0)?,
                generation_ms: row.get(1)?,
                requests: row.get(2)?,
            })
        })
        .ok()
        .filter(|totals| totals.speed().is_some())
}

#[cfg(test)]
fn session_average_query(
    session_id: &str,
    boundary: Option<&crate::conversation_stats::RuntimeHistoryBoundary>,
) -> (String, Vec<SqlValue>) {
    let mut sql = String::from(
        "SELECT SUM(output_tokens * 1.0),
        SUM((total_duration_ms - router_pre_upstream_ms - upstream_first_byte_ms) * 1.0), COUNT(*)
        FROM route_request_logs INDEXED BY idx_route_request_logs_session_time
        WHERE codex_session_id IN (?, ?) AND request_kind = 'responses'
          AND COALESCE(codex_session_is_parent, 0) = 0
          AND output_tokens >= 0 AND router_pre_upstream_ms >= 0
          AND upstream_first_byte_ms >= 0 AND total_duration_ms >= router_pre_upstream_ms
          AND total_duration_ms - router_pre_upstream_ms > upstream_first_byte_ms",
    );
    let mut values = vec![
        SqlValue::Text(session_id.to_owned()),
        SqlValue::Text(format!("local:{session_id}")),
    ];
    append_runtime_history_boundary(&mut sql, &mut values, boundary);
    (sql, values)
}

fn append_runtime_history_boundary(
    sql: &mut String,
    values: &mut Vec<SqlValue>,
    boundary: Option<&crate::conversation_stats::RuntimeHistoryBoundary>,
) {
    if let Some(boundary) = boundary {
        if boundary.exclude_entire_millisecond {
            sql.push_str(" AND timestamp_unix_ms < ?");
            values.push(SqlValue::Integer(to_i64(boundary.timestamp_unix_ms)));
        } else {
            // 显式上界供会话时间索引使用；仅边界同毫秒需要额外排除少量 ID。
            sql.push_str(" AND timestamp_unix_ms <= ?");
            values.push(SqlValue::Integer(to_i64(boundary.timestamp_unix_ms)));
            if !boundary.request_ids.is_empty() {
                sql.push_str(" AND (timestamp_unix_ms < ? OR request_id NOT IN (");
                values.push(SqlValue::Integer(to_i64(boundary.timestamp_unix_ms)));
                for (index, id) in boundary.request_ids.iter().enumerate() {
                    if index > 0 {
                        sql.push(',');
                    }
                    sql.push('?');
                    values.push(SqlValue::Text(id.clone()));
                }
                sql.push_str("))");
            }
        }
    }
}

/// 最近一轮只查询明确时间窗，沿用会话时间索引，不扫描其他会话或旧轮次。
pub(crate) fn last_turn_recorded_stats(
    root: &Path,
    session_id: &str,
    window: &crate::conversation_stats::TurnWindow,
    boundary: Option<&crate::conversation_stats::RuntimeHistoryBoundary>,
) -> Option<crate::conversation_stats::TurnRequestTotals> {
    let path = root.join(SQLITE_FILE_NAME);
    if !path.is_file() {
        return None;
    }
    let connection = open_query_connection(&path).ok()?;
    let (sql, values) = last_turn_stats_query(session_id, window, boundary);
    connection
        .query_row(&sql, params_from_iter(values), |row| {
            Ok(crate::conversation_stats::TurnRequestTotals {
                requests: row.get(0)?,
                model_duration_ms: row.get::<_, Option<u64>>(1)?.unwrap_or(0),
                model_samples: row.get(2)?,
                ttft_total_ms: row.get::<_, Option<f64>>(3)?.unwrap_or(0.0),
                ttft_samples: row.get(4)?,
                generation: SessionGenerationTotals {
                    output_tokens: row.get::<_, Option<f64>>(5)?.unwrap_or(0.0),
                    generation_ms: row.get::<_, Option<f64>>(6)?.unwrap_or(0.0),
                    requests: row.get(7)?,
                },
                excluded_boundary_requests: row.get(8)?,
            })
        })
        .ok()
        .filter(|totals| totals.requests > 0 || totals.excluded_boundary_requests > 0)
}

fn last_turn_stats_query(
    session_id: &str,
    window: &crate::conversation_stats::TurnWindow,
    boundary: Option<&crate::conversation_stats::RuntimeHistoryBoundary>,
) -> (String, Vec<SqlValue>) {
    let generation = "output_tokens >= 0 AND router_pre_upstream_ms >= 0 AND upstream_first_byte_ms >= 0 AND total_duration_ms >= router_pre_upstream_ms AND total_duration_ms - router_pre_upstream_ms > upstream_first_byte_ms";
    let model = "router_pre_upstream_ms >= 0 AND total_duration_ms >= router_pre_upstream_ms";
    let ttft =
        "downstream_first_content_ms >= 0 AND downstream_first_content_ms <= total_duration_ms";
    let mut sql = format!("SELECT COUNT(CASE WHEN inside_turn = 1 THEN 1 END),
        SUM(CASE WHEN {model} THEN total_duration_ms - router_pre_upstream_ms END),
        COUNT(CASE WHEN {model} THEN 1 END),
        SUM(CASE WHEN {ttft} THEN downstream_first_content_ms * 1.0 END),
        COUNT(CASE WHEN {ttft} THEN 1 END),
        SUM(CASE WHEN {generation} THEN output_tokens * 1.0 END),
        SUM(CASE WHEN {generation} THEN (total_duration_ms - router_pre_upstream_ms - upstream_first_byte_ms) * 1.0 END),
        COUNT(CASE WHEN {generation} THEN 1 END),
        COUNT(CASE WHEN inside_turn = 0 THEN 1 END)
        FROM (SELECT total_duration_ms, router_pre_upstream_ms, downstream_first_content_ms,
            upstream_first_byte_ms, output_tokens, 1 AS inside_turn
        FROM route_request_logs INDEXED BY idx_route_request_logs_session_time
        WHERE codex_session_id IN (?, ?) AND request_kind = 'responses'
        AND COALESCE(codex_session_is_parent, 0) = 0 AND timestamp_unix_ms > ?");
    let mut values = vec![
        SqlValue::Text(session_id.to_owned()),
        SqlValue::Text(format!("local:{session_id}")),
        SqlValue::Integer(to_i64(window.started_at_unix_ms)),
    ];
    if let Some(end) = window.completed_at_unix_ms {
        sql.push_str(" AND timestamp_unix_ms < ?");
        values.push(SqlValue::Integer(to_i64(end)));
    }
    append_runtime_history_boundary(&mut sql, &mut values, boundary);
    // 起止毫秒内没有 turn ID 的请求无法可靠归属。单独精确查这两个毫秒，
    // 不扩大上述历史范围，也不漏掉运行期去重上界之后的结束边界样本。
    sql.push_str(
        " UNION ALL SELECT NULL, NULL, NULL, NULL, NULL, 0
        FROM route_request_logs INDEXED BY idx_route_request_logs_session_time
        WHERE codex_session_id IN (?, ?) AND request_kind = 'responses'
        AND COALESCE(codex_session_is_parent, 0) = 0 AND timestamp_unix_ms IN (?",
    );
    values.extend([
        SqlValue::Text(session_id.to_owned()),
        SqlValue::Text(format!("local:{session_id}")),
        SqlValue::Integer(to_i64(window.started_at_unix_ms)),
    ]);
    if let Some(end) = window.completed_at_unix_ms {
        sql.push_str(", ?");
        values.push(SqlValue::Integer(to_i64(end)));
    }
    sql.push_str("))");
    (sql, values)
}
