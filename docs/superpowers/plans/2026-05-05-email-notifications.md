# Email Notifications via SendGrid — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SendGrid email as a second notification channel alongside OS popups, gated by an in-Settings API key, with immediate delivery for escalations and a periodic digest for info-severity events.

**Architecture:** New `crates/app/src/email/` module exposes an `EmailNotifier` mirroring the existing `Notifier` pattern. A thin `notifications::dispatch(trigger, …)` aggregator fans out to OS + email channels in parallel. Escalations (`OperatorEscalate`, `AomError`) send immediately; `AomComplete` is buffered and flushed every N minutes by a background task. Settings gain `sendgrid_api_key` (top-level) and four fields under `NotificationConfig`. Templates are embedded plain-text constants; SendGrid v3 mail/send is called via `reqwest` behind a `SendGridClient` trait so tests use a recording mock.

**Tech Stack:** Rust (tokio, reqwest, serde, tracing, async_trait), Tauri 2, plain-TS frontend. Spec: `docs/superpowers/specs/2026-05-05-email-notifications-design.md`.

---

## File Structure

**New files:**
- `crates/app/src/email/mod.rs` — `EmailNotifier`, `EmailOutcome`, `EmailMessage`, `Severity`, public API.
- `crates/app/src/email/client.rs` — `SendGridClient` trait + `HttpSendGridClient` (reqwest impl) + `RecordingSendGridClient` for tests.
- `crates/app/src/email/digest.rs` — buffered digest state + spawn helper.
- `crates/app/src/email/templates.rs` — `ESCALATION_TEMPLATE`, `DIGEST_TEMPLATE`.
- `crates/app/src/notifications.rs` — `dispatch(trigger, ctx)` fan-out aggregator.

**Modified files:**
- `crates/app/src/settings.rs` — add `sendgrid_api_key`, extend `NotificationConfig`.
- `crates/app/src/notify.rs` — add `Severity` enum and `Trigger::severity()` (or move to `email/mod.rs` and re-import — see Task 3).
- `crates/app/src/operator.rs:1996` and `:2060` — replace `notifier.emit(...)` with `notifications::dispatch(...)`.
- `crates/app/src/lib.rs:1327` — replace AOM-complete `notifier.emit(...)` with dispatch; wire `EmailNotifier` construction at `:2143`.
- `crates/app/Cargo.toml` — add `async-trait`, `wiremock` (dev), confirm `reqwest` features.
- Frontend Settings panel (`ui/src/settings/*` — locate during Task 11) — add Email section.

---

## Task 1: Settings — add `sendgrid_api_key` + `NotificationConfig` email fields

**Files:**
- Modify: `crates/app/src/settings.rs`
- Test: `crates/app/src/settings.rs` (existing `#[cfg(test)] mod tests`)

- [ ] **Step 1: Write the failing test**

Append to the existing test module in `crates/app/src/settings.rs`:

```rust
    #[test]
    fn settings_round_trip_email_fields() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let mut s = Settings::default();
        s.sendgrid_api_key = Some("SG.test".to_string());
        s.notifications.email_enabled = true;
        s.notifications.email_from = Some("from@example.com".to_string());
        s.notifications.email_to = Some("to@example.com".to_string());
        s.notifications.email_digest_window_minutes = 30;
        save_to_path(&s, &path).unwrap();
        let loaded = load_from_path(&path).unwrap();
        assert_eq!(loaded.sendgrid_api_key.as_deref(), Some("SG.test"));
        assert!(loaded.notifications.email_enabled);
        assert_eq!(loaded.notifications.email_from.as_deref(), Some("from@example.com"));
        assert_eq!(loaded.notifications.email_to.as_deref(), Some("to@example.com"));
        assert_eq!(loaded.notifications.email_digest_window_minutes, 30);
    }

    #[test]
    fn settings_back_compat_missing_email_fields() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        // Hand-write an old settings.json with no email fields.
        std::fs::write(&path, r#"{"anthropic_api_key":null}"#).unwrap();
        let loaded = load_from_path(&path).unwrap();
        assert!(loaded.sendgrid_api_key.is_none());
        assert!(!loaded.notifications.email_enabled);
        assert!(loaded.notifications.email_from.is_none());
        assert!(loaded.notifications.email_to.is_none());
        assert_eq!(loaded.notifications.email_digest_window_minutes, 15);
    }
```

(Names `save_to_path`/`load_from_path` must match what already exists in the file. If they differ, adjust the call sites — do not invent new helpers.)

- [ ] **Step 2: Run tests — expect failure**

```bash
cargo test -p karl-app settings::tests::settings_round_trip_email_fields settings::tests::settings_back_compat_missing_email_fields
```

Expected: compile error — fields don't exist yet.

- [ ] **Step 3: Add the fields**

In `crates/app/src/settings.rs`, in the `Settings` struct add (next to `anthropic_api_key`):

```rust
    #[serde(default)]
    pub sendgrid_api_key: Option<String>,
```

In `NotificationConfig` (around line 122) add:

```rust
    #[serde(default)]
    pub email_enabled: bool,
    #[serde(default)]
    pub email_from: Option<String>,
    #[serde(default)]
    pub email_to: Option<String>,
    #[serde(default = "default_digest_window")]
    pub email_digest_window_minutes: u32,
```

Add the helper near `default_true`:

```rust
fn default_digest_window() -> u32 {
    15
}
```

In `NotificationConfig::default()` add:

```rust
            email_enabled: false,
            email_from: None,
            email_to: None,
            email_digest_window_minutes: 15,
```

In `Settings::default()` add `sendgrid_api_key: None,` next to `anthropic_api_key: None,`.

In the persistence helper (`crates/app/src/settings.rs:430` area where `anthropic_api_key` is sanitized) mirror the empty-string-to-None logic for `sendgrid_api_key`:

```rust
    if let Some(ref key) = to_persist.sendgrid_api_key {
        if key.trim().is_empty() {
            to_persist.sendgrid_api_key = None;
        }
    }
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cargo test -p karl-app settings::
```

Expected: all settings tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/settings.rs
git commit -m "feat(settings): add SendGrid key and email notification config fields"
```

---

## Task 2: Add `async-trait` and `wiremock` dependencies

**Files:**
- Modify: `crates/app/Cargo.toml`

- [ ] **Step 1: Add deps**

Under `[dependencies]` in `crates/app/Cargo.toml` add:

```toml
async-trait = "0.1"
```

Under `[dev-dependencies]` add (create the section if missing):

```toml
wiremock = "0.6"
tempfile = "3"
```

(Skip any line that already exists.)

- [ ] **Step 2: Verify compile**

```bash
cargo check -p karl-app
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add crates/app/Cargo.toml Cargo.lock
git commit -m "chore(app): add async-trait + wiremock deps for email channel"
```

---

## Task 3: `Severity` + `Trigger::severity()`

**Files:**
- Modify: `crates/app/src/notify.rs`
- Test: `crates/app/src/notify.rs` (existing test module)

- [ ] **Step 1: Write the failing test**

Append to `mod tests` in `crates/app/src/notify.rs`:

```rust
    #[test]
    fn trigger_severity_routes_correctly() {
        assert_eq!(Trigger::OperatorEscalate.severity(), Severity::Escalation);
        assert_eq!(Trigger::AomError.severity(), Severity::Escalation);
        assert_eq!(Trigger::AomComplete.severity(), Severity::Info);
    }
```

- [ ] **Step 2: Run — expect failure**

```bash
cargo test -p karl-app notify::tests::trigger_severity_routes_correctly
```

Expected: `Severity` not in scope.

- [ ] **Step 3: Implement**

In `crates/app/src/notify.rs`, near the `Trigger` definition add:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Escalation,
    Info,
}

impl Trigger {
    pub fn severity(self) -> Severity {
        match self {
            Trigger::OperatorEscalate | Trigger::AomError => Severity::Escalation,
            Trigger::AomComplete => Severity::Info,
        }
    }
}
```

(If Rust complains about `impl Trigger` collision, add the method inside the existing `impl Trigger` block instead.)

- [ ] **Step 4: Run — expect pass**

```bash
cargo test -p karl-app notify::
```

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/notify.rs
git commit -m "feat(notify): classify Trigger by Severity for channel routing"
```

---

## Task 4: Templates module

**Files:**
- Create: `crates/app/src/email/mod.rs` (initially just `pub mod templates;`)
- Create: `crates/app/src/email/templates.rs`
- Modify: `crates/app/src/lib.rs` (add `pub mod email;`)

- [ ] **Step 1: Write the failing test**

Create `crates/app/src/email/templates.rs`:

```rust
pub const ESCALATION_TEMPLATE: &str = "[Covenant] {label}\n\n\
Session: {session}\n\
When:    {timestamp}\n\
Cwd:     {cwd}\n\n\
{title}\n\n\
{body}\n";

pub const DIGEST_TEMPLATE: &str = "[Covenant] Activity digest — {count} event(s)\n\n\
Window: {window_start} → {window_end}\n\n\
{entries}\n\n\
—\n\
This digest groups Info-severity events from the last {minutes} minutes.\n";

pub fn render_escalation(
    label: &str,
    session: &str,
    timestamp: &str,
    cwd: &str,
    title: &str,
    body: &str,
) -> String {
    ESCALATION_TEMPLATE
        .replace("{label}", label)
        .replace("{session}", session)
        .replace("{timestamp}", timestamp)
        .replace("{cwd}", cwd)
        .replace("{title}", title)
        .replace("{body}", body)
}

pub fn render_digest(
    count: usize,
    window_start: &str,
    window_end: &str,
    minutes: u32,
    entries: &str,
) -> String {
    DIGEST_TEMPLATE
        .replace("{count}", &count.to_string())
        .replace("{window_start}", window_start)
        .replace("{window_end}", window_end)
        .replace("{minutes}", &minutes.to_string())
        .replace("{entries}", entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escalation_substitutes_all_placeholders() {
        let out = render_escalation("op_escalate", "01HX", "2026-05-05T12:00:00Z", "/tmp", "paused", "blocked on input");
        assert!(out.contains("op_escalate"));
        assert!(out.contains("01HX"));
        assert!(out.contains("2026-05-05T12:00:00Z"));
        assert!(out.contains("/tmp"));
        assert!(out.contains("paused"));
        assert!(out.contains("blocked on input"));
        assert!(!out.contains("{"));
    }

    #[test]
    fn digest_substitutes_all_placeholders() {
        let out = render_digest(3, "12:00", "12:15", 15, "- a\n- b\n- c");
        assert!(out.contains("3 event(s)"));
        assert!(out.contains("12:00 → 12:15"));
        assert!(out.contains("- a"));
        assert!(out.contains("last 15 minutes"));
        assert!(!out.contains("{"));
    }
}
```

Create `crates/app/src/email/mod.rs`:

```rust
pub mod templates;
```

In `crates/app/src/lib.rs` near other `pub mod` declarations add:

```rust
pub mod email;
```

- [ ] **Step 2: Run — expect pass**

```bash
cargo test -p karl-app email::templates::
```

- [ ] **Step 3: Commit**

```bash
git add crates/app/src/email/ crates/app/src/lib.rs
git commit -m "feat(email): add embedded plain-text templates for escalation and digest"
```

---

## Task 5: `SendGridClient` trait + `RecordingSendGridClient`

**Files:**
- Create: `crates/app/src/email/client.rs`
- Modify: `crates/app/src/email/mod.rs`

- [ ] **Step 1: Write the failing test**

Create `crates/app/src/email/client.rs`:

```rust
use async_trait::async_trait;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmailMessage {
    pub from: String,
    pub to: String,
    pub subject: String,
    pub body: String,
}

#[derive(Debug, thiserror::Error)]
pub enum EmailError {
    #[error("missing config")]
    MissingConfig,
    #[error("sendgrid http {0}")]
    Http(u16),
    #[error("network: {0}")]
    Network(String),
    #[error("serialize: {0}")]
    Serialize(String),
}

#[async_trait]
pub trait SendGridClient: Send + Sync {
    async fn send(&self, msg: EmailMessage) -> Result<(), EmailError>;
}

#[derive(Default, Clone)]
pub struct RecordingSendGridClient {
    pub sent: Arc<Mutex<Vec<EmailMessage>>>,
}

#[async_trait]
impl SendGridClient for RecordingSendGridClient {
    async fn send(&self, msg: EmailMessage) -> Result<(), EmailError> {
        self.sent.lock().unwrap().push(msg);
        Ok(())
    }
}

impl RecordingSendGridClient {
    pub fn snapshot(&self) -> Vec<EmailMessage> {
        self.sent.lock().unwrap().clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn recording_client_captures_message() {
        let c = RecordingSendGridClient::default();
        c.send(EmailMessage {
            from: "a@b".into(),
            to: "c@d".into(),
            subject: "s".into(),
            body: "b".into(),
        })
        .await
        .unwrap();
        let snap = c.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].subject, "s");
    }
}
```

Update `crates/app/src/email/mod.rs`:

```rust
pub mod client;
pub mod templates;
```

Confirm `karl-app` already depends on `thiserror` and `tokio` (it does — used elsewhere). If not, add them.

- [ ] **Step 2: Run — expect pass**

```bash
cargo test -p karl-app email::client::
```

- [ ] **Step 3: Commit**

```bash
git add crates/app/src/email/
git commit -m "feat(email): SendGridClient trait + recording test double"
```

---

## Task 6: `HttpSendGridClient` (reqwest impl) — golden body fixture

**Files:**
- Modify: `crates/app/src/email/client.rs`

- [ ] **Step 1: Write the failing test**

Append to the `tests` module in `crates/app/src/email/client.rs`:

```rust
    #[test]
    fn http_client_builds_v3_mail_send_body() {
        let body = HttpSendGridClient::serialize_body(&EmailMessage {
            from: "from@example.com".into(),
            to: "to@example.com".into(),
            subject: "hello".into(),
            body: "world".into(),
        })
        .unwrap();
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["from"]["email"], "from@example.com");
        assert_eq!(v["personalizations"][0]["to"][0]["email"], "to@example.com");
        assert_eq!(v["subject"], "hello");
        assert_eq!(v["content"][0]["type"], "text/plain");
        assert_eq!(v["content"][0]["value"], "world");
    }

    #[tokio::test]
    async fn http_client_posts_to_sendgrid() {
        use wiremock::matchers::{header, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v3/mail/send"))
            .and(header("authorization", "Bearer SG.unit"))
            .respond_with(ResponseTemplate::new(202))
            .mount(&server)
            .await;

        let client = HttpSendGridClient::with_base_url("SG.unit".into(), server.uri());
        client
            .send(EmailMessage {
                from: "f@x".into(),
                to: "t@x".into(),
                subject: "s".into(),
                body: "b".into(),
            })
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn http_client_maps_401_to_http_err() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v3/mail/send"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;

        let client = HttpSendGridClient::with_base_url("bad".into(), server.uri());
        let err = client
            .send(EmailMessage {
                from: "f@x".into(),
                to: "t@x".into(),
                subject: "s".into(),
                body: "b".into(),
            })
            .await
            .unwrap_err();
        assert!(matches!(err, EmailError::Http(401)));
    }
```

- [ ] **Step 2: Run — expect failure**

```bash
cargo test -p karl-app email::client::tests::http
```

Expected: `HttpSendGridClient` does not exist.

- [ ] **Step 3: Implement**

Append to `crates/app/src/email/client.rs`:

```rust
const SENDGRID_BASE_URL: &str = "https://api.sendgrid.com";
const SENDGRID_PATH: &str = "/v3/mail/send";

pub struct HttpSendGridClient {
    api_key: String,
    base_url: String,
    http: reqwest::Client,
}

impl HttpSendGridClient {
    pub fn new(api_key: String) -> Self {
        Self::with_base_url(api_key, SENDGRID_BASE_URL.to_string())
    }

    pub fn with_base_url(api_key: String, base_url: String) -> Self {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("reqwest client");
        Self { api_key, base_url, http }
    }

    pub fn serialize_body(msg: &EmailMessage) -> Result<String, EmailError> {
        let v = serde_json::json!({
            "personalizations": [{
                "to": [{ "email": msg.to }]
            }],
            "from": { "email": msg.from },
            "subject": msg.subject,
            "content": [{
                "type": "text/plain",
                "value": msg.body
            }]
        });
        serde_json::to_string(&v).map_err(|e| EmailError::Serialize(e.to_string()))
    }
}

#[async_trait]
impl SendGridClient for HttpSendGridClient {
    async fn send(&self, msg: EmailMessage) -> Result<(), EmailError> {
        let body = Self::serialize_body(&msg)?;
        let url = format!("{}{}", self.base_url, SENDGRID_PATH);
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.api_key)
            .header("content-type", "application/json")
            .body(body)
            .send()
            .await
            .map_err(|e| EmailError::Network(e.to_string()))?;
        let status = resp.status();
        if status.is_success() {
            Ok(())
        } else {
            Err(EmailError::Http(status.as_u16()))
        }
    }
}
```

- [ ] **Step 4: Run — expect pass**

```bash
cargo test -p karl-app email::client::
```

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/email/client.rs
git commit -m "feat(email): HTTP SendGrid client over reqwest with wiremock tests"
```

---

## Task 7: Digest buffer + drain logic (no spawn yet)

**Files:**
- Create: `crates/app/src/email/digest.rs`
- Modify: `crates/app/src/email/mod.rs`

- [ ] **Step 1: Write the failing test**

Create `crates/app/src/email/digest.rs`:

```rust
use std::sync::Mutex;
use std::time::SystemTime;

#[derive(Debug, Clone)]
pub struct DigestEntry {
    pub at: SystemTime,
    pub label: String,
    pub summary: String,
}

#[derive(Default)]
pub struct DigestBuffer {
    entries: Mutex<Vec<DigestEntry>>,
}

impl DigestBuffer {
    pub fn push(&self, entry: DigestEntry) {
        self.entries.lock().unwrap().push(entry);
    }

    pub fn drain(&self) -> Vec<DigestEntry> {
        std::mem::take(&mut *self.entries.lock().unwrap())
    }

    pub fn len(&self) -> usize {
        self.entries.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

pub fn format_entries(entries: &[DigestEntry]) -> String {
    use std::time::UNIX_EPOCH;
    entries
        .iter()
        .map(|e| {
            let secs = e
                .at
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            format!("- t={secs} [{}] {}", e.label, e.summary)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(label: &str, summary: &str) -> DigestEntry {
        DigestEntry {
            at: SystemTime::now(),
            label: label.into(),
            summary: summary.into(),
        }
    }

    #[test]
    fn push_and_drain_roundtrip() {
        let b = DigestBuffer::default();
        assert!(b.is_empty());
        b.push(entry("aom_complete", "ok"));
        b.push(entry("aom_complete", "again"));
        assert_eq!(b.len(), 2);
        let drained = b.drain();
        assert_eq!(drained.len(), 2);
        assert!(b.is_empty());
    }

    #[test]
    fn drain_on_empty_returns_empty() {
        let b = DigestBuffer::default();
        assert!(b.drain().is_empty());
    }

    #[test]
    fn format_entries_emits_one_line_each() {
        let e = vec![entry("aom_complete", "ok"), entry("aom_complete", "two")];
        let s = format_entries(&e);
        assert_eq!(s.lines().count(), 2);
        assert!(s.contains("aom_complete"));
    }
}
```

Update `crates/app/src/email/mod.rs`:

```rust
pub mod client;
pub mod digest;
pub mod templates;
```

- [ ] **Step 2: Run — expect pass**

```bash
cargo test -p karl-app email::digest::
```

- [ ] **Step 3: Commit**

```bash
git add crates/app/src/email/
git commit -m "feat(email): digest buffer with drain semantics"
```

---

## Task 8: `EmailNotifier` — gating, throttle, severity routing

**Files:**
- Modify: `crates/app/src/email/mod.rs`

- [ ] **Step 1: Write the failing test**

Replace `crates/app/src/email/mod.rs` with:

```rust
pub mod client;
pub mod digest;
pub mod templates;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex as AsyncMutex;

use crate::notify::{Severity, Trigger};
use crate::settings::Settings;
use client::{EmailMessage, SendGridClient};
use digest::{DigestBuffer, DigestEntry};

const EMAIL_THROTTLE_WINDOW: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmailOutcome {
    Sent,
    Buffered,
    SuppressedByConfig,
    SuppressedByThrottle,
    Failed,
}

#[derive(Default)]
struct EmailThrottle {
    last_fire: HashMap<Trigger, Instant>,
}

impl EmailThrottle {
    fn allow(&mut self, trigger: Trigger, now: Instant) -> bool {
        match self.last_fire.get(&trigger).copied() {
            Some(prev) if now.duration_since(prev) < EMAIL_THROTTLE_WINDOW => false,
            _ => {
                self.last_fire.insert(trigger, now);
                true
            }
        }
    }
}

pub struct EmailNotifier {
    client: Arc<dyn SendGridClient>,
    settings: Arc<AsyncMutex<Settings>>,
    throttle: std::sync::Mutex<EmailThrottle>,
    pub(crate) buffer: Arc<DigestBuffer>,
}

impl EmailNotifier {
    pub fn new(client: Arc<dyn SendGridClient>, settings: Arc<AsyncMutex<Settings>>) -> Self {
        Self {
            client,
            settings,
            throttle: std::sync::Mutex::new(EmailThrottle::default()),
            buffer: Arc::new(DigestBuffer::default()),
        }
    }

    pub async fn emit(
        &self,
        trigger: Trigger,
        subject: String,
        body: String,
        session_short: String,
    ) -> EmailOutcome {
        let s = self.settings.lock().await;
        let cfg = s.notifications.clone();
        let key = s.sendgrid_api_key.clone();
        drop(s);

        let activated = cfg.email_enabled
            && key.as_deref().map(|k| !k.trim().is_empty()).unwrap_or(false)
            && cfg.email_from.is_some()
            && cfg.email_to.is_some();
        if !activated {
            tracing::info!(channel = "email", trigger = ?trigger, outcome = "SuppressedByConfig", "email");
            return EmailOutcome::SuppressedByConfig;
        }

        match trigger.severity() {
            Severity::Info => {
                self.buffer.push(DigestEntry {
                    at: std::time::SystemTime::now(),
                    label: format!("{:?}", trigger),
                    summary: body,
                });
                tracing::info!(channel = "email", trigger = ?trigger, outcome = "Buffered", "email");
                EmailOutcome::Buffered
            }
            Severity::Escalation => {
                if !self.allow_now(trigger) {
                    tracing::info!(channel = "email", trigger = ?trigger, outcome = "SuppressedByThrottle", "email");
                    return EmailOutcome::SuppressedByThrottle;
                }
                let msg = EmailMessage {
                    from: cfg.email_from.unwrap(),
                    to: cfg.email_to.unwrap(),
                    subject: format!("[Covenant] {} — {}", format!("{:?}", trigger), session_short),
                    body,
                };
                match self.client.send(msg).await {
                    Ok(()) => {
                        tracing::info!(channel = "email", trigger = ?trigger, outcome = "Sent", "email");
                        EmailOutcome::Sent
                    }
                    Err(e) => {
                        tracing::warn!(channel = "email", trigger = ?trigger, error = %e, "email send failed");
                        EmailOutcome::Failed
                    }
                }
            }
        }
    }

    fn allow_now(&self, trigger: Trigger) -> bool {
        let mut t = match self.throttle.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        t.allow(trigger, Instant::now())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::Settings;
    use client::RecordingSendGridClient;

    fn settings_with(
        enabled: bool,
        key: Option<&str>,
        from: Option<&str>,
        to: Option<&str>,
    ) -> Arc<AsyncMutex<Settings>> {
        let mut s = Settings::default();
        s.sendgrid_api_key = key.map(|k| k.to_string());
        s.notifications.email_enabled = enabled;
        s.notifications.email_from = from.map(|x| x.to_string());
        s.notifications.email_to = to.map(|x| x.to_string());
        Arc::new(AsyncMutex::new(s))
    }

    #[tokio::test]
    async fn missing_config_suppresses() {
        let rec = Arc::new(RecordingSendGridClient::default());
        let n = EmailNotifier::new(rec.clone(), settings_with(true, None, Some("a@b"), Some("c@d")));
        let out = n
            .emit(Trigger::OperatorEscalate, "s".into(), "b".into(), "01H".into())
            .await;
        assert_eq!(out, EmailOutcome::SuppressedByConfig);
        assert!(rec.snapshot().is_empty());
    }

    #[tokio::test]
    async fn escalation_sends_immediately() {
        let rec = Arc::new(RecordingSendGridClient::default());
        let n = EmailNotifier::new(
            rec.clone(),
            settings_with(true, Some("SG"), Some("a@b"), Some("c@d")),
        );
        let out = n
            .emit(Trigger::OperatorEscalate, "s".into(), "blocked".into(), "01H".into())
            .await;
        assert_eq!(out, EmailOutcome::Sent);
        let snap = rec.snapshot();
        assert_eq!(snap.len(), 1);
        assert!(snap[0].subject.contains("01H"));
    }

    #[tokio::test]
    async fn info_is_buffered_not_sent() {
        let rec = Arc::new(RecordingSendGridClient::default());
        let n = EmailNotifier::new(
            rec.clone(),
            settings_with(true, Some("SG"), Some("a@b"), Some("c@d")),
        );
        let out = n
            .emit(Trigger::AomComplete, "s".into(), "done".into(), "01H".into())
            .await;
        assert_eq!(out, EmailOutcome::Buffered);
        assert!(rec.snapshot().is_empty());
        assert_eq!(n.buffer.len(), 1);
    }

    #[tokio::test]
    async fn escalation_is_throttled_within_60s() {
        let rec = Arc::new(RecordingSendGridClient::default());
        let n = EmailNotifier::new(
            rec.clone(),
            settings_with(true, Some("SG"), Some("a@b"), Some("c@d")),
        );
        let _ = n
            .emit(Trigger::OperatorEscalate, "s".into(), "x".into(), "01H".into())
            .await;
        let out = n
            .emit(Trigger::OperatorEscalate, "s".into(), "y".into(), "01H".into())
            .await;
        assert_eq!(out, EmailOutcome::SuppressedByThrottle);
        assert_eq!(rec.snapshot().len(), 1);
    }

    #[test]
    fn throttle_releases_after_window() {
        let mut t = EmailThrottle::default();
        let t0 = Instant::now();
        assert!(t.allow(Trigger::AomError, t0));
        assert!(!t.allow(Trigger::AomError, t0 + Duration::from_secs(30)));
        assert!(t.allow(Trigger::AomError, t0 + Duration::from_secs(61)));
    }
}
```

- [ ] **Step 2: Run — expect pass**

```bash
cargo test -p karl-app email::
```

- [ ] **Step 3: Commit**

```bash
git add crates/app/src/email/
git commit -m "feat(email): EmailNotifier with severity routing, gating, 60s throttle"
```

---

## Task 9: Digest flush task (background tokio task)

**Files:**
- Modify: `crates/app/src/email/digest.rs`
- Modify: `crates/app/src/email/mod.rs`

- [ ] **Step 1: Write the failing test**

Append to `crates/app/src/email/digest.rs`:

```rust
#[cfg(test)]
mod flush_tests {
    use super::*;
    use crate::email::client::{EmailMessage, RecordingSendGridClient, SendGridClient};
    use std::sync::Arc;
    use std::time::Duration;

    #[tokio::test(start_paused = true)]
    async fn flush_emits_one_email_per_window_with_entries() {
        let buf = Arc::new(DigestBuffer::default());
        let client: Arc<dyn SendGridClient> = Arc::new(RecordingSendGridClient::default());
        let recorder = Arc::clone(&client) as Arc<dyn SendGridClient>;
        let _ = recorder; // silence

        // Push two entries before any tick.
        buf.push(DigestEntry {
            at: std::time::SystemTime::now(),
            label: "AomComplete".into(),
            summary: "first".into(),
        });
        buf.push(DigestEntry {
            at: std::time::SystemTime::now(),
            label: "AomComplete".into(),
            summary: "second".into(),
        });

        let buf2 = Arc::clone(&buf);
        let client2 = Arc::clone(&client);
        let handle = tokio::spawn(spawn_flush_loop(
            buf2,
            client2,
            "from@x".into(),
            "to@x".into(),
            Duration::from_secs(60),
        ));

        tokio::time::advance(Duration::from_secs(61)).await;
        tokio::task::yield_now().await;
        // Stop the loop.
        handle.abort();

        // Downcast to RecordingSendGridClient via Arc — easier: keep a typed handle.
        // (Replaced below in the implementation step.)
        let _ = (); // placeholder; see Step 3 for the real assertion path.
    }
}
```

Note: the test above is a sketch; the implementation step will replace it with a working version that keeps a typed `Arc<RecordingSendGridClient>` handle. Carry that change through.

- [ ] **Step 2: Run — expect compile error**

```bash
cargo test -p karl-app email::digest::flush_tests
```

Expected: `spawn_flush_loop` not found.

- [ ] **Step 3: Implement + replace the test sketch**

Replace the `flush_tests` module with:

```rust
#[cfg(test)]
mod flush_tests {
    use super::*;
    use crate::email::client::{RecordingSendGridClient, SendGridClient};
    use std::sync::Arc;
    use std::time::Duration;

    #[tokio::test(start_paused = true)]
    async fn flush_emits_one_email_when_buffer_has_entries() {
        let buf = Arc::new(DigestBuffer::default());
        let recording = Arc::new(RecordingSendGridClient::default());
        let client: Arc<dyn SendGridClient> = recording.clone();

        buf.push(DigestEntry {
            at: std::time::SystemTime::now(),
            label: "AomComplete".into(),
            summary: "first".into(),
        });
        buf.push(DigestEntry {
            at: std::time::SystemTime::now(),
            label: "AomComplete".into(),
            summary: "second".into(),
        });

        let handle = tokio::spawn(spawn_flush_loop(
            Arc::clone(&buf),
            client,
            "from@x".into(),
            "to@x".into(),
            Duration::from_secs(60),
        ));

        tokio::time::advance(Duration::from_secs(61)).await;
        tokio::task::yield_now().await;
        handle.abort();

        let snap = recording.snapshot();
        assert_eq!(snap.len(), 1, "expected exactly one digest email");
        assert!(snap[0].subject.contains("2 event(s)"));
        assert!(snap[0].body.contains("first"));
        assert!(snap[0].body.contains("second"));
        assert!(buf.is_empty(), "buffer should be drained");
    }

    #[tokio::test(start_paused = true)]
    async fn flush_skips_when_buffer_empty() {
        let buf = Arc::new(DigestBuffer::default());
        let recording = Arc::new(RecordingSendGridClient::default());
        let client: Arc<dyn SendGridClient> = recording.clone();

        let handle = tokio::spawn(spawn_flush_loop(
            Arc::clone(&buf),
            client,
            "from@x".into(),
            "to@x".into(),
            Duration::from_secs(60),
        ));

        tokio::time::advance(Duration::from_secs(61)).await;
        tokio::task::yield_now().await;
        handle.abort();

        assert!(recording.snapshot().is_empty());
    }
}
```

Append to `crates/app/src/email/digest.rs` (outside the test module):

```rust
use std::sync::Arc;

pub async fn spawn_flush_loop(
    buffer: Arc<DigestBuffer>,
    client: Arc<dyn crate::email::client::SendGridClient>,
    from: String,
    to: String,
    window: std::time::Duration,
) {
    use crate::email::client::EmailMessage;
    use crate::email::templates::render_digest;
    let mut interval = tokio::time::interval(window);
    interval.tick().await; // skip the immediate first tick
    loop {
        interval.tick().await;
        let entries = buffer.drain();
        if entries.is_empty() {
            continue;
        }
        let count = entries.len();
        let body = render_digest(
            count,
            "now",
            "now",
            (window.as_secs() / 60) as u32,
            &format_entries(&entries),
        );
        let msg = EmailMessage {
            from: from.clone(),
            to: to.clone(),
            subject: format!("[Covenant] Activity digest — {} event(s)", count),
            body,
        };
        if let Err(e) = client.send(msg).await {
            tracing::warn!(error = %e, "digest flush failed");
        }
    }
}
```

- [ ] **Step 4: Run — expect pass**

```bash
cargo test -p karl-app email::digest::flush_tests
```

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/email/
git commit -m "feat(email): periodic digest flush task with empty-window skip"
```

---

## Task 10: `notifications::dispatch` aggregator

**Files:**
- Create: `crates/app/src/notifications.rs`
- Modify: `crates/app/src/lib.rs` (declare `pub mod notifications;`)
- Modify: `crates/app/src/operator.rs:1996` and `:2060` — replace `notifier.emit(...)` with `notifications::dispatch(...)`.
- Modify: `crates/app/src/lib.rs:1327` — replace AOM-complete `notifier.emit(...)` similarly.

- [ ] **Step 1: Write the failing test**

Create `crates/app/src/notifications.rs`:

```rust
use std::sync::Arc;

use karl_session::SessionId;

use crate::email::{EmailNotifier, EmailOutcome};
use crate::notify::{Notifier, Trigger};

pub struct DispatchCtx {
    pub trigger: Trigger,
    pub title: String,
    pub body: String,
    pub session_id: Option<SessionId>,
}

pub struct DispatchResult {
    pub email: EmailOutcome,
}

pub async fn dispatch(
    notifier: &Notifier,
    email: &EmailNotifier,
    ctx: DispatchCtx,
) -> DispatchResult {
    let session_short = ctx
        .session_id
        .map(|s| s.to_string().chars().take(6).collect::<String>())
        .unwrap_or_else(|| "-".into());
    let DispatchCtx { trigger, title, body, session_id } = ctx;
    let title2 = title.clone();
    let body2 = body.clone();
    let (_, email_out) = tokio::join!(
        notifier.emit(trigger, title, body, session_id),
        email.emit(trigger, title2, body2, session_short),
    );
    DispatchResult { email: email_out }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::email::client::{RecordingSendGridClient, SendGridClient};
    use crate::settings::Settings;
    use std::sync::Arc;
    use tokio::sync::Mutex as AsyncMutex;

    // No real Notifier construction in unit tests (needs AppHandle).
    // The dispatch function is exercised end-to-end in the email-side
    // tests; here we just assert the email side runs through dispatch's
    // join arm by calling EmailNotifier::emit directly with the same
    // arguments — i.e. we trust tokio::join! semantics rather than
    // mocking AppHandle.

    #[tokio::test]
    async fn email_path_runs_with_full_config() {
        let mut s = Settings::default();
        s.sendgrid_api_key = Some("SG".into());
        s.notifications.email_enabled = true;
        s.notifications.email_from = Some("a@b".into());
        s.notifications.email_to = Some("c@d".into());
        let settings = Arc::new(AsyncMutex::new(s));
        let rec = Arc::new(RecordingSendGridClient::default());
        let client: Arc<dyn SendGridClient> = rec.clone();
        let email = EmailNotifier::new(client, settings);
        let out = email
            .emit(Trigger::OperatorEscalate, "title".into(), "body".into(), "01HABC".into())
            .await;
        assert_eq!(out, EmailOutcome::Sent);
        assert_eq!(rec.snapshot().len(), 1);
    }
}
```

In `crates/app/src/lib.rs` add (near other `pub mod`):

```rust
pub mod notifications;
```

- [ ] **Step 2: Run — expect pass**

```bash
cargo test -p karl-app notifications::
```

- [ ] **Step 3: Wire dispatch at the three call sites**

(a) `crates/app/src/operator.rs` around line 1996 — before the change the block calls `notifier.emit(Trigger::OperatorEscalate, ...).await`. Find the surrounding scope; the function signature must also receive `&EmailNotifier`. Add a parameter `email: &crate::email::EmailNotifier` to the same function (mirror how `notifier: &crate::notify::Notifier` is threaded — the signature is at `crates/app/src/operator.rs:1175`). Replace the `notifier.emit(...)` call with:

```rust
crate::notifications::dispatch(
    notifier,
    email,
    crate::notifications::DispatchCtx {
        trigger: crate::notify::Trigger::OperatorEscalate,
        title,
        body: body.to_string(),
        session_id: Some(session_id),
    },
)
.await;
```

(b) Same file around line 2060 (`AomError` path) — same replacement with `Trigger::AomError`.

(c) `crates/app/src/lib.rs:1327` — the AOM-complete path. Replace `notifier.emit(Trigger::AomComplete, ...)` with the dispatch call. The enclosing function must thread an `&EmailNotifier` argument; the construction site at `:2143` will supply it (see Task 11).

For each modification, also thread `email: Arc<EmailNotifier>` through the call chain wherever `notifier: Notifier` is currently passed. There are two spots in `operator.rs` (`:482`/`:496` struct field and `:1003`/`:1041` runner state) and one in `lib.rs` around the AOM driver.

- [ ] **Step 4: Run — expect compile + pass**

```bash
cargo test -p karl-app
```

Fix call-site mismatches as needed; do not change behavior of any other test.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/notifications.rs crates/app/src/lib.rs crates/app/src/operator.rs
git commit -m "feat(notifications): dispatch fan-out to OS + email channels"
```

---

## Task 11: Construct `EmailNotifier` at app startup, spawn flush task

**Files:**
- Modify: `crates/app/src/lib.rs` (around line 2143, where `Notifier::new` is called)

- [ ] **Step 1: Implement**

Locate the block in `crates/app/src/lib.rs` near line 2143 that constructs the `Notifier`. Immediately after, add:

```rust
let sendgrid_key = {
    let s = settings_arc.lock().await;
    s.sendgrid_api_key.clone().unwrap_or_default()
};
let sg_client: std::sync::Arc<dyn crate::email::client::SendGridClient> =
    std::sync::Arc::new(crate::email::client::HttpSendGridClient::new(sendgrid_key));
let email_notifier = std::sync::Arc::new(crate::email::EmailNotifier::new(
    sg_client.clone(),
    settings_arc.clone(),
));

// Spawn the digest flush loop. Pull from/to/window from settings at spawn
// time; if any are missing the buffer just stays empty and the loop is a no-op.
{
    let s = settings_arc.lock().await;
    let from = s.notifications.email_from.clone().unwrap_or_default();
    let to = s.notifications.email_to.clone().unwrap_or_default();
    let minutes = s.notifications.email_digest_window_minutes.max(1);
    drop(s);
    let buf = email_notifier.buffer.clone();
    let client = sg_client.clone();
    tokio::spawn(crate::email::digest::spawn_flush_loop(
        buf,
        client,
        from,
        to,
        std::time::Duration::from_secs((minutes as u64) * 60),
    ));
}
```

Then thread `email_notifier.clone()` through wherever `notifier.clone()` is currently passed (the AOM driver setup, the operator runner spawn). Match every existing `notifier` argument with an adjacent `email` argument.

- [ ] **Step 2: Run**

```bash
cargo build -p karl-app
cargo test -p karl-app
```

Expected: clean build, all tests pass.

- [ ] **Step 3: Commit**

```bash
git add crates/app/src/lib.rs
git commit -m "feat(email): wire EmailNotifier and digest flush at app startup"
```

---

## Task 12: Tauri command — `validate_sendgrid_key`

**Files:**
- Modify: `crates/app/src/lib.rs` (Tauri commands area)

- [ ] **Step 1: Write the failing test**

In `crates/app/src/email/client.rs`, add:

```rust
pub async fn check_key_via(base_url: &str, api_key: &str) -> Result<bool, EmailError> {
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| EmailError::Network(e.to_string()))?;
    let url = format!("{}/v3/scopes", base_url);
    let resp = http
        .get(&url)
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|e| EmailError::Network(e.to_string()))?;
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Ok(false);
    }
    if status.is_success() {
        return Ok(true);
    }
    Err(EmailError::Http(status.as_u16()))
}

#[cfg(test)]
mod scope_tests {
    use super::*;

    #[tokio::test]
    async fn key_check_true_on_200() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let s = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v3/scopes"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&s)
            .await;
        assert_eq!(check_key_via(&s.uri(), "k").await.unwrap(), true);
    }

    #[tokio::test]
    async fn key_check_false_on_401() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let s = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v3/scopes"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&s)
            .await;
        assert_eq!(check_key_via(&s.uri(), "k").await.unwrap(), false);
    }
}
```

- [ ] **Step 2: Run — expect pass**

```bash
cargo test -p karl-app email::client::scope_tests
```

- [ ] **Step 3: Add the Tauri command**

In `crates/app/src/lib.rs` near the other `#[tauri::command]` definitions add:

```rust
#[tauri::command]
async fn validate_sendgrid_key(
    app: tauri::AppHandle,
    api_key: String,
) -> Result<bool, String> {
    use tauri::Emitter;
    let base = "https://api.sendgrid.com";
    match crate::email::client::check_key_via(base, &api_key).await {
        Ok(true) => Ok(true),
        Ok(false) => {
            let _ = app.emit("sendgrid-key-invalid", ());
            Ok(false)
        }
        Err(e) => Err(e.to_string()),
    }
}
```

Register it in the `tauri::Builder::default().invoke_handler(tauri::generate_handler![...])` list (find the existing list in the same file and append `validate_sendgrid_key`).

- [ ] **Step 4: Build**

```bash
cargo build -p karl-app
```

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/email/client.rs crates/app/src/lib.rs
git commit -m "feat(email): validate_sendgrid_key Tauri command + sendgrid-key-invalid event"
```

---

## Task 13: Frontend Settings — Email subsection

**Files:**
- Locate first: `find ui/src -type f -name '*.ts' -o -name '*.html' | xargs grep -l 'on_operator_escalate\|notifications' | head`. The current Notifications panel is somewhere under `ui/src/`. Modify whatever file already renders the toggles for `on_operator_escalate`, `on_aom_error`, etc.

- [ ] **Step 1: Add the Email block under the existing Notifications section**

In the located file, append a new subsection that binds to:
- `settings.sendgrid_api_key` (password input with show/hide — reuse the same component used for `anthropic_api_key`)
- `settings.notifications.email_enabled` (toggle)
- `settings.notifications.email_from` (text input, type=email)
- `settings.notifications.email_to` (text input, type=email)
- `settings.notifications.email_digest_window_minutes` (range input min=5 max=60 step=5)

Inline warning when `email_enabled === true` and any of `sendgrid_api_key`, `email_from`, `email_to` is empty: `"Email notifications need API key, from, and to."`

When the user blurs the API key field with a non-empty value, call `invoke('validate_sendgrid_key', { apiKey: value })`. Subscribe to the Tauri event `sendgrid-key-invalid` and show a one-shot warning beside the field when received.

- [ ] **Step 2: Manual smoke test**

```bash
pnpm --dir ui dev
# In another shell:
cargo tauri dev
```

Open Settings → Notifications → confirm:
1. New Email subsection renders.
2. Toggle on without filling fields → warning appears, toggle stays on visually.
3. Fill all fields with a fake key → blur → warning event triggers (since key is invalid).
4. Save → settings.json on disk contains the new fields.

Document the manual result in the commit message body.

- [ ] **Step 3: Commit**

```bash
git add ui/
git commit -m "feat(ui): Settings — Email (SendGrid) subsection with key validation"
```

---

## Task 14: Wire `OperatorEscalate` truncation (parity with notify path)

The existing operator code truncates the body to 200 chars before passing it to the notifier. The dispatch refactor in Task 10 must preserve that truncation so the OS popup body stays tidy. Verify by re-reading `crates/app/src/operator.rs:1996` after the Task 10 changes — the call site must still hand the truncated string. If the truncation got dropped during the refactor, restore it inline in the dispatch ctx.

- [ ] **Step 1: Read the post-refactor call site**

```bash
sed -n '1985,2010p' crates/app/src/operator.rs
```

- [ ] **Step 2: If truncation was lost, restore it**

```rust
let body = msg.lines().next().unwrap_or(msg);
let body = truncate(body, 200).to_string();
```

Then commit if any change:

```bash
git add crates/app/src/operator.rs
git commit -m "fix(operator): preserve 200-char truncation through dispatch refactor"
```

(If no change needed, skip this commit.)

---

## Task 15: Spec → CHANGELOG + version bump

**Files:**
- Modify: `CHANGELOG.md` (or equivalent — confirm presence)
- Modify: `Cargo.toml` workspace version, `ui/package.json` version (if mirrored)

- [ ] **Step 1: Add CHANGELOG entry**

```markdown
## v0.2.13 — Email notifications via SendGrid

- New: SendGrid email channel for Operator escalations, AOM errors (immediate)
  and AOM completions (digest). Configure via Settings → Notifications → Email.
- Email channel is gated by an API key + from/to addresses; defaults off.
- Digest window configurable 5–60 minutes; default 15.
```

- [ ] **Step 2: Bump versions** if the project's release flow requires it (check recent commits — `release: v0.2.12` is the latest tag).

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md Cargo.toml ui/package.json
git commit -m "release: v0.2.13 — email notifications via SendGrid"
```

---

## Verification checklist (run before merge)

- [ ] `cargo test -p karl-app` — all green
- [ ] `cargo clippy -p karl-app -- -D warnings` — clean
- [ ] `cargo tauri dev` — manual smoke: trigger an operator escalate while email is configured with a real SendGrid sandbox key; verify email arrives. Then disable, trigger again — no email.
- [ ] AOM-complete fires; wait for digest window (or set it to 5 minutes for the test); verify single digest email arrives.
- [ ] Throttle: trigger two escalations within 60s; only one email sent.
- [ ] Bad key: enter an invalid key, blur → "key invalid" warning shows.
- [ ] Settings round-trip: close and reopen the app; Email config persists.
