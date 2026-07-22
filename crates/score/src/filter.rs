//! SQL WHERE-clause builder for ScoreFilter.

use crate::types::{ScoreFilter, TimeRange};

pub struct Where {
    pub sql: String,
    pub params: Vec<rusqlite::types::Value>,
}

/// Build a WHERE clause for the given filter, using `ts_col` as the timestamp
/// column name. `score_events` uses `timestamp_ms`; `specs` and `llm_calls`
/// use `ts_ms`. Pass the right column for the table you are querying.
pub fn build_where_ts(f: &ScoreFilter, ts_col: &str) -> Where {
    let mut parts: Vec<String> = vec!["1=1".to_string()];
    let mut params: Vec<rusqlite::types::Value> = vec![];
    match f.range {
        TimeRange::All => {}
        TimeRange::Last7d => {
            parts.push(format!("{ts_col} >= ?"));
            params.push((chrono::Utc::now().timestamp_millis() - 7 * 86_400_000).into());
        }
        TimeRange::Last30d => {
            parts.push(format!("{ts_col} >= ?"));
            params.push((chrono::Utc::now().timestamp_millis() - 30 * 86_400_000).into());
        }
    }
    if let Some(r) = &f.repo {
        parts.push("repo = ?".into());
        params.push(r.clone().into());
    }
    if let Some(b) = &f.branch {
        parts.push("branch = ?".into());
        params.push(b.clone().into());
    }
    if let Some(g) = &f.group_name {
        parts.push("group_name = ?".into());
        params.push(g.clone().into());
    }
    if let Some(d) = &f.day {
        parts.push("day = ?".into());
        params.push(d.clone().into());
    }
    if let Some(a) = &f.agent {
        parts.push("agent = ?".into());
        params.push(a.clone().into());
    }
    Where {
        sql: parts.join(" AND "),
        params,
    }
}

/// Convenience wrapper for `score_events` queries (uses `timestamp_ms`).
pub fn build_where(f: &ScoreFilter) -> Where {
    build_where_ts(f, "timestamp_ms")
}
