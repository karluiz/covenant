//! UI vitals — terminal-speed metrics (switch / input / boot) persisted
//! per app version so releases can be compared from real local usage.
//! Frontend batches events through `vitals_record`; percentiles are
//! computed on read. Everything stays in `<data_dir>/vitals.db`.

use std::path::Path;
use std::sync::Once;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::AppState;

const RETENTION_DAYS: i64 = 90;

#[derive(Debug, Clone, Deserialize)]
pub struct UiVitalEventIn {
    pub metric: String,
    pub value_ms: f64,
    pub aux_ms: Option<f64>,
    pub detail: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VitalsSummaryRow {
    pub metric: String,
    pub app_version: String,
    pub n: i64,
    pub p50: f64,
    pub p95: f64,
    pub max: f64,
    pub first_seen: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct VitalsWorstRow {
    pub ts: i64,
    pub app_version: String,
    pub value_ms: f64,
    pub aux_ms: Option<f64>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VitalsDailyRow {
    pub day: String,
    pub p95: f64,
    pub n: i64,
}

pub fn open_db(data_dir: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(data_dir.join("vitals.db"))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vitals_events (
           id          INTEGER PRIMARY KEY,
           ts          INTEGER NOT NULL,
           app_version TEXT NOT NULL,
           metric      TEXT NOT NULL,
           value_ms    REAL NOT NULL,
           aux_ms      REAL,
           detail      TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_vitals_metric_version
           ON vitals_events(metric, app_version);
         CREATE INDEX IF NOT EXISTS idx_vitals_ts ON vitals_events(ts);",
    )?;
    Ok(conn)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn insert_events(
    conn: &Connection,
    ts_ms: i64,
    app_version: &str,
    events: &[UiVitalEventIn],
) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare(
        "INSERT INTO vitals_events (ts, app_version, metric, value_ms, aux_ms, detail)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;
    for e in events {
        stmt.execute(params![
            ts_ms,
            app_version,
            e.metric,
            e.value_ms,
            e.aux_ms,
            e.detail.as_ref().map(|d| d.to_string()),
        ])?;
    }
    Ok(())
}

/// Nearest-rank percentile on an ascending-sorted slice.
fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let rank = ((p / 100.0) * sorted.len() as f64).ceil() as usize;
    sorted[rank.clamp(1, sorted.len()) - 1]
}

pub fn summary(conn: &Connection, days: u32) -> rusqlite::Result<Vec<VitalsSummaryRow>> {
    let cutoff = now_ms() - i64::from(days) * 86_400_000;
    let mut stmt = conn.prepare(
        "SELECT metric, app_version, value_ms, ts FROM vitals_events
         WHERE ts >= ?1 ORDER BY metric, app_version",
    )?;
    // Group in Rust — volumes are small (hundreds/day).
    let mut groups: Vec<(String, String, Vec<f64>, i64)> = Vec::new();
    let rows = stmt.query_map(params![cutoff], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, f64>(2)?,
            r.get::<_, i64>(3)?,
        ))
    })?;
    for row in rows {
        let (metric, version, value, ts) = row?;
        match groups.last_mut() {
            Some((m, v, values, first)) if *m == metric && *v == version => {
                values.push(value);
                if ts < *first {
                    *first = ts;
                }
            }
            _ => groups.push((metric, version, vec![value], ts)),
        }
    }
    Ok(groups
        .into_iter()
        .map(|(metric, app_version, mut values, first_seen)| {
            values.sort_by(|a, b| a.total_cmp(b));
            VitalsSummaryRow {
                metric,
                app_version,
                n: values.len() as i64,
                p50: percentile(&values, 50.0),
                p95: percentile(&values, 95.0),
                max: values.last().copied().unwrap_or(0.0),
                first_seen,
            }
        })
        .collect())
}

pub fn worst(conn: &Connection, metric: &str, limit: u32) -> rusqlite::Result<Vec<VitalsWorstRow>> {
    let mut stmt = conn.prepare(
        "SELECT ts, app_version, value_ms, aux_ms, detail FROM vitals_events
         WHERE metric = ?1 ORDER BY value_ms DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![metric, limit], |r| {
        Ok(VitalsWorstRow {
            ts: r.get(0)?,
            app_version: r.get(1)?,
            value_ms: r.get(2)?,
            aux_ms: r.get(3)?,
            detail: r.get(4)?,
        })
    })?;
    rows.collect()
}

pub fn daily(conn: &Connection, metric: &str, days: u32) -> rusqlite::Result<Vec<VitalsDailyRow>> {
    let cutoff = now_ms() - i64::from(days) * 86_400_000;
    let mut stmt = conn.prepare(
        "SELECT date(ts / 1000, 'unixepoch') AS day, value_ms FROM vitals_events
         WHERE metric = ?1 AND ts >= ?2 ORDER BY day",
    )?;
    let mut groups: Vec<(String, Vec<f64>)> = Vec::new();
    let rows = stmt.query_map(params![metric, cutoff], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?))
    })?;
    for row in rows {
        let (day, value) = row?;
        match groups.last_mut() {
            Some((d, values)) if *d == day => values.push(value),
            _ => groups.push((day, vec![value])),
        }
    }
    Ok(groups
        .into_iter()
        .map(|(day, mut values)| {
            values.sort_by(|a, b| a.total_cmp(b));
            VitalsDailyRow {
                day,
                p95: percentile(&values, 95.0),
                n: values.len() as i64,
            }
        })
        .collect())
}

pub fn prune(conn: &Connection, now_ms: i64) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM vitals_events WHERE ts < ?1",
        params![now_ms - RETENTION_DAYS * 86_400_000],
    )
}

static PRUNE_ONCE: Once = Once::new();

#[tauri::command]
pub async fn vitals_record(
    state: State<'_, AppState>,
    events: Vec<UiVitalEventIn>,
) -> Result<(), String> {
    let data_dir = state.data_dir.clone();
    tokio::task::spawn_blocking(move || {
        let conn = open_db(&data_dir).map_err(|e| e.to_string())?;
        PRUNE_ONCE.call_once(|| {
            let _ = prune(&conn, now_ms());
        });
        insert_events(&conn, now_ms(), env!("CARGO_PKG_VERSION"), &events)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn vitals_summary(
    state: State<'_, AppState>,
    days: u32,
) -> Result<Vec<VitalsSummaryRow>, String> {
    let data_dir = state.data_dir.clone();
    tokio::task::spawn_blocking(move || {
        let conn = open_db(&data_dir).map_err(|e| e.to_string())?;
        summary(&conn, days).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn vitals_worst(
    state: State<'_, AppState>,
    metric: String,
    limit: u32,
) -> Result<Vec<VitalsWorstRow>, String> {
    let data_dir = state.data_dir.clone();
    tokio::task::spawn_blocking(move || {
        let conn = open_db(&data_dir).map_err(|e| e.to_string())?;
        worst(&conn, &metric, limit).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn vitals_daily(
    state: State<'_, AppState>,
    metric: String,
    days: u32,
) -> Result<Vec<VitalsDailyRow>, String> {
    let data_dir = state.data_dir.clone();
    tokio::task::spawn_blocking(move || {
        let conn = open_db(&data_dir).map_err(|e| e.to_string())?;
        daily(&conn, &metric, days).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(metric: &str, value: f64) -> UiVitalEventIn {
        UiVitalEventIn {
            metric: metric.into(),
            value_ms: value,
            aux_ms: None,
            detail: None,
        }
    }

    #[test]
    fn insert_then_summary_computes_percentiles_per_version() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_db(dir.path()).expect("open");
        let now = now_ms();
        let values: Vec<UiVitalEventIn> = (1..=100).map(|i| ev("switch", f64::from(i))).collect();
        insert_events(&conn, now, "0.11.2", &values).expect("insert");
        insert_events(&conn, now, "0.11.1", &[ev("switch", 500.0)]).expect("insert");
        let rows = summary(&conn, 90).expect("summary");
        let v2 = rows
            .iter()
            .find(|r| r.app_version == "0.11.2" && r.metric == "switch")
            .expect("row");
        assert_eq!(v2.n, 100);
        assert_eq!(v2.p50, 50.0);
        assert_eq!(v2.p95, 95.0);
        assert_eq!(v2.max, 100.0);
        let v1 = rows
            .iter()
            .find(|r| r.app_version == "0.11.1")
            .expect("row");
        assert_eq!(v1.n, 1);
        assert_eq!(v1.p50, 500.0);
    }

    #[test]
    fn worst_orders_by_value_and_carries_detail() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_db(dir.path()).expect("open");
        let mut slow = ev("switch", 900.0);
        slow.detail = Some(serde_json::json!({ "colsDelta": 40 }));
        insert_events(
            &conn,
            now_ms(),
            "0.11.2",
            &[ev("switch", 10.0), slow, ev("switch", 50.0)],
        )
        .expect("insert");
        let rows = worst(&conn, "switch", 2).expect("worst");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].value_ms, 900.0);
        assert!(rows[0]
            .detail
            .as_deref()
            .expect("detail")
            .contains("colsDelta"));
        assert_eq!(rows[1].value_ms, 50.0);
    }

    #[test]
    fn daily_groups_by_day() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_db(dir.path()).expect("open");
        let day_ms = 86_400_000;
        let now = now_ms();
        insert_events(
            &conn,
            now - day_ms,
            "0.11.2",
            &[ev("input", 20.0), ev("input", 40.0)],
        )
        .expect("insert");
        insert_events(&conn, now, "0.11.2", &[ev("input", 30.0)]).expect("insert");
        let rows = daily(&conn, "input", 90).expect("daily");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].n, 2);
        assert_eq!(rows[1].n, 1);
        assert_eq!(rows[1].p95, 30.0);
    }

    #[test]
    fn prune_drops_only_expired_rows() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = open_db(dir.path()).expect("open");
        let now = now_ms();
        insert_events(
            &conn,
            now - (RETENTION_DAYS + 1) * 86_400_000,
            "0.11.0",
            &[ev("boot", 1.0)],
        )
        .expect("insert");
        insert_events(&conn, now, "0.11.2", &[ev("boot", 2.0)]).expect("insert");
        let dropped = prune(&conn, now).expect("prune");
        assert_eq!(dropped, 1);
        let rows = summary(&conn, 3650).expect("summary");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].app_version, "0.11.2");
    }

    #[test]
    fn percentile_nearest_rank() {
        assert_eq!(percentile(&[], 95.0), 0.0);
        assert_eq!(percentile(&[7.0], 50.0), 7.0);
        assert_eq!(percentile(&[1.0, 2.0, 3.0, 4.0], 50.0), 2.0);
        assert_eq!(percentile(&[1.0, 2.0, 3.0, 4.0], 95.0), 4.0);
    }
}
