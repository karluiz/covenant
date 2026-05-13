//! Schema for the single tool the ⌘K agent must invoke to return a
//! structured response. Streaming tool inputs arrive as JSON fragments
//! across many `input_json_delta` events; `ToolInputAccumulator` joins
//! them and parses once the content block closes.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::safety::Risk;

pub const TOOL_NAME: &str = "respond";

/// JSON Schema for the `respond` tool. Passed verbatim in the
/// `tools` array of the Messages API request.
pub fn tool_schema() -> Value {
    serde_json::json!({
        "name": TOOL_NAME,
        "description": "Return your answer to the user. Always invoke this tool exactly once. \
                        Put prose in `explanation`. If a single shell command would help the \
                        user, put it in `command`. Suggest up to 3 short follow-up questions.",
        "input_schema": {
            "type": "object",
            "additionalProperties": false,
            "required": ["explanation"],
            "properties": {
                "explanation": {
                    "type": "string",
                    "description": "Plain prose. May be empty if the command is self-evident."
                },
                "command": {
                    "type": ["object", "null"],
                    "additionalProperties": false,
                    "required": ["cmd", "rationale"],
                    "properties": {
                        "cmd": { "type": "string", "description": "Single shell-ready line, no $ prefix, no fences." },
                        "rationale": { "type": "string", "description": "One short sentence." },
                        "cwd_hint": { "type": ["string", "null"] }
                    }
                },
                "followups": {
                    "type": "array",
                    "maxItems": 3,
                    "items": { "type": "string" }
                }
            }
        }
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentResponse {
    #[serde(default)]
    pub explanation: String,
    #[serde(default)]
    pub command: Option<CommandAction>,
    #[serde(default)]
    pub followups: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandAction {
    pub cmd: String,
    pub rationale: String,
    /// Backend-overridden, never trusted from the model.
    #[serde(default = "default_risk")]
    pub risk: Risk,
    #[serde(default)]
    pub cwd_hint: Option<String>,
}

fn default_risk() -> Risk {
    Risk::Safe
}

/// Joins streaming `input_json_delta` fragments for a single tool_use
/// content block. Call `push` for every delta, then `finish` to parse.
#[derive(Default, Debug)]
pub struct ToolInputAccumulator {
    buf: String,
}

impl ToolInputAccumulator {
    pub fn push(&mut self, fragment: &str) {
        self.buf.push_str(fragment);
    }

    pub fn finish(self) -> Result<AgentResponse, serde_json::Error> {
        // Anthropic sends `{}` if the model emits no input. Tolerate.
        let raw = if self.buf.trim().is_empty() {
            "{}".to_string()
        } else {
            self.buf
        };
        let mut resp: AgentResponse = serde_json::from_str(&raw)?;
        // Force-classify the command risk; never trust the model.
        if let Some(c) = resp.command.as_mut() {
            c.risk = crate::safety::classify(&c.cmd);
        }
        Ok(resp)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accumulates_and_classifies() {
        let mut acc = ToolInputAccumulator::default();
        acc.push(r#"{"explanation":"kills the port","command":{"cmd":"#);
        acc.push(r#""lsof -ti :3000 | xargs kill -9","rationale":"frees 3000""#);
        acc.push(r#"},"followups":["which process is it?"]}"#);
        let r = acc.finish().unwrap();
        assert_eq!(r.explanation, "kills the port");
        let c = r.command.expect("command present");
        assert_eq!(c.risk, Risk::Mutates);
        assert_eq!(r.followups.len(), 1);
    }

    #[test]
    fn empty_input_is_ok() {
        let acc = ToolInputAccumulator::default();
        let r = acc.finish().unwrap();
        assert!(r.explanation.is_empty());
        assert!(r.command.is_none());
    }

    #[test]
    fn destructive_classification_overrides_model() {
        let mut acc = ToolInputAccumulator::default();
        acc.push(r#"{"explanation":"x","command":{"cmd":"rm -rf /tmp/x","rationale":"clean","risk":"safe"}}"#);
        let r = acc.finish().unwrap();
        assert_eq!(r.command.unwrap().risk, Risk::Destructive);
    }
}
