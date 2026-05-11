use crate::error::Result;
use crate::memory::Memory;
use crate::summarizer::{Llm, Summarizer};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;
use tokio::sync::{Mutex, Notify};
use karl_session::SessionEvent;

pub struct Observer<L: Llm + 'static> {
    pub memory: Arc<Mutex<Memory>>,
    pub llm: Arc<L>,
    pub session_filter: String,
    pub flush_every: usize,
    pub flush_after: Duration,
    /// Optional shutdown signal. When `notify_waiters` is called on it,
    /// the observer's run loop exits cleanly. If `None`, the observer
    /// only exits when the broadcast sender drops (legacy behavior).
    pub shutdown: Option<Arc<Notify>>,
}

impl<L: Llm + 'static> Observer<L> {
    /// Drains the bus until the channel closes. Persists each event matching
    /// `session_filter`; after `flush_every` events or `flush_after` elapsed,
    /// runs the eager summarizer.
    pub async fn run(self, mut rx: broadcast::Receiver<SessionEvent>) -> Result<()> {
        let mut pending: usize = 0;
        let mut last_flush = tokio::time::Instant::now();
        // Use a sentinel Notify when none provided; it's never triggered.
        let shutdown = self.shutdown.clone().unwrap_or_else(|| Arc::new(Notify::new()));
        loop {
            enum Step { Event(std::result::Result<SessionEvent, broadcast::error::RecvError>), Timeout, Shutdown }
            let step = tokio::select! {
                biased;
                _ = shutdown.notified() => Step::Shutdown,
                res = rx.recv() => Step::Event(res),
                _ = tokio::time::sleep(self.flush_after) => Step::Timeout,
            };
            let event = match step {
                Step::Shutdown => break,
                Step::Event(Ok(ev)) => Some(ev),
                Step::Event(Err(broadcast::error::RecvError::Closed)) => break,
                Step::Event(Err(broadcast::error::RecvError::Lagged(_))) => continue,
                Step::Timeout => None,
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
        // TODO(telegram): handled in Task 5/6
        SessionEvent::EscalationRequested { .. } => "EscalationRequested",
        SessionEvent::EscalationResolved { .. } => "EscalationResolved",
        SessionEvent::MissionCompleted { .. } => "MissionCompleted",
        SessionEvent::MissionFailed { .. } => "MissionFailed",
        SessionEvent::AgentIdleWaiting { .. } => {
            tracing::trace!("AgentIdleWaiting observer forwarding deferred to Task 6");
            "AgentIdleWaiting"
        }
        SessionEvent::AgentResumed { .. } => {
            tracing::trace!("AgentResumed observer forwarding deferred to Task 6");
            "AgentResumed"
        }
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
        | SessionEvent::FixSuggested { session, .. }
        // TODO(telegram): handled in Task 5/6
        | SessionEvent::EscalationRequested { session, .. }
        | SessionEvent::MissionCompleted { session, .. }
        | SessionEvent::MissionFailed { session, .. }
        | SessionEvent::AgentIdleWaiting { session, .. }
        | SessionEvent::AgentResumed { session } => session.to_string(),
        // TODO(telegram): handled in Task 5/6 — no session id on this variant
        SessionEvent::EscalationResolved { .. } => String::new(),
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
