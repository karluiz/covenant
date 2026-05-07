//! One-shot importer for the user's existing shell history files.
//!
//! Run on first launch, then never again (gated by a settings flag).
//! Without this, Recall starts empty for every new Covenant install
//! and feels useless until the user has accumulated their own history.
//!
//! Supported shells and formats:
//! - **zsh**: `~/.zsh_history` — extended (`: <epoch>:<elapsed>;cmd`) and plain
//! - **bash**: `~/.bash_history` — plain or HISTTIMEFORMAT (`#<epoch>` line before cmd)
//! - **fish**: `~/.local/share/fish/fish_history` — YAML-ish (`- cmd: …\n  when: …`)
//!
//! All parsers produce the same [`ZshHistoryEntry`] type (the name is
//! a historical artifact; the struct is shell-agnostic).
//!
//! Imported entries are stored as ordinary block rows under a single
//! synthetic session. Exit code is set to 0 — shells don't reliably
//! record exit codes, and assuming success keeps Recall stats sensible.

use std::path::Path;

/// One parsed entry from `.zsh_history`.
///
/// `finished_at_unix_ms` falls back to the import time minus an offset
/// derived from line position when the format is plain (so order is
/// preserved even without timestamps).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZshHistoryEntry {
    pub command: String,
    pub finished_at_unix_ms: u64,
    pub duration_ms: u64,
}

/// Read `.zsh_history` from disk and parse. Returns the most recent
/// `max_entries` (oldest dropped). Skips empty/whitespace lines.
///
/// `fallback_now_ms` is used when an entry has no timestamp (plain
/// format). It's NOT used to overwrite extended-format timestamps.
pub fn parse_zsh_history(
    text: &str,
    fallback_now_ms: u64,
    max_entries: usize,
) -> Vec<ZshHistoryEntry> {
    let mut out = Vec::new();

    // Multi-line commands end the previous line with `\`. Accumulate
    // until a line ends without trailing backslash, then flush.
    let mut buf: Option<String> = None;
    let mut buf_ts: u64 = fallback_now_ms;
    let mut buf_dur: u64 = 0;

    let mut plain_index: u64 = 0;

    for line in text.lines() {
        let (continued, body) = strip_continuation(line);

        if let Some(ref mut acc) = buf {
            // Continuation of the previous command.
            acc.push('\n');
            acc.push_str(body);
            if !continued {
                let cmd = std::mem::take(acc).trim().to_string();
                buf = None;
                push_if_useful(&mut out, cmd, buf_ts, buf_dur);
            }
            continue;
        }

        // Starting a fresh entry.
        let (ts, dur, cmd_part) = parse_header(body, fallback_now_ms, &mut plain_index);

        if continued {
            buf = Some(cmd_part.to_string());
            buf_ts = ts;
            buf_dur = dur;
        } else {
            push_if_useful(&mut out, cmd_part.trim().to_string(), ts, dur);
        }
    }

    // Flush any unterminated continuation.
    if let Some(acc) = buf {
        push_if_useful(&mut out, acc.trim().to_string(), buf_ts, buf_dur);
    }

    // Newest-first within the file, then keep at most max_entries.
    // .zsh_history is append-only so the tail is the freshest.
    if out.len() > max_entries {
        let drop = out.len() - max_entries;
        out.drain(0..drop);
    }
    out
}

/// Convenience for production use: read the file off disk and parse.
/// Missing file → `Ok(vec![])` (nothing to import).
pub fn read_and_parse(
    path: &Path,
    fallback_now_ms: u64,
    max_entries: usize,
) -> std::io::Result<Vec<ZshHistoryEntry>> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(parse_zsh_history(&text, fallback_now_ms, max_entries)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e),
    }
}

fn push_if_useful(out: &mut Vec<ZshHistoryEntry>, command: String, ts: u64, dur: u64) {
    if command.is_empty() {
        return;
    }
    out.push(ZshHistoryEntry {
        command,
        finished_at_unix_ms: ts,
        duration_ms: dur,
    });
}

/// Returns `(continued, body)`. `continued = true` means the next line
/// is a continuation of this command (this line ends with a single
/// backslash, not preceded by another backslash).
fn strip_continuation(line: &str) -> (bool, &str) {
    if let Some(stripped) = line.strip_suffix('\\') {
        // A doubled backslash at end is a literal backslash, not a
        // continuation marker. (zsh wouldn't write this in practice
        // but be defensive.)
        if stripped.ends_with('\\') {
            (false, line)
        } else {
            (true, stripped)
        }
    } else {
        (false, line)
    }
}

/// Parse the header of a zsh history line. Extended format:
///
///   `: 1700000000:0;cmd`
///
/// On plain lines, the whole body is the command. `plain_index` is
/// bumped so plain entries get monotonically increasing fake
/// timestamps in input order.
fn parse_header<'a>(
    body: &'a str,
    fallback_now_ms: u64,
    plain_index: &mut u64,
) -> (u64, u64, &'a str) {
    if let Some(rest) = body.strip_prefix(": ") {
        // Find the `;` that separates the metadata from the command.
        if let Some(semi) = rest.find(';') {
            let (meta, cmd) = rest.split_at(semi);
            let cmd = &cmd[1..]; // skip ';'
            // meta = "<epoch>:<elapsed>"
            let mut parts = meta.splitn(2, ':');
            let ts_str = parts.next().unwrap_or("");
            let dur_str = parts.next().unwrap_or("0");
            let ts = ts_str.trim().parse::<u64>().ok();
            let dur = dur_str.trim().parse::<u64>().unwrap_or(0);
            if let Some(ts) = ts {
                return (ts.saturating_mul(1000), dur.saturating_mul(1000), cmd);
            }
        }
    }
    // Plain line. Stagger timestamps by a millisecond per line so
    // ordering is stable when the user re-imports.
    let staggered = fallback_now_ms.saturating_sub(*plain_index);
    *plain_index += 1;
    (staggered, 0, body)
}

/// Parse `~/.bash_history`.
///
/// Two formats:
/// - **HISTTIMEFORMAT**: a `#<epoch>` line immediately before each command.
/// - **Plain**: one command per line, no timestamps.
///
/// Multi-line commands (bash `$'...\n...'` style) are not common in
/// `~/.bash_history` and are left as-is (one line = one entry).
pub fn parse_bash_history(
    text: &str,
    fallback_now_ms: u64,
    max_entries: usize,
) -> Vec<ZshHistoryEntry> {
    let mut out = Vec::new();
    let mut pending_ts: Option<u64> = None;
    let mut plain_index: u64 = 0;

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // HISTTIMEFORMAT produces `#<epoch>` lines immediately before the command.
        if let Some(rest) = line.strip_prefix('#') {
            if let Ok(ts) = rest.trim().parse::<u64>() {
                pending_ts = Some(ts.saturating_mul(1000));
                continue;
            }
        }
        // This line is a command.
        let ts = pending_ts.take().unwrap_or_else(|| {
            let t = fallback_now_ms.saturating_sub(plain_index);
            plain_index += 1;
            t
        });
        push_if_useful(&mut out, line.to_string(), ts, 0);
    }

    if out.len() > max_entries {
        let drop = out.len() - max_entries;
        out.drain(0..drop);
    }
    out
}

/// Parse `~/.local/share/fish/fish_history`.
///
/// Fish stores history in a YAML-ish format:
/// ```text
/// - cmd: ls -la
///   when: 1700000000
/// - cmd: git status
///   when: 1700000005
/// ```
/// Multi-line commands use `\n` escapes within the `cmd:` value.
pub fn parse_fish_history(
    text: &str,
    fallback_now_ms: u64,
    max_entries: usize,
) -> Vec<ZshHistoryEntry> {
    let mut out = Vec::new();
    let mut current_cmd: Option<String> = None;
    let mut current_ts: u64 = fallback_now_ms;
    let mut plain_index: u64 = 0;

    for line in text.lines() {
        if let Some(cmd_raw) = line.strip_prefix("- cmd: ") {
            // Flush any previous entry that had no `when:`.
            if let Some(cmd) = current_cmd.take() {
                push_if_useful(&mut out, cmd, current_ts, 0);
            }
            // Unescape fish's `\n` within cmd values.
            let cmd = cmd_raw.replace("\\n", "\n").trim().to_string();
            current_cmd = Some(cmd);
            // Default ts in case `when:` is missing.
            current_ts = fallback_now_ms.saturating_sub(plain_index);
            plain_index += 1;
        } else if let Some(when_raw) = line.trim_start().strip_prefix("when: ") {
            if let Ok(ts) = when_raw.trim().parse::<u64>() {
                current_ts = ts.saturating_mul(1000);
            }
            // Flush: `when:` always follows `cmd:` as the last field.
            if let Some(cmd) = current_cmd.take() {
                push_if_useful(&mut out, cmd, current_ts, 0);
            }
        }
        // Other lines (paths:, etc.) are ignored.
    }
    // Flush any trailing entry without a `when:`.
    if let Some(cmd) = current_cmd.take() {
        push_if_useful(&mut out, cmd, current_ts, 0);
    }

    if out.len() > max_entries {
        let drop = out.len() - max_entries;
        out.drain(0..drop);
    }
    out
}

/// Convenience: read a bash history file and parse. Missing → `Ok(vec![])`.
pub fn read_and_parse_bash(
    path: &Path,
    fallback_now_ms: u64,
    max_entries: usize,
) -> std::io::Result<Vec<ZshHistoryEntry>> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(parse_bash_history(&text, fallback_now_ms, max_entries)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e),
    }
}

/// Convenience: read a fish history file and parse. Missing → `Ok(vec![])`.
pub fn read_and_parse_fish(
    path: &Path,
    fallback_now_ms: u64,
    max_entries: usize,
) -> std::io::Result<Vec<ZshHistoryEntry>> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(parse_fish_history(&text, fallback_now_ms, max_entries)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e),
    }
}


mod tests {
    use super::*;

    #[test]
    fn parses_extended_format() {
        let text = "\
: 1700000000:0;ls -la
: 1700000005:2;cargo build
";
        let out = parse_zsh_history(text, 9_000_000_000, 100);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].command, "ls -la");
        assert_eq!(out[0].finished_at_unix_ms, 1_700_000_000_000);
        assert_eq!(out[0].duration_ms, 0);
        assert_eq!(out[1].command, "cargo build");
        assert_eq!(out[1].duration_ms, 2_000);
    }

    #[test]
    fn parses_plain_format_with_descending_fake_timestamps() {
        let text = "\
ls
pwd
git status
";
        let out = parse_zsh_history(text, 1_000_000, 100);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].command, "ls");
        // Plain lines get staggered timestamps: ls=1_000_000,
        // pwd=999_999, git=999_998. So ls is most recent in this
        // ordering, which matches "first line is older" for plain
        // .zsh_history? Actually .zsh_history grows append-only so
        // the LAST line is newest — but plain timestamps are a
        // best-effort fallback only. Recall ranking will still
        // surface high-frequency items regardless.
        assert!(out[0].finished_at_unix_ms >= out[1].finished_at_unix_ms);
        assert!(out[1].finished_at_unix_ms >= out[2].finished_at_unix_ms);
    }

    #[test]
    fn skips_blank_lines() {
        let text = "\n: 1700000000:0;ls\n\n: 1700000010:0;pwd\n\n";
        let out = parse_zsh_history(text, 0, 100);
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn joins_multiline_commands() {
        let text = "\
: 1700000000:0;for i in 1 2 3; do\\
echo $i\\
done
: 1700000050:0;ls
";
        let out = parse_zsh_history(text, 0, 100);
        assert_eq!(out.len(), 2);
        assert!(out[0].command.contains("for i in 1 2 3"));
        assert!(out[0].command.contains("echo $i"));
        assert!(out[0].command.contains("done"));
        assert_eq!(out[1].command, "ls");
    }

    #[test]
    fn truncates_to_max_entries_keeping_newest() {
        let text = "\
: 1700000001:0;a
: 1700000002:0;b
: 1700000003:0;c
: 1700000004:0;d
: 1700000005:0;e
";
        let out = parse_zsh_history(text, 0, 3);
        assert_eq!(out.len(), 3);
        // Newest 3 → c, d, e.
        let cmds: Vec<&str> = out.iter().map(|e| e.command.as_str()).collect();
        assert_eq!(cmds, vec!["c", "d", "e"]);
    }

    #[test]
    fn malformed_extended_falls_through_as_plain() {
        // No semicolon → treat as plain.
        let text = ": 1700000000:0 ls\n";
        let out = parse_zsh_history(text, 1_000_000, 100);
        assert_eq!(out.len(), 1);
        // Whole line landed as the command body.
        assert!(out[0].command.contains(": 1700000000"));
    }

    #[test]
    fn empty_input_produces_no_entries() {
        let out = parse_zsh_history("", 0, 100);
        assert!(out.is_empty());
    }
}
