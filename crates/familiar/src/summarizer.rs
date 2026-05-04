use crate::error::Result;
use crate::memory::{EventRow, Memory};
use async_trait::async_trait;

#[async_trait]
pub trait Llm: Send + Sync {
    async fn complete(&self, system: &str, user: &str) -> Result<LlmResponse>;
}

#[derive(Debug, Clone)]
pub struct LlmResponse {
    pub text: String,
    pub tokens_in: i64,
    pub tokens_out: i64,
    pub cost_usd: f64,
}

pub struct Summarizer<'a, L: Llm> {
    pub memory: &'a Memory,
    pub llm: &'a L,
}

impl<'a, L: Llm> Summarizer<'a, L> {
    /// Folds new events into the rolling summary. Returns the new summary text
    /// and the cost incurred. Idempotent w.r.t. last_event_id.
    pub async fn run_eager(&self, now_ms: i64) -> Result<Option<String>> {
        let prev = self.memory.latest_summary()?;
        let after = prev.as_ref().map(|s| s.last_event_id).unwrap_or(0);
        let new_events = self.memory.events_since(after)?;
        if new_events.is_empty() { return Ok(None); }

        let prev_text = prev.as_ref().map(|s| s.summary.as_str()).unwrap_or("");
        let user = render_eager_input(prev_text, &new_events);
        let sys = "You maintain a rolling summary of what an operator is doing in a terminal. \
                   Update the summary to reflect the new events. Stay under 300 words. \
                   Preserve key decisions, blockers, and current focus.";
        let resp = self.llm.complete(sys, &user).await?;
        let last_id = new_events.last().map(|e| e.id).unwrap_or(after);
        self.memory.write_summary(now_ms, &resp.text, last_id, resp.tokens_in, resp.tokens_out)?;
        Ok(Some(resp.text))
    }

    pub async fn run_lazy_for_mission(&self, mission_id: &str, now_ms: i64)
        -> Result<String>
    {
        let row = self.memory.mission(mission_id)?
            .ok_or_else(|| crate::FamiliarError::NotFound(mission_id.into()))?;
        let events = self.memory.events_since(0)?
            .into_iter()
            .filter(|e| e.ts_ms >= row.started_ms
                     && row.finished_ms.map_or(true, |f| e.ts_ms <= f))
            .collect::<Vec<_>>();

        let prev = self.memory.latest_summary()?
            .map(|s| s.summary).unwrap_or_default();
        let user = format!(
"MISSION OBJECTIVE: {}
ROLLING SUMMARY AT END:
{}

EVENT TIMELINE:
{}

Produce a structured digest (≤2000 chars):
- Objective restated
- Key decisions (bulleted)
- Outcome (success / blocked / abandoned)
- Notable blockers
- One-line takeaway",
            row.objective,
            prev,
            events.iter()
                .map(|e| format!("[{}] {}: {}", e.ts_ms, e.kind, e.payload_json))
                .collect::<Vec<_>>().join("\n"),
        );
        let sys = "You produce concise mission digests. Output the digest only.";
        let resp = self.llm.complete(sys, &user).await?;
        self.memory.finish_mission(mission_id, now_ms, &resp.text)?;
        Ok(resp.text)
    }
}

fn render_eager_input(prev: &str, events: &[EventRow]) -> String {
    let mut s = String::new();
    s.push_str("CURRENT SUMMARY:\n");
    s.push_str(if prev.is_empty() { "(none)\n" } else { prev });
    s.push_str("\n\nNEW EVENTS:\n");
    for e in events {
        s.push_str(&format!("[{}] {} {}: {}\n", e.ts_ms, e.session_id, e.kind, e.payload_json));
    }
    s.push_str("\nReturn the updated summary text only — no preamble.");
    s
}

pub struct AnthropicLlm {
    pub api_key: String,
    pub model: String,
    pub price_in_per_mtok: f64,
    pub price_out_per_mtok: f64,
}

impl AnthropicLlm {
    pub fn haiku(api_key: String) -> Self {
        Self {
            api_key,
            model: "claude-haiku-4-5-20251001".into(),
            price_in_per_mtok: 0.80,
            price_out_per_mtok: 4.00,
        }
    }
    pub fn sonnet(api_key: String) -> Self {
        Self {
            api_key,
            model: "claude-sonnet-4-6".into(),
            price_in_per_mtok: 3.00,
            price_out_per_mtok: 15.00,
        }
    }
}

#[async_trait]
impl Llm for AnthropicLlm {
    async fn complete(&self, system: &str, user: &str) -> Result<LlmResponse> {
        let req = karl_agent::AskRequest {
            api_key: self.api_key.clone(),
            model: self.model.clone(),
            system_prompt: system.to_string(),
            user_message: user.to_string(),
            max_tokens: 1024,
        };
        let resp = karl_agent::ask_oneshot_with_usage(req).await
            .map_err(crate::FamiliarError::Agent)?;
        let cost_usd = (resp.usage.input_tokens as f64 / 1_000_000.0) * self.price_in_per_mtok
                     + (resp.usage.output_tokens as f64 / 1_000_000.0) * self.price_out_per_mtok;
        Ok(LlmResponse {
            text: resp.text,
            tokens_in: resp.usage.input_tokens as i64,
            tokens_out: resp.usage.output_tokens as i64,
            cost_usd,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct MockLlm {
        responses: Mutex<Vec<LlmResponse>>,
        prompts_seen: Mutex<Vec<(String, String)>>,
    }
    impl MockLlm {
        fn new(resps: Vec<LlmResponse>) -> Self {
            Self { responses: Mutex::new(resps), prompts_seen: Mutex::new(vec![]) }
        }
    }
    #[async_trait]
    impl Llm for MockLlm {
        async fn complete(&self, sys: &str, user: &str) -> Result<LlmResponse> {
            self.prompts_seen.lock().unwrap().push((sys.into(), user.into()));
            Ok(self.responses.lock().unwrap().remove(0))
        }
    }

    #[tokio::test]
    async fn no_events_no_call() {
        let m = Memory::open_in_memory().unwrap();
        let llm = MockLlm::new(vec![]);
        let s = Summarizer { memory: &m, llm: &llm };
        assert!(s.run_eager(1000).await.unwrap().is_none());
        assert_eq!(llm.prompts_seen.lock().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn first_run_seeds_summary() {
        let m = Memory::open_in_memory().unwrap();
        m.append_event(100, "BlockFinished", "S", r#"{"cmd":"ls","exit":0}"#).unwrap();
        let llm = MockLlm::new(vec![LlmResponse {
            text: "operator listed files".into(),
            tokens_in: 50, tokens_out: 10, cost_usd: 0.001,
        }]);
        let s = Summarizer { memory: &m, llm: &llm };
        let out = s.run_eager(200).await.unwrap();
        assert_eq!(out.as_deref(), Some("operator listed files"));
        let latest = m.latest_summary().unwrap().unwrap();
        assert_eq!(latest.summary, "operator listed files");
    }

    #[tokio::test]
    async fn second_run_only_sees_delta() {
        let m = Memory::open_in_memory().unwrap();
        m.append_event(100, "BlockFinished", "S", "{}").unwrap();
        let llm1 = MockLlm::new(vec![LlmResponse {
            text: "first".into(), tokens_in: 1, tokens_out: 1, cost_usd: 0.0,
        }]);
        Summarizer { memory: &m, llm: &llm1 }.run_eager(200).await.unwrap();

        m.append_event(300, "BlockFinished", "S", r#"{"new":true}"#).unwrap();
        let llm2 = MockLlm::new(vec![LlmResponse {
            text: "second".into(), tokens_in: 1, tokens_out: 1, cost_usd: 0.0,
        }]);
        Summarizer { memory: &m, llm: &llm2 }.run_eager(400).await.unwrap();

        let user_input = &llm2.prompts_seen.lock().unwrap()[0].1;
        assert!(user_input.contains(r#"{"new":true}"#));
        assert!(!user_input.contains(r#"BlockFinished S: {}"#)); // delta only
    }

    #[tokio::test]
    async fn mission_digest_writes_to_store() {
        let m = Memory::open_in_memory().unwrap();
        m.start_mission("M1", 1000, "ship feature").unwrap();
        m.append_event(1100, "BlockFinished", "S", r#"{"cmd":"git push"}"#).unwrap();
        m.append_event(1200, "BlockFinished", "S", r#"{"cmd":"npm test"}"#).unwrap();
        let llm = MockLlm::new(vec![LlmResponse {
            text: "Pushed feature; tests green.".into(),
            tokens_in: 100, tokens_out: 30, cost_usd: 0.05,
        }]);
        let s = Summarizer { memory: &m, llm: &llm };
        s.run_lazy_for_mission("M1", 1300).await.unwrap();
        let row = m.mission("M1").unwrap().unwrap();
        assert_eq!(row.digest, "Pushed feature; tests green.");
        assert_eq!(row.finished_ms, Some(1300));
    }
}
