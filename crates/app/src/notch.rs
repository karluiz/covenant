//! Per-session ExecutorPhaseDetector wired to the SessionEvent bus.

use std::collections::HashMap;
use std::sync::Arc;

use karl_blocks::executor_phase::ExecutorPhaseDetector;
use karl_session::{SessionEvent, SessionId};
use tokio::sync::{broadcast, Mutex};

struct Entry {
    detector: ExecutorPhaseDetector,
    bus: broadcast::Sender<SessionEvent>,
}

pub struct NotchHub {
    sessions: Mutex<HashMap<SessionId, Entry>>,
}

impl NotchHub {
    pub fn new() -> Arc<Self> {
        Arc::new(Self { sessions: Mutex::new(HashMap::new()) })
    }

    pub async fn register(&self, session: SessionId, bus: broadcast::Sender<SessionEvent>) {
        self.sessions.lock().await.insert(
            session,
            Entry { detector: ExecutorPhaseDetector::default(), bus },
        );
    }

    pub async fn ingest(&self, session: SessionId, bytes: &[u8]) {
        let mut map = self.sessions.lock().await;
        let Some(entry) = map.get_mut(&session) else { return };
        if entry.detector.feed(bytes) {
            let _ = entry.bus.send(SessionEvent::ExecutorStateChanged {
                session,
                phase: entry.detector.phase().clone(),
            });
        }
    }

    pub async fn drop_session(&self, session: &SessionId) {
        self.sessions.lock().await.remove(session);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use karl_session::ExecutorPhase;

    #[tokio::test]
    async fn ingest_emits_event_on_phase_change() {
        let (tx, mut rx) = broadcast::channel(16);
        let hub = NotchHub::new();
        let sid = SessionId::new();
        hub.register(sid, tx).await;
        hub.ingest(sid, b"thinking...\n").await;
        let ev = rx.recv().await.expect("event");
        match ev {
            SessionEvent::ExecutorStateChanged { phase, .. } => {
                assert_eq!(phase, ExecutorPhase::Thinking);
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[tokio::test]
    async fn ingest_silent_when_phase_same() {
        let (tx, mut rx) = broadcast::channel(16);
        let hub = NotchHub::new();
        let sid = SessionId::new();
        hub.register(sid, tx).await;
        hub.ingest(sid, b"thinking...\n").await;
        let _ = rx.recv().await;
        hub.ingest(sid, b"more thinking\n").await;
        assert!(rx.try_recv().is_err());
    }
}
