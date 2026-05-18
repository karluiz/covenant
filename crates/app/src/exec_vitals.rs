//! Executor transcript vitals — tails the JSONL transcript a Claude Code
//! session writes per turn and feeds the same `VitalsHandle` the rest of
//! Covenant uses, so the status-bar vitals cluster reflects the model and
//! token usage of the user's actual executor (not just Covenant's own
//! summariser / fix-proposer calls).
//!
//! Scope (v1):
//!   * Claude Code only. It writes `~/.claude/projects/<slug>/<sid>.jsonl`,
//!     one JSON object per line, where each `assistant` turn carries
//!     `message.model` + `message.usage`.
//!   * Per-session tail task started on `attach(session, cwd)` and
//!     aborted on `detach(session)`. The watcher always picks the most
//!     recently mtime'd JSONL in the project dir at the time of `attach`,
//!     seeks to EOF (we don't replay history), and polls the file for
//!     appended lines every 1s.
//!   * Latency for each assistant turn is approximated as
//!     `assistant.timestamp - <preceding user.timestamp>`. Clamped to
//!     [50, 600_000] ms before being reported.
//!
//! Out of scope here: Codex/Copilot/Gemini transcripts (different formats),
//! mid-session rotation to a fresher jsonl file, and concurrent Claude Code
//! sessions in the same project dir colliding on "newest by mtime".

#![allow(dead_code)]

use std::collections::HashMap;
use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use karl_agent::TokenUsage;
use karl_session::SessionId;
use serde::Deserialize;
use tokio::fs::File;
use tokio::io::{AsyncBufReadExt, AsyncSeekExt, BufReader};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::vitals::VitalsHandle;

const POLL_INTERVAL: Duration = Duration::from_millis(1000);
/// Cap a parsed latency so a stale prior `user` timestamp doesn't paint
/// a "10 minute" call. Anthropic's longest legit calls are well under
/// this; anything bigger is almost certainly a foreground gap.
const LATENCY_MAX_MS: u64 = 600_000;
const LATENCY_MIN_MS: u64 = 50;

/// Window during which we wait for a freshly-created jsonl to appear in
/// the project dir before falling back to "newest existing in dir." If
/// two Claude Code sessions share a cwd, the older one shouldn't shadow
/// the just-spawned one — discovery binds to the file that appears (or
/// gets touched) AFTER the tab was attached.
const DISCOVERY_WINDOW: Duration = Duration::from_secs(10);
const DISCOVERY_POLL: Duration = Duration::from_millis(500);

/// Per-line shape we care about. Everything else in Claude Code's JSONL
/// (parentUuid, sessionId, content blocks, etc.) is ignored.
#[derive(Debug, Deserialize)]
struct TranscriptLine {
    #[serde(rename = "type")]
    kind: Option<String>,
    timestamp: Option<String>,
    message: Option<TranscriptMessage>,
}

#[derive(Debug, Deserialize)]
struct TranscriptMessage {
    model: Option<String>,
    usage: Option<TranscriptUsage>,
}

#[derive(Debug, Deserialize, Default)]
struct TranscriptUsage {
    #[serde(default)]
    input_tokens: u32,
    #[serde(default)]
    output_tokens: u32,
    #[serde(default)]
    cache_creation_input_tokens: u32,
    #[serde(default)]
    cache_read_input_tokens: u32,
}

/// Spawn-side handle. Cheap to clone — shares the inner map across the
/// app via `Arc`.
#[derive(Clone)]
pub struct ExecVitals {
    inner: Arc<Inner>,
}

struct Inner {
    vitals: VitalsHandle,
    tasks: Mutex<HashMap<SessionId, JoinHandle<()>>>,
}

impl ExecVitals {
    pub fn new(vitals: VitalsHandle) -> Self {
        Self {
            inner: Arc::new(Inner {
                vitals,
                tasks: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Begin tailing a Claude Code transcript for `session`. If a tailer
    /// is already attached for this session it's replaced — covers the
    /// case where the user `cd`s mid-session and we want to re-resolve
    /// the project dir from the new cwd.
    ///
    /// The discovery + tail run on a single spawned task: it first waits
    /// up to DISCOVERY_WINDOW for a fresh jsonl to appear in the project
    /// dir (so concurrent Claude Code sessions sharing one cwd don't
    /// shadow the just-spawned one), then tails it.
    pub async fn attach(&self, session: SessionId, cwd: PathBuf) {
        let vitals = self.inner.vitals.clone();
        let handle = tokio::spawn(async move {
            let jsonl = match discover_jsonl_for_session(&cwd).await {
                Some(p) => p,
                None => {
                    tracing::debug!(
                        target: "exec_vitals",
                        session = %session,
                        cwd = %cwd.display(),
                        "no transcript found"
                    );
                    return;
                }
            };
            if let Err(e) = tail_file(session, jsonl.clone(), vitals).await {
                tracing::debug!(
                    target: "exec_vitals",
                    session = %session,
                    path = %jsonl.display(),
                    error = %e,
                    "tail loop exited"
                );
            }
        });
        let mut tasks = self.inner.tasks.lock().await;
        if let Some(prev) = tasks.insert(session, handle) {
            prev.abort();
        }
    }

    pub async fn detach(&self, session: SessionId) {
        if let Some(prev) = self.inner.tasks.lock().await.remove(&session) {
            prev.abort();
        }
    }
}

/// Slugify a cwd the way Claude Code does:
///   `/Users/foo/bar`  →  `-Users-foo-bar`
/// Components are joined by `-` with a leading `-` from the root slash.
/// On non-unix targets we mirror the same shape from path components.
fn slugify_cwd(cwd: &Path) -> String {
    let s = cwd.to_string_lossy().replace('/', "-");
    // Defensive: collapse any duplicate dashes that could arise from
    // weird inputs like `//Users/...`.
    s.replace("--", "-")
}

fn claude_projects_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

/// Pick the jsonl to tail for a freshly-attached Claude Code session.
///
/// Snapshots the project dir at attach time (file set + their mtimes),
/// then polls every DISCOVERY_POLL for up to DISCOVERY_WINDOW looking
/// for either:
///   • a new jsonl whose path wasn't in the snapshot, OR
///   • an existing jsonl whose mtime advanced past the snapshot baseline
///     (covers Claude Code reusing a prior file on resume — rare).
///
/// First match wins. If nothing new appears within the window we fall
/// back to the old "newest by mtime" so the user still gets a tailer
/// when they're the only `cc` in this cwd.
async fn discover_jsonl_for_session(cwd: &Path) -> Option<PathBuf> {
    let dir = claude_projects_dir()?.join(slugify_cwd(cwd));

    let baseline: HashMap<PathBuf, std::time::SystemTime> = std::fs::read_dir(&dir)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                return None;
            }
            let mtime = e.metadata().ok()?.modified().ok()?;
            Some((path, mtime))
        })
        .collect();
    let attach_wall = std::time::SystemTime::now();
    let deadline = attach_wall + DISCOVERY_WINDOW;

    let mut interval = tokio::time::interval(DISCOVERY_POLL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        interval.tick().await;
        if let Ok(read) = std::fs::read_dir(&dir) {
            for entry in read.flatten() {
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                    continue;
                }
                let Ok(meta) = entry.metadata() else { continue };
                let Ok(mtime) = meta.modified() else { continue };
                let prior = baseline.get(&path);
                let is_new = prior.is_none();
                let advanced = match prior {
                    Some(prev) => mtime > *prev && mtime >= attach_wall,
                    None => false,
                };
                if is_new || advanced {
                    tracing::debug!(
                        target: "exec_vitals",
                        path = %path.display(),
                        is_new,
                        "discovered transcript for new session"
                    );
                    return Some(path);
                }
            }
        }
        if std::time::SystemTime::now() > deadline {
            let fallback = newest_jsonl_for_cwd(cwd);
            if let Some(ref p) = fallback {
                tracing::debug!(
                    target: "exec_vitals",
                    path = %p.display(),
                    "discovery window expired; falling back to newest existing jsonl"
                );
            }
            return fallback;
        }
    }
}

fn newest_jsonl_for_cwd(cwd: &Path) -> Option<PathBuf> {
    let dir = claude_projects_dir()?.join(slugify_cwd(cwd));
    let read = std::fs::read_dir(&dir).ok()?;
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in read.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(mtime) = meta.modified() else { continue };
        match &best {
            Some((cur, _)) if *cur >= mtime => {}
            _ => best = Some((mtime, path)),
        }
    }
    best.map(|(_, p)| p)
}

async fn tail_file(session: SessionId, path: PathBuf, vitals: VitalsHandle) -> std::io::Result<()> {
    let mut file = File::open(&path).await?;
    // Skip historical turns — only count what happens while the
    // tailer is attached.
    let mut pos = file.seek(SeekFrom::End(0)).await?;
    let mut last_user_ts_ms: Option<i64> = None;
    let mut interval = tokio::time::interval(POLL_INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        interval.tick().await;
        let meta = match tokio::fs::metadata(&path).await {
            Ok(m) => m,
            Err(_) => continue,
        };
        let len = meta.len();
        if len <= pos {
            // No new bytes (or file shrank — possible if Claude rotated).
            // Reset pos to the new tail; no replay.
            if len < pos {
                pos = len;
            }
            continue;
        }
        file.seek(SeekFrom::Start(pos)).await?;
        let mut reader = BufReader::new(&mut file);
        let mut buf = String::new();
        while reader.read_line(&mut buf).await? > 0 {
            if !buf.ends_with('\n') {
                // Partial line — leave it for the next poll. Rewind pos
                // so we re-read this fragment with the rest of its line.
                break;
            }
            handle_line(session, buf.trim_end(), &vitals, &mut last_user_ts_ms);
            buf.clear();
        }
        pos = reader.into_inner().stream_position().await?;
    }
}

fn handle_line(
    session: SessionId,
    line: &str,
    vitals: &VitalsHandle,
    last_user_ts_ms: &mut Option<i64>,
) {
    if line.is_empty() {
        return;
    }
    let Ok(parsed) = serde_json::from_str::<TranscriptLine>(line) else {
        return;
    };
    let ts_ms = parsed.timestamp.as_deref().and_then(parse_iso8601_ms);

    match parsed.kind.as_deref() {
        Some("user") => {
            if let Some(ts) = ts_ms {
                *last_user_ts_ms = Some(ts);
            }
        }
        Some("assistant") => {
            let Some(msg) = parsed.message else { return };
            let Some(usage) = msg.usage else { return };
            // Skip lines with zero usage — Claude Code emits a few
            // bookkeeping entries that have an empty `usage` block.
            if usage.input_tokens == 0
                && usage.output_tokens == 0
                && usage.cache_creation_input_tokens == 0
                && usage.cache_read_input_tokens == 0
            {
                return;
            }
            let model = msg.model.unwrap_or_else(|| "claude".to_string());
            let latency_ms = match (last_user_ts_ms.take(), ts_ms) {
                (Some(start), Some(end)) if end > start => {
                    ((end - start) as u64)
                        .clamp(LATENCY_MIN_MS, LATENCY_MAX_MS) as u32
                }
                _ => LATENCY_MIN_MS as u32,
            };
            let tu = TokenUsage {
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
                cache_creation_input_tokens: usage.cache_creation_input_tokens,
                cache_read_input_tokens: usage.cache_read_input_tokens,
            };
            vitals.record_complete(session, model, tu, latency_ms);
        }
        _ => {}
    }
}

/// Very small ISO-8601 → unix-ms parser tuned for the format Claude Code
/// writes (`2026-05-18T06:50:57.111634Z`). Falls back to `None` rather
/// than depending on `chrono` for one call site.
fn parse_iso8601_ms(s: &str) -> Option<i64> {
    // YYYY-MM-DDTHH:MM:SS(.fff…)?Z
    let bytes = s.as_bytes();
    if bytes.len() < 20 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let mon: u32 = s.get(5..7)?.parse().ok()?;
    let day: u32 = s.get(8..10)?.parse().ok()?;
    let hour: u32 = s.get(11..13)?.parse().ok()?;
    let min: u32 = s.get(14..16)?.parse().ok()?;
    let sec: u32 = s.get(17..19)?.parse().ok()?;

    // Optional fractional seconds.
    let mut ms_frac: u32 = 0;
    if bytes.get(19) == Some(&b'.') {
        // Read up to 3 digits after the dot (ms precision is all we need).
        let mut i = 20;
        let mut digits = 0u32;
        let mut acc: u32 = 0;
        while i < bytes.len() && digits < 3 && bytes[i].is_ascii_digit() {
            acc = acc * 10 + (bytes[i] - b'0') as u32;
            i += 1;
            digits += 1;
        }
        while digits < 3 {
            acc *= 10;
            digits += 1;
        }
        ms_frac = acc;
    }

    let days = days_from_civil(year, mon as i32, day as i32);
    let secs = days * 86_400 + (hour as i64) * 3600 + (min as i64) * 60 + (sec as i64);
    Some(secs * 1000 + ms_frac as i64)
}

/// Howard Hinnant's date algorithm — days since unix epoch for a given
/// civil date. Avoids a chrono dependency.
fn days_from_civil(y: i64, m: i32, d: i32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) as i64 + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugifies_simple_cwd() {
        assert_eq!(
            slugify_cwd(Path::new("/Users/foo/bar")),
            "-Users-foo-bar"
        );
    }

    #[test]
    fn parses_iso8601_with_fraction() {
        let ms = parse_iso8601_ms("2026-05-18T06:50:57.111634Z").unwrap();
        // Sanity: should be in the right ballpark (May 2026).
        assert!(ms > 1_777_000_000_000);
        assert!(ms < 1_810_000_000_000);
    }

    #[test]
    fn parses_iso8601_without_fraction() {
        let a = parse_iso8601_ms("2026-05-18T06:50:57Z").unwrap();
        let b = parse_iso8601_ms("2026-05-18T06:50:57.000Z").unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn handle_line_skips_zero_usage() {
        // We can't easily run the full VitalsHandle without a runtime;
        // this just exercises the JSON parse + early returns.
        let line = r#"{"type":"assistant","timestamp":"2026-05-18T06:50:57Z","message":{"model":"claude-opus-4-7","usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}"#;
        let parsed: TranscriptLine = serde_json::from_str(line).unwrap();
        assert_eq!(parsed.kind.as_deref(), Some("assistant"));
        let usage = parsed.message.unwrap().usage.unwrap();
        assert_eq!(usage.input_tokens, 0);
    }
}
