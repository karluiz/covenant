# Telegram Escalation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bidirectional Telegram escalation: outbound notifications with inline buttons + free-text replies via reply-to, using a user-owned bot and long-polling (no infra).

**Architecture:** New module `crates/app/src/telegram/` mirroring the existing `email/` layout. Long-polling task runs alongside `EmailNotifier` and `notify::Notifier`. Outbound subscribes to new `EscalationRequested`, `EscalationResolved`, `MissionCompleted`, `MissionFailed` events; inbound translates Telegram updates back into `EscalationResolved` and free-text `OperatorInput`. Settings token stored plaintext in `settings.json`. No SQLite, no offline queue.

**Tech Stack:** Rust + Tokio, `reqwest` (already used by email/agent clients), `serde_json`, `tracing`. Frontend: vanilla TS + existing `ui/src/settings/panel.ts` patterns.

**Spec:** `docs/superpowers/specs/2026-05-06-telegram-escalation-design.md`

**Worktree:** This plan must execute in a git worktree (per repo convention for agent-driven work). Create one with the using-git-worktrees skill before starting Task 1.

---

## File Structure

**New files:**
- `crates/app/src/telegram/mod.rs` — `TelegramNotifier`, public API, lifecycle
- `crates/app/src/telegram/client.rs` — HTTP client trait + `ReqwestTelegramClient` impl
- `crates/app/src/telegram/types.rs` — Telegram API request/response types
- `crates/app/src/telegram/outbound.rs` — formatting, message_id↔escalation map
- `crates/app/src/telegram/inbound.rs` — long-poll loop + update routing
- `ui/src/settings/telegram.ts` — Telegram settings section renderer

**Modified files:**
- `crates/app/src/lib.rs` — declare `mod telegram;`, spawn polling task in setup
- `crates/app/src/settings.rs` — add `TelegramSettings` struct, persist
- `crates/app/src/operator.rs` — emit new events at existing escalation/mission points
- `crates/app/src/notify.rs` — add `Trigger::Escalation`, `Trigger::MissionCompleted`, `Trigger::MissionFailed` if missing
- `ui/src/settings/panel.ts` — wire Telegram section
- `ui/src/api.ts` — add `telegram_test_connection` Tauri command wrapper
- `ui/src/status/` (find statusbar file) — add Telegram status icon

---

## Task 1: Skeleton crate structure + settings

**Files:**
- Create: `crates/app/src/telegram/mod.rs`, `client.rs`, `types.rs`, `outbound.rs`, `inbound.rs`
- Modify: `crates/app/src/lib.rs`, `crates/app/src/settings.rs`

- [ ] **Step 1: Add `TelegramSettings` to settings.rs**

In `crates/app/src/settings.rs`, add struct and field on `Settings`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TelegramSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub bot_token: String,
    #[serde(default)]
    pub chat_id: String,
    #[serde(default)]
    pub events: TelegramEvents,
    #[serde(default)]
    pub per_tab_overrides: HashMap<String, TelegramTabOverride>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelegramEvents {
    pub escalations: bool,
    pub mission_completed: bool,
    pub mission_failed: bool,
}

impl Default for TelegramEvents {
    fn default() -> Self {
        Self { escalations: true, mission_completed: true, mission_failed: true }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TelegramTabOverride {
    pub enabled: Option<bool>,
}
```

Add `pub telegram: TelegramSettings,` to `Settings` with `#[serde(default)]`.

- [ ] **Step 2: Stub the five new files**

Create `crates/app/src/telegram/mod.rs`:

```rust
pub mod client;
pub mod inbound;
pub mod outbound;
pub mod types;

use std::sync::Arc;
use tokio::sync::Mutex as AsyncMutex;

use crate::settings::Settings;
use client::TelegramClient;

pub struct TelegramNotifier {
    pub(crate) client: Arc<dyn TelegramClient>,
    pub(crate) settings: Arc<AsyncMutex<Settings>>,
    pub(crate) state: Arc<outbound::OutboundState>,
}

impl TelegramNotifier {
    pub fn new(client: Arc<dyn TelegramClient>, settings: Arc<AsyncMutex<Settings>>) -> Self {
        Self {
            client,
            settings,
            state: Arc::new(outbound::OutboundState::default()),
        }
    }
}
```

Create `crates/app/src/telegram/types.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
pub struct SendMessageReq {
    pub chat_id: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_markup: Option<InlineKeyboardMarkup>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parse_mode: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct InlineKeyboardMarkup {
    pub inline_keyboard: Vec<Vec<InlineKeyboardButton>>,
}

#[derive(Debug, Serialize, Clone)]
pub struct InlineKeyboardButton {
    pub text: String,
    pub callback_data: String,
}

#[derive(Debug, Deserialize)]
pub struct SendMessageResp {
    pub ok: bool,
    pub result: Option<MessageResult>,
}

#[derive(Debug, Deserialize)]
pub struct MessageResult {
    pub message_id: i64,
}

#[derive(Debug, Deserialize)]
pub struct GetUpdatesResp {
    pub ok: bool,
    #[serde(default)]
    pub result: Vec<Update>,
}

#[derive(Debug, Deserialize)]
pub struct Update {
    pub update_id: i64,
    pub message: Option<IncomingMessage>,
    pub callback_query: Option<CallbackQuery>,
}

#[derive(Debug, Deserialize)]
pub struct IncomingMessage {
    pub message_id: i64,
    pub chat: Chat,
    pub text: Option<String>,
    pub reply_to_message: Option<Box<IncomingMessage>>,
}

#[derive(Debug, Deserialize)]
pub struct Chat { pub id: i64 }

#[derive(Debug, Deserialize)]
pub struct CallbackQuery {
    pub id: String,
    pub from: From,
    pub message: Option<IncomingMessage>,
    pub data: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct From { pub id: i64 }
```

Create `crates/app/src/telegram/client.rs`:

```rust
use async_trait::async_trait;

use super::types::*;

#[async_trait]
pub trait TelegramClient: Send + Sync {
    async fn send_message(&self, token: &str, req: SendMessageReq) -> anyhow::Result<MessageResult>;
    async fn edit_message_text(&self, token: &str, chat_id: &str, message_id: i64, text: String, remove_keyboard: bool) -> anyhow::Result<()>;
    async fn answer_callback_query(&self, token: &str, callback_id: &str) -> anyhow::Result<()>;
    async fn get_updates(&self, token: &str, offset: Option<i64>, timeout_secs: u64) -> anyhow::Result<Vec<Update>>;
    async fn get_me(&self, token: &str) -> anyhow::Result<()>;
}

pub struct ReqwestTelegramClient {
    http: reqwest::Client,
}

impl ReqwestTelegramClient {
    pub fn new() -> Self {
        Self { http: reqwest::Client::builder().build().expect("http client") }
    }
    fn url(token: &str, method: &str) -> String {
        format!("https://api.telegram.org/bot{token}/{method}")
    }
}
```

Create `crates/app/src/telegram/outbound.rs`:

```rust
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Default)]
pub struct OutboundState {
    pub map: Mutex<HashMap<i64, String>>, // message_id -> escalation_id
}
```

Create `crates/app/src/telegram/inbound.rs`:

```rust
// Long-poll loop is added in Task 7.
```

- [ ] **Step 3: Wire module in lib.rs**

In `crates/app/src/lib.rs`, add `pub mod telegram;` near the other module declarations.

- [ ] **Step 4: Build to verify it compiles**

Run: `cargo build -p app`
Expected: compiles cleanly (warnings about unused fields are OK).

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/telegram/ crates/app/src/lib.rs crates/app/src/settings.rs
git commit -m "feat(telegram): scaffold telegram module + settings struct"
```

---

## Task 2: New session events for escalation + mission lifecycle

**Files:**
- Modify: `crates/app/src/operator.rs` (or wherever `SessionEvent` enum lives — search first)

- [ ] **Step 1: Locate the event enum**

Run: `rg -n "enum SessionEvent|enum AgentAction|EscalationRequested|MissionCompleted" crates/app/src crates/session/src`

Pick the actual file. Spec assumes `crates/session/events.rs` but the real layout (per `crates/session/src/lib.rs`) likely keeps events in `crates/app/src/operator.rs` or a sibling. Use whichever exists.

- [ ] **Step 2: Add the new variants**

Add to the existing event enum (keep variants compatible — `#[derive(Clone)]`, `Serialize` if peers do):

```rust
EscalationRequested {
    session: SessionId,
    escalation_id: String,             // ulid as string
    kind: EscalationKind,
    summary: String,
    actions: Vec<EscalationAction>,
},
EscalationResolved {
    escalation_id: String,
    resolution: EscalationResolution,
    source: ResolutionSource,
},
MissionCompleted { session: SessionId, summary: String },
MissionFailed    { session: SessionId, reason: String },
```

And the supporting enums (place in same module):

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum EscalationKind { Blocked, Blocklist, BudgetExhausted, Loop }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum EscalationAction { Approve, Reject, Snooze10m }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum EscalationResolution { Approved, Rejected, Snoozed, FreeText(String) }

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ResolutionSource { Terminal, Telegram }
```

- [ ] **Step 3: Build**

Run: `cargo build -p app`
Expected: clean build. Match-arm errors elsewhere (if any) are fixed by adding `_ => {}` or explicit no-op handlers — do NOT change unrelated logic; mark with `// TODO(telegram): handled in Task 5`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(telegram): add escalation + mission events to bus"
```

---

## Task 3: Outbound formatter — unit-tested

**Files:**
- Modify: `crates/app/src/telegram/outbound.rs`
- Test: inline `#[cfg(test)] mod tests` in same file

- [ ] **Step 1: Write the failing test**

Append to `crates/app/src/telegram/outbound.rs`:

```rust
pub fn format_escalation(tab_name: &str, kind: &str, summary: &str) -> String {
    let trimmed = if summary.chars().count() > 500 {
        let mut s: String = summary.chars().take(499).collect();
        s.push('…');
        s
    } else {
        summary.to_string()
    };
    format!("[tab: {tab_name}] {kind}\n{trimmed}")
}

pub fn keyboard_for(actions: &[String], escalation_id: &str) -> super::types::InlineKeyboardMarkup {
    use super::types::{InlineKeyboardButton, InlineKeyboardMarkup};
    let buttons: Vec<InlineKeyboardButton> = actions.iter().map(|a| {
        let label = match a.as_str() {
            "Approve" => "✓ Approve",
            "Reject" => "✗ Reject",
            "Snooze10m" => "⏸ Snooze 10m",
            other => other,
        }.to_string();
        InlineKeyboardButton {
            text: label,
            callback_data: format!("esc:{escalation_id}:{a}"),
        }
    }).collect();
    InlineKeyboardMarkup { inline_keyboard: vec![buttons] }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncates_long_summary() {
        let long = "x".repeat(800);
        let out = format_escalation("dep", "BLOCKED", &long);
        assert!(out.contains("…"));
        assert!(out.chars().count() <= 600); // header + 500
    }

    #[test]
    fn short_summary_passes_through() {
        let out = format_escalation("dep", "BLOCKED", "hi");
        assert_eq!(out, "[tab: dep] BLOCKED\nhi");
    }

    #[test]
    fn keyboard_encodes_action_in_callback() {
        let kb = keyboard_for(&["Approve".into(), "Reject".into()], "01J...");
        assert_eq!(kb.inline_keyboard[0][0].callback_data, "esc:01J...:Approve");
        assert_eq!(kb.inline_keyboard[0][1].callback_data, "esc:01J...:Reject");
    }
}
```

- [ ] **Step 2: Run tests — should pass (impl is in same step)**

Run: `cargo test -p app telegram::outbound`
Expected: 3 passing tests.

- [ ] **Step 3: Commit**

```bash
git add crates/app/src/telegram/outbound.rs
git commit -m "feat(telegram): outbound formatter + inline keyboard"
```

---

## Task 4: HTTP client implementation + fake for tests

**Files:**
- Modify: `crates/app/src/telegram/client.rs`

- [ ] **Step 1: Implement `ReqwestTelegramClient` methods**

Add to `crates/app/src/telegram/client.rs`:

```rust
#[async_trait]
impl TelegramClient for ReqwestTelegramClient {
    async fn send_message(&self, token: &str, req: SendMessageReq) -> anyhow::Result<MessageResult> {
        let resp: SendMessageResp = self.http
            .post(Self::url(token, "sendMessage"))
            .json(&req)
            .send().await?
            .error_for_status()?
            .json().await?;
        resp.result.ok_or_else(|| anyhow::anyhow!("telegram sendMessage returned ok=false"))
    }

    async fn edit_message_text(&self, token: &str, chat_id: &str, message_id: i64, text: String, remove_keyboard: bool) -> anyhow::Result<()> {
        let mut body = serde_json::json!({
            "chat_id": chat_id,
            "message_id": message_id,
            "text": text,
        });
        if remove_keyboard {
            body["reply_markup"] = serde_json::json!({ "inline_keyboard": [] });
        }
        self.http.post(Self::url(token, "editMessageText"))
            .json(&body)
            .send().await?
            .error_for_status()?;
        Ok(())
    }

    async fn answer_callback_query(&self, token: &str, callback_id: &str) -> anyhow::Result<()> {
        self.http.post(Self::url(token, "answerCallbackQuery"))
            .json(&serde_json::json!({ "callback_query_id": callback_id }))
            .send().await?
            .error_for_status()?;
        Ok(())
    }

    async fn get_updates(&self, token: &str, offset: Option<i64>, timeout_secs: u64) -> anyhow::Result<Vec<Update>> {
        let mut body = serde_json::json!({ "timeout": timeout_secs });
        if let Some(o) = offset { body["offset"] = o.into(); }
        let resp: GetUpdatesResp = self.http
            .post(Self::url(token, "getUpdates"))
            .json(&body)
            .timeout(std::time::Duration::from_secs(timeout_secs + 10))
            .send().await?
            .error_for_status()?
            .json().await?;
        Ok(resp.result)
    }

    async fn get_me(&self, token: &str) -> anyhow::Result<()> {
        self.http.get(Self::url(token, "getMe"))
            .send().await?
            .error_for_status()?;
        Ok(())
    }
}
```

- [ ] **Step 2: Add a `FakeTelegramClient` for tests**

Append to `crates/app/src/telegram/client.rs`:

```rust
#[cfg(test)]
pub mod fake {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    pub struct FakeTelegramClient {
        pub sent: Mutex<Vec<SendMessageReq>>,
        pub edits: Mutex<Vec<(String, i64, String, bool)>>, // (chat, msg_id, text, remove_kb)
        pub answers: Mutex<Vec<String>>,
        pub queued_updates: Mutex<Vec<Vec<Update>>>,
        pub next_message_id: Mutex<i64>,
    }

    #[async_trait]
    impl TelegramClient for FakeTelegramClient {
        async fn send_message(&self, _t: &str, req: SendMessageReq) -> anyhow::Result<MessageResult> {
            let mut id = self.next_message_id.lock().unwrap();
            *id += 1;
            self.sent.lock().unwrap().push(req);
            Ok(MessageResult { message_id: *id })
        }
        async fn edit_message_text(&self, _t: &str, chat: &str, mid: i64, text: String, rm: bool) -> anyhow::Result<()> {
            self.edits.lock().unwrap().push((chat.into(), mid, text, rm));
            Ok(())
        }
        async fn answer_callback_query(&self, _t: &str, cid: &str) -> anyhow::Result<()> {
            self.answers.lock().unwrap().push(cid.into());
            Ok(())
        }
        async fn get_updates(&self, _t: &str, _offset: Option<i64>, _timeout: u64) -> anyhow::Result<Vec<Update>> {
            let mut q = self.queued_updates.lock().unwrap();
            if q.is_empty() { Ok(vec![]) } else { Ok(q.remove(0)) }
        }
        async fn get_me(&self, _t: &str) -> anyhow::Result<()> { Ok(()) }
    }
}
```

- [ ] **Step 3: Add `async-trait` dep if missing**

Run: `cargo metadata --format-version 1 -p app | grep async-trait`
If empty, add to `crates/app/Cargo.toml`: `async-trait = "0.1"`.

- [ ] **Step 4: Build**

Run: `cargo build -p app && cargo test -p app telegram::`
Expected: compiles, prior outbound tests still pass.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/telegram/client.rs crates/app/Cargo.toml
git commit -m "feat(telegram): reqwest client + fake for tests"
```

---

## Task 5: Outbound notifier — send + edit on resolve

**Files:**
- Modify: `crates/app/src/telegram/mod.rs`

- [ ] **Step 1: Write the failing test**

Append to `crates/app/src/telegram/mod.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{Settings, TelegramSettings};
    use crate::telegram::client::fake::FakeTelegramClient;

    fn settings_with_telegram(enabled: bool, chat: &str) -> Arc<AsyncMutex<Settings>> {
        let mut s = Settings::default();
        s.telegram = TelegramSettings {
            enabled,
            bot_token: "T".into(),
            chat_id: chat.into(),
            ..Default::default()
        };
        Arc::new(AsyncMutex::new(s))
    }

    #[tokio::test]
    async fn send_escalation_records_message_id() {
        let fake = Arc::new(FakeTelegramClient::default());
        *fake.next_message_id.lock().unwrap() = 100;
        let n = TelegramNotifier::new(fake.clone(), settings_with_telegram(true, "42"));
        n.send_escalation("tab1", "BLOCKED", "summary", "esc-1",
            &["Approve".into(), "Reject".into()]).await.unwrap();
        assert_eq!(fake.sent.lock().unwrap().len(), 1);
        let map = n.state.map.lock().unwrap();
        assert_eq!(map.get(&101).map(String::as_str), Some("esc-1"));
    }

    #[tokio::test]
    async fn send_escalation_skipped_when_disabled() {
        let fake = Arc::new(FakeTelegramClient::default());
        let n = TelegramNotifier::new(fake.clone(), settings_with_telegram(false, "42"));
        n.send_escalation("t", "K", "s", "id", &["Approve".into()]).await.unwrap();
        assert!(fake.sent.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn resolve_edits_original_message() {
        let fake = Arc::new(FakeTelegramClient::default());
        *fake.next_message_id.lock().unwrap() = 100;
        let n = TelegramNotifier::new(fake.clone(), settings_with_telegram(true, "42"));
        n.send_escalation("t", "K", "s", "esc-1", &["Approve".into()]).await.unwrap();
        n.on_resolved("esc-1", "Approved via terminal").await.unwrap();
        assert_eq!(fake.edits.lock().unwrap().len(), 1);
        // map cleaned up
        assert!(n.state.map.lock().unwrap().is_empty());
    }
}
```

- [ ] **Step 2: Implement `send_escalation` and `on_resolved`**

Add to `crates/app/src/telegram/mod.rs`:

```rust
use crate::telegram::outbound::{format_escalation, keyboard_for};
use crate::telegram::types::SendMessageReq;

impl TelegramNotifier {
    pub async fn send_escalation(
        &self,
        tab_name: &str,
        kind: &str,
        summary: &str,
        escalation_id: &str,
        actions: &[String],
    ) -> anyhow::Result<()> {
        let s = self.settings.lock().await;
        if !s.telegram.enabled || s.telegram.bot_token.is_empty() || s.telegram.chat_id.is_empty()
            || !s.telegram.events.escalations {
            return Ok(());
        }
        let token = s.telegram.bot_token.clone();
        let chat = s.telegram.chat_id.clone();
        drop(s);

        let req = SendMessageReq {
            chat_id: chat,
            text: format_escalation(tab_name, kind, summary),
            reply_markup: Some(keyboard_for(actions, escalation_id)),
            parse_mode: None,
        };
        let result = self.client.send_message(&token, req).await?;
        self.state.map.lock().unwrap().insert(result.message_id, escalation_id.to_string());
        Ok(())
    }

    pub async fn send_mission_event(&self, mission_kind: MissionKind, tab: &str, body: &str) -> anyhow::Result<()> {
        let s = self.settings.lock().await;
        let allowed = match mission_kind {
            MissionKind::Completed => s.telegram.events.mission_completed,
            MissionKind::Failed => s.telegram.events.mission_failed,
        };
        if !s.telegram.enabled || !allowed || s.telegram.bot_token.is_empty() || s.telegram.chat_id.is_empty() {
            return Ok(());
        }
        let token = s.telegram.bot_token.clone();
        let chat = s.telegram.chat_id.clone();
        drop(s);
        let prefix = match mission_kind { MissionKind::Completed => "✅ MISSION COMPLETED", MissionKind::Failed => "❌ MISSION FAILED" };
        let req = SendMessageReq {
            chat_id: chat, parse_mode: None, reply_markup: None,
            text: format!("[tab: {tab}] {prefix}\n{body}"),
        };
        self.client.send_message(&token, req).await?;
        Ok(())
    }

    pub async fn on_resolved(&self, escalation_id: &str, status: &str) -> anyhow::Result<()> {
        let entry = {
            let mut map = self.state.map.lock().unwrap();
            let key = map.iter().find(|(_, v)| v.as_str() == escalation_id).map(|(k, _)| *k);
            key.and_then(|k| map.remove(&k).map(|_| k))
        };
        let Some(message_id) = entry else { return Ok(()); };
        let s = self.settings.lock().await;
        if s.telegram.bot_token.is_empty() || s.telegram.chat_id.is_empty() { return Ok(()); }
        let token = s.telegram.bot_token.clone();
        let chat = s.telegram.chat_id.clone();
        drop(s);
        self.client.edit_message_text(&token, &chat, message_id,
            format!("✓ Resolved: {status}"), true).await?;
        Ok(())
    }
}

pub enum MissionKind { Completed, Failed }
```

- [ ] **Step 3: Run tests**

Run: `cargo test -p app telegram::tests`
Expected: 3 passing tests.

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/telegram/mod.rs
git commit -m "feat(telegram): outbound send + edit-on-resolve"
```

---

## Task 6: Wire outbound to operator events

**Files:**
- Modify: `crates/app/src/operator.rs` (search for emit points)

- [ ] **Step 1: Find existing escalation/mission emission sites**

Run:
```bash
rg -n "Blocklist|BudgetExhausted|loop_detected|mission.*complete|mission.*fail|escalat" crates/app/src/operator.rs | head -40
```

Identify the call sites where the Operator currently:
- Refuses to execute due to blocklist
- Pauses due to budget cap
- Detects an AOM loop
- Marks mission complete / failed

- [ ] **Step 2: Emit `EscalationRequested` at each site**

At each identified site, after the existing handling, emit on the bus (use the same channel/handle the operator uses for other events):

```rust
let escalation_id = ulid::Ulid::new().to_string();
let _ = bus.send(SessionEvent::EscalationRequested {
    session: session_id.clone(),
    escalation_id: escalation_id.clone(),
    kind: EscalationKind::Blocklist, // adjust per site
    summary: ansi_escapes::strip(&context).into_owned(),
    actions: vec![EscalationAction::Approve, EscalationAction::Reject, EscalationAction::Snooze10m],
});
```

For mission terminal states:

```rust
bus.send(SessionEvent::MissionCompleted { session: session_id.clone(), summary: msg }).ok();
// or MissionFailed { ..., reason: msg }
```

- [ ] **Step 3: Subscribe `TelegramNotifier` to the bus**

In the place where `EmailNotifier` is wired into the bus (search for `EmailNotifier::emit` callers), add a parallel subscriber that:
- On `EscalationRequested` → `telegram.send_escalation(...)`
- On `EscalationResolved` → `telegram.on_resolved(escalation_id, format!("{:?} via {:?}", resolution, source))`
- On `MissionCompleted` → `telegram.send_mission_event(MissionKind::Completed, ...)`
- On `MissionFailed` → `telegram.send_mission_event(MissionKind::Failed, ...)`

Tab name resolution: look up the tab's display name from the existing tab manifest (search `tab_manifest::name_for` or similar).

- [ ] **Step 4: Build**

Run: `cargo build -p app`
Expected: clean. If there are missing variants in `match` blocks elsewhere, add explicit no-op arms — never delete existing logic.

- [ ] **Step 5: Manual smoke test**

```bash
cargo run -p app
```
- Set Telegram: enabled, bot_token, chat_id (use a real bot for now; we add UI in Task 9).
- Trigger a blocklisted command (`rm -rf /tmp/foo` via the operator path).
- Verify Telegram receives the escalation message with three buttons.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(telegram): emit + forward escalation/mission events"
```

---

## Task 7: Inbound long-poll loop

**Files:**
- Modify: `crates/app/src/telegram/inbound.rs`, `mod.rs`

- [ ] **Step 1: Write the failing test**

Append to `crates/app/src/telegram/mod.rs` `tests` module:

```rust
#[tokio::test]
async fn callback_query_publishes_resolution() {
    use crate::telegram::types::*;
    let fake = Arc::new(FakeTelegramClient::default());
    fake.queued_updates.lock().unwrap().push(vec![Update {
        update_id: 1,
        message: None,
        callback_query: Some(CallbackQuery {
            id: "cb1".into(),
            from: From { id: 42 },
            message: Some(IncomingMessage { message_id: 99, chat: Chat { id: 42 }, text: None, reply_to_message: None }),
            data: Some("esc:abc:Approve".into()),
        }),
    }]);
    let n = TelegramNotifier::new(fake.clone(), settings_with_telegram(true, "42"));
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let handle = n.spawn_inbound(tx);
    // wait briefly for one poll
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    handle.abort();

    let evt = rx.try_recv().expect("expected resolution");
    match evt {
        InboundEvent::Resolved { escalation_id, resolution } => {
            assert_eq!(escalation_id, "abc");
            assert!(matches!(resolution, ResolutionFromTelegram::Approved));
        }
        _ => panic!("wrong event"),
    }
    assert_eq!(fake.answers.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn message_from_other_chat_ignored() {
    let fake = Arc::new(FakeTelegramClient::default());
    fake.queued_updates.lock().unwrap().push(vec![Update {
        update_id: 1,
        callback_query: None,
        message: Some(IncomingMessage {
            message_id: 1, chat: Chat { id: 999 }, text: Some("hi".into()), reply_to_message: None,
        }),
    }]);
    let n = TelegramNotifier::new(fake.clone(), settings_with_telegram(true, "42"));
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let handle = n.spawn_inbound(tx);
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    handle.abort();
    assert!(rx.try_recv().is_err());
}

#[tokio::test]
async fn reply_message_publishes_freetext() {
    let fake = Arc::new(FakeTelegramClient::default());
    *fake.next_message_id.lock().unwrap() = 100;
    let n = TelegramNotifier::new(fake.clone(), settings_with_telegram(true, "42"));
    n.send_escalation("t", "K", "s", "esc-7", &["Approve".into()]).await.unwrap();
    // message_id = 101 → mapped to esc-7
    fake.queued_updates.lock().unwrap().push(vec![Update {
        update_id: 1, callback_query: None,
        message: Some(IncomingMessage {
            message_id: 200, chat: Chat { id: 42 },
            text: Some("usa --force".into()),
            reply_to_message: Some(Box::new(IncomingMessage {
                message_id: 101, chat: Chat { id: 42 }, text: None, reply_to_message: None,
            })),
        }),
    }]);
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let handle = n.spawn_inbound(tx);
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    handle.abort();
    let evt = rx.recv().await.unwrap();
    match evt {
        InboundEvent::Resolved { escalation_id, resolution } => {
            assert_eq!(escalation_id, "esc-7");
            assert!(matches!(resolution, ResolutionFromTelegram::FreeText(t) if t == "usa --force"));
        }
        _ => panic!(),
    }
}
```

- [ ] **Step 2: Implement the inbound loop**

Replace `crates/app/src/telegram/inbound.rs` contents:

```rust
use std::sync::Arc;
use tokio::sync::mpsc::UnboundedSender;
use tokio::task::JoinHandle;

use super::client::TelegramClient;
use super::types::Update;
use super::OutboundState;

#[derive(Debug)]
pub enum InboundEvent {
    Resolved { escalation_id: String, resolution: ResolutionFromTelegram },
    UnknownReply { chat_id: i64, message_id: i64 }, // for bot to nudge user
}

#[derive(Debug)]
pub enum ResolutionFromTelegram {
    Approved, Rejected, Snoozed, FreeText(String),
}

pub struct InboundConfig {
    pub token: String,
    pub allowed_chat_id: i64,
}

pub fn spawn(
    client: Arc<dyn TelegramClient>,
    state: Arc<OutboundState>,
    cfg: InboundConfig,
    tx: UnboundedSender<InboundEvent>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut offset: Option<i64> = None;
        loop {
            let updates = match client.get_updates(&cfg.token, offset, 30).await {
                Ok(u) => u,
                Err(e) => {
                    tracing::warn!(error=%e, "telegram getUpdates failed; sleeping 60s");
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    continue;
                }
            };
            for u in updates {
                offset = Some(u.update_id + 1);
                if let Some(cb) = u.callback_query {
                    if cb.from.id != cfg.allowed_chat_id { continue; }
                    let _ = client.answer_callback_query(&cfg.token, &cb.id).await;
                    let Some(data) = cb.data else { continue; };
                    if let Some((eid, action)) = parse_callback(&data) {
                        let res = match action.as_str() {
                            "Approve" => ResolutionFromTelegram::Approved,
                            "Reject" => ResolutionFromTelegram::Rejected,
                            "Snooze10m" => ResolutionFromTelegram::Snoozed,
                            _ => continue,
                        };
                        let _ = tx.send(InboundEvent::Resolved { escalation_id: eid, resolution: res });
                    }
                } else if let Some(msg) = u.message {
                    if msg.chat.id != cfg.allowed_chat_id { continue; }
                    let Some(text) = msg.text else { continue; };
                    if let Some(reply) = msg.reply_to_message {
                        let map = state.map.lock().unwrap();
                        if let Some(eid) = map.get(&reply.message_id).cloned() {
                            let _ = tx.send(InboundEvent::Resolved {
                                escalation_id: eid,
                                resolution: ResolutionFromTelegram::FreeText(text),
                            });
                        } else {
                            let _ = tx.send(InboundEvent::UnknownReply { chat_id: msg.chat.id, message_id: reply.message_id });
                        }
                    } else {
                        let _ = tx.send(InboundEvent::UnknownReply { chat_id: msg.chat.id, message_id: msg.message_id });
                    }
                }
            }
        }
    })
}

fn parse_callback(s: &str) -> Option<(String, String)> {
    let mut parts = s.splitn(3, ':');
    let prefix = parts.next()?;
    if prefix != "esc" { return None; }
    let id = parts.next()?.to_string();
    let action = parts.next()?.to_string();
    Some((id, action))
}
```

- [ ] **Step 3: Add `spawn_inbound` helper on `TelegramNotifier`**

In `crates/app/src/telegram/mod.rs`:

```rust
pub use inbound::{InboundEvent, ResolutionFromTelegram};

impl TelegramNotifier {
    pub fn spawn_inbound(&self, tx: tokio::sync::mpsc::UnboundedSender<InboundEvent>)
        -> tokio::task::JoinHandle<()>
    {
        // snapshot settings; if disabled, return a no-op task
        let token = futures::executor::block_on(async { self.settings.lock().await.telegram.bot_token.clone() });
        let chat_str = futures::executor::block_on(async { self.settings.lock().await.telegram.chat_id.clone() });
        let allowed_chat_id: i64 = chat_str.parse().unwrap_or(0);
        if token.is_empty() || allowed_chat_id == 0 {
            return tokio::spawn(async {});
        }
        inbound::spawn(self.client.clone(), self.state.clone(),
            inbound::InboundConfig { token, allowed_chat_id }, tx)
    }
}
```

(Note: `futures::executor::block_on` is acceptable here only because the call sites are during setup, not in async tasks. If `app` already uses an async setup path, prefer `.await` inline.)

- [ ] **Step 4: Run tests**

Run: `cargo test -p app telegram::`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/telegram/inbound.rs crates/app/src/telegram/mod.rs
git commit -m "feat(telegram): inbound long-poll loop with chat whitelist"
```

---

## Task 8: Wire inbound to operator + bus + lifecycle

**Files:**
- Modify: `crates/app/src/lib.rs` (or main setup), `crates/app/src/operator.rs`

- [ ] **Step 1: Spawn the notifier in app setup**

In the Tauri `setup` closure (search `tauri::Builder::default()` or similar), after settings load:

```rust
let telegram = Arc::new(crate::telegram::TelegramNotifier::new(
    Arc::new(crate::telegram::client::ReqwestTelegramClient::new()),
    settings.clone(),
));
let (tg_tx, mut tg_rx) = tokio::sync::mpsc::unbounded_channel();
let _inbound_handle = telegram.spawn_inbound(tg_tx);
```

Stash `telegram` in app state (`app.manage(telegram.clone())`) so Tauri commands can use it.

- [ ] **Step 2: Drain `tg_rx` and re-publish to bus / OperatorInput**

Spawn a task that receives `InboundEvent` and either:
- For `Resolved { Approved/Rejected/Snoozed }` → publish `EscalationResolved` with `ResolutionSource::Telegram`.
- For `Resolved { FreeText(t) }` → publish `EscalationResolved::FreeText(t)` AND inject `t` into the operator's input queue for that tab (find the tab via `escalation_id → tab_id` lookup; store this map in `OutboundState` alongside `message_id` map).
- For `UnknownReply { chat_id, message_id }` → call `client.send_message` with text "Esa escalación ya cerró" or "Responde al mensaje de la tab a la que te refieres" depending on whether it had a reply_to but unknown id, vs no reply at all. (Differentiate `UnknownReply` into two variants.)

- [ ] **Step 3: Add restart-on-settings-change**

Search for the settings-save path (`save_settings` Tauri command or similar). After save, if `telegram` settings changed (compare old/new), abort the previous `_inbound_handle` and respawn.

- [ ] **Step 4: Build + run**

Run: `cargo build -p app`. Then manual test:
- Open app, configure Telegram (use direct `settings.json` edit if UI not yet ready).
- Trigger an escalation; verify Telegram message arrives.
- Tap "✓ Approve" in Telegram → terminal should resolve the escalation.
- Reply "use --force" → operator should receive it as a free-text instruction.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(telegram): wire inbound loop + operator resolution"
```

---

## Task 9: Frontend — Settings panel section

**Files:**
- Create: `ui/src/settings/telegram.ts`
- Modify: `ui/src/settings/panel.ts`, `ui/src/api.ts`

- [ ] **Step 1: Add Tauri command for test connection**

In `crates/app/src/telegram/mod.rs`:

```rust
impl TelegramNotifier {
    pub async fn test_connection(&self) -> Result<(), String> {
        let s = self.settings.lock().await;
        if s.telegram.bot_token.is_empty() || s.telegram.chat_id.is_empty() {
            return Err("token y chat_id requeridos".into());
        }
        let token = s.telegram.bot_token.clone();
        let chat = s.telegram.chat_id.clone();
        drop(s);
        self.client.get_me(&token).await.map_err(|e| format!("getMe: {e}"))?;
        self.client.send_message(&token, super::types::SendMessageReq {
            chat_id: chat, text: "✓ Covenant connected".into(),
            reply_markup: None, parse_mode: None,
        }).await.map_err(|e| format!("sendMessage: {e}"))?;
        Ok(())
    }
}
```

Add a Tauri command (in the place other commands are registered):

```rust
#[tauri::command]
async fn telegram_test_connection(state: tauri::State<'_, Arc<TelegramNotifier>>) -> Result<(), String> {
    state.test_connection().await
}
```

Register in `invoke_handler`.

- [ ] **Step 2: Add the API wrapper**

In `ui/src/api.ts`, add:

```ts
export async function telegramTestConnection(): Promise<void> {
  return invoke<void>("telegram_test_connection");
}
```

- [ ] **Step 3: Build the settings section**

Create `ui/src/settings/telegram.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";
import { telegramTestConnection } from "../api";

export function renderTelegramSection(container: HTMLElement, settings: any, save: (patch: any) => Promise<void>) {
  const t = settings.telegram ?? { enabled: false, bot_token: "", chat_id: "",
    events: { escalations: true, mission_completed: true, mission_failed: true } };

  container.innerHTML = `
    <h3>Telegram</h3>
    <label><input type="checkbox" id="tg-enabled" ${t.enabled ? "checked" : ""}/> Enabled</label>
    <div>Bot token <input type="password" id="tg-token" value="${t.bot_token ?? ""}"/>
      <span class="hint" title="Crea un bot con @BotFather, /newbot, copia el token">?</span></div>
    <div>Chat ID <input type="text" id="tg-chat" value="${t.chat_id ?? ""}"/>
      <span class="hint" title="@userinfobot te lo dice">?</span></div>
    <button id="tg-test">Test connection</button>
    <div id="tg-test-result"></div>
    <fieldset>
      <legend>Notify on</legend>
      <label><input type="checkbox" id="tg-ev-esc" ${t.events.escalations ? "checked" : ""}/> Escalations</label>
      <label><input type="checkbox" id="tg-ev-mc" ${t.events.mission_completed ? "checked" : ""}/> Mission completed</label>
      <label><input type="checkbox" id="tg-ev-mf" ${t.events.mission_failed ? "checked" : ""}/> Mission failed</label>
    </fieldset>
  `;

  const persist = () => save({
    telegram: {
      ...t,
      enabled: (container.querySelector("#tg-enabled") as HTMLInputElement).checked,
      bot_token: (container.querySelector("#tg-token") as HTMLInputElement).value,
      chat_id: (container.querySelector("#tg-chat") as HTMLInputElement).value,
      events: {
        escalations: (container.querySelector("#tg-ev-esc") as HTMLInputElement).checked,
        mission_completed: (container.querySelector("#tg-ev-mc") as HTMLInputElement).checked,
        mission_failed: (container.querySelector("#tg-ev-mf") as HTMLInputElement).checked,
      },
    }
  });

  container.querySelectorAll("input").forEach(el => el.addEventListener("change", persist));

  container.querySelector("#tg-test")!.addEventListener("click", async () => {
    const out = container.querySelector("#tg-test-result")!;
    out.textContent = "...";
    try { await telegramTestConnection(); out.textContent = "✓ OK"; }
    catch (e: any) { out.textContent = "✗ " + (e?.message ?? String(e)); }
  });
}
```

- [ ] **Step 4: Mount in panel.ts**

In `ui/src/settings/panel.ts`, after the existing sections, import and call `renderTelegramSection(container, settings, save)`.

- [ ] **Step 5: Manual test**

Run the app, open Settings, configure Telegram, click Test connection. Verify success message + Telegram receives "✓ Covenant connected".

- [ ] **Step 6: Commit**

```bash
git add ui/src/settings/telegram.ts ui/src/settings/panel.ts ui/src/api.ts crates/app/src/telegram/mod.rs crates/app/src/lib.rs
git commit -m "feat(telegram): settings UI + test connection command"
```

---

## Task 10: Statusbar icon + tab override

**Files:**
- Modify: statusbar TS file (search `ui/src/status*`), tab context menu (search `ui/src/tabs/`)

- [ ] **Step 1: Add status state command**

In `crates/app/src/telegram/mod.rs`, expose `pub async fn status(&self) -> TelegramStatus`:

```rust
#[derive(Serialize, Clone)]
pub enum TelegramStatus { Disabled, Ok, Error }
```

Track last poll outcome inside `OutboundState` (atomic). The inbound loop sets it on each `get_updates` result.

Tauri command:

```rust
#[tauri::command]
async fn telegram_status(state: tauri::State<'_, Arc<TelegramNotifier>>) -> Result<TelegramStatus, String> { Ok(state.status().await) }
```

- [ ] **Step 2: Render status icon**

Find the statusbar TS module (`rg -n "statusbar|status-bar" ui/src --files-with-matches`). Add an element that polls `invoke("telegram_status")` every 5s and sets a class (`.tg-ok`, `.tg-err`, `.tg-off`) used by `styles.css` to color the icon. Click → opens Settings panel scrolled to the Telegram section.

- [ ] **Step 3: Per-tab override in context menu**

In the tab context menu module (`rg -n "context.*menu|tabContextMenu" ui/src/tabs`), add a submenu "Telegram notifications" with options Inherit/On/Off. Persist via existing tab settings save flow into `settings.telegram.per_tab_overrides[tabId].enabled = true|false|null`.

Update `TelegramNotifier::send_escalation` and `send_mission_event` to accept a `tab_id` and consult `per_tab_overrides` before global enable check. (Add `tab_id` param to both APIs and update Task 6 wiring.)

- [ ] **Step 4: Test override**

Manually: set a tab to "Off"; trigger escalation in that tab — Telegram does NOT receive it. Trigger in another tab — does receive.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(telegram): statusbar icon + per-tab override"
```

---

## Task 11: Final verification + docs

- [ ] **Step 1: Full test suite**

```bash
cargo test -p app
```
Expected: all green, no new warnings.

- [ ] **Step 2: Manual end-to-end checklist**

Run app, with Telegram configured:
- [ ] Blocklist trigger → Telegram message with 3 buttons.
- [ ] Tap Approve in Telegram → terminal modal closes as approved.
- [ ] Free-text reply ("usa --force") → operator continues with that instruction.
- [ ] Mission completion → Telegram receives ✅ message (no buttons).
- [ ] Resolve from terminal → Telegram message edits to "✓ Resolved".
- [ ] Disable Telegram in settings → escalations no longer notify.
- [ ] Per-tab Off → that tab's escalations don't notify; others do.
- [ ] Wrong chat_id sends a message to the bot → ignored, no terminal effect.

- [ ] **Step 3: Update CLAUDE.md milestone notes if needed**

If a "Telegram" section is appropriate under M-OP6 area, append a one-paragraph summary.

- [ ] **Step 4: Final commit + merge**

```bash
git add -A
git commit -m "chore(telegram): verify e2e + docs"
```

Then per project convention (worktree merge to main or PR per finishing-a-development-branch skill).
