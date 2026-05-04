use karl_familiar::memory::Memory;
use karl_familiar::observer::Observer;
use karl_familiar::summarizer::{Llm, LlmResponse};
use karl_familiar::error::Result;
use async_trait::async_trait;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::sync::{broadcast, Mutex};
use tokio::task::LocalSet;

struct CountingLlm {
    n: StdMutex<usize>,
}

#[async_trait]
impl Llm for CountingLlm {
    async fn complete(&self, _: &str, _: &str) -> Result<LlmResponse> {
        *self.n.lock().unwrap() += 1;
        Ok(LlmResponse {
            text: "summary".into(),
            tokens_in: 1,
            tokens_out: 1,
            cost_usd: 0.0,
        })
    }
}

#[tokio::test]
async fn observer_persists_and_summarizes() {
    let local = LocalSet::new();

    local.run_until(async {
        let mem = Arc::new(Mutex::new(Memory::open_in_memory().unwrap()));
        let llm = Arc::new(CountingLlm { n: StdMutex::new(0) });
        let (tx, rx) = broadcast::channel::<karl_session::SessionEvent>(64);

        // Use a stable session id string so observer filter matches.
        let session_str = "01H0000000000000000000000S";

        let obs = Observer {
            memory: mem.clone(),
            llm: llm.clone(),
            session_filter: session_str.into(),
            flush_every: 3,
            flush_after: Duration::from_millis(200),
        };

        let handle = tokio::task::spawn_local(async move { obs.run(rx).await });

        use ulid::Ulid;
        use karl_session::{SessionEvent, SessionId};
        use karl_blocks::BlockId;
        use std::path::PathBuf;

        let s1 = SessionId(Ulid::from_string(session_str).unwrap_or_else(|_| Ulid::new()));

        // Emit 3 BlockFinished events — triggers flush_every=3.
        for i in 0..3_i32 {
            let ev = SessionEvent::BlockFinished {
                session: s1,
                block: BlockId(Ulid::new()),
                command: format!("echo {}", i),
                cwd: PathBuf::from("/tmp"),
                exit_code: Some(i),
                duration_ms: 10,
                output_text: format!("output {}", i),
            };
            tx.send(ev).unwrap();
        }

        tokio::time::sleep(Duration::from_millis(400)).await;
        drop(tx);
        let _ = handle.await;

        let m = mem.lock().await;
        let evs = m.events_since(0).unwrap();
        assert!(evs.len() >= 3, "expected >=3 events, got {}", evs.len());
        assert!(
            *llm.n.lock().unwrap() >= 1,
            "summarizer should have run at least once"
        );
    }).await;
}
