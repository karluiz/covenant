//! SQL WHERE-clause builder for ScoreFilter.

use crate::types::{ScoreFilter, TimeRange};

pub struct Where {
    pub sql: String,
    pub params: Vec<rusqlite::types::Value>,
}

pub fn build_where(f: &ScoreFilter) -> Where {
    let mut parts: Vec<String> = vec!["1=1".to_string()];
    let mut params: Vec<rusqlite::types::Value> = vec![];
    match f.range {
        TimeRange::All => {}
        TimeRange::Last7d => {
            parts.push("timestamp_ms >= ?".into());
            params.push((chrono::Utc::now().timestamp_millis() - 7 * 86_400_000).into());
        }
        TimeRange::Last30d => {
            parts.push("timestamp_ms >= ?".into());
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
    Where {
        sql: parts.join(" AND "),
        params,
    }
}
