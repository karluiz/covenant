use async_trait::async_trait;
use karl_familiar::error::Result;
use karl_familiar::memory::Memory;
use karl_familiar::observer::Observer;
use karl_familiar::summarizer::{Llm, LlmResponse};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::sync::{broadcast, Mutex, Notify};
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

    local
        .run_until(async {
            let mem = Arc::new(Mutex::new(Memory::open_in_memory().unwrap()));
            let llm = Arc::new(CountingLlm {
                n: StdMutex::new(0),
            });
            let (tx, rx) = broadcast::channel::<karl_session::SessionEvent>(64);

            // Use a stable session id string so observer filter matches.
            let session_str = "01H0000000000000000000000S";

            let obs = Observer {
                memory: mem.clone(),
                llm: llm.clone(),
                session_filter: session_str.into(),
                flush_every: 3,
                flush_after: Duration::from_millis(200),
                shutdown: None,
            };

            let handle = tokio::task::spawn_local(async move { obs.run(rx).await });

            use karl_blocks::BlockId;
            use karl_session::{SessionEvent, SessionId};
            use std::path::PathBuf;
            use ulid::Ulid;

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
        })
        .await;
}

#[tokio::test]
async fn observer_exits_on_shutdown() {
    let local = LocalSet::new();
    local
        .run_until(async {
            let mem = Arc::new(Mutex::new(Memory::open_in_memory().unwrap()));
            let llm = Arc::new(CountingLlm {
                n: StdMutex::new(0),
            });
            let (tx, rx) = broadcast::channel::<karl_session::SessionEvent>(8);
            let shutdown = Arc::new(Notify::new());

            let obs = Observer {
                memory: mem.clone(),
                llm: llm.clone(),
                session_filter: "anything".into(),
                flush_every: 100,
                // Long flush_after — without the shutdown branch, the loop would
                // park here for 60s and not exit until the bus closes.
                flush_after: Duration::from_secs(60),
                shutdown: Some(shutdown.clone()),
            };

            let handle = tokio::task::spawn_local(async move { obs.run(rx).await });

            // Don't drop tx; rely solely on the shutdown signal to exit the loop.
            tokio::time::sleep(Duration::from_millis(50)).await;
            shutdown.notify_waiters();

            let result = tokio::time::timeout(Duration::from_secs(2), handle).await;
            assert!(
                result.is_ok(),
                "observer did not exit after shutdown signal"
            );
            // Keep tx alive until the assertion, so we know the exit path is the
            // shutdown signal rather than a closed bus.
            drop(tx);
        })
        .await;
}
