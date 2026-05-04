use crate::error::Result;
use crate::memory::Memory;
use crate::summarizer::{Llm, Summarizer};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;
use tokio::sync::Mutex;
use karl_session::SessionEvent;

pub struct Observer<L: Llm + 'static> {
    pub memory: Arc<Mutex<Memory>>,
    pub llm: Arc<L>,
    pub session_filter: String,
    pub flush_every: usize,
    pub flush_after: Duration,
}

impl<L: Llm + 'static> Observer<L> {
    /// Drains the bus until the channel closes. Persists each event matching
    /// `session_filter`; after `flush_every` events or `flush_after` elapsed,
    /// runs the eager summarizer.
    pub async fn run(self, mut rx: broadcast::Receiver<SessionEvent>) -> Result<()> {
        let mut pending: usize = 0;
        let mut last_flush = tokio::time::Instant::now();
        loop {
            let event = match tokio::time::timeout(self.flush_after, rx.recv()).await {
                Ok(Ok(ev)) => Some(ev),
                Ok(Err(broadcast::error::RecvError::Closed)) => break,
                Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
                Err(_) => None, // timeout
            };
            if let Some(ev) = event {
                if event_session_id(&ev) != self.session_filter {
                    continue;
                }
                let now = now_ms();
                let kind = event_kind(&ev);
                let payload = serde_json::to_string(&ev).unwrap_or_else(|_| "{}".into());
                {
                    let mem = self.memory.lock().await;
                    mem.append_event(now, &kind, &self.session_filter, &payload)?;
                }
                pending += 1;
            }
            let elapsed = last_flush.elapsed() >= self.flush_after;
            if pending >= self.flush_every || (pending > 0 && elapsed) {
                let mem = self.memory.lock().await;
                let s = Summarizer {
                    memory: &mem,
                    llm: self.llm.as_ref(),
                };
                let _ = s.run_eager(now_ms()).await?;
                pending = 0;
                last_flush = tokio::time::Instant::now();
            }
        }
        Ok(())
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn event_kind(ev: &SessionEvent) -> String {
    match ev {
        SessionEvent::Opened { .. } => "Opened",
        SessionEvent::Closed { .. } => "Closed",
        SessionEvent::PromptStart { .. } => "PromptStart",
        SessionEvent::BlockSubmitted { .. } => "BlockSubmitted",
        SessionEvent::BlockFinished { .. } => "BlockFinished",
        SessionEvent::CwdChanged { .. } => "CwdChanged",
        SessionEvent::FixSuggested { .. } => "FixSuggested",
    }
    .into()
}

fn event_session_id(ev: &SessionEvent) -> String {
    match ev {
        SessionEvent::Opened { session, .. }
        | SessionEvent::Closed { session }
        | SessionEvent::PromptStart { session }
        | SessionEvent::BlockSubmitted { session, .. }
        | SessionEvent::BlockFinished { session, .. }
        | SessionEvent::CwdChanged { session, .. }
        | SessionEvent::FixSuggested { session, .. } => session.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::summarizer::LlmResponse;
    use async_trait::async_trait;
    use std::sync::Mutex as StdMutex;

    struct MockLlm {
        n: StdMutex<usize>,
    }

    #[async_trait]
    impl Llm for MockLlm {
        async fn complete(&self, _: &str, _: &str) -> Result<LlmResponse> {
            *self.n.lock().unwrap() += 1;
            Ok(LlmResponse {
                text: "ok".into(),
                tokens_in: 1,
                tokens_out: 1,
                cost_usd: 0.0,
            })
        }
    }

    // Real SessionEvent construction is environment-specific; integration is
    // exercised in crates/familiar/tests/observer.rs (see Task 14).
    #[test]
    fn placeholder_compiles() {
        let _ = ();
    }
}
