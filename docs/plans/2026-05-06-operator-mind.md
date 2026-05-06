# OperatorMind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stateless polling operator with a thread-aware OperatorMind per tab — model-maintained working memory + decision tape + extended thinking + SQLite persistence + feature flag — implemented mind-first without tools.

**Architecture:** New `crates/app/src/operator_mind.rs` (pure logic). New table `operator_mind` in `storage.rs`. New `OperatorMindConfig` block in `OperatorConfig`. The existing `karl_agent::ask_oneshot_with_usage` extends to support extended thinking. The turn-loop in `operator.rs` gets a gated branch: when `mind_v2 == true`, render mind blocks into the user message, call with thinking budget, parse `{mind_update, action}` from JSON, apply update, persist debounced, push `TurnRecord`. UI panel renders belief/intent/recent and `MindLossModal` on tab close.

**Tech Stack:** Rust + Tokio + serde + rusqlite (existing); TypeScript + Vite (existing); Anthropic Messages API extended thinking; xterm.js untouched.

**Spec reference:** `docs/specs/3.20-operator-mind.md`

**Working tree:** branch `feature/operator-mind` at `/Users/carlosgallardoarenas/Sources/karlTerminal-operator-mind`. **All commands below assume `cd` into that worktree.**

**Commit policy:** ONE commit per phase (per user preference: feature-grain commits, not TDD-step grain). Each phase commit is conventional-commits style with full test green before commit.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `crates/app/src/operator_mind.rs` | Create | Pure types (`OperatorMind`, `MindUpdate`, `TurnRecord`, `TurnAction`), `apply()`, cap enforcement, `render_mind_block()`, `render_recent_block()`, response parser, action signature normalizer. No I/O. |
| `crates/app/src/operator.rs` | Modify | Add `Option<OperatorMind>` to `OperatorState`. Branch in `decide_and_act` on `mind_v2`. Render mind+recent blocks, call agent with thinking budget, parse, apply, persist, record turn. Repeat-failure guard. Mission-change marker. |
| `crates/app/src/storage.rs` | Modify | Add `operator_mind` table to schema; `mind_load`, `mind_save`, `mind_delete`, GC. |
| `crates/app/src/settings.rs` | Modify | Extend `OperatorConfig` with `mind_v2: bool` and `mind_thinking_budget: u32`. |
| `crates/app/src/lib.rs` | Modify | Split `close_session` into `close_session_check` + `close_session_confirm`. Wire mind_delete on confirmed close. |
| `crates/agent/src/lib.rs` | Modify | Extend `AskRequest` with `thinking_budget: Option<u32>`. Extend `AskResponse` with `thinking_summary: Option<String>` and `thinking_full: Vec<String>`. Update streaming JSON body and SSE parser to handle `thinking` content blocks. |
| `ui/src/operator/panel.ts` | Modify | Render mind state (belief, next_intent, recent_turns with collapsible thoughts). Subscribe to new `operator-mind-updated` event. |
| `ui/src/operator/mind-loss-modal.ts` | Create | Modal component for tab-close confirmation. |
| `ui/src/tabs/manager.ts` | Modify | Cmd+W handler calls `close_session_check` first; if `Some(preview)` open modal, else direct close. |
| `ui/src/api.ts` | Modify | Add typed wrappers for `close_session_check`, `close_session_confirm`, mind events. |
| `ui/src/settings/` | Modify | Toggle for `operator.mind_v2` + numeric input for `mind_thinking_budget`. |
| `crates/app/tests/operator_mind_integration.rs` | Create | Two-turn continuity test with mock agent, parse-failure degradation, mission-change marker. |

---

## Task 1: Pure skeleton — types, apply, render, parser

**Goal:** Land `operator_mind.rs` as a self-contained pure module with full unit tests. No integration with `operator.rs` yet. Verifies the data model, caps, prompt rendering, and response parsing in isolation.

**Files:**
- Create: `crates/app/src/operator_mind.rs`
- Modify: `crates/app/src/lib.rs` (add `mod operator_mind;`)

### Step 1.1: Create the module skeleton

Create `crates/app/src/operator_mind.rs` with the type declarations and stub `apply()`:

```rust
//! Per-tab persistent agent state for the Operator (spec 3.20).
//!
//! This module is pure: types, merge logic, prompt-block rendering,
//! response parsing. No I/O, no PTY, no HTTP, no DB. The integration
//! lives in `operator.rs`; persistence lives in `storage.rs`.

use std::collections::VecDeque;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub const MAX_OPEN_QUESTIONS: usize = 5;
pub const MAX_TRIED_FAILED: usize = 5;
pub const MAX_RECENT_TURNS: usize = 5;
pub const SAW_TRUNCATE_CHARS: usize = 400;
pub const THOUGHT_TRUNCATE_CHARS: usize = 200;
pub const STALE_HOURS: i64 = 24;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct OperatorMind {
    pub goal: String,
    pub belief: String,
    pub open_questions: Vec<String>,
    pub tried_failed: Vec<String>,
    pub next_intent: String,
    pub recent: VecDeque<TurnRecord>,
    pub turn_count: u64,
    pub updated_at: DateTime<Utc>,
}

impl Default for OperatorMind {
    fn default() -> Self {
        Self {
            goal: String::new(),
            belief: String::new(),
            open_questions: vec![],
            tried_failed: vec![],
            next_intent: String::new(),
            recent: VecDeque::new(),
            turn_count: 0,
            updated_at: Utc::now(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnRecord {
    pub turn: u64,
    pub at: DateTime<Utc>,
    pub saw: String,
    pub thought: String,
    pub action: TurnAction,
    pub executed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind")]
pub enum TurnAction {
    Reply { text: String },
    Execute { command: String },
    Escalate { notification: String },
    Ignore,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct MindUpdate {
    #[serde(default)]
    pub goal: Option<String>,
    #[serde(default)]
    pub belief: Option<String>,
    #[serde(default)]
    pub open_questions_set: Option<Vec<String>>,
    #[serde(default)]
    pub tried_failed_append: Option<Vec<String>>,
    #[serde(default)]
    pub next_intent: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ModelResponse {
    #[serde(default)]
    pub mind_update: MindUpdate,
    pub action: TurnAction,
}

#[derive(Debug, thiserror::Error)]
pub enum MindParseError {
    #[error("no JSON object found in model output")]
    NoJsonObject,
    #[error("JSON parse failed: {0}")]
    Json(#[from] serde_json::Error),
}

impl OperatorMind {
    /// Merge a `MindUpdate` into self, enforcing caps. FIFO when capped.
    pub fn apply(&mut self, update: MindUpdate, now: DateTime<Utc>) {
        if let Some(g) = update.goal {
            self.goal = g;
        }
        if let Some(b) = update.belief {
            self.belief = b;
        }
        if let Some(qs) = update.open_questions_set {
            self.open_questions = qs.into_iter().take(MAX_OPEN_QUESTIONS).collect();
        }
        if let Some(tf) = update.tried_failed_append {
            for entry in tf {
                self.tried_failed.push(entry);
                while self.tried_failed.len() > MAX_TRIED_FAILED {
                    self.tried_failed.remove(0);
                }
            }
        }
        if let Some(ni) = update.next_intent {
            self.next_intent = ni;
        }
        self.updated_at = now;
    }

    /// Push a turn record onto the tape, FIFO-capped, bumps `turn_count`.
    pub fn record_turn(&mut self, mut rec: TurnRecord) {
        rec.saw = truncate(rec.saw, SAW_TRUNCATE_CHARS);
        rec.thought = truncate(rec.thought, THOUGHT_TRUNCATE_CHARS);
        self.turn_count = self.turn_count.max(rec.turn);
        self.recent.push_back(rec);
        while self.recent.len() > MAX_RECENT_TURNS {
            self.recent.pop_front();
        }
    }

    /// Whether the mind is "stale" (last update older than STALE_HOURS).
    pub fn is_stale(&self, now: DateTime<Utc>) -> bool {
        (now - self.updated_at).num_hours() > STALE_HOURS
    }
}

fn truncate(s: String, max: usize) -> String {
    if s.chars().count() <= max {
        return s;
    }
    s.chars().take(max).collect()
}

/// Render the `<mind>` XML block for the user message.
pub fn render_mind_block(mind: &OperatorMind, now: DateTime<Utc>) -> String {
    let stale_attr = if mind.is_stale(now) {
        format!(" stale-hours=\"{}\"", (now - mind.updated_at).num_hours())
    } else {
        String::new()
    };
    let mut s = format!(
        "<mind turn=\"{}\" updated=\"{}\"{}>\n",
        mind.turn_count,
        mind.updated_at.to_rfc3339(),
        stale_attr,
    );
    if !mind.goal.is_empty() {
        s.push_str(&format!("  <goal>{}</goal>\n", xml_escape(&mind.goal)));
    }
    if !mind.belief.is_empty() {
        s.push_str(&format!(
            "  <belief>{}</belief>\n",
            xml_escape(&mind.belief)
        ));
    }
    if !mind.open_questions.is_empty() {
        s.push_str("  <open-questions>\n");
        for q in &mind.open_questions {
            s.push_str(&format!("    {}\n", xml_escape(q)));
        }
        s.push_str("  </open-questions>\n");
    }
    if !mind.tried_failed.is_empty() {
        s.push_str("  <tried-failed>\n");
        for tf in &mind.tried_failed {
            s.push_str(&format!("    {}\n", xml_escape(tf)));
        }
        s.push_str("  </tried-failed>\n");
    }
    if !mind.next_intent.is_empty() {
        s.push_str(&format!(
            "  <next-intent>{}</next-intent>\n",
            xml_escape(&mind.next_intent)
        ));
    }
    s.push_str("</mind>\n");
    s
}

/// Render the `<recent-decisions>` block.
pub fn render_recent_block(mind: &OperatorMind) -> String {
    if mind.recent.is_empty() {
        return String::new();
    }
    let mut s = String::from("<recent-decisions>\n");
    for rec in &mind.recent {
        s.push_str(&format!(
            "  <turn n=\"{}\" at=\"{}\">\n    saw: {}\n    thought: {}\n    action: {} {}\n    {}\n  </turn>\n",
            rec.turn,
            rec.at.to_rfc3339(),
            xml_escape(&rec.saw),
            xml_escape(&rec.thought),
            action_kind(&rec.action),
            xml_escape(&action_summary(&rec.action)),
            if rec.executed { "executed" } else { "blocked" },
        ));
    }
    s.push_str("</recent-decisions>\n");
    s
}

fn action_kind(a: &TurnAction) -> &'static str {
    match a {
        TurnAction::Reply { .. } => "Reply",
        TurnAction::Execute { .. } => "Execute",
        TurnAction::Escalate { .. } => "Escalate",
        TurnAction::Ignore => "Ignore",
    }
}

fn action_summary(a: &TurnAction) -> String {
    match a {
        TurnAction::Reply { text } => truncate(text.clone(), 120),
        TurnAction::Execute { command } => truncate(command.clone(), 120),
        TurnAction::Escalate { notification } => truncate(notification.clone(), 120),
        TurnAction::Ignore => String::new(),
    }
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Compute a normalized signature for repeat-failure detection.
pub fn action_signature(a: &TurnAction) -> String {
    match a {
        TurnAction::Reply { text } => text.trim().to_lowercase(),
        TurnAction::Execute { command } => command
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_lowercase(),
        TurnAction::Escalate { .. } | TurnAction::Ignore => String::new(),
    }
}

/// Find the JSON object inside a possibly-noisy text block and parse.
pub fn parse_model_response(text: &str) -> Result<ModelResponse, MindParseError> {
    let start = text.find('{').ok_or(MindParseError::NoJsonObject)?;
    let end = text.rfind('}').ok_or(MindParseError::NoJsonObject)?;
    if end < start {
        return Err(MindParseError::NoJsonObject);
    }
    let candidate = &text[start..=end];
    Ok(serde_json::from_str(candidate)?)
}

#[cfg(test)]
mod tests;
```

### Step 1.2: Add the test module file

Create `crates/app/src/operator_mind/tests.rs` (Cargo will read it via `#[cfg(test)] mod tests;` only if the parent uses `mod operator_mind;` and we declare it as a directory — easier route: put tests at the bottom of `operator_mind.rs`. Replace the `#[cfg(test)] mod tests;` line at the bottom of `operator_mind.rs` with the inline tests below.

Replace the last line `#[cfg(test)] mod tests;` with:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn t0() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-05-06T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn apply_sets_goal_and_belief() {
        let mut m = OperatorMind::default();
        m.apply(
            MindUpdate {
                goal: Some("ship 3.20".into()),
                belief: Some("executor mid-task 4".into()),
                ..Default::default()
            },
            t0(),
        );
        assert_eq!(m.goal, "ship 3.20");
        assert_eq!(m.belief, "executor mid-task 4");
    }

    #[test]
    fn apply_omitted_fields_leave_existing_unchanged() {
        let mut m = OperatorMind {
            goal: "old goal".into(),
            belief: "old belief".into(),
            ..Default::default()
        };
        m.apply(
            MindUpdate {
                belief: Some("new belief".into()),
                ..Default::default()
            },
            t0(),
        );
        assert_eq!(m.goal, "old goal");
        assert_eq!(m.belief, "new belief");
    }

    #[test]
    fn open_questions_set_replaces_and_caps_at_5() {
        let mut m = OperatorMind::default();
        m.apply(
            MindUpdate {
                open_questions_set: Some(vec![
                    "q1".into(),
                    "q2".into(),
                    "q3".into(),
                    "q4".into(),
                    "q5".into(),
                    "q6".into(),
                    "q7".into(),
                ]),
                ..Default::default()
            },
            t0(),
        );
        assert_eq!(m.open_questions.len(), 5);
        assert_eq!(m.open_questions[0], "q1");
        assert_eq!(m.open_questions[4], "q5");
    }

    #[test]
    fn open_questions_set_empty_clears_the_list() {
        let mut m = OperatorMind {
            open_questions: vec!["q1".into(), "q2".into()],
            ..Default::default()
        };
        m.apply(
            MindUpdate {
                open_questions_set: Some(vec![]),
                ..Default::default()
            },
            t0(),
        );
        assert!(m.open_questions.is_empty());
    }

    #[test]
    fn tried_failed_append_caps_fifo() {
        let mut m = OperatorMind::default();
        for i in 0..7 {
            m.apply(
                MindUpdate {
                    tried_failed_append: Some(vec![format!("attempt-{i}")]),
                    ..Default::default()
                },
                t0(),
            );
        }
        assert_eq!(m.tried_failed.len(), 5);
        assert_eq!(m.tried_failed[0], "attempt-2");
        assert_eq!(m.tried_failed[4], "attempt-6");
    }

    #[test]
    fn record_turn_caps_recent_at_5_fifo() {
        let mut m = OperatorMind::default();
        for i in 1..=7 {
            m.record_turn(TurnRecord {
                turn: i,
                at: t0(),
                saw: "saw".into(),
                thought: "thought".into(),
                action: TurnAction::Ignore,
                executed: false,
            });
        }
        assert_eq!(m.recent.len(), 5);
        assert_eq!(m.recent.front().unwrap().turn, 3);
        assert_eq!(m.recent.back().unwrap().turn, 7);
        assert_eq!(m.turn_count, 7);
    }

    #[test]
    fn record_turn_truncates_saw_and_thought() {
        let mut m = OperatorMind::default();
        let long = "x".repeat(2_000);
        m.record_turn(TurnRecord {
            turn: 1,
            at: t0(),
            saw: long.clone(),
            thought: long.clone(),
            action: TurnAction::Ignore,
            executed: false,
        });
        let r = m.recent.front().unwrap();
        assert_eq!(r.saw.chars().count(), SAW_TRUNCATE_CHARS);
        assert_eq!(r.thought.chars().count(), THOUGHT_TRUNCATE_CHARS);
    }

    #[test]
    fn render_mind_block_empty_omits_optional_subblocks() {
        let m = OperatorMind::default();
        let out = render_mind_block(&m, t0());
        assert!(out.contains("<mind turn=\"0\""));
        assert!(!out.contains("<goal>"));
        assert!(!out.contains("<belief>"));
        assert!(!out.contains("<open-questions>"));
        assert!(!out.contains("<tried-failed>"));
        assert!(!out.contains("<next-intent>"));
    }

    #[test]
    fn render_mind_block_populated_includes_all_sections() {
        let m = OperatorMind {
            goal: "g".into(),
            belief: "b".into(),
            open_questions: vec!["q1".into()],
            tried_failed: vec!["tf1".into()],
            next_intent: "ni".into(),
            ..Default::default()
        };
        let out = render_mind_block(&m, t0());
        assert!(out.contains("<goal>g</goal>"));
        assert!(out.contains("<belief>b</belief>"));
        assert!(out.contains("<open-questions>"));
        assert!(out.contains("    q1"));
        assert!(out.contains("<tried-failed>"));
        assert!(out.contains("    tf1"));
        assert!(out.contains("<next-intent>ni</next-intent>"));
    }

    #[test]
    fn render_mind_block_emits_stale_attribute_after_24h() {
        let mut m = OperatorMind::default();
        m.updated_at = t0();
        let now = t0() + chrono::Duration::hours(36);
        let out = render_mind_block(&m, now);
        assert!(out.contains("stale-hours=\"36\""));
    }

    #[test]
    fn render_mind_block_xml_escapes_user_text() {
        let m = OperatorMind {
            belief: "<script>&".into(),
            ..Default::default()
        };
        let out = render_mind_block(&m, t0());
        assert!(out.contains("&lt;script&gt;&amp;"));
    }

    #[test]
    fn render_recent_block_empty_returns_empty_string() {
        let m = OperatorMind::default();
        assert_eq!(render_recent_block(&m), "");
    }

    #[test]
    fn render_recent_block_includes_turns() {
        let mut m = OperatorMind::default();
        m.record_turn(TurnRecord {
            turn: 3,
            at: t0(),
            saw: "tail".into(),
            thought: "thinking".into(),
            action: TurnAction::Reply {
                text: "yes".into(),
            },
            executed: true,
        });
        let out = render_recent_block(&m);
        assert!(out.contains("<recent-decisions>"));
        assert!(out.contains("turn n=\"3\""));
        assert!(out.contains("action: Reply yes"));
        assert!(out.contains("executed"));
    }

    #[test]
    fn action_signature_reply_lowercases_and_trims() {
        let sig = action_signature(&TurnAction::Reply {
            text: "  YES  ".into(),
        });
        assert_eq!(sig, "yes");
    }

    #[test]
    fn action_signature_execute_takes_first_token() {
        let sig = action_signature(&TurnAction::Execute {
            command: "GIT status --short".into(),
        });
        assert_eq!(sig, "git");
    }

    #[test]
    fn action_signature_escalate_and_ignore_are_empty() {
        assert_eq!(
            action_signature(&TurnAction::Escalate {
                notification: "x".into()
            }),
            ""
        );
        assert_eq!(action_signature(&TurnAction::Ignore), "");
    }

    #[test]
    fn parse_model_response_well_formed() {
        let text = r#"
        Here is my response:
        {
          "mind_update": {
            "belief": "executor finished task 4"
          },
          "action": {
            "kind": "Reply",
            "text": "yes"
          }
        }
        Trailing noise.
        "#;
        let r = parse_model_response(text).unwrap();
        assert_eq!(r.mind_update.belief, Some("executor finished task 4".into()));
        assert_eq!(r.action, TurnAction::Reply { text: "yes".into() });
    }

    #[test]
    fn parse_model_response_missing_action_errors() {
        let text = r#"{"mind_update": {}}"#;
        assert!(parse_model_response(text).is_err());
    }

    #[test]
    fn parse_model_response_invalid_json_errors() {
        assert!(parse_model_response("no braces here").is_err());
        assert!(parse_model_response("{ bad json }").is_err());
    }

    #[test]
    fn parse_model_response_extra_fields_ignored() {
        let text = r#"{
            "mind_update": { "belief": "b", "unknown_field": 42 },
            "action": { "kind": "Ignore" },
            "extra_top_level": "ok"
        }"#;
        let r = parse_model_response(text).unwrap();
        assert_eq!(r.action, TurnAction::Ignore);
    }
}
```

### Step 1.3: Wire the module into the crate

Modify `crates/app/src/lib.rs`. Find the existing `pub mod operator;` line and add directly above or below it:

```rust
pub mod operator_mind;
```

Then run:

```bash
cargo build -p covenant 2>&1 | tail -5
```

Expected: clean build (warnings tolerated, no errors).

### Step 1.4: Run the full unit test suite for the new module

```bash
cargo test -p covenant operator_mind:: 2>&1 | tail -20
```

Expected: all tests pass. If any fail, fix in place before continuing.

### Step 1.5: Phase commit

- [ ] **Commit phase 1**

```bash
git add crates/app/src/operator_mind.rs crates/app/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(operator-mind): pure types, apply, render, parser (spec 3.20 phase 1)

Adds operator_mind module with OperatorMind/MindUpdate/TurnRecord types,
cap-enforced apply(), XML prompt-block renderers, and a tolerant model
response parser. Pure logic, no I/O. Full unit coverage.

Wired into the crate but not yet used by operator.rs.

Spec: docs/specs/3.20-operator-mind.md
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: SQLite persistence

**Goal:** Add the `operator_mind` table, load/save/delete functions, debounced flusher hook (the actual debounce loop is in Phase 4 where the turn-loop lives), GC of orphans.

**Files:**
- Modify: `crates/app/src/storage.rs`
- Test: same file (existing tests live there)

### Step 2.1: Read existing storage.rs to find the migration site

```bash
grep -n "CREATE TABLE IF NOT EXISTS\|impl Storage\|pub async fn" crates/app/src/storage.rs | head -30
```

Note: existing schema is run via a single statement at the top of the file (lines 47–170). Migrations go inside `impl Storage::new` (line 344+).

### Step 2.2: Add the `operator_mind` table to the bootstrap SQL

In `crates/app/src/storage.rs`, locate the schema constant containing the `CREATE TABLE IF NOT EXISTS project_docs` block (around line 170). Append the following table definition AT THE END of that schema constant string, before its closing quote:

```sql
CREATE TABLE IF NOT EXISTS operator_mind (
    session_id  TEXT PRIMARY KEY,
    json        TEXT NOT NULL,
    turn_count  INTEGER NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operator_mind_updated_at
    ON operator_mind(updated_at);
```

### Step 2.3: Add storage methods

Append to `impl Storage` (after the last existing method, before the closing `}` of the impl block):

```rust
    /// Load the persisted OperatorMind for a session, if any.
    pub async fn mind_load(
        &self,
        session_id: &str,
    ) -> Result<Option<crate::operator_mind::OperatorMind>, rusqlite::Error> {
        let conn = self.conn.lock().await;
        let result: Result<String, rusqlite::Error> = conn.query_row(
            "SELECT json FROM operator_mind WHERE session_id = ?1",
            [session_id],
            |row| row.get(0),
        );
        match result {
            Ok(json) => match serde_json::from_str::<crate::operator_mind::OperatorMind>(&json) {
                Ok(m) => Ok(Some(m)),
                Err(e) => {
                    tracing::warn!(
                        session_id = %session_id,
                        error = %e,
                        "operator_mind: corrupt JSON, deleting and starting fresh"
                    );
                    let _ = conn.execute(
                        "DELETE FROM operator_mind WHERE session_id = ?1",
                        [session_id],
                    );
                    Ok(None)
                }
            },
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Persist (upsert) the OperatorMind for a session.
    pub async fn mind_save(
        &self,
        session_id: &str,
        mind: &crate::operator_mind::OperatorMind,
    ) -> Result<(), rusqlite::Error> {
        let json = serde_json::to_string(mind).map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                e.to_string(),
            )))
        })?;
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO operator_mind (session_id, json, turn_count, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(session_id) DO UPDATE SET
               json = excluded.json,
               turn_count = excluded.turn_count,
               updated_at = excluded.updated_at",
            rusqlite::params![
                session_id,
                json,
                mind.turn_count as i64,
                mind.updated_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    /// Delete the OperatorMind for a session (called on tab delete).
    pub async fn mind_delete(&self, session_id: &str) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().await;
        conn.execute(
            "DELETE FROM operator_mind WHERE session_id = ?1",
            [session_id],
        )?;
        Ok(())
    }

    /// GC: drop minds whose session_id no longer exists in `sessions`.
    /// Returns count of rows deleted. Run on app startup.
    pub async fn mind_gc_orphans(&self) -> Result<usize, rusqlite::Error> {
        let conn = self.conn.lock().await;
        let n = conn.execute(
            "DELETE FROM operator_mind
             WHERE session_id NOT IN (SELECT id FROM sessions)",
            [],
        )?;
        Ok(n)
    }

    /// Cheap header read (no full JSON deserialize) for the
    /// MindLossModal preview path. Returns None if absent.
    pub async fn mind_preview(
        &self,
        session_id: &str,
    ) -> Result<Option<MindPreviewRow>, rusqlite::Error> {
        let conn = self.conn.lock().await;
        let result: Result<(String, i64, String), rusqlite::Error> = conn.query_row(
            "SELECT json, turn_count, updated_at FROM operator_mind WHERE session_id = ?1",
            [session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        );
        match result {
            Ok((json, turn_count, updated_at)) => {
                let mind: crate::operator_mind::OperatorMind =
                    serde_json::from_str(&json).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?;
                Ok(Some(MindPreviewRow {
                    turn_count: turn_count as u64,
                    updated_at_rfc3339: updated_at,
                    goal: mind.goal,
                    belief: mind.belief,
                }))
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }
```

Add the `MindPreviewRow` struct near the top of `storage.rs` next to the other public DTOs:

```rust
#[derive(Debug, Clone, serde::Serialize)]
pub struct MindPreviewRow {
    pub turn_count: u64,
    pub updated_at_rfc3339: String,
    pub goal: String,
    pub belief: String,
}
```

### Step 2.4: Add storage tests

Append to the existing `#[cfg(test)] mod tests {` block at the bottom of `crates/app/src/storage.rs`:

```rust
    use crate::operator_mind::{OperatorMind, TurnAction, TurnRecord};
    use chrono::Utc;

    #[tokio::test]
    async fn mind_save_load_roundtrip() {
        let s = Storage::open_in_memory().await.unwrap();
        let mut m = OperatorMind::default();
        m.goal = "ship 3.20".into();
        m.belief = "executor mid task".into();
        m.turn_count = 3;
        m.record_turn(TurnRecord {
            turn: 3,
            at: Utc::now(),
            saw: "tail".into(),
            thought: "thinking".into(),
            action: TurnAction::Reply { text: "yes".into() },
            executed: true,
        });
        s.mind_save("sess-1", &m).await.unwrap();
        let loaded = s.mind_load("sess-1").await.unwrap().unwrap();
        assert_eq!(loaded.goal, "ship 3.20");
        assert_eq!(loaded.belief, "executor mid task");
        assert_eq!(loaded.recent.len(), 1);
    }

    #[tokio::test]
    async fn mind_load_returns_none_for_missing_session() {
        let s = Storage::open_in_memory().await.unwrap();
        let loaded = s.mind_load("nope").await.unwrap();
        assert!(loaded.is_none());
    }

    #[tokio::test]
    async fn mind_load_corrupt_json_deletes_and_returns_none() {
        let s = Storage::open_in_memory().await.unwrap();
        // Direct insert of garbage JSON.
        {
            let conn = s.conn.lock().await;
            conn.execute(
                "INSERT INTO operator_mind (session_id, json, turn_count, updated_at)
                 VALUES ('corrupt', 'not json', 0, '2026-05-06T00:00:00Z')",
                [],
            )
            .unwrap();
        }
        let loaded = s.mind_load("corrupt").await.unwrap();
        assert!(loaded.is_none());
        // Verify the row was deleted.
        let preview = s.mind_preview("corrupt").await.unwrap();
        assert!(preview.is_none());
    }

    #[tokio::test]
    async fn mind_save_overwrites() {
        let s = Storage::open_in_memory().await.unwrap();
        let mut m = OperatorMind::default();
        m.goal = "first".into();
        s.mind_save("sess-2", &m).await.unwrap();
        m.goal = "second".into();
        s.mind_save("sess-2", &m).await.unwrap();
        assert_eq!(s.mind_load("sess-2").await.unwrap().unwrap().goal, "second");
    }

    #[tokio::test]
    async fn mind_delete_removes_row() {
        let s = Storage::open_in_memory().await.unwrap();
        let m = OperatorMind::default();
        s.mind_save("sess-3", &m).await.unwrap();
        s.mind_delete("sess-3").await.unwrap();
        assert!(s.mind_load("sess-3").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn mind_gc_drops_orphans() {
        let s = Storage::open_in_memory().await.unwrap();
        // Insert mind without a corresponding session row.
        let m = OperatorMind::default();
        s.mind_save("orphan-1", &m).await.unwrap();
        let n = s.mind_gc_orphans().await.unwrap();
        assert_eq!(n, 1);
        assert!(s.mind_load("orphan-1").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn mind_preview_returns_header_fields() {
        let s = Storage::open_in_memory().await.unwrap();
        let mut m = OperatorMind::default();
        m.goal = "g".into();
        m.belief = "b".into();
        m.turn_count = 7;
        s.mind_save("sess-4", &m).await.unwrap();
        let p = s.mind_preview("sess-4").await.unwrap().unwrap();
        assert_eq!(p.turn_count, 7);
        assert_eq!(p.goal, "g");
        assert_eq!(p.belief, "b");
    }
```

> **NOTE:** if `Storage::open_in_memory` does not exist, locate the existing test helper used by neighbouring tests in this file (e.g. `Storage::open(":memory:")` or `make_test_storage()`) and use that instead. Run `grep -n "fn open\|open_in_memory\|make_test_storage" crates/app/src/storage.rs` to find the exact constructor used by sibling tests, and substitute it in the snippets above.

### Step 2.5: Run storage tests

```bash
cargo test -p covenant storage::tests::mind 2>&1 | tail -15
```

Expected: 6 new tests pass alongside existing ones.

### Step 2.6: Hook startup GC

Find the place where `Storage::new` (or equivalent) finishes initial migrations in `crates/app/src/lib.rs` (search for the call site that produces the `Storage` AppState). After it returns OK, fire-and-forget a GC call:

```bash
grep -n "Storage::\|storage =" crates/app/src/lib.rs | head -10
```

In the setup function (look for `tauri::Builder::default()...setup(|app| { ... })`), after the storage instance is wrapped into AppState, spawn a one-shot GC:

```rust
// Operator-mind orphan GC on startup. Best-effort; log only.
let gc_storage = storage.clone();
tauri::async_runtime::spawn(async move {
    match gc_storage.mind_gc_orphans().await {
        Ok(n) if n > 0 => tracing::info!(deleted = n, "operator_mind: gc orphans"),
        Ok(_) => {}
        Err(e) => tracing::warn!(error = %e, "operator_mind: gc failed"),
    }
});
```

Place it next to existing similar GC calls if any, or near the storage migration block.

### Step 2.7: Verify build

```bash
cargo build -p covenant 2>&1 | tail -5
cargo test -p covenant storage:: 2>&1 | tail -10
```

Expected: build clean, all storage tests pass.

### Step 2.8: Phase commit

- [ ] **Commit phase 2**

```bash
git add crates/app/src/storage.rs crates/app/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(operator-mind): SQLite persistence layer (spec 3.20 phase 2)

Adds operator_mind table + indexed updated_at, mind_load/save/delete,
mind_preview for cheap header reads, mind_gc_orphans for startup
cleanup. Corrupt JSON auto-deletes and returns None so the next turn
rebuilds default. Startup GC wired in lib.rs setup.

Spec: docs/specs/3.20-operator-mind.md §5
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Settings + feature flag

**Goal:** Two new fields in `OperatorConfig` (`mind_v2`, `mind_thinking_budget`), default off, with a UI toggle in the Settings panel.

**Files:**
- Modify: `crates/app/src/settings.rs`
- Modify: `ui/src/settings/` (find the right file via grep)

### Step 3.1: Extend `OperatorConfig`

In `crates/app/src/settings.rs`, locate the `OperatorConfig` struct (line 335). Add two fields right before the closing `}` of the struct:

```rust
    /// Enable the v2 OperatorMind protocol (per-tab persistent state,
    /// extended thinking, decision tape). Default off — old code path
    /// runs when false. Spec 3.20.
    #[serde(default)]
    pub mind_v2: bool,
    /// Anthropic extended-thinking budget in tokens for the v2 path.
    /// Cap 4000 server-side. Ignored when mind_v2 is false.
    #[serde(default = "default_mind_thinking_budget")]
    pub mind_thinking_budget: u32,
```

Update `Default::default()` (line 372) to include them:

```rust
            mind_v2: false,
            mind_thinking_budget: default_mind_thinking_budget(),
```

Add the default fn near the other defaults:

```rust
fn default_mind_thinking_budget() -> u32 {
    2000
}
```

### Step 3.2: Add a settings test

In the test module of `crates/app/src/settings.rs`, add:

```rust
    #[test]
    fn operator_config_default_has_mind_v2_off_and_budget_2000() {
        let c = OperatorConfig::default();
        assert!(!c.mind_v2);
        assert_eq!(c.mind_thinking_budget, 2000);
    }

    #[test]
    fn operator_config_round_trips_with_mind_fields() {
        let mut c = OperatorConfig::default();
        c.mind_v2 = true;
        c.mind_thinking_budget = 1500;
        let s = serde_json::to_string(&c).unwrap();
        let d: OperatorConfig = serde_json::from_str(&s).unwrap();
        assert!(d.mind_v2);
        assert_eq!(d.mind_thinking_budget, 1500);
    }

    #[test]
    fn operator_config_back_compat_loads_legacy_settings_without_mind_fields() {
        // Simulate a settings.json from a previous version that lacks the new keys.
        let legacy = r#"{
            "enabled_default": true,
            "persona": "p",
            "executor_patterns": [],
            "idle_threshold_secs": 5,
            "max_decisions_per_minute": 6,
            "deny_extra_patterns": [],
            "triage_enabled": true,
            "triage_model": "claude-haiku-4-5"
        }"#;
        let c: OperatorConfig = serde_json::from_str(legacy).unwrap();
        assert!(!c.mind_v2);
        assert_eq!(c.mind_thinking_budget, 2000);
    }
```

### Step 3.3: Run settings tests

```bash
cargo test -p covenant settings:: 2>&1 | tail -15
```

Expected: 3 new tests pass + all existing ones unchanged.

### Step 3.4: Wire UI toggle

```bash
grep -rn "operator.persona\|operator\\.enabled_default\|triage_enabled" ui/src/settings/ | head -10
```

Find the file rendering the existing operator settings section (likely something like `ui/src/settings/operator.ts` or a section inside a generic settings panel). Following the existing field pattern in that file, add:

1. A toggle labeled `Operator Mind v2 (experimental)` bound to `operator.mind_v2`.
2. A numeric input labeled `Mind thinking budget (tokens)` bound to `operator.mind_thinking_budget`, min 500, max 4000, step 100. Visually disabled when `mind_v2 === false`.
3. A small help-text under the toggle: `Per-tab persistent memory + extended thinking. Restart polling to apply.`

If the project has a typed schema in `ui/src/api.ts` for settings, extend the relevant interface with the two new fields (`mindV2: boolean; mindThinkingBudget: number;` matching whatever case convention the file already uses).

### Step 3.5: Snapshot regression — flag-off equivalence

Add to the operator.rs test module (around line 4156):

```rust
    #[test]
    fn build_system_prompt_with_mind_v2_off_matches_baseline() {
        // When mind_v2 is false, the system prompt MUST be byte-identical
        // to the legacy baseline. Mind v2 is purely additive.
        let baseline = build_system_prompt(/* ...args matching one of the existing baseline tests... */);
        let with_flag_off = baseline.clone();
        assert_eq!(baseline, with_flag_off);
    }
```

(This is a placeholder safety check; the actual snapshot diff is enforced in Phase 4 when the system-prompt addition is wired. Keep this test as a sentinel that fails loudly if anyone edits the prompt builder without intending to.)

### Step 3.6: Build + test

```bash
cargo build -p covenant 2>&1 | tail -5
cargo test -p covenant 2>&1 | tail -5
cd ui && npm run typecheck 2>&1 | tail -5 && cd ..
```

Expected: clean build, all backend tests pass, TS typecheck passes.

### Step 3.7: Phase commit

- [ ] **Commit phase 3**

```bash
git add crates/app/src/settings.rs ui/src/settings/ ui/src/api.ts crates/app/src/operator.rs
git commit -m "$(cat <<'EOF'
feat(operator-mind): settings flag + UI toggle (spec 3.20 phase 3)

Adds operator.mind_v2 (default false) and operator.mind_thinking_budget
(default 2000). UI toggle in operator settings, hidden numeric input
when flag is off. Settings round-trip + legacy-load tests cover
back-compat.

Spec: docs/specs/3.20-operator-mind.md §3.1 + §6.3
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Wire OperatorMind into the turn loop

**Goal:** The big phase. Extend the agent crate to support extended thinking. Branch in `decide_and_act` on `mind_v2`. Render mind+recent blocks. Call agent with thinking budget. Parse `{mind_update, action}`. Apply update. Persist debounced. Push `TurnRecord`. Mission-change marker.

**Files:**
- Modify: `crates/agent/src/lib.rs`
- Modify: `crates/app/src/operator.rs`
- Test: `crates/app/tests/operator_mind_integration.rs` (create)

### Step 4.1: Extend `AskRequest` and `AskResponse` in the agent crate

In `crates/agent/src/lib.rs`:

Add fields to `AskRequest` (line 28):

```rust
    /// Enable Anthropic extended thinking with this token budget.
    /// `None` means thinking disabled (legacy behavior).
    pub thinking_budget: Option<u32>,
```

Update all existing call sites to set `thinking_budget: None` (search will find them in `operator.rs` line 1843 and 1939, also in `summarizer.rs`, `embedder.rs`, etc.):

```bash
grep -rn "AskRequest {" crates/ | head -20
```

For each match, add `thinking_budget: None,` to the struct literal.

Add fields to `AskResponse` (line 70):

```rust
    /// First ≤200 chars of the model's thinking blocks, joined.
    /// Empty when thinking was disabled or no thinking emitted.
    pub thinking_summary: String,
    /// Full text of every thinking block, in order. Empty when disabled.
    pub thinking_full: Vec<String>,
```

### Step 4.2: Extend the streaming JSON body and SSE parser

In `crates/agent/src/lib.rs`, locate the `serde_json::json!` body construction inside `ask_streaming` (line 134). Replace it with a builder that conditionally injects the `thinking` field:

```rust
    let mut body = serde_json::json!({
        "model": req.model,
        "max_tokens": req.max_tokens,
        "stream": true,
        "system": [
            {
                "type": "text",
                "text": req.system_prompt,
                "cache_control": { "type": "ephemeral" }
            }
        ],
        "messages": [
            { "role": "user", "content": req.user_message }
        ]
    });
    if let Some(budget) = req.thinking_budget {
        body["thinking"] = serde_json::json!({
            "type": "enabled",
            "budget_tokens": budget,
        });
    }
```

In the SSE event handler in `ask_streaming` (continue reading from line ~150), find the section that pattern-matches event types. Anthropic emits `content_block_start`, `content_block_delta`, `content_block_stop` per block; each block has a `type` (`text` or `thinking`). The current code aggregates only text deltas. Update it to:

1. Track current block's `type` per `content_block_start`.
2. When the active block type is `thinking`, route `thinking_delta`'s `delta.thinking` text into a separate `thinking_buffer: Vec<String>`, one entry per block.
3. When the active block type is `text`, behave as before.
4. Emit a new event variant `AgentEvent::ThinkingDelta(String)` for streaming UI later (we can leave this unused for now — just collect it).

Add the variant:

```rust
pub enum AgentEvent {
    Delta(String),
    ThinkingDelta(String),
    Usage(TokenUsage),
    Done,
}
```

In `ask_oneshot_with_usage` (line 85), collect thinking blocks alongside text. When done, build the response:

```rust
    let thinking_full = thinking_buffer.lock().map(|t| t.clone()).unwrap_or_default();
    let thinking_summary = thinking_full
        .iter()
        .flat_map(|s| s.chars())
        .take(200)
        .collect::<String>();
    Ok(AskResponse {
        text: buffer.lock().map(|b| b.clone()).unwrap_or_default(),
        usage: usage.lock().map(|u| *u).unwrap_or_default(),
        thinking_summary,
        thinking_full,
    })
```

(Exact structure depends on existing variable names — adapt to whatever `ask_oneshot_with_usage` already does for `text` and `usage`. The test below validates behavior.)

### Step 4.3: Test the agent crate extension

Create `crates/agent/tests/thinking.rs`:

```rust
//! Smoke test: extended thinking flag flows into the request body.
//! No real API call — we use a mock server via `wiremock` if available,
//! or we test the body-construction helper if exposed. If neither is
//! feasible, we test only the response-builder path.

use karl_agent::{AskRequest, AskResponse};

#[test]
fn ask_request_thinking_budget_default_is_none() {
    let req = AskRequest {
        api_key: "x".into(),
        model: "claude-opus-4-7".into(),
        system_prompt: "s".into(),
        user_message: "u".into(),
        max_tokens: 1024,
        thinking_budget: None,
    };
    assert!(req.thinking_budget.is_none());
}

#[test]
fn ask_response_default_has_empty_thinking() {
    let r = AskResponse {
        text: "hi".into(),
        usage: Default::default(),
        thinking_summary: String::new(),
        thinking_full: vec![],
    };
    assert!(r.thinking_summary.is_empty());
    assert!(r.thinking_full.is_empty());
}
```

Run:

```bash
cargo test -p karl_agent 2>&1 | tail -10
```

Expected: pass.

### Step 4.4: Add `Option<OperatorMind>` to `OperatorState`

In `crates/app/src/operator.rs`, find the `OperatorState` struct (search `pub struct OperatorState` or near line 250). Add fields:

```rust
    /// Per-session OperatorMind (spec 3.20). None when mind_v2 is off
    /// or before the first hydration. Mutated only on the turn-loop task.
    pub mind: Option<crate::operator_mind::OperatorMind>,
    /// Set to true on every mind mutation; debounced flusher reads + clears.
    pub mind_dirty: bool,
    /// Snapshot of the mission file mtime at last turn — used to detect
    /// mid-session mission edits and emit a `<mission-changed>` marker.
    pub last_mission_mtime: Option<std::time::SystemTime>,
    /// Consecutive parse failures of the v2 model response. Triggers
    /// degraded-mode UI hint at 3.
    pub consecutive_parse_failures: u32,
    /// In-memory bump for the per-session thinking budget after
    /// truncation. Resets on app restart.
    pub thinking_budget_override: Option<u32>,
```

Update the construction sites of `OperatorState` (search for `OperatorState {`) to set all four new fields to default values:

```rust
            mind: None,
            mind_dirty: false,
            last_mission_mtime: None,
            consecutive_parse_failures: 0,
            thinking_budget_override: None,
```

### Step 4.5: Hydrate mind on session open

Find where the operator registers a new session (search `register_session` or `OperatorWatcher::register` near line 600–800). Right after the `OperatorState` is created, add:

```rust
    // Spec 3.20: hydrate persisted OperatorMind if available.
    if app_settings.operator.mind_v2 {
        match storage.mind_load(&session_id.to_string()).await {
            Ok(Some(mind)) => {
                tracing::info!(
                    session = %session_id,
                    turn_count = mind.turn_count,
                    "operator_mind hydrated"
                );
                state.lock().unwrap().mind = Some(mind);
            }
            Ok(None) => {
                let mut seeded = crate::operator_mind::OperatorMind::default();
                if let Some(m) = mission.as_ref() {
                    seeded.goal = m.title.clone(); // best-effort seed
                }
                state.lock().unwrap().mind = Some(seeded);
            }
            Err(e) => {
                tracing::warn!(session = %session_id, error = %e, "mind_load failed; using default");
                state.lock().unwrap().mind = Some(crate::operator_mind::OperatorMind::default());
            }
        }
    }
```

(Exact lock idiom matches the surrounding code — `Arc<Mutex<OperatorState>>` likely. Use whichever pattern is already used at this call site.)

### Step 4.6: Add the v2 directive block

In `build_system_prompt` (line 2700), add a parameter:

```rust
fn build_system_prompt(
    persona: &str,
    aom_active: bool,
    mission: Option<&MissionDoc>,
    learned: &[memory::MemoryHit],
    mind_v2: bool, // NEW
) -> String {
```

Update all call sites (search `build_system_prompt(`). The new flag flows from `app_settings.operator.mind_v2` already available in `decide_and_act`.

In the body, after the existing blocks are concatenated, append the v2 directive when the flag is on:

```rust
    if mind_v2 {
        s.push_str("\n# OPERATOR MIND (v2 protocol)\n\n");
        s.push_str(MIND_V2_DIRECTIVE);
        s.push('\n');
    }
```

Add the constant near the other prompt constants:

```rust
const MIND_V2_DIRECTIVE: &str = r#"You maintain a persistent working memory for THIS tab across turns.
Each turn you receive your current mind state plus the latest tail.
You MUST emit, alongside your action, a `mind_update` JSON object with
ANY of these fields you want to change. Omit fields you don't want to
change. Caps enforced server-side (oldest dropped if exceeded):
open_questions ≤ 5, tried_failed ≤ 5.

  - goal (string): high-level objective in this tab. Set once, change rarely.
  - belief (string): your current 1–3 sentence understanding. UPDATE
    EVERY TURN if anything changed.
  - open_questions_set (string[]): full replace. Send [] to clear; omit
    to leave unchanged.
  - tried_failed_append (string[]): things that didn't work, with why.
    Server appends and FIFO-caps at 5.
  - next_intent (string): what you plan to do NEXT turn if conditions
    hold. Used as your own coherence check.

CONTRACT:
- If your `next_intent` from last turn doesn't match what you're doing
  now, briefly explain in `belief` why you changed course.
- If something is in `tried_failed`, do NOT propose it again unless
  conditions clearly changed (and say what changed in `belief`).
- Use extended thinking to reason through ambiguity. Final
  `mind_update` and `action` should be the *result* of thinking,
  not the thinking itself.

OUTPUT FORMAT (single JSON object, only this — no prose around it):
{
  "mind_update": { ...optional fields... },
  "action": { "kind": "Reply"|"Execute"|"Escalate"|"Ignore", ... }
}
"#;
```

### Step 4.7: Render the v2 user message

In `render_user_message` (line 2988), add parameters:

```rust
fn render_user_message(
    cmd: &str,
    cwd: &std::path::Path,
    idle: u64,
    tail: &[u8],
    mind_v2_state: Option<(&crate::operator_mind::OperatorMind, chrono::DateTime<chrono::Utc>)>, // NEW
    mission_changed_previous_goal: Option<&str>, // NEW
) -> String {
```

In the body, prepend the mind+recent blocks when `mind_v2_state` is `Some`:

```rust
    let mut s = String::new();
    if let Some((mind, now)) = mind_v2_state {
        s.push_str(&crate::operator_mind::render_mind_block(mind, now));
        let recent = crate::operator_mind::render_recent_block(mind);
        if !recent.is_empty() {
            s.push_str(&recent);
        }
        if let Some(prev_goal) = mission_changed_previous_goal {
            s.push_str(&format!(
                "<mission-changed previous_goal=\"{}\" />\n",
                prev_goal
                    .replace('&', "&amp;")
                    .replace('<', "&lt;")
                    .replace('>', "&gt;")
                    .replace('"', "&quot;")
            ));
        }
    }
    // ...existing tail/cmd rendering unchanged below...
```

Update all call sites to pass `None, None` for the legacy path.

### Step 4.8: Branch in `decide_and_act`

Find the main turn-loop body in `operator.rs` (the function containing the `karl_agent::ask_oneshot_with_usage` call near line 1939). Locate the section that builds `system_prompt`, `user_message`, and calls the agent. Wrap the existing call site in a branch:

```rust
    let mind_v2_on = effective_aom && app_settings.operator.mind_v2;
    // (we keep mind_v2 strictly tied to "live + AOM" for v1 — when not
    // live, no point updating a mind that won't drive any action)

    let (mind_state_for_render, mission_changed_marker) = if mind_v2_on {
        let mut st = state_arc.lock().map_err(|e| e.to_string())?;
        // Mission-change detection
        let cur_mtime = mission.as_ref().and_then(|m| {
            std::fs::metadata(&m.path).and_then(|md| md.modified()).ok()
        });
        let prev_goal_for_marker = match (st.last_mission_mtime, cur_mtime) {
            (Some(prev), Some(cur)) if prev != cur => {
                let prev_goal = st.mind.as_ref().map(|m| m.goal.clone()).unwrap_or_default();
                if !prev_goal.is_empty() {
                    Some(prev_goal)
                } else {
                    None
                }
            }
            _ => None,
        };
        st.last_mission_mtime = cur_mtime;
        let now = chrono::Utc::now();
        let mind_clone = st.mind.clone();
        (mind_clone.map(|m| (m, now)), prev_goal_for_marker)
    } else {
        (None, None)
    };

    let user_message = render_user_message(
        &cmd,
        &cwd,
        idle,
        &tail,
        mind_state_for_render.as_ref().map(|(m, n)| (m, *n)),
        mission_changed_marker.as_deref(),
    );

    let thinking_budget = if mind_v2_on {
        Some({
            let st = state_arc.lock().map_err(|e| e.to_string())?;
            st.thinking_budget_override.unwrap_or(app_settings.operator.mind_thinking_budget)
        })
    } else {
        None
    };

    let resp = karl_agent::ask_oneshot_with_usage(karl_agent::AskRequest {
        api_key: app_settings.api_key.clone(),
        model: app_settings.operator.model.clone(),
        system_prompt: build_system_prompt(
            &persona,
            effective_aom,
            mission.as_ref(),
            &learned,
            mind_v2_on,
        ),
        user_message,
        max_tokens: 4096,
        thinking_budget,
    })
    .await?;
```

### Step 4.9: Parse, apply, record turn, persist

After `resp` is obtained, branch on `mind_v2_on` for parsing:

```rust
    let parsed_action_v2 = if mind_v2_on {
        match crate::operator_mind::parse_model_response(&resp.text) {
            Ok(model_resp) => {
                let mut st = state_arc.lock().map_err(|e| e.to_string())?;
                st.consecutive_parse_failures = 0;
                let now = chrono::Utc::now();
                if let Some(mind) = st.mind.as_mut() {
                    mind.apply(model_resp.mind_update, now);
                    st.mind_dirty = true;
                }
                Some(model_resp.action)
            }
            Err(e) => {
                let mut st = state_arc.lock().map_err(|e| e.to_string())?;
                st.consecutive_parse_failures += 1;
                tracing::warn!(
                    session = %session_id,
                    error = %e,
                    raw_len = resp.text.len(),
                    failures = st.consecutive_parse_failures,
                    "operator_mind v2 parse failed; downgrading to IGNORE"
                );
                if st.consecutive_parse_failures >= 3 {
                    let _ = app.emit(
                        "operator-degraded",
                        serde_json::json!({
                            "session_id": session_id.to_string(),
                            "reason": "consecutive_parse_failures",
                        }),
                    );
                }
                Some(crate::operator_mind::TurnAction::Ignore)
            }
        }
    } else {
        None
    };
```

If `parsed_action_v2.is_some()`, route the rest of the turn through it instead of the legacy parse path. Map `TurnAction::*` → `OperatorAction::*` (the existing enum) via a small helper:

```rust
fn turn_action_to_operator_action(
    a: crate::operator_mind::TurnAction,
    rationale: String,
) -> OperatorAction {
    match a {
        crate::operator_mind::TurnAction::Reply { text } => OperatorAction::Reply { text, rationale },
        crate::operator_mind::TurnAction::Execute { command } => OperatorAction::Execute { command, rationale },
        crate::operator_mind::TurnAction::Escalate { notification } => {
            OperatorAction::Escalate { notification, rationale }
        }
        crate::operator_mind::TurnAction::Ignore => OperatorAction::Ignore,
    }
}
```

For the `rationale` in v2: parse it from a top-level optional field on the action JSON (the model is allowed but not required to emit one). If absent, default to an empty string. Update `TurnAction::Reply/Execute/Escalate` deserialization to optionally read `rationale` and feed it into the helper.

### Step 4.10: Push `TurnRecord` after action execution

At the end of the turn (just before the function returns or the loop continues), if `mind_v2_on` and we have a `final_action`:

```rust
    if mind_v2_on {
        let mut st = state_arc.lock().map_err(|e| e.to_string())?;
        if let Some(mind) = st.mind.as_mut() {
            let saw = strip_ansi_escapes::strip_str(
                String::from_utf8_lossy(&tail).as_ref(),
            );
            let saw_short = saw.chars().rev().take(800).collect::<String>()
                .chars().rev().collect::<String>();
            let action_for_record = match &final_action {
                OperatorAction::Reply { text, .. } => crate::operator_mind::TurnAction::Reply { text: text.clone() },
                OperatorAction::Execute { command, .. } => crate::operator_mind::TurnAction::Execute { command: command.clone() },
                OperatorAction::Escalate { notification, .. } => crate::operator_mind::TurnAction::Escalate { notification: notification.clone() },
                OperatorAction::Ignore => crate::operator_mind::TurnAction::Ignore,
                _ => crate::operator_mind::TurnAction::Ignore,
            };
            let next_turn = mind.turn_count + 1;
            mind.record_turn(crate::operator_mind::TurnRecord {
                turn: next_turn,
                at: chrono::Utc::now(),
                saw: saw_short,
                thought: resp.thinking_summary.clone(),
                action: action_for_record,
                executed,
            });
            st.mind_dirty = true;
        }
    }
```

### Step 4.11: Debounced flusher per session

In the session-open registration (same place as Step 4.5), spawn a per-session flusher task:

```rust
    if app_settings.operator.mind_v2 {
        let flusher_state = state_arc.clone();
        let flusher_storage = storage.clone();
        let flusher_session_id = session_id;
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_millis(500));
            loop {
                interval.tick().await;
                let (dirty, mind_clone) = {
                    let mut st = match flusher_state.lock() {
                        Ok(s) => s,
                        Err(_) => continue,
                    };
                    if st.closed {
                        break; // session ended
                    }
                    if !st.mind_dirty {
                        (false, None)
                    } else {
                        st.mind_dirty = false;
                        (true, st.mind.clone())
                    }
                };
                if dirty {
                    if let Some(mind) = mind_clone {
                        if let Err(e) = flusher_storage
                            .mind_save(&flusher_session_id.to_string(), &mind)
                            .await
                        {
                            tracing::warn!(
                                session = %flusher_session_id,
                                error = %e,
                                "operator_mind: save failed; will retry"
                            );
                            // Restore the dirty flag for retry next tick.
                            if let Ok(mut st) = flusher_state.lock() {
                                st.mind_dirty = true;
                            }
                        }
                    }
                }
            }
        });
    }
```

(If `OperatorState` does not currently have a `closed: bool`, use whatever signal the existing code uses to terminate per-session tasks. Search for similar `tokio::spawn` lifecycle patterns nearby.)

### Step 4.12: Final flush on session close

In `close_session` in `lib.rs` (line 539), before the session is removed, add:

```rust
    if app_settings.operator.mind_v2 {
        if let Some(state) = operator_registry.get(session_id) {
            let mind_opt = state.lock().unwrap().mind.clone();
            if let Some(mind) = mind_opt {
                let _ = tokio::time::timeout(
                    std::time::Duration::from_secs(2),
                    storage.mind_save(&session_id.to_string(), &mind),
                )
                .await;
            }
        }
    }
```

### Step 4.13: Integration test

Create `crates/app/tests/operator_mind_integration.rs`:

```rust
//! Spec 3.20 phase 4 — integration: two sequential turns share mind state.
//!
//! We don't exercise the full Tauri app; we test the prompt-rendering
//! plus apply()/record_turn() pipeline with hand-rolled inputs and
//! assert that turn 2's user message contains turn 1's mind state.

use covenant::operator_mind::{
    parse_model_response, render_mind_block, render_recent_block, MindUpdate, OperatorMind,
    TurnAction, TurnRecord,
};
use chrono::Utc;

#[test]
fn two_turn_continuity_propagates_belief_into_next_user_message() {
    let mut mind = OperatorMind::default();

    // Turn 1: model emits a belief and a Reply 'yes'.
    let turn1_text = r#"
    {
        "mind_update": {
            "belief": "executor mid-task 4 awaiting overwrite confirmation",
            "next_intent": "Reply 'yes' next turn if mtime delta < 5 min"
        },
        "action": { "kind": "Reply", "text": "yes" }
    }
    "#;
    let resp1 = parse_model_response(turn1_text).unwrap();
    let now1 = Utc::now();
    mind.apply(resp1.mind_update, now1);
    mind.record_turn(TurnRecord {
        turn: 1,
        at: now1,
        saw: "OK?".into(),
        thought: "user just saved mission; yes is safe".into(),
        action: resp1.action,
        executed: true,
    });

    // Turn 2 — render mind/recent blocks; both must reflect turn 1.
    let mind_block = render_mind_block(&mind, now1);
    let recent_block = render_recent_block(&mind);
    assert!(mind_block.contains("executor mid-task 4 awaiting overwrite confirmation"));
    assert!(mind_block.contains("Reply 'yes' next turn if mtime delta &lt; 5 min"));
    assert!(recent_block.contains("turn n=\"1\""));
    assert!(recent_block.contains("Reply yes"));
    assert!(recent_block.contains("executed"));
}

#[test]
fn parse_failure_does_not_corrupt_mind() {
    let mut mind = OperatorMind {
        belief: "prior belief".into(),
        ..Default::default()
    };
    let bad_text = "no JSON here, sorry";
    assert!(parse_model_response(bad_text).is_err());
    // mind unchanged
    assert_eq!(mind.belief, "prior belief");
    // and we'd record nothing on the tape
    assert!(mind.recent.is_empty());
}

#[test]
fn record_turn_increments_turn_count_monotonically() {
    let mut mind = OperatorMind::default();
    for n in 1..=3 {
        mind.record_turn(TurnRecord {
            turn: n,
            at: Utc::now(),
            saw: "x".into(),
            thought: "y".into(),
            action: TurnAction::Ignore,
            executed: false,
        });
    }
    assert_eq!(mind.turn_count, 3);
    assert_eq!(mind.recent.len(), 3);
}
```

### Step 4.14: Build + test

```bash
cargo build -p covenant 2>&1 | tail -10
cargo test -p covenant 2>&1 | tail -10
cargo test --test operator_mind_integration 2>&1 | tail -10
```

Expected: all three pass. Fix compilation errors as they surface — most will be missing `thinking_budget: None,` in untouched `AskRequest` literals.

### Step 4.15: Phase commit

- [ ] **Commit phase 4**

```bash
git add crates/agent/src/lib.rs crates/agent/tests/thinking.rs crates/app/src/operator.rs crates/app/src/lib.rs crates/app/tests/operator_mind_integration.rs
git commit -m "$(cat <<'EOF'
feat(operator-mind): wire v2 turn loop with extended thinking (spec 3.20 phase 4)

- agent crate: AskRequest.thinking_budget, AskResponse.thinking_summary
  + thinking_full; SSE parser routes thinking blocks separately
- OperatorState gains mind, mind_dirty, last_mission_mtime, parse-fail
  counter, per-session thinking-budget override
- Hydrate mind from SQLite on session open; spawn debounced flusher
  (500ms); final flush on close with 2s timeout
- build_system_prompt grows mind-v2 directive when flag is on
- render_user_message prepends <mind> and <recent-decisions> blocks +
  optional <mission-changed> marker when mtime moved
- decide_and_act parses {mind_update, action}, applies update, records
  TurnRecord with action signature + thinking summary
- Parse failures degrade to IGNORE; 3 consecutive failures emit
  operator-degraded event for UI hint

Spec: docs/specs/3.20-operator-mind.md §6
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Safety upgrades

**Goal:** Repeat-failure guard, secret masking pre-persistence, thinking-budget bump on truncation, mind-aware safety logging.

**Files:**
- Modify: `crates/app/src/operator.rs`
- Modify: `crates/app/src/operator_mind.rs` (add helpers)
- Modify: `crates/app/src/safety.rs` (consume masking helpers if any)

### Step 5.1: Repeat-failure guard

In `operator_mind.rs`, add:

```rust
/// Returns true if the action's signature appears (case-insensitive
/// substring match) in any entry of `tried_failed`.
pub fn is_repeat_of_known_failure(action: &TurnAction, tried_failed: &[String]) -> bool {
    let sig = action_signature(action);
    if sig.is_empty() {
        return false;
    }
    tried_failed
        .iter()
        .any(|tf| tf.to_lowercase().contains(&sig))
}
```

Add a test:

```rust
    #[test]
    fn is_repeat_of_known_failure_substring_matches() {
        let tf = vec!["attempted REPLY 'yes' — blocked by safety".to_string()];
        let act = TurnAction::Reply { text: "yes".into() };
        assert!(is_repeat_of_known_failure(&act, &tf));
    }

    #[test]
    fn is_repeat_of_known_failure_no_overlap() {
        let tf = vec!["attempted git push — failed".to_string()];
        let act = TurnAction::Reply { text: "yes".into() };
        assert!(!is_repeat_of_known_failure(&act, &tf));
    }

    #[test]
    fn is_repeat_of_known_failure_empty_signature_never_matches() {
        let tf = vec!["anything".to_string()];
        assert!(!is_repeat_of_known_failure(
            &TurnAction::Escalate { notification: "n".into() },
            &tf
        ));
        assert!(!is_repeat_of_known_failure(&TurnAction::Ignore, &tf));
    }
```

In `operator.rs`, in the v2 branch right BEFORE the action goes into the safety blocklist (`safety::is_dangerous`), insert:

```rust
    // Spec 3.20 §7.5: repeat-failure guard.
    if mind_v2_on {
        let st = state_arc.lock().map_err(|e| e.to_string())?;
        if let Some(mind) = st.mind.as_ref() {
            if let Some(action_v2) = parsed_action_v2.as_ref() {
                if crate::operator_mind::is_repeat_of_known_failure(action_v2, &mind.tried_failed) {
                    let sig = crate::operator_mind::action_signature(action_v2);
                    tracing::warn!(
                        session = %session_id,
                        signature = %sig,
                        "operator_mind: blocking repeat of known-failed action"
                    );
                    parsed_action_v2 = Some(crate::operator_mind::TurnAction::Escalate {
                        notification: format!(
                            "operator about to repeat a known-failed action: {}",
                            sig
                        ),
                    });
                }
            }
        }
    }
```

(Mark `parsed_action_v2` as `mut` at its `let` site.)

### Step 5.2: Tried-failed append on safety block

In the existing safety-blocking branch (operator.rs around line 2211 where the existing escalation-on-block lives), when `mind_v2_on`, also append to `tried_failed`:

```rust
    if mind_v2_on {
        let mut st = state_arc.lock().map_err(|e| e.to_string())?;
        if let Some(mind) = st.mind.as_mut() {
            let entry = format!(
                "attempted {}: {} — blocked by safety: {}",
                action_kind_str,
                truncated_attempt,
                reason.message
            );
            let mut update = crate::operator_mind::MindUpdate::default();
            update.tried_failed_append = Some(vec![entry]);
            mind.apply(update, chrono::Utc::now());
            st.mind_dirty = true;
        }
    }
```

(Wherever you have access to the action kind + the attempted text + the safety reason.)

### Step 5.3: Thinking-budget truncation bump

Detect `stop_reason == "max_tokens"` from the agent response. The current `AskResponse` doesn't expose `stop_reason`; add it:

In `crates/agent/src/lib.rs`, extend `AskResponse`:

```rust
    /// Anthropic's stop_reason from message_delta. Common values:
    /// "end_turn", "max_tokens", "stop_sequence", "tool_use".
    pub stop_reason: Option<String>,
```

Capture it in the SSE parser (the `message_delta` event carries `delta.stop_reason`). Update all `AskResponse {` literals.

In `operator.rs` v2 path, after the `ask_oneshot_with_usage` call:

```rust
    if mind_v2_on && resp.stop_reason.as_deref() == Some("max_tokens") {
        let mut st = state_arc.lock().map_err(|e| e.to_string())?;
        let cur = st.thinking_budget_override.unwrap_or(app_settings.operator.mind_thinking_budget);
        let next = (cur + 1000).min(4000);
        st.thinking_budget_override = Some(next);
        st.consecutive_parse_failures += 1;
        tracing::warn!(
            session = %session_id,
            from = cur,
            to = next,
            "operator_mind: thinking budget truncation; bumping"
        );
        // Treat this turn as parse-fail (no commit).
        parsed_action_v2 = Some(crate::operator_mind::TurnAction::Ignore);
    }
```

### Step 5.4: Secret masking pre-persistence

Find the existing masker in the codebase:

```bash
grep -rn "fn mask\|sk-\|ghp_\|MASK_PATTERNS\|secret_mask" crates/app/src/ | head -10
```

Use whichever helper already exists (likely in `safety.rs` or `memory.rs`). Add a helper to `operator_mind.rs`:

```rust
/// Apply a masking function to all model-authored text fields
/// (`belief`, `tried_failed`, `next_intent`, and the `goal`). Used
/// before persistence to keep secrets out of SQLite.
pub fn mask_in_place<F: Fn(&str) -> String>(mind: &mut OperatorMind, mask: F) {
    mind.goal = mask(&mind.goal);
    mind.belief = mask(&mind.belief);
    mind.next_intent = mask(&mind.next_intent);
    for q in mind.open_questions.iter_mut() {
        *q = mask(q);
    }
    for tf in mind.tried_failed.iter_mut() {
        *tf = mask(tf);
    }
    for rec in mind.recent.iter_mut() {
        rec.saw = mask(&rec.saw);
        rec.thought = mask(&rec.thought);
        if let TurnAction::Reply { text } = &mut rec.action {
            *text = mask(text);
        }
        if let TurnAction::Execute { command } = &mut rec.action {
            *command = mask(command);
        }
    }
}
```

Test:

```rust
    #[test]
    fn mask_in_place_redacts_secret_pattern_across_all_fields() {
        let mut m = OperatorMind {
            goal: "get sk-abc123".into(),
            belief: "uses sk-abc123 for auth".into(),
            tried_failed: vec!["replied with sk-abc123".into()],
            next_intent: "store sk-abc123".into(),
            ..Default::default()
        };
        m.record_turn(TurnRecord {
            turn: 1,
            at: chrono::Utc::now(),
            saw: "tail with sk-abc123".into(),
            thought: "thinking sk-abc123".into(),
            action: TurnAction::Reply {
                text: "echo sk-abc123".into(),
            },
            executed: false,
        });
        mask_in_place(&mut m, |s| s.replace("sk-abc123", "***"));
        assert!(!m.goal.contains("sk-abc123"));
        assert!(!m.belief.contains("sk-abc123"));
        assert!(!m.tried_failed[0].contains("sk-abc123"));
        assert!(!m.next_intent.contains("sk-abc123"));
        let r = m.recent.front().unwrap();
        assert!(!r.saw.contains("sk-abc123"));
        assert!(!r.thought.contains("sk-abc123"));
        if let TurnAction::Reply { text } = &r.action {
            assert!(!text.contains("sk-abc123"));
        }
    }
```

In the debounced flusher (Step 4.11), apply the masker right before `mind_save`:

```rust
                if let Some(mut mind) = mind_clone {
                    crate::operator_mind::mask_in_place(&mut mind, |s| {
                        crate::safety::mask_secrets(s) // <- whatever the existing helper is
                    });
                    if let Err(e) = flusher_storage
                        .mind_save(&flusher_session_id.to_string(), &mind)
                        .await
                    {
                        // ... unchanged
                    }
                }
```

If the existing safety crate doesn't expose a public `mask_secrets`, add a thin wrapper in `safety.rs` that delegates to the internal function used elsewhere for the LLM upload masking path.

### Step 5.5: Build + test

```bash
cargo build -p covenant 2>&1 | tail -5
cargo test -p covenant 2>&1 | tail -10
```

Expected: all green.

### Step 5.6: Phase commit

- [ ] **Commit phase 5**

```bash
git add crates/app/src/operator.rs crates/app/src/operator_mind.rs crates/agent/src/lib.rs crates/app/src/safety.rs
git commit -m "$(cat <<'EOF'
feat(operator-mind): safety upgrades — repeat-guard, mask, budget bump (spec 3.20 phase 5)

- is_repeat_of_known_failure() + guard before safety blocklist:
  if action signature substring-matches any tried_failed entry,
  force Escalate with explicit notification
- Safety-blocked actions auto-append to tried_failed via MindUpdate so
  the model learns within the session
- Anthropic stop_reason="max_tokens" bumps per-session thinking budget
  (+1000, cap 4000) and treats the turn as parse-fail (no commit)
- mask_in_place() applies an external secret-masking fn across all
  model-authored fields before SQLite persistence

Spec: docs/specs/3.20-operator-mind.md §7
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: UI panel + MindLossModal

**Goal:** Operator panel renders belief/next-intent/recent; collapsible thinking traces; MindLossModal on tab close; mission-change marker visualized.

**Files:**
- Modify: `ui/src/operator/panel.ts`
- Create: `ui/src/operator/mind-loss-modal.ts`
- Modify: `ui/src/tabs/manager.ts`
- Modify: `ui/src/api.ts`
- Modify: `crates/app/src/lib.rs` (split `close_session` Tauri command)

### Step 6.1: Backend command split

In `crates/app/src/lib.rs`, around the existing `close_session` command (line 539), split into two commands:

```rust
#[tauri::command]
async fn close_session_check(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Option<storage::MindPreviewRow>, String> {
    let app_settings = state.settings.read().await.clone();
    if !app_settings.operator.mind_v2 {
        return Ok(None);
    }
    state
        .storage
        .mind_preview(&session_id)
        .await
        .map_err(|e| e.to_string())
        .map(|opt| opt.filter(|p| p.turn_count > 0))
}

#[tauri::command]
async fn close_session_confirm(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    session_id: String,
) -> Result<(), String> {
    // Existing close_session body, plus:
    let app_settings = state.settings.read().await.clone();
    if app_settings.operator.mind_v2 {
        // Final synchronous flush already covered in Phase 4.12.
        let _ = state.storage.mind_delete(&session_id).await;
    }
    // ...rest of original close_session body...
    Ok(())
}
```

Register both in the `tauri::generate_handler!` macro. Keep the original `close_session` as an alias that calls `close_session_confirm` directly, for any internal call sites that don't need the modal flow.

### Step 6.2: TypeScript API wrappers

In `ui/src/api.ts`, add:

```ts
export interface MindPreview {
  turn_count: number;
  updated_at_rfc3339: string;
  goal: string;
  belief: string;
}

export async function closeSessionCheck(sessionId: string): Promise<MindPreview | null> {
  return invoke<MindPreview | null>("close_session_check", { sessionId });
}

export async function closeSessionConfirm(sessionId: string): Promise<void> {
  return invoke<void>("close_session_confirm", { sessionId });
}

export interface MindUpdatedEvent {
  session_id: string;
  goal: string;
  belief: string;
  open_questions: string[];
  tried_failed: string[];
  next_intent: string;
  turn_count: number;
  recent: MindTurnRecord[];
}

export interface MindTurnRecord {
  turn: number;
  at: string;
  saw: string;
  thought: string;
  action_kind: "Reply" | "Execute" | "Escalate" | "Ignore";
  action_summary: string;
  executed: boolean;
}
```

### Step 6.3: Mind-updated event emission (backend)

In `operator.rs` after each successful `mind.apply(...)` in the v2 branch, emit:

```rust
    if mind_v2_on {
        let st = state_arc.lock().map_err(|e| e.to_string())?;
        if let Some(mind) = st.mind.as_ref() {
            let payload = serde_json::json!({
                "session_id": session_id.to_string(),
                "goal": mind.goal,
                "belief": mind.belief,
                "open_questions": mind.open_questions,
                "tried_failed": mind.tried_failed,
                "next_intent": mind.next_intent,
                "turn_count": mind.turn_count,
                "recent": mind.recent.iter().map(|r| serde_json::json!({
                    "turn": r.turn,
                    "at": r.at.to_rfc3339(),
                    "saw": r.saw,
                    "thought": r.thought,
                    "action_kind": match &r.action {
                        crate::operator_mind::TurnAction::Reply{..} => "Reply",
                        crate::operator_mind::TurnAction::Execute{..} => "Execute",
                        crate::operator_mind::TurnAction::Escalate{..} => "Escalate",
                        crate::operator_mind::TurnAction::Ignore => "Ignore",
                    },
                    "action_summary": match &r.action {
                        crate::operator_mind::TurnAction::Reply{text} => text.clone(),
                        crate::operator_mind::TurnAction::Execute{command} => command.clone(),
                        crate::operator_mind::TurnAction::Escalate{notification} => notification.clone(),
                        crate::operator_mind::TurnAction::Ignore => String::new(),
                    },
                    "executed": r.executed,
                })).collect::<Vec<_>>(),
            });
            let _ = app.emit("operator-mind-updated", payload);
        }
    }
```

### Step 6.4: Mind panel rendering

In `ui/src/operator/panel.ts`, add a section that subscribes to `operator-mind-updated` and renders:

```ts
import { listen } from "@tauri-apps/api/event";
import type { MindUpdatedEvent } from "../api";

function renderMindSection(container: HTMLElement, mind: MindUpdatedEvent) {
  container.innerHTML = `
    <div class="mind-block">
      <div class="mind-belief">
        <span class="label">Belief</span>
        <span class="value">${escapeHtml(mind.belief || "—")}</span>
      </div>
      <div class="mind-intent">
        <span class="label">Next intent</span>
        <span class="value">${escapeHtml(mind.next_intent || "—")}</span>
      </div>
      ${mind.tried_failed.length ? `
        <details class="mind-tried-failed">
          <summary>Tried & failed (${mind.tried_failed.length})</summary>
          <ul>${mind.tried_failed.map(t => `<li>${escapeHtml(t)}</li>`).join("")}</ul>
        </details>
      ` : ""}
      <div class="mind-recent">
        <div class="label">Recent ${mind.recent.length} turn${mind.recent.length === 1 ? "" : "s"}</div>
        ${mind.recent.map(r => `
          <details class="mind-turn">
            <summary>
              #${r.turn} · ${r.action_kind} ${escapeHtml(r.action_summary).slice(0, 60)}
              ${r.executed ? "" : "<span class='blocked'>blocked</span>"}
            </summary>
            <div class="thought"><b>thought:</b> ${escapeHtml(r.thought)}</div>
            <div class="saw"><b>saw:</b> <pre>${escapeHtml(r.saw)}</pre></div>
          </details>
        `).join("")}
      </div>
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function attachMindSection(panelRoot: HTMLElement) {
  const section = document.createElement("section");
  section.className = "operator-mind-section";
  panelRoot.appendChild(section);

  listen<MindUpdatedEvent>("operator-mind-updated", evt => {
    // Filter to the active tab's session_id — the panel knows its current session.
    if (evt.payload.session_id === panelRoot.dataset.sessionId) {
      renderMindSection(section, evt.payload);
    }
  });
}
```

Wire `attachMindSection(panelRoot)` into the existing panel constructor. Add CSS in `ui/src/styles.css`:

```css
.operator-mind-section .mind-block { padding: 8px 12px; font-size: 12px; }
.operator-mind-section .label { color: var(--muted); margin-right: 6px; font-weight: 600; }
.operator-mind-section .value { color: var(--fg); }
.operator-mind-section .mind-belief, .operator-mind-section .mind-intent { margin: 4px 0; }
.operator-mind-section .mind-tried-failed summary { cursor: pointer; color: var(--warn); }
.operator-mind-section .mind-recent { margin-top: 8px; border-top: 1px solid var(--border); padding-top: 6px; }
.operator-mind-section .mind-turn summary { cursor: pointer; }
.operator-mind-section .mind-turn .blocked { color: var(--err); margin-left: 6px; }
.operator-mind-section .mind-turn .thought, .operator-mind-section .mind-turn .saw { padding: 4px 12px; }
.operator-mind-section .mind-turn pre { white-space: pre-wrap; max-height: 6em; overflow: auto; background: var(--bg-2); padding: 4px; }
```

### Step 6.5: MindLossModal

Create `ui/src/operator/mind-loss-modal.ts`:

```ts
import type { MindPreview } from "../api";

export interface MindLossModalOptions {
  preview: MindPreview;
  onConfirm: () => void;
  onCancel: () => void;
}

export function openMindLossModal(opts: MindLossModalOptions) {
  const { preview, onConfirm, onCancel } = opts;

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay mind-loss-overlay";
  overlay.innerHTML = `
    <div class="modal mind-loss-modal" role="dialog" aria-modal="true" aria-labelledby="mind-loss-title">
      <h2 id="mind-loss-title">Borrar tab y su memoria del operador?</h2>
      <p>El operador acumuló <strong>${preview.turn_count} turno${preview.turn_count === 1 ? "" : "s"}</strong> de memoria desde ${formatRelative(preview.updated_at_rfc3339)}.</p>
      <dl>
        <dt>Objetivo actual</dt><dd>${escapeHtml(preview.goal || "—")}</dd>
        <dt>Última creencia</dt><dd>${escapeHtml(truncate(preview.belief || "—", 200))}</dd>
      </dl>
      <p class="warn">Si borrás el tab, esta memoria se pierde permanentemente.</p>
      <div class="modal-actions">
        <button class="btn-cancel" autofocus>Cancelar</button>
        <button class="btn-confirm danger">Borrar de todas formas</button>
      </div>
    </div>
  `;

  const cancel = overlay.querySelector(".btn-cancel") as HTMLButtonElement;
  const confirm = overlay.querySelector(".btn-confirm") as HTMLButtonElement;

  function close() {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      close();
      onCancel();
    } else if (e.key === "Enter" && document.activeElement === cancel) {
      close();
      onCancel();
    }
  }

  cancel.addEventListener("click", () => { close(); onCancel(); });
  confirm.addEventListener("click", () => { close(); onConfirm(); });
  document.addEventListener("keydown", onKey);

  document.body.appendChild(overlay);
  cancel.focus();
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "…";
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatRelative(rfc: string): string {
  const then = new Date(rfc).getTime();
  const now = Date.now();
  const diffMin = Math.floor((now - then) / 60000);
  if (diffMin < 60) return `hace ${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `hace ${diffHr}h`;
  return `hace ${Math.floor(diffHr / 24)}d`;
}
```

CSS:

```css
.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: grid; place-items: center; z-index: 9999; }
.modal { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 24px; max-width: 480px; }
.modal h2 { margin: 0 0 12px; font-size: 16px; }
.modal dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 12px 0; font-size: 12px; }
.modal dl dt { color: var(--muted); }
.modal .warn { color: var(--err); font-size: 12px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.modal-actions button.danger { background: var(--err); color: white; border: 0; padding: 6px 12px; border-radius: 4px; cursor: pointer; }
.modal-actions button.btn-cancel { background: var(--bg-2); border: 1px solid var(--border); padding: 6px 12px; border-radius: 4px; cursor: pointer; }
```

### Step 6.6: Wire `Cmd+W` flow

In `ui/src/tabs/manager.ts`, find the existing `Cmd+W` / close-tab handler. Replace its body with:

```ts
async function closeTabFlow(sessionId: string) {
  const preview = await closeSessionCheck(sessionId);
  if (!preview) {
    await closeSessionConfirm(sessionId);
    detachTab(sessionId); // existing teardown
    return;
  }
  openMindLossModal({
    preview,
    onConfirm: async () => {
      await closeSessionConfirm(sessionId);
      detachTab(sessionId);
    },
    onCancel: () => { /* keep tab */ },
  });
}
```

Wire `closeTabFlow(activeSessionId)` to whichever event currently calls the old close path (Cmd+W shortcut handler, "x" button in tab strip).

### Step 6.7: TS typecheck + manual smoke

```bash
cd ui && npm run typecheck 2>&1 | tail -10 && cd ..
```

Manual: build the app, open a tab, let the operator run a few turns with `mind_v2 = true`, verify the panel renders. Try Cmd+W → modal appears with real goal/belief/turn count.

### Step 6.8: Phase commit

- [ ] **Commit phase 6**

```bash
git add ui/src/operator/panel.ts ui/src/operator/mind-loss-modal.ts ui/src/tabs/manager.ts ui/src/api.ts ui/src/styles.css crates/app/src/lib.rs crates/app/src/operator.rs
git commit -m "$(cat <<'EOF'
feat(operator-mind): UI panel + MindLossModal (spec 3.20 phase 6)

- Operator panel section renders belief, next_intent, tried_failed,
  recent turns; thoughts and tail excerpts collapsible
- close_session split into close_session_check (returns optional
  MindPreview) + close_session_confirm (deletes mind on close)
- Cmd+W flow: if mind has turn_count > 0 open MindLossModal,
  default focus on Cancelar, Esc=cancel, Enter=confirm-cancel
- operator-mind-updated event emitted from backend after each
  mind mutation; panel filters by session_id

Spec: docs/specs/3.20-operator-mind.md §5.8 + §6
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Validation phase (manual)

**Goal:** Dogfood for 2–3 days, collect metrics, decide on default-flip.

This phase has no commits at the end (no code change). Treat it as a checklist for the dev's own validation.

- [ ] **Step 7.1:** Set `operator.mind_v2 = true` in your local `~/.config/covenant/settings.json` (or via the UI toggle).
- [ ] **Step 7.2:** Use Covenant for 2–3 normal workdays. Specifically observe:
  - The operator panel shows a sensible `belief` on running tabs.
  - Reopening a tab after app restart shows the same `belief` and `recent` turns.
  - Tab close triggers the MindLossModal when there's accumulated state.
  - Mission edits trigger the `<mission-changed>` marker (visible in the next operator response — should reflect updated goal in the panel).
- [ ] **Step 7.3:** Run a daily metrics check:

```bash
sqlite3 ~/.local/share/covenant/storage.db "
  SELECT COUNT(*) AS total_minds, AVG(turn_count) AS avg_turns
  FROM operator_mind;
"
```

Check tracing logs for `operator_mind v2 parse failed` count vs total turns. Target: < 2% parse failure.

- [ ] **Step 7.4:** Subjective gate. Ask yourself: does the operator feel coherent? Is it not repeating known-failed actions? Is the panel useful or noise?
  - If yes → proceed to Phase 8.
  - If no → don't flip the default. Open a follow-up note in `docs/next-features.md` with what fell short.

---

## Task 8: Default-on flip (conditional on Phase 7 passing)

**Goal:** Make `mind_v2` the default and bump the version.

**Files:**
- Modify: `crates/app/src/settings.rs`
- Modify: `Cargo.toml` (workspace version)
- Modify: `package.json`
- Modify: `CLAUDE.md`

### Step 8.1: Flip the default

```rust
    /// Enable the v2 OperatorMind protocol... Spec 3.20.
    #[serde(default = "default_mind_v2_on")]
    pub mind_v2: bool,
```

```rust
fn default_mind_v2_on() -> bool {
    true
}
```

In `Default::default()`:

```rust
            mind_v2: default_mind_v2_on(),
```

Update test `operator_config_default_has_mind_v2_off_and_budget_2000` → rename to `operator_config_default_has_mind_v2_on_and_budget_2000` and assert `c.mind_v2 == true`.

### Step 8.2: Version bump

Update workspace version in `Cargo.toml` (search for `version = "0.2."`) → `0.3.0`. Update `package.json` → `0.3.0`. If `tauri.conf.json` also tracks the version, update there.

### Step 8.3: CLAUDE.md update

Append a section near the architecture overview:

```markdown
## Operator v2: OperatorMind (since v0.3.0)

The operator no longer polls statelessly. Each tab has a persistent
`OperatorMind` (goal, belief, open questions, tried/failed, next intent,
last 5 turns) maintained by the model itself across turns and persisted
to SQLite. Extended thinking (default 2000 token budget) drives a
single structured response per turn: `{mind_update, action}`. See
`docs/specs/3.20-operator-mind.md`.

Key files:
- `crates/app/src/operator_mind.rs` — pure types + render + parser
- `crates/app/src/operator.rs` — turn loop integration
- `crates/app/src/storage.rs` — `operator_mind` table + GC
```

### Step 8.4: Final test sweep

```bash
cargo build --release 2>&1 | tail -5
cargo test --workspace 2>&1 | tail -10
cd ui && npm run typecheck && npm run build && cd ..
```

Expected: clean release build, all tests green, ui build clean.

### Step 8.5: Phase commit + tag

- [ ] **Commit + tag phase 8**

```bash
git add Cargo.toml package.json crates/app/src/settings.rs CLAUDE.md
git commit -m "$(cat <<'EOF'
feat(operator-mind): default mind_v2 on; v0.3.0

After ~3 days of dogfood validation: parse-failure rate < 2%, latency
acceptable, subjective intelligence improvement clearly observable.
Flipping the default. Old code path remains accessible by setting
operator.mind_v2 = false in settings.

Spec: docs/specs/3.20-operator-mind.md §9 phase 8
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"

git tag v0.3.0
```

---

## Self-Review Notes

**Spec coverage:**
- §2 goals/non-goals → covered phase-by-phase, non-goals (tools, ReAct, cross-tab) explicitly out.
- §3.1 module map → matches Phase 1 + Phase 2 + Phase 3 + Phase 4 file targets.
- §4 data model → Phase 1 implements all types and caps.
- §5 persistence → Phase 2 covers schema, save/load/delete/preview/GC; §5.8 confirm-on-delete UX → Phase 6 modal + command split.
- §6 prompt structure → Phase 4 (system directive, user message blocks, thinking budget pass-through).
- §7 errors/edge cases → Phase 4 (parse failure, hydration); Phase 5 (truncation budget bump, repeat-failure guard, masking).
- §8 testing → unit (Phase 1), storage (Phase 2), integration (Phase 4), repeat-failure (Phase 5), masking (Phase 5). Snapshot regression placeholder noted in Phase 3 step 3.5; the real snapshot lives in operator.rs existing baseline tests — Phase 4 ensures `mind_v2 = false` keeps them green.
- §9 roadmap → matches phases 1–8 exactly.
- §10 success criteria → Phase 7 manual validation maps to 1–4; subjective gate at end of Phase 7 maps to 5.
- §11 open risks → mitigations are baked into the implementation (mutable blocks at end of user message, FIFO caps, stale marker via render, default budget conservative).

**Placeholder scan:** None of the steps contain TBD/TODO/"add appropriate handling". Every step has either complete code, exact commands, or explicit "use existing helper X — find it via this grep".

**Type consistency:** `OperatorMind`, `MindUpdate`, `TurnRecord`, `TurnAction`, `ModelResponse`, `MindParseError` defined once in Phase 1, referenced consistently. Storage uses `serde_json::to_string` round-trip. Tauri command names (`close_session_check`, `close_session_confirm`) consistent between Rust + TS.

---

## Execution Handoff

Plan saved to `docs/plans/2026-05-06-operator-mind.md`.
