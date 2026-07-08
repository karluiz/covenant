/// LSP base-protocol framing: `Content-Length: N\r\n(\r\n|<hdr>\r\n)*\r\n<N bytes>`.
/// Incremental: `push` buffers partial input and returns every complete payload.
pub struct FrameDecoder {
    buf: Vec<u8>,
}

pub fn encode_frame(msg: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(msg.len() + 32);
    out.extend_from_slice(format!("Content-Length: {}\r\n\r\n", msg.len()).as_bytes());
    out.extend_from_slice(msg.as_bytes());
    out
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        loop {
            // Find end of header block.
            let Some(hdr_end) = find_subslice(&self.buf, b"\r\n\r\n") else {
                break;
            };
            let headers = String::from_utf8_lossy(&self.buf[..hdr_end]);
            let len = headers.lines().find_map(|l| {
                let (k, v) = l.split_once(':')?;
                k.eq_ignore_ascii_case("content-length")
                    .then(|| v.trim().parse::<usize>().ok())
                    .flatten()
            });
            let Some(len) = len else {
                // No Content-Length: drop this header block and resync.
                tracing::warn!("lsp frame without Content-Length header; dropping");
                self.buf.drain(..hdr_end + 4);
                continue;
            };
            let body_start = hdr_end + 4;
            if self.buf.len() < body_start + len {
                break; // body incomplete — wait for more bytes
            }
            let body =
                String::from_utf8_lossy(&self.buf[body_start..body_start + len]).into_owned();
            self.buf.drain(..body_start + len);
            out.push(body);
        }
        out
    }
}

impl Default for FrameDecoder {
    fn default() -> Self {
        Self::new()
    }
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_produces_content_length_header() {
        let out = encode_frame(r#"{"a":1}"#);
        assert_eq!(out, b"Content-Length: 7\r\n\r\n{\"a\":1}");
    }

    #[test]
    fn decodes_single_message() {
        let mut d = FrameDecoder::new();
        let msgs = d.push(b"Content-Length: 7\r\n\r\n{\"a\":1}");
        assert_eq!(msgs, vec![r#"{"a":1}"#.to_string()]);
    }

    #[test]
    fn decodes_message_split_across_pushes() {
        let mut d = FrameDecoder::new();
        assert!(d.push(b"Content-Le").is_empty());
        assert!(d.push(b"ngth: 7\r\n\r\n{\"a\"").is_empty());
        assert_eq!(d.push(b":1}"), vec![r#"{"a":1}"#.to_string()]);
    }

    #[test]
    fn decodes_two_messages_in_one_push() {
        let mut d = FrameDecoder::new();
        let msgs = d.push(b"Content-Length: 2\r\n\r\n{}Content-Length: 7\r\n\r\n{\"a\":1}");
        assert_eq!(msgs, vec!["{}".to_string(), r#"{"a":1}"#.to_string()]);
    }

    #[test]
    fn tolerates_extra_headers_and_case() {
        let mut d = FrameDecoder::new();
        let msgs = d.push(
            b"content-length: 2\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{}",
        );
        assert_eq!(msgs, vec!["{}".to_string()]);
    }

    #[test]
    fn malformed_header_is_skipped_without_panic() {
        let mut d = FrameDecoder::new();
        // no Content-Length at all — decoder drops the header block and resyncs
        let msgs = d.push(b"Garbage: x\r\n\r\nContent-Length: 2\r\n\r\n{}");
        assert_eq!(msgs, vec!["{}".to_string()]);
    }
}
