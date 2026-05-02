//! OSC 133 block parser for Covenant.
//!
//! Feeds raw PTY bytes through a [`vte::Parser`] and emits semantic
//! [`BlockEvent`]s when prompt / command-submitted / done markers appear.
//! Also handles OSC 7 (cwd notifications). Bytes are NOT transformed —
//! the same chunks continue downstream to xterm.js verbatim. The parser
//! is purely observational.
//!
//! Marker reference (subset of WezTerm's spec):
//!
//! | Sequence              | Behavior                                  |
//! |-----------------------|-------------------------------------------|
//! | `ESC ] 133 ; A ST`    | Emit [`BlockEvent::PromptStart`]          |
//! | `ESC ] 133 ; B ST`    | Internal: start capturing the command text |
//! | `ESC ] 133 ; C ST`    | Emit [`BlockEvent::CommandSubmitted`] with the captured text |
//! | `ESC ] 133 ; D[;<n>] ST` | Emit [`BlockEvent::CommandFinished`]   |
//! | `ESC ] 7 ; file://host/<path> ST` | Emit [`BlockEvent::CwdChanged`] |
//!
//! `ST` is either `BEL` (0x07) or `ESC \\` (0x1b 0x5c). Both are accepted.
//!
//! Command-text capture is best-effort: between B and C the parser
//! accumulates `print()`/`execute()` bytes, which covers a freshly typed
//! command. Tab-completion redraws and other line-editing escapes pass
//! through `csi_dispatch` (ignored), so a heavily edited command line
//! may yield a slightly off command string. Good enough for M1; iTerm-
//! style `OSC 133 ; C ; cmdline=…` extension is a future upgrade.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use ulid::Ulid;
use vte::Perform;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct BlockId(pub Ulid);

impl BlockId {
    pub fn new() -> Self {
        Self(Ulid::new())
    }
}

impl Default for BlockId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for BlockId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BlockEvent {
    /// `OSC 133 ; A` — prompt is being rendered. Useful for marking
    /// "shell is idle, awaiting input".
    PromptStart,

    /// `OSC 133 ; C` — user submitted a command. `command` is the text
    /// the parser observed echoed between the `B` and `C` markers,
    /// trimmed of trailing whitespace.
    CommandSubmitted { command: String },

    /// `OSC 133 ; D` — command finished. `exit_code` is `None` when the
    /// shell snippet emitted `D` without an exit code (older form).
    CommandFinished { exit_code: Option<i32> },

    /// `OSC 7 ; file://host/<path>` — cwd changed.
    CwdChanged { path: PathBuf },
}

/// Stateful parser. Stream as many chunks through [`BlockParser::feed`]
/// as you like; internal VT state and command capture survive across
/// calls.
pub struct BlockParser {
    inner: vte::Parser,
    sink: Sink,
}

impl BlockParser {
    pub fn new() -> Self {
        Self {
            inner: vte::Parser::new(),
            sink: Sink::default(),
        }
    }

    /// Feed bytes through the VT parser and return any [`BlockEvent`]s
    /// the chunk produced. The bytes themselves are not consumed in any
    /// other sense — callers should still forward the original chunk to
    /// xterm.js (or whichever sink renders it).
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<BlockEvent> {
        self.sink.events.clear();
        self.inner.advance(&mut self.sink, bytes);
        std::mem::take(&mut self.sink.events)
    }
}

impl Default for BlockParser {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Default, PartialEq, Eq, Clone, Copy)]
enum CaptureState {
    #[default]
    Idle,
    /// Saw `133;B`, accumulating bytes into `cmd_buf` until `133;C`.
    AwaitingExec,
}

#[derive(Default)]
struct Sink {
    events: Vec<BlockEvent>,
    state: CaptureState,
    cmd_buf: Vec<u8>,
}

impl Perform for Sink {
    fn print(&mut self, c: char) {
        if self.state == CaptureState::AwaitingExec {
            let mut buf = [0u8; 4];
            let s = c.encode_utf8(&mut buf);
            self.cmd_buf.extend_from_slice(s.as_bytes());
        }
    }

    fn execute(&mut self, _byte: u8) {
        // Intentionally NOT accumulated during command-text capture:
        // C0 control bytes (SOH/STX/CR/LF/BEL) at this layer are ZLE
        // redraw markers or terminal control, not characters the user
        // typed. Including them produced garbage like `l\x01ls` in the
        // sidebar when the user's prompt framework leaked %{...%} markers.
    }

    fn osc_dispatch(&mut self, params: &[&[u8]], _bell_terminated: bool) {
        let Some(first) = params.first() else { return };
        match *first {
            b"133" => self.handle_133(&params[1..]),
            b"7" => self.handle_7(&params[1..]),
            _ => {}
        }
    }
}

impl Sink {
    fn handle_133(&mut self, rest: &[&[u8]]) {
        let Some(action) = rest.first() else { return };
        match *action {
            b"A" => self.events.push(BlockEvent::PromptStart),
            b"B" => {
                self.state = CaptureState::AwaitingExec;
                self.cmd_buf.clear();
            }
            b"C" => {
                // Prefer the cmdline carried as OSC `; C ; <cmd>` payload
                // (set by our snippet via $1 in zsh's preexec). The shell
                // knows exactly what was executed, so this avoids the
                // false captures that byte-scraping produces under
                // zsh-autosuggestions, history-substring-search, etc.
                //
                // Falls back to whatever bytes we accumulated between B
                // and C if the payload is absent — useful when paired
                // with a third-party shell snippet that only emits the
                // bare `; C` form.
                let command = match rest.get(1) {
                    Some(cmd_bytes) => String::from_utf8_lossy(cmd_bytes)
                        .trim()
                        .to_string(),
                    None => {
                        let cleaned = strip_ansi_escapes::strip(&self.cmd_buf);
                        String::from_utf8_lossy(&cleaned).trim().to_string()
                    }
                };
                self.events
                    .push(BlockEvent::CommandSubmitted { command });
                self.state = CaptureState::Idle;
                self.cmd_buf.clear();
            }
            b"D" => {
                let exit_code = rest
                    .get(1)
                    .and_then(|b| std::str::from_utf8(b).ok())
                    .and_then(|s| s.parse::<i32>().ok());
                self.events
                    .push(BlockEvent::CommandFinished { exit_code });
            }
            _ => {}
        }
    }

    fn handle_7(&mut self, rest: &[&[u8]]) {
        let Some(uri_bytes) = rest.first() else { return };
        let Ok(uri) = std::str::from_utf8(uri_bytes) else {
            return;
        };
        if let Some(path) = parse_file_uri(uri) {
            self.events.push(BlockEvent::CwdChanged { path });
        }
    }
}

/// Pull the path out of `file://hostname/path` (or `file:///path`).
/// Decodes percent-escapes lazily; non-UTF-8 sequences fall back to
/// lossy string conversion.
fn parse_file_uri(uri: &str) -> Option<PathBuf> {
    let stripped = uri.strip_prefix("file://")?;
    let path_start = stripped.find('/')?;
    let path = &stripped[path_start..];
    Some(PathBuf::from(percent_decode(path)))
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(
                std::str::from_utf8(&bytes[i + 1..=i + 2]).unwrap_or("zz"),
                16,
            ) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(input: &[u8]) -> Vec<BlockEvent> {
        let mut p = BlockParser::new();
        p.feed(input)
    }

    #[test]
    fn osc133_prompt_start_bell() {
        let evs = parse(b"\x1b]133;A\x07");
        assert_eq!(evs, vec![BlockEvent::PromptStart]);
    }

    #[test]
    fn osc133_prompt_start_st() {
        let evs = parse(b"\x1b]133;A\x1b\\");
        assert_eq!(evs, vec![BlockEvent::PromptStart]);
    }

    #[test]
    fn osc133_command_b_emits_no_event_alone() {
        // `B` only flips internal state; no event until `C` fires.
        let evs = parse(b"\x1b]133;B\x07");
        assert!(evs.is_empty());
    }

    #[test]
    fn osc133_command_submitted_captures_text() {
        let evs = parse(b"\x1b]133;B\x07echo hi\x1b]133;C\x07");
        assert_eq!(
            evs,
            vec![BlockEvent::CommandSubmitted {
                command: "echo hi".to_string()
            }]
        );
    }

    #[test]
    fn osc133_c_payload_overrides_byte_capture() {
        // Snippet emits `; C ; <cmd>` directly. Even if the bytes between
        // B and C contain noise (autosuggestion redraw, etc.), the
        // explicit payload wins.
        let evs =
            parse(b"\x1b]133;B\x07lls-noise\x1b]133;C;ls -la\x1b\\");
        assert_eq!(
            evs,
            vec![BlockEvent::CommandSubmitted {
                command: "ls -la".to_string()
            }]
        );
    }

    #[test]
    fn osc133_command_submitted_empty_when_no_text() {
        let evs = parse(b"\x1b]133;B\x07\x1b]133;C\x07");
        assert_eq!(
            evs,
            vec![BlockEvent::CommandSubmitted {
                command: String::new()
            }]
        );
    }

    #[test]
    fn osc133_done_with_exit() {
        let evs = parse(b"\x1b]133;D;42\x1b\\");
        assert_eq!(
            evs,
            vec![BlockEvent::CommandFinished {
                exit_code: Some(42)
            }]
        );
    }

    #[test]
    fn osc133_done_without_exit() {
        let evs = parse(b"\x1b]133;D\x07");
        assert_eq!(
            evs,
            vec![BlockEvent::CommandFinished { exit_code: None }]
        );
    }

    #[test]
    fn osc7_simple() {
        let evs = parse(b"\x1b]7;file://host/Users/karl/work\x1b\\");
        assert_eq!(
            evs,
            vec![BlockEvent::CwdChanged {
                path: PathBuf::from("/Users/karl/work")
            }]
        );
    }

    #[test]
    fn osc7_empty_host() {
        let evs = parse(b"\x1b]7;file:///etc\x1b\\");
        assert_eq!(
            evs,
            vec![BlockEvent::CwdChanged {
                path: PathBuf::from("/etc")
            }]
        );
    }

    #[test]
    fn osc7_percent_decoded() {
        let evs = parse(b"\x1b]7;file://h/Users/karl/My%20Code\x1b\\");
        assert_eq!(
            evs,
            vec![BlockEvent::CwdChanged {
                path: PathBuf::from("/Users/karl/My Code")
            }]
        );
    }

    #[test]
    fn unrelated_osc_ignored() {
        let evs = parse(b"\x1b]0;some title\x1b\\");
        assert!(evs.is_empty());
    }

    #[test]
    fn full_block_sequence() {
        let stream = b"\
            \x1b]133;A\x07\
            $ \
            \x1b]133;B\x07\
            echo hi\n\
            \x1b]133;C\x07\
            hi\n\
            \x1b]133;D;0\x07\
        ";
        let evs = parse(stream);
        assert_eq!(
            evs,
            vec![
                BlockEvent::PromptStart,
                BlockEvent::CommandSubmitted {
                    command: "echo hi".to_string()
                },
                BlockEvent::CommandFinished { exit_code: Some(0) },
            ]
        );
    }

    #[test]
    fn parser_handles_chunked_input() {
        let mut p = BlockParser::new();
        let part1 = p.feed(b"\x1b]133;");
        let part2 = p.feed(b"D;7\x07");
        assert!(part1.is_empty());
        assert_eq!(
            part2,
            vec![BlockEvent::CommandFinished { exit_code: Some(7) }]
        );
    }

    #[test]
    fn parser_keeps_command_capture_state_across_feeds() {
        let mut p = BlockParser::new();
        let _ = p.feed(b"\x1b]133;B\x07ec");
        let _ = p.feed(b"ho hi");
        let evs = p.feed(b"\x1b]133;C\x07");
        assert_eq!(
            evs,
            vec![BlockEvent::CommandSubmitted {
                command: "echo hi".to_string()
            }]
        );
    }

    #[test]
    fn parser_passes_through_unrelated_text() {
        let stream = b"\x1b[32mok\x1b[0m\x1b]133;A\x07hello world";
        let evs = parse(stream);
        assert_eq!(evs, vec![BlockEvent::PromptStart]);
    }
}
