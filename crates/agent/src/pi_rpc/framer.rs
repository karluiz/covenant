//! Byte-exact JSONL line framer for Pi RPC. See module-level docs in
//! [`super`] for context.
//!
//! ## Why a custom framer
//!
//! Pi's RPC docs explicitly warn that Node's `readline` is not protocol-
//! compliant: it splits on Unicode line separators (U+2028 / U+2029) in
//! addition to `\n`, which corrupts payloads. We mirror that warning: the
//! framer below splits **only** on `\n` (0x0A) bytes and strips a trailing
//! `\r` (0x0D). UTF-8 decoding happens after a line is fully isolated, so
//! 4-byte codepoints split across `read()` boundaries are safe.

use std::collections::VecDeque;

/// Byte-level JSONL line framer. Feed it bytes as they arrive from the
/// child's stdout; drain complete lines via [`LineFramer::pop_line`].
///
/// Lines are returned as `Vec<u8>` so the caller can decide whether to
/// decode UTF-8 (and how to handle decode errors per line). Blank lines
/// are skipped — they carry no JSON payload.
#[derive(Debug, Default)]
pub struct LineFramer {
    buf: Vec<u8>,
    ready: VecDeque<Vec<u8>>,
}

impl LineFramer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Append a chunk of bytes. Any complete lines become available via
    /// [`pop_line`]. Partial trailing data stays in the internal buffer
    /// until the next `feed` call.
    pub fn feed(&mut self, chunk: &[u8]) {
        // Scan for `\n` byte by byte. We can't `split` because that loses
        // the partial trailing fragment that needs to survive to the next
        // `feed`.
        let mut start = 0usize;
        for (i, &b) in chunk.iter().enumerate() {
            if b == b'\n' {
                self.buf.extend_from_slice(&chunk[start..i]);
                // Trim a trailing `\r` (DOS line endings from `pi.exe`).
                if self.buf.last() == Some(&b'\r') {
                    self.buf.pop();
                }
                if !self.buf.is_empty() {
                    let line = std::mem::take(&mut self.buf);
                    self.ready.push_back(line);
                } else {
                    self.buf.clear();
                }
                start = i + 1;
            }
        }
        if start < chunk.len() {
            self.buf.extend_from_slice(&chunk[start..]);
        }
    }

    /// Pop the next complete line in arrival order, if any.
    pub fn pop_line(&mut self) -> Option<Vec<u8>> {
        self.ready.pop_front()
    }

    /// Number of buffered complete lines awaiting drain.
    pub fn pending(&self) -> usize {
        self.ready.len()
    }

    /// Bytes held in the partial-line buffer. Useful for tests and for
    /// detecting runaway lines (cap enforcement lives outside the framer).
    pub fn partial_len(&self) -> usize {
        self.buf.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(framer: &mut LineFramer) -> Vec<String> {
        let mut out = Vec::new();
        while let Some(line) = framer.pop_line() {
            out.push(String::from_utf8(line).expect("utf8"));
        }
        out
    }

    #[test]
    fn splits_on_lf() {
        let mut f = LineFramer::new();
        f.feed(b"{\"a\":1}\n{\"b\":2}\n");
        assert_eq!(lines(&mut f), vec!["{\"a\":1}", "{\"b\":2}"]);
        assert_eq!(f.partial_len(), 0);
    }

    #[test]
    fn strips_trailing_cr() {
        let mut f = LineFramer::new();
        f.feed(b"{\"a\":1}\r\n{\"b\":2}\r\n");
        assert_eq!(lines(&mut f), vec!["{\"a\":1}", "{\"b\":2}"]);
    }

    #[test]
    fn carries_partial_across_feeds() {
        let mut f = LineFramer::new();
        f.feed(b"{\"a\":");
        assert_eq!(f.pending(), 0);
        assert!(f.partial_len() > 0);
        f.feed(b"1}\n");
        assert_eq!(lines(&mut f), vec!["{\"a\":1}"]);
        assert_eq!(f.partial_len(), 0);
    }

    #[test]
    fn handles_utf8_split_across_chunks() {
        // "🚀" is U+1F680, encoded as F0 9F 9A 80 in UTF-8 (4 bytes).
        // Split the codepoint across two feeds — the framer must not
        // attempt to decode until a full line is isolated.
        let mut f = LineFramer::new();
        f.feed(b"{\"emoji\":\"\xF0\x9F");
        f.feed(b"\x9A\x80\"}\n");
        let out = lines(&mut f);
        assert_eq!(out, vec!["{\"emoji\":\"\u{1F680}\"}"]);
    }

    #[test]
    fn preserves_unicode_line_separators_inside_payload() {
        // U+2028 (LINE SEPARATOR) is `E2 80 A8` in UTF-8. Node's `readline`
        // would split on it; the spec says we MUST NOT. Embed it inside a
        // JSON string and confirm the line stays whole.
        let mut f = LineFramer::new();
        let payload = b"{\"text\":\"foo\xE2\x80\xA8bar\"}\n";
        f.feed(payload);
        let out = lines(&mut f);
        assert_eq!(out, vec!["{\"text\":\"foo\u{2028}bar\"}"]);
    }

    #[test]
    fn preserves_paragraph_separator_inside_payload() {
        // U+2029 (PARAGRAPH SEPARATOR) — same hazard as U+2028.
        let mut f = LineFramer::new();
        f.feed(b"{\"t\":\"a\xE2\x80\xA9b\"}\n");
        assert_eq!(lines(&mut f), vec!["{\"t\":\"a\u{2029}b\"}"]);
    }

    #[test]
    fn skips_blank_lines() {
        let mut f = LineFramer::new();
        f.feed(b"\n\n{\"a\":1}\n\n{\"b\":2}\n\n");
        assert_eq!(lines(&mut f), vec!["{\"a\":1}", "{\"b\":2}"]);
    }

    #[test]
    fn handles_oversize_line_in_many_feeds() {
        let mut f = LineFramer::new();
        // 100 KiB single line, fed 7 bytes at a time.
        let big = "x".repeat(100 * 1024);
        let line = format!("\"{}\"\n", big);
        for chunk in line.as_bytes().chunks(7) {
            f.feed(chunk);
        }
        let out = lines(&mut f);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].len(), big.len() + 2); // surrounding quotes
    }

    #[test]
    fn empty_feed_is_noop() {
        let mut f = LineFramer::new();
        f.feed(b"");
        assert_eq!(f.pending(), 0);
        assert_eq!(f.partial_len(), 0);
    }

    #[test]
    fn malformed_json_is_caller_problem() {
        // The framer is byte-exact; JSON validity is the caller's concern.
        // We just verify the line round-trips so the caller sees what Pi
        // actually emitted (helpful for logging parse failures verbatim).
        let mut f = LineFramer::new();
        f.feed(b"this is not json\n");
        assert_eq!(lines(&mut f), vec!["this is not json"]);
    }

    #[test]
    fn lone_cr_inside_line_is_preserved() {
        // Only a `\r` immediately preceding `\n` is stripped. A `\r` in the
        // middle of a line must survive (it could be inside a JSON string).
        let mut f = LineFramer::new();
        f.feed(b"{\"t\":\"a\rb\"}\n");
        assert_eq!(lines(&mut f), vec!["{\"t\":\"a\rb\"}"]);
    }
}

