use crate::directive::{Directive, DirectiveKind, ensure_safe, SafetyCheck};
use crate::error::Result;
use crate::identity::FamiliarConfig;
use crate::memory::Memory;
use crate::prompts::system_prompt;
use crate::summarizer::Llm;
use serde::Deserialize;

pub struct ChatAgent<'a, L: Llm> {
    pub memory: &'a Memory,
    pub llm: &'a L,
    pub safety: &'a dyn SafetyCheck,
    pub config: &'a FamiliarConfig,
}

#[derive(Debug, Clone)]
pub struct ChatTurn {
    pub assistant_text: String,
    pub proposed_directive: Option<Directive>,
    pub safety_block_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DirectivePayload {
    kind: String,
    payload: String,
    rationale: String,
}

impl<'a, L: Llm> ChatAgent<'a, L> {
    pub async fn turn(&self, now_ms: i64, user_text: &str) -> Result<ChatTurn> {
        self.memory.append_chat(now_ms, "user", user_text)?;
        let summary = self.memory.latest_summary()?
            .map(|s| s.summary).unwrap_or_default();
        let missions = self.memory.recent_missions(5)?;
        let missions_text = missions.iter()
            .map(|m| format!("- mission {} ({}): {}", m.mission_id, m.objective, m.digest))
            .collect::<Vec<_>>().join("\n");
        let history = self.memory.chat_history(20)?;
        let history_text = history.iter()
            .map(|c| format!("{}: {}", c.role, c.content))
            .collect::<Vec<_>>().join("\n");

        let sys = system_prompt(self.config, &summary, &missions_text);
        let user = format!(
"CHAT HISTORY:
{history_text}

If you want to propose a directive to the operator, include exactly one block:
<<DIRECTIVE>>
{{\"kind\":\"stop|focus|avoid|resume|custom\",\"payload\":\"...\",\"rationale\":\"...\"}}
<</DIRECTIVE>>

Otherwise just reply normally.");

        let resp = self.llm.complete(&sys, &user).await?;
        let (visible, parsed) = extract_directive(&resp.text);
        let mut proposed: Option<Directive> = None;
        let mut blocked: Option<String> = None;
        if let Some(p) = parsed {
            let kind = match p.kind.as_str() {
                "stop" => DirectiveKind::Stop,
                "focus" => DirectiveKind::Focus,
                "avoid" => DirectiveKind::Avoid,
                "resume" => DirectiveKind::Resume,
                _ => DirectiveKind::Custom,
            };
            let d = Directive::new(kind, p.payload, p.rationale);
            match ensure_safe(&d, self.safety) {
                Ok(()) => {
                    self.memory.log_directive(&d.id, now_ms, "proposed",
                        &format!("{:?}", d.kind), &d.payload, &d.rationale, None)?;
                    proposed = Some(d);
                }
                Err(crate::FamiliarError::SafetyBlocked { reason }) => {
                    self.memory.log_directive(&d.id, now_ms, "safety_blocked",
                        &format!("{:?}", d.kind), &d.payload, &d.rationale, Some(&reason))?;
                    blocked = Some(reason);
                }
                Err(e) => return Err(e),
            }
        }
        self.memory.append_chat(now_ms + 1, "assistant", &visible)?;
        Ok(ChatTurn {
            assistant_text: visible,
            proposed_directive: proposed,
            safety_block_reason: blocked,
        })
    }
}

fn extract_directive(text: &str) -> (String, Option<DirectivePayload>) {
    if let (Some(start), Some(end)) = (text.find("<<DIRECTIVE>>"), text.find("<</DIRECTIVE>>")) {
        if end > start {
            let json_part = &text[start + "<<DIRECTIVE>>".len() .. end];
            let visible = format!("{}{}", &text[..start], &text[end + "<</DIRECTIVE>>".len()..])
                .trim().to_string();
            if let Ok(p) = serde_json::from_str::<DirectivePayload>(json_part.trim()) {
                return (visible, Some(p));
            }
        }
    }
    (text.to_string(), None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::directive::DefaultSafety;
    use crate::summarizer::LlmResponse;
    use async_trait::async_trait;
    use std::sync::Mutex;

    struct CannedLlm(Mutex<Vec<String>>);
    #[async_trait]
    impl Llm for CannedLlm {
        async fn complete(&self, _: &str, _: &str) -> Result<LlmResponse> {
            let text = self.0.lock().unwrap().remove(0);
            Ok(LlmResponse { text, tokens_in: 1, tokens_out: 1, cost_usd: 0.0 })
        }
    }

    #[tokio::test]
    async fn plain_reply_records_history() {
        let m = Memory::open_in_memory().unwrap();
        let llm = CannedLlm(Mutex::new(vec!["all good".into()]));
        let cfg = FamiliarConfig::default();
        let agent = ChatAgent { memory: &m, llm: &llm, safety: &DefaultSafety, config: &cfg };
        let turn = agent.turn(1000, "status?").await.unwrap();
        assert_eq!(turn.assistant_text, "all good");
        assert!(turn.proposed_directive.is_none());
        assert_eq!(m.chat_history(10).unwrap().len(), 2);
    }

    #[tokio::test]
    async fn directive_extracted_and_logged() {
        let m = Memory::open_in_memory().unwrap();
        let llm = CannedLlm(Mutex::new(vec![
            "Sure, here's my proposal.\n<<DIRECTIVE>>{\"kind\":\"stop\",\"payload\":\"halt deploy\",\"rationale\":\"prod risk\"}<</DIRECTIVE>>".into()
        ]));
        let cfg = FamiliarConfig::default();
        let agent = ChatAgent { memory: &m, llm: &llm, safety: &DefaultSafety, config: &cfg };
        let turn = agent.turn(1000, "stop?").await.unwrap();
        assert!(turn.proposed_directive.is_some());
        assert!(turn.assistant_text.contains("Sure"));
        assert!(!turn.assistant_text.contains("DIRECTIVE"));
    }

    #[tokio::test]
    async fn unsafe_directive_recorded_as_blocked() {
        let m = Memory::open_in_memory().unwrap();
        let llm = CannedLlm(Mutex::new(vec![
            "<<DIRECTIVE>>{\"kind\":\"custom\",\"payload\":\"rm -rf /\",\"rationale\":\"x\"}<</DIRECTIVE>>".into()
        ]));
        let cfg = FamiliarConfig::default();
        let agent = ChatAgent { memory: &m, llm: &llm, safety: &DefaultSafety, config: &cfg };
        let turn = agent.turn(1000, "x").await.unwrap();
        assert!(turn.proposed_directive.is_none());
        assert!(turn.safety_block_reason.is_some());
    }
}
