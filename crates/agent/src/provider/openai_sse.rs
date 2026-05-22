//! Shared SSE chunk parser for OpenAI-shaped Chat Completions streams.
//! Used by both `openai_compat` and `azure_foundry`.

use crate::{AgentEvent, TokenUsage};

/// Find the next `\n\n` boundary in `buf`. Returns the index of the
/// first `\n` (so a `drain(..idx + 2)` consumes the whole separator).
pub fn find_double_newline(buf: &[u8]) -> Option<usize> {
    buf.windows(2).position(|w| w == b"\n\n")
}

/// Parse one drained event block (everything up to but not including
/// the `\n\n`) and emit `AgentEvent`s via `on_event`. Returns `true`
/// when the stream signaled `[DONE]`.
pub fn handle_event_block(text: &str, on_event: &mut dyn FnMut(AgentEvent)) -> bool {
    for line in text.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim_start();
        if data.is_empty() {
            continue;
        }
        if data == "[DONE]" {
            on_event(AgentEvent::Done);
            return true;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else {
            continue;
        };

        if let Some(choice) = v.get("choices").and_then(|c| c.get(0)) {
            if let Some(text) = choice
                .get("delta")
                .and_then(|d| d.get("content"))
                .and_then(|t| t.as_str())
            {
                if !text.is_empty() {
                    on_event(AgentEvent::Delta(text.to_string()));
                }
            }
            if let Some(reason) = choice.get("finish_reason").and_then(|r| r.as_str()) {
                on_event(AgentEvent::StopReason(reason.to_string()));
            }
        }

        if let Some(usage) = v.get("usage") {
            let get = |k: &str| {
                usage
                    .get(k)
                    .and_then(|n| n.as_u64())
                    .map(|n| n as u32)
                    .unwrap_or(0)
            };
            on_event(AgentEvent::Usage(TokenUsage {
                input_tokens: get("prompt_tokens"),
                output_tokens: get("completion_tokens"),
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
            }));
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn done_marker_returns_true_and_emits_done() {
        let mut events = vec![];
        let done = handle_event_block("data: [DONE]", &mut |e| events.push(e));
        assert!(done);
        assert!(matches!(events.as_slice(), [AgentEvent::Done]));
    }

    #[test]
    fn content_delta_is_emitted() {
        let mut events = vec![];
        handle_event_block(
            r#"data: {"choices":[{"delta":{"content":"hi"}}]}"#,
            &mut |e| events.push(e),
        );
        match events.as_slice() {
            [AgentEvent::Delta(s)] => assert_eq!(s, "hi"),
            other => panic!("unexpected events: {other:?}"),
        }
    }

    #[test]
    fn usage_block_emits_token_counts() {
        let mut events = vec![];
        handle_event_block(
            r#"data: {"usage":{"prompt_tokens":12,"completion_tokens":34}}"#,
            &mut |e| events.push(e),
        );
        match events.as_slice() {
            [AgentEvent::Usage(u)] => {
                assert_eq!(u.input_tokens, 12);
                assert_eq!(u.output_tokens, 34);
            }
            other => panic!("unexpected events: {other:?}"),
        }
    }
}
