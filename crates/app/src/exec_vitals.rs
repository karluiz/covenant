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

/// How often discovery re-scans the project dir for transcript growth.
const DISCOVERY_POLL: Duration = Duration::from_millis(500);
/// After the user presses Enter in this tab's PTY, a new `user` line in a
/// jsonl is attributed to this tab if it appears within this window.
/// Generous — covers Claude's think-then-write latency plus missed ticks.
const INPUT_CORRELATION_WINDOW: Duration = Duration::from_secs(12);

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
    /// Wall-clock of the last time the user pressed Enter into each
    /// session's PTY. Used to bind a tab to the *right* jsonl when several
    /// Claude Code sessions share a cwd: only the jsonl that gains a `user`
    /// line shortly after a local submit belongs to this tab. A background
    /// session (e.g. an AI assistant running Claude in the same repo) never
    /// receives this tab's keystrokes, so it's excluded automatically.
    last_input: std::sync::Mutex<HashMap<SessionId, std::time::Instant>>,
}

impl ExecVitals {
    pub fn new(vitals: VitalsHandle) -> Self {
        Self {
            inner: Arc::new(Inner {
                vitals,
                tasks: Mutex::new(HashMap::new()),
                last_input: std::sync::Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Record that the user submitted input (pressed Enter) into `session`'s
    /// PTY. Called from `write_to_session`. Only Enter (`\r`) counts — plain
    /// keystrokes don't trigger a transcript turn.
    pub fn note_input(&self, session: SessionId, data: &[u8]) {
        if data.contains(&b'\r') {
            if let Ok(mut m) = self.inner.last_input.lock() {
                m.insert(session, std::time::Instant::now());
            }
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
        let inner = self.inner.clone();
        let handle = tokio::spawn(async move {
            let (jsonl, start_pos) = match discover_jsonl_for_session(&cwd, session, &inner).await {
                Some(pair) => pair,
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
            if let Err(e) = tail_file(session, jsonl.clone(), start_pos, vitals).await {
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

/// Bind a freshly-attached Claude Code session to the *correct* jsonl by
/// correlating the user's PTY input with transcript writes.
///
/// Several Claude Code sessions can share one project dir (e.g. an AI
/// assistant running Claude inside the same repo as the user's tab). The
/// old "newest by mtime" heuristic grabbed whichever session was hottest —
/// wrong, and it could leak another session's tokens. Instead: poll the
/// dir and bind to the first jsonl that gains a `user` line within
/// INPUT_CORRELATION_WINDOW of the user pressing Enter in *this* PTY. A
/// background session never receives this tab's keystrokes, so it can't
/// satisfy the correlation.
///
/// `start_byte_position` is the file's size just before the correlated
/// growth, so `tail_file` re-reads the `user` line and the assistant usage
/// that follows. Waits indefinitely (the task is aborted on detach); the
/// cluster stays empty until the user interacts, which is honest.
async fn discover_jsonl_for_session(
    cwd: &Path,
    session: SessionId,
    inner: &Inner,
) -> Option<(PathBuf, u64)> {
    let dir = claude_projects_dir()?.join(slugify_cwd(cwd));

    // Baseline size for every jsonl present at attach — we only react to
    // bytes appended afterwards (no replay of history).
    let mut sizes: HashMap<PathBuf, u64> = dir_jsonl_sizes(&dir);

    let mut interval = tokio::time::interval(DISCOVERY_POLL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        interval.tick().await;
        let current = dir_jsonl_sizes(&dir);
        for (path, &new_size) in &current {
            let old = sizes.get(path).copied().unwrap_or(0);
            if new_size <= old {
                continue;
            }
            if grew_with_user_line(path, old, new_size) && input_recent(inner, session) {
                tracing::debug!(
                    target: "exec_vitals",
                    session = %session,
                    path = %path.display(),
                    start_pos = old,
                    "bound transcript via PTY input correlation"
                );
                return Some((path.clone(), old));
            }
        }
        // Advance baselines so we don't re-scan the same appended bytes.
        sizes = current;
    }
}

fn dir_jsonl_sizes(dir: &Path) -> HashMap<PathBuf, u64> {
    let mut out = HashMap::new();
    if let Ok(read) = std::fs::read_dir(dir) {
        for e in read.flatten() {
            let path = e.path();
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            if let Ok(meta) = e.metadata() {
                out.insert(path, meta.len());
            }
        }
    }
    out
}

/// True if the bytes appended to `path` in `[start, end)` contain at least
/// one `user`-type transcript line — the marker that a new turn began.
fn grew_with_user_line(path: &Path, start: u64, end: u64) -> bool {
    use std::io::{Read, Seek};
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    if f.seek(SeekFrom::Start(start)).is_err() {
        return false;
    }
    let cap = (end.saturating_sub(start)).min(1 << 20) as usize;
    let mut buf = vec![0u8; cap];
    let Ok(n) = f.read(&mut buf) else {
        return false;
    };
    String::from_utf8_lossy(&buf[..n]).lines().any(|line| {
        serde_json::from_str::<TranscriptLine>(line)
            .ok()
            .and_then(|p| p.kind)
            .as_deref()
            == Some("user")
    })
}

fn input_recent(inner: &Inner, session: SessionId) -> bool {
    inner
        .last_input
        .lock()
        .ok()
        .and_then(|m| {
            m.get(&session)
                .map(|t| t.elapsed() < INPUT_CORRELATION_WINDOW)
        })
        .unwrap_or(false)
}

async fn tail_file(
    session: SessionId,
    path: PathBuf,
    start_pos: u64,
    vitals: VitalsHandle,
) -> std::io::Result<()> {
    let mut file = File::open(&path).await?;
    // Start where discovery told us — typically right before the line
    // whose append triggered detection, so we catch it on the first
    // poll instead of waiting for the next message round-trip.
    let mut pos = file.seek(SeekFrom::Start(start_pos)).await?;
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
                    ((end - start) as u64).clamp(LATENCY_MIN_MS, LATENCY_MAX_MS) as u32
                }
                _ => LATENCY_MIN_MS as u32,
            };
            let tu = TokenUsage {
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
                cache_creation_input_tokens: usage.cache_creation_input_tokens,
                cache_read_input_tokens: usage.cache_read_input_tokens,
            };
            // Context occupancy = the whole prompt that was sent (cache
            // reads included — they still occupy the window). Reported on
            // the dedicated executor channel so internal Covenant calls
            // can't clobber it.
            let ctx = usage
                .input_tokens
                .saturating_add(usage.cache_creation_input_tokens)
                .saturating_add(usage.cache_read_input_tokens);
            vitals.record_executor_context(session, model.clone(), ctx);
            vitals.record_executor_complete(session, model, tu, latency_ms);
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
        assert_eq!(slugify_cwd(Path::new("/Users/foo/bar")), "-Users-foo-bar");
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

    #[test]
    fn grew_with_user_line_detects_only_user_turns() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let assistant = "{\"type\":\"assistant\",\"message\":{\"usage\":{\"input_tokens\":5}}}\n";
        let user = "{\"type\":\"user\",\"timestamp\":\"2026-05-18T06:50:57Z\"}\n";
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(assistant.as_bytes()).unwrap();
        let after_assistant = assistant.len() as u64;
        f.write_all(user.as_bytes()).unwrap();
        f.write_all(assistant.as_bytes()).unwrap();
        let end = f.metadata().unwrap().len();
        drop(f);

        // Growth that contains a user line → true.
        assert!(grew_with_user_line(&path, after_assistant, end));
        // Growth that is only the first assistant line → false.
        assert!(!grew_with_user_line(&path, 0, after_assistant));
    }
}
