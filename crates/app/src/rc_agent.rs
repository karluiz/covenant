//! Desktop end of the Covenant remote-control channel (RC-0, read-only).
//! Connects outbound to the relay's /rc/desktop and answers list_tabs.

use futures_util::{SinkExt, StreamExt};
use karl_blocks::executor_phase::ExecutorPhase;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio_tungstenite::tungstenite::Message;

use crate::AppState;

#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
enum InFrame {
    ListTabs,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
struct TabInfo {
    session_id: String,
    title: String,
    cwd: String,
    executor: Option<String>,
    phase: String,
    armed: bool,
}

#[derive(Debug, Serialize)]
#[serde(tag = "t", rename_all = "snake_case")]
enum OutFrame {
    Tabs {
        device_id: String,
        tabs: Vec<TabInfo>,
    },
}

fn phase_str(p: &ExecutorPhase) -> &'static str {
    match p {
        ExecutorPhase::Idle => "idle",
        ExecutorPhase::Thinking => "thinking",
        ExecutorPhase::Running { .. } => "running",
        ExecutorPhase::Writing { .. } => "writing",
        ExecutorPhase::Reading { .. } => "reading",
        ExecutorPhase::Waiting { .. } => "waiting",
        ExecutorPhase::Done { .. } => "done",
    }
}

fn ws_url(base: &str, token: &str) -> String {
    let b = base.trim_end_matches('/');
    let b = b
        .strip_prefix("https://")
        .map(|r| format!("wss://{r}"))
        .or_else(|| b.strip_prefix("http://").map(|r| format!("ws://{r}")))
        .unwrap_or_else(|| b.to_string());
    format!("{b}/rc/desktop?token={token}")
}

fn backoff_next(current: Duration) -> Duration {
    current.saturating_mul(2).min(Duration::from_secs(30))
}

fn load_or_create_device_id(config_dir: &PathBuf) -> String {
    let path = config_dir.join("rc_device_id");
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let t = existing.trim();
        if !t.is_empty() {
            return t.to_string();
        }
    }
    let host = std::env::var("HOSTNAME")
        .ok()
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "mac".to_string());
    let id = format!("{host}-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    let _ = std::fs::create_dir_all(config_dir);
    let _ = std::fs::write(&path, &id);
    id
}

async fn collect_tabs(app: &AppHandle) -> Vec<TabInfo> {
    let Some(state) = app.try_state::<AppState>() else {
        return Vec::new();
    };
    let notch = state.notch_hub.clone();

    // Snapshot (id, world-handle) pairs under the lock, then drop the guard.
    // The guard's iterator is not `Send`, so we must not hold it across the
    // per-session `.await`s below (this future runs on a spawned task).
    let snapshot: Vec<_> = {
        let sessions = state.sessions.lock().await;
        sessions
            .iter()
            .map(|(sid, managed)| (*sid, managed.world.clone()))
            .collect()
    };

    let mut out = Vec::with_capacity(snapshot.len());
    for (sid, world) in snapshot {
        let session_id = sid.to_string();
        let (cwd, world_title) = {
            let w = world.lock().await;
            (w.cwd.display().to_string(), w.title.clone())
        };
        let (phase, executor) = match notch.phase_snapshot(sid).await {
            Some((p, agent)) => (phase_str(&p).to_string(), agent),
            None => ("idle".to_string(), None),
        };
        let label = notch.tab_label(sid).await;
        let title = label.or(world_title).unwrap_or_else(|| {
            std::path::Path::new(&cwd)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "shell".to_string())
        });
        out.push(TabInfo {
            session_id,
            title,
            cwd,
            executor,
            phase,
            armed: false,
        });
    }
    out
}

async fn run_once(app: &AppHandle, url: &str, device_id: &str) -> anyhow::Result<()> {
    let (ws, _resp) = tokio_tungstenite::connect_async(url).await?;
    let (mut sink, mut stream) = ws.split();
    tracing::info!(target: "rc_agent", "relay connected");
    while let Some(msg) = stream.next().await {
        match msg? {
            Message::Text(text) => match serde_json::from_str::<InFrame>(&text) {
                Ok(InFrame::ListTabs) => {
                    let tabs = collect_tabs(app).await;
                    let json = serde_json::to_string(&OutFrame::Tabs {
                        device_id: device_id.to_string(),
                        tabs,
                    })?;
                    sink.send(Message::Text(json)).await?;
                }
                Ok(InFrame::Unknown) => {}
                Err(e) => tracing::debug!(target: "rc_agent", error=%e, "bad frame"),
            },
            Message::Close(_) => break,
            _ => {}
        }
    }
    Ok(())
}

async fn agent_loop(app: AppHandle, device_id: String) {
    let mut backoff = Duration::from_secs(1);
    loop {
        let token = match karl_score::auth::load_jwt() {
            Ok(Some(t)) => t,
            Ok(None) => {
                tokio::time::sleep(Duration::from_secs(30)).await;
                continue;
            }
            Err(e) => {
                tracing::debug!(target: "rc_agent", error=%e, "jwt load failed");
                tokio::time::sleep(Duration::from_secs(30)).await;
                continue;
            }
        };
        let base = std::env::var("COVENANT_BACKEND_URL")
            .unwrap_or_else(|_| "https://forge.covenant.uno".to_string());
        let url = ws_url(&base, &token);
        match run_once(&app, &url, &device_id).await {
            Ok(()) => {
                tracing::info!(target: "rc_agent", "relay disconnected; reconnecting");
                backoff = Duration::from_secs(1);
            }
            Err(e) => {
                tracing::debug!(target: "rc_agent", error=%e, "relay connect failed");
                tokio::time::sleep(backoff).await;
                backoff = backoff_next(backoff);
            }
        }
    }
}

pub fn spawn(app: AppHandle) {
    let config_dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let device_id = load_or_create_device_id(&config_dir);
    tracing::info!(target: "rc_agent", %device_id, "starting rc-agent");
    tauri::async_runtime::spawn(agent_loop(app, device_id));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_tabs_frame_parses() {
        let f: InFrame = serde_json::from_str(r#"{"t":"list_tabs"}"#).unwrap();
        assert!(matches!(f, InFrame::ListTabs));
    }
    #[test]
    fn unknown_frame_is_ignored_not_error() {
        let f: InFrame = serde_json::from_str(r#"{"t":"send_input","data":"x"}"#).unwrap();
        assert!(matches!(f, InFrame::Unknown));
    }
    #[test]
    fn tabs_frame_serializes_with_tag() {
        let out = OutFrame::Tabs {
            device_id: "dev1".into(),
            tabs: vec![TabInfo {
                session_id: "s1".into(),
                title: "build".into(),
                cwd: "/proj".into(),
                executor: Some("claude".into()),
                phase: "running".into(),
                armed: false,
            }],
        };
        let s = serde_json::to_string(&out).unwrap();
        assert!(s.contains(r#""t":"tabs""#));
        assert!(s.contains(r#""session_id":"s1""#));
        assert!(s.contains(r#""armed":false"#));
    }
    #[test]
    fn phase_strings_are_stable() {
        assert_eq!(phase_str(&ExecutorPhase::Idle), "idle");
        assert_eq!(
            phase_str(&ExecutorPhase::Running { cmd: "x".into() }),
            "running"
        );
        assert_eq!(
            phase_str(&ExecutorPhase::Waiting { reason: "y".into() }),
            "waiting"
        );
    }
    #[test]
    fn ws_url_swaps_scheme_and_appends_path() {
        assert_eq!(
            ws_url("https://forge.covenant.uno", "T"),
            "wss://forge.covenant.uno/rc/desktop?token=T"
        );
        assert_eq!(
            ws_url("http://localhost:8080/", "T"),
            "ws://localhost:8080/rc/desktop?token=T"
        );
        assert_eq!(
            ws_url("wss://forge.covenant.uno", "T"),
            "wss://forge.covenant.uno/rc/desktop?token=T"
        );
    }
    #[test]
    fn backoff_doubles_and_caps_at_30s() {
        assert_eq!(backoff_next(Duration::from_secs(1)), Duration::from_secs(2));
        assert_eq!(backoff_next(Duration::from_secs(16)), Duration::from_secs(30));
        assert_eq!(backoff_next(Duration::from_secs(30)), Duration::from_secs(30));
    }
    #[test]
    fn device_id_persists_across_calls() {
        let dir = std::env::temp_dir().join(format!("rc_test_{}", uuid::Uuid::new_v4()));
        let a = load_or_create_device_id(&dir);
        let b = load_or_create_device_id(&dir);
        assert_eq!(a, b);
        assert!(a.contains('-'));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
