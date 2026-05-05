//! Spec 3.19 — `/summary` slash command.
//!
//! Task 1: memory query helpers (read-only, no migrations).
//! Task 3: `summary_turn` with cache-hit / cache-miss / frozen-mode branches.

use async_trait::async_trait;
use karl_familiar::agent::{ChatAgent, SummaryScope};
use karl_familiar::directive::DefaultSafety;
use karl_familiar::error::Result as FResult;
use karl_familiar::identity::FamiliarConfig;
use karl_familiar::memory::Memory;
use karl_familiar::summarizer::{Llm, LlmResponse};
use std::sync::Mutex as StdMutex;

const DAY_MS: i64 = 24 * 3600 * 1000;

// ---------- events_in_window ----------

#[test]
fn events_in_window_filters_by_ts_and_orders_asc() {
    let m = Memory::open_in_memory().unwrap();
    // Insert out of order to verify ASC ordering by ts_ms.
    m.append_event(3000, "C", "S", "{}").unwrap();
    m.append_event(1000, "A", "S", "{}").unwrap();
    m.append_event(2000, "B", "S", "{}").unwrap();
    m.append_event(500,  "Z", "S", "{}").unwrap(); // outside window

    let win = m.events_in_window(1000).unwrap();
    let kinds: Vec<_> = win.iter().map(|e| e.kind.as_str()).collect();
    assert_eq!(kinds, vec!["A", "B", "C"]);
}

#[test]
fn events_in_window_inclusive_lower_bound() {
    let m = Memory::open_in_memory().unwrap();
    m.append_event(1000, "A", "S", "{}").unwrap();
    let win = m.events_in_window(1000).unwrap();
    assert_eq!(win.len(), 1, "ts == since_ms must be included");
}

#[test]
fn events_in_window_empty_returns_empty() {
    let m = Memory::open_in_memory().unwrap();
    m.append_event(1000, "A", "S", "{}").unwrap();
    assert!(m.events_in_window(5000).unwrap().is_empty());
}

// ---------- directives_in_window ----------

#[test]
fn directives_in_window_filters_by_proposed_ms_asc() {
    let m = Memory::open_in_memory().unwrap();
    m.log_directive("d1", 100, "proposed", "Stop", "x", "r", None).unwrap();
    m.log_directive("d2", 300, "approved", "Stop", "y", "r", None).unwrap();
    m.log_directive("d3", 200, "rejected", "Stop", "z", "r", Some("nope")).unwrap();
    m.log_directive("d4",  50, "proposed", "Stop", "old", "r", None).unwrap();

    let win = m.directives_in_window(100).unwrap();
    let ids: Vec<_> = win.iter().map(|d| d.id.as_str()).collect();
    assert_eq!(ids, vec!["d1", "d3", "d2"], "ASC by proposed_ms, lower bound inclusive");
}

#[test]
fn directives_in_window_empty() {
    let m = Memory::open_in_memory().unwrap();
    m.log_directive("d1", 100, "proposed", "Stop", "x", "r", None).unwrap();
    assert!(m.directives_in_window(500).unwrap().is_empty());
}

// ---------- has_recent_closed_mission ----------

#[test]
fn has_recent_closed_mission_true_when_finished_in_window() {
    let m = Memory::open_in_memory().unwrap();
    m.start_mission("m1", 1000, "ship X").unwrap();
    m.finish_mission("m1", 5000, "shipped").unwrap();
    assert!(m.has_recent_closed_mission(2000).unwrap());
}

#[test]
fn has_recent_closed_mission_false_when_finished_before_window() {
    let m = Memory::open_in_memory().unwrap();
    m.start_mission("m1", 1000, "ship X").unwrap();
    m.finish_mission("m1", 1500, "shipped").unwrap();
    assert!(!m.has_recent_closed_mission(2000).unwrap());
}

#[test]
fn has_recent_closed_mission_false_when_only_open_missions() {
    let m = Memory::open_in_memory().unwrap();
    m.start_mission("m1", 1000, "ship X").unwrap();
    // never finished
    assert!(!m.has_recent_closed_mission(0).unwrap());
}

#[test]
fn has_recent_closed_mission_inclusive_lower_bound() {
    let m = Memory::open_in_memory().unwrap();
    m.start_mission("m1", 1000, "ship X").unwrap();
    m.finish_mission("m1", 2000, "shipped").unwrap();
    assert!(m.has_recent_closed_mission(2000).unwrap());
}

// ---------- costs_in_window ----------
//
// Schema is keyed by `day` string ("YYYY-MM-DD" UTC). Helper sums any day whose
// midnight UTC is >= the start day implied by since_ms (whole-day inclusion).

const DAY_2026_05_03_MIDNIGHT_UTC_MS: i64 = 1_777_785_600_000;
// Sanity: 2026-05-03 00:00:00 UTC. We don't depend on the exact constant —
// the test inserts rows at day-strings and queries at offsets relative to those.

#[test]
fn costs_in_window_sums_days_within_window() {
    let m = Memory::open_in_memory().unwrap();
    m.add_spend("2026-05-03", 0.10).unwrap();
    m.add_spend("2026-05-04", 0.20).unwrap();
    m.add_spend("2026-05-05", 0.30).unwrap();

    // since_ms = midnight 2026-05-04 UTC → include 05-04 and 05-05 (0.50)
    let since = DAY_2026_05_03_MIDNIGHT_UTC_MS + DAY_MS;
    let total = m.costs_in_window(since).unwrap();
    assert!((total - 0.50).abs() < 1e-9, "got {total}");
}

#[test]
fn costs_in_window_includes_partial_day_whole() {
    let m = Memory::open_in_memory().unwrap();
    m.add_spend("2026-05-04", 0.20).unwrap();
    // since_ms = noon on 2026-05-04 → still includes whole 05-04 day
    let since = DAY_2026_05_03_MIDNIGHT_UTC_MS + DAY_MS + 12 * 3600 * 1000;
    let total = m.costs_in_window(since).unwrap();
    assert!((total - 0.20).abs() < 1e-9);
}

// ============================================================
// Task 3 — summary_turn behavior
// ============================================================

#[derive(Default)]
struct RecordingLlm {
    calls: StdMutex<Vec<(String, String)>>, // (system, user)
    canned: StdMutex<Vec<String>>,
}

impl RecordingLlm {
    fn with_response(text: &str) -> Self {
        Self {
            calls: StdMutex::new(Vec::new()),
            canned: StdMutex::new(vec![text.to_string()]),
        }
    }
    fn call_count(&self) -> usize { self.calls.lock().unwrap().len() }
    fn last_call(&self) -> Option<(String, String)> {
        self.calls.lock().unwrap().last().cloned()
    }
}

#[async_trait]
impl Llm for RecordingLlm {
    async fn complete(&self, sys: &str, user: &str) -> FResult<LlmResponse> {
        self.calls.lock().unwrap().push((sys.into(), user.into()));
        let text = self.canned.lock().unwrap().pop()
            .unwrap_or_else(|| "fallback".into());
        Ok(LlmResponse { text, tokens_in: 1, tokens_out: 1, cost_usd: 0.0 })
    }
}

const NOW: i64 = 1_777_900_000_000; // mid-2026 UTC

fn fresh_agent_setup() -> (Memory, RecordingLlm, FamiliarConfig) {
    let m = Memory::open_in_memory().unwrap();
    let llm = RecordingLlm::with_response("LLM-GENERATED");
    let cfg = FamiliarConfig::default(); // daily_cap_usd = 5.0
    (m, llm, cfg)
}

#[tokio::test]
async fn summary_cache_hit_skips_llm_when_few_events() {
    let (m, llm, cfg) = fresh_agent_setup();
    // Seed a rolling summary at last_event_id=0.
    m.write_summary(NOW - 1000, "operator built feature X", 0, 10, 5).unwrap();
    // Append a few events (well below the 50-event staleness threshold).
    for i in 0..5 {
        m.append_event(NOW - 500 + i, "BlockFinished", "S", "{}").unwrap();
    }
    let agent = ChatAgent {
        memory: &m, llm: &llm, safety: &DefaultSafety, config: &cfg,
    };
    let turn = agent.turn(NOW, "/summary").await.unwrap();
    assert_eq!(llm.call_count(), 0, "cache-hit must NOT call LLM");
    assert!(turn.proposed_directive.is_none());
    assert!(turn.safety_block_reason.is_none());
    assert!(turn.assistant_text.contains("Resumen"));
    assert!(turn.assistant_text.contains("operator built feature X"));
}

#[tokio::test]
async fn summary_cache_miss_calls_llm_with_scoped_payload() {
    let (m, llm, cfg) = fresh_agent_setup();
    // Rolling summary at last_event_id=0.
    m.write_summary(NOW - 10_000, "pre-AOM state", 0, 10, 5).unwrap();
    // 60 events past the rolling — over the 50-event threshold.
    for i in 0..60 {
        m.append_event(NOW - 5_000 + i, "BlockFinished", "S",
                       &format!(r#"{{"i":{i}}}"#)).unwrap();
    }
    // A directive in window for the prompt to include.
    m.log_directive("d-1", NOW - 4_000, "approved", "Stop",
                    "halt deploy", "prod risk", None).unwrap();
    let agent = ChatAgent {
        memory: &m, llm: &llm, safety: &DefaultSafety, config: &cfg,
    };
    let turn = agent.turn(NOW, "/summary today").await.unwrap();

    assert_eq!(llm.call_count(), 1, "cache-miss must call LLM exactly once");
    let (sys, user) = llm.last_call().unwrap();
    assert!(sys.contains("rolling 24h"), "system must mention scope label");
    assert!(sys.contains("language"), "system must instruct language detection");
    assert!(sys.contains("Do NOT propose directives"));
    assert!(user.contains("pre-AOM state"), "user payload must include rolling");
    assert!(user.contains("halt deploy"), "user payload must include directive");
    assert_eq!(turn.assistant_text, "LLM-GENERATED");
    assert!(turn.proposed_directive.is_none());
}

#[tokio::test]
async fn summary_frozen_mode_skips_llm_and_appends_disclaimer() {
    let (m, llm, cfg) = fresh_agent_setup();
    // Push spend to exactly the cap → frozen.
    let day = karl_familiar::cost::CostGate::current_day(NOW);
    m.add_spend(&day, cfg.daily_cap_usd).unwrap();
    // Many events — would normally trigger cache-miss. Frozen short-circuits.
    m.write_summary(NOW - 10_000, "ctx", 0, 10, 5).unwrap();
    for i in 0..100 {
        m.append_event(NOW - 5_000 + i, "BlockFinished", "S", "{}").unwrap();
    }
    let agent = ChatAgent {
        memory: &m, llm: &llm, safety: &DefaultSafety, config: &cfg,
    };
    let turn = agent.turn(NOW, "/summary").await.unwrap();
    assert_eq!(llm.call_count(), 0, "frozen mode must NOT call LLM");
    assert!(turn.assistant_text.contains("modo congelado"),
            "frozen reply must include disclaimer; got: {}", turn.assistant_text);
}

#[tokio::test]
async fn summary_persists_user_and_assistant_chat() {
    let (m, llm, cfg) = fresh_agent_setup();
    m.write_summary(NOW - 1000, "ctx", 0, 10, 5).unwrap();
    let agent = ChatAgent {
        memory: &m, llm: &llm, safety: &DefaultSafety, config: &cfg,
    };
    let _ = agent.turn(NOW, "/summary").await.unwrap();
    let hist = m.chat_history(10).unwrap();
    assert_eq!(hist.len(), 2);
    assert_eq!(hist[0].role, "user");
    assert_eq!(hist[0].content, "/summary");
    assert_eq!(hist[1].role, "assistant");
    assert!(hist[1].content.contains("Resumen"));
}

#[tokio::test]
async fn summary_never_returns_directive() {
    // Even if the LLM tries to inject a directive marker, /summary strips it.
    let m = Memory::open_in_memory().unwrap();
    let cfg = FamiliarConfig::default();
    m.write_summary(NOW - 10_000, "ctx", 0, 10, 5).unwrap();
    for i in 0..60 {
        m.append_event(NOW - 5_000 + i, "BlockFinished", "S", "{}").unwrap();
    }
    let llm = RecordingLlm::with_response(
        "## Decisiones\n<<DIRECTIVE>>{\"kind\":\"stop\",\"payload\":\"x\",\"rationale\":\"y\"}<</DIRECTIVE>>\nrest"
    );
    let agent = ChatAgent {
        memory: &m, llm: &llm, safety: &DefaultSafety, config: &cfg,
    };
    let turn = agent.turn(NOW, "/summary").await.unwrap();
    assert!(turn.proposed_directive.is_none(),
            "/summary must never propose directives, even if LLM emits them");
    assert!(!turn.assistant_text.contains("<<DIRECTIVE>>"));
    assert!(!turn.assistant_text.contains("<</DIRECTIVE>>"));
    assert!(turn.assistant_text.contains("rest"));
}

#[test]
fn costs_in_window_empty_returns_zero() {
    let m = Memory::open_in_memory().unwrap();
    m.add_spend("2026-05-01", 0.99).unwrap();
    let since = DAY_2026_05_03_MIDNIGHT_UTC_MS + 30 * DAY_MS;
    assert!((m.costs_in_window(since).unwrap() - 0.0).abs() < 1e-9);
}
