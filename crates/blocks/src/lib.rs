//! OSC 133 block parser for karl-terminal.
//!
//! Feeds raw PTY bytes through a [`vte::Parser`] and emits semantic
//! [`BlockEvent`]s when prompt / command / output / done markers appear.
//! Also handles OSC 7 (cwd notifications). Bytes are NOT transformed —
//! the same chunks continue downstream to xterm.js verbatim. The parser
//! is purely observational.
//!
//! Marker reference (subset of WezTerm's spec):
//!
//! | Sequence              | Event                       |
//! |-----------------------|-----------------------------|
//! | `ESC ] 133 ; A ST`    | [`BlockEvent::PromptStart`] |
//! | `ESC ] 133 ; B ST`    | [`BlockEvent::CommandStart`]|
//! | `ESC ] 133 ; C ST`    | [`BlockEvent::OutputStart`] |
//! | `ESC ] 133 ; D[;<n>] ST` | [`BlockEvent::CommandFinished`] |
//! | `ESC ] 7 ; file://host/<path> ST` | [`BlockEvent::CwdChanged`] |
//!
//! `ST` is either `BEL` (0x07) or `ESC \\` (0x1b 0x5c). Both are accepted.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use ulid::Ulid;
use vte::Perform;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
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
    PromptStart,
    CommandStart,
    OutputStart,
    CommandFinished { exit_code: Option<i32> },
    CwdChanged { path: PathBuf },
}

/// Stateless wrapper around [`vte::Parser`] that produces [`BlockEvent`]s.
/// Stream as many chunks through [`BlockParser::feed`] as you like; the
/// parser maintains its own state across calls.
pub struct BlockParser {
    inner: vte::Parser,
}

impl BlockParser {
    pub fn new() -> Self {
        Self {
            inner: vte::Parser::new(),
        }
    }

    /// Feed bytes through the VT parser and return any [`BlockEvent`]s
    /// the chunk produced. The bytes themselves are not consumed in any
    /// other sense — callers should still forward the original chunk to
    /// xterm.js (or whichever sink renders it).
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<BlockEvent> {
        let mut sink = Sink::default();
        self.inner.advance(&mut sink, bytes);
        sink.events
    }
}

impl Default for BlockParser {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Default)]
struct Sink {
    events: Vec<BlockEvent>,
}

impl Perform for Sink {
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
            b"B" => self.events.push(BlockEvent::CommandStart),
            b"C" => self.events.push(BlockEvent::OutputStart),
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
/// Decodes any percent-escapes lazily; non-UTF-8 sequences fall back to
/// lossy string conversion (which is fine for typical path display, even
/// if the on-disk path could only be reconstructed from raw bytes).
fn parse_file_uri(uri: &str) -> Option<PathBuf> {
    let stripped = uri.strip_prefix("file://")?;
    // Skip optional hostname segment up to the first `/`.
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
    fn osc133_command_start() {
        let evs = parse(b"\x1b]133;B\x07");
        assert_eq!(evs, vec![BlockEvent::CommandStart]);
    }

    #[test]
    fn osc133_output_start() {
        let evs = parse(b"\x1b]133;C\x07");
        assert_eq!(evs, vec![BlockEvent::OutputStart]);
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
        // OSC 0 (terminal title) — not our concern.
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
                BlockEvent::CommandStart,
                BlockEvent::OutputStart,
                BlockEvent::CommandFinished { exit_code: Some(0) },
            ]
        );
    }

    #[test]
    fn parser_handles_chunked_input() {
        let mut p = BlockParser::new();
        // Split an OSC sequence across two feed() calls — the parser
        // must keep state across boundaries.
        let part1 = p.feed(b"\x1b]133;");
        let part2 = p.feed(b"D;7\x07");
        assert!(part1.is_empty());
        assert_eq!(
            part2,
            vec![BlockEvent::CommandFinished { exit_code: Some(7) }]
        );
    }

    #[test]
    fn parser_passes_through_unrelated_text() {
        // Plain text + ANSI color codes around an OSC 133 marker. The
        // unrelated bytes generate no events.
        let stream = b"\x1b[32mok\x1b[0m\x1b]133;A\x07hello world";
        let evs = parse(stream);
        assert_eq!(evs, vec![BlockEvent::PromptStart]);
    }
}
