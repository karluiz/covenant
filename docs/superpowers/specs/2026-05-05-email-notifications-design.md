# Email Notifications via SendGrid — Design Spec

**Date:** 2026-05-05
**Status:** Draft, pending review
**Owner:** karluiz
**Related:** spec 3.6 (`docs/specs/3.6-os-notifications.md`), `crates/app/src/notify.rs`

## Goal

Add email as a second notification channel alongside the existing OS popups, so the operator can be reached when the Covenant window is not in focus or the machine is locked. Channel activates only when a SendGrid API key is configured, mirroring how the Anthropic key gates LLM features today.

## Non-goals (v1)

- Multi-recipient delivery (single `to` address).
- HTML templates (plain text only).
- Retries / exponential backoff on transient SendGrid failures.
- User-editable templates.
- Migrating the SendGrid key to macOS Keychain (deferred with `anthropic_api_key` to M3.5).
- Surfacing email failures in the UI beyond a one-shot "key invalid" warning.

## Architecture

### New module: `crates/app/src/email/`

```
crates/app/src/email/
├── mod.rs          # EmailNotifier, EmailOutcome, public API
├── client.rs       # SendGridClient trait + HttpSendGridClient
├── digest.rs       # Buffered digest task for Info-severity events
└── templates.rs    # Embedded plain-text templates (const &str)
```

`notify.rs` (OS popups) and `email.rs` (SendGrid) are independent channels. A new thin module **`crates/app/src/notifications.rs`** exposes `dispatch(trigger, ctx)` which fans out to both channels in parallel via `tokio::join!`. All current call sites that invoke `Notifier::emit` are migrated to `notifications::dispatch`.

### Settings changes (`crates/app/src/settings.rs`)

Top-level `Settings` gains:

```rust
pub sendgrid_api_key: Option<String>,  // plain in settings.json (chmod 0600), same pattern as anthropic_api_key
```

`NotificationConfig` gains:

```rust
pub email_enabled: bool,                 // default false
pub email_from: Option<String>,          // default None
pub email_to: Option<String>,            // default None
pub email_digest_window_minutes: u32,    // default 15
```

All new fields use `#[serde(default)]` so existing settings.json files load without migration.

### Activation predicate

The email channel emits only when **all** of these hold:

```rust
cfg.email_enabled
  && settings.sendgrid_api_key.is_some()
  && cfg.email_from.is_some()
  && cfg.email_to.is_some()
```

Any missing field → `EmailOutcome::SuppressedByConfig`, log only, no SendGrid call.

## Triggers, severity, routing

Extend the existing `Trigger` enum (in `notify.rs`) with a `severity()` method:

| Trigger             | Severity     | Email mode                   |
|---------------------|--------------|------------------------------|
| `OperatorEscalate`  | `Escalation` | Immediate (1-per-event)      |
| `AomError`          | `Escalation` | Immediate (1-per-event)      |
| `AomComplete`       | `Info`       | Buffered into digest         |

```rust
pub enum Severity { Escalation, Info }

impl Trigger {
    pub fn severity(self) -> Severity {
        match self {
            Trigger::OperatorEscalate | Trigger::AomError => Severity::Escalation,
            Trigger::AomComplete => Severity::Info,
        }
    }
}
```

New triggers added later declare their severity and route automatically.

### Immediate path (Escalation)

- Independent throttle in the email channel: **60 seconds per trigger** (vs. 30s on the OS channel).
- Subject: `[Covenant] {trigger label} — {session short id}`
- Body: title + body of the trigger event + ISO-8601 timestamp + cwd if present.
- `suppress_when_focused` (OS-only) does **not** apply to email — email's job is reaching the operator when away.

### Digest path (Info)

- Buffer: `Arc<Mutex<Vec<DigestEntry>>>` inside `EmailNotifier`.
- A `tokio::task` spawned at notifier construction ticks every `email_digest_window_minutes` (default 15). On each tick:
  - If buffer empty → no-op.
  - Else → drain buffer, build single email with all entries in chronological order, send.
- App shutdown: best-effort flush with 2s timeout. Not guaranteed; log on failure.
- Subject: `[Covenant] Activity digest — {N} events`
- Body: chronological list, one line per event with timestamp + label + summary.

## SendGrid client

Trait-based for testability:

```rust
#[async_trait]
pub trait SendGridClient: Send + Sync {
    async fn send(&self, msg: EmailMessage) -> Result<(), EmailError>;
}

pub struct HttpSendGridClient {
    api_key: String,
    http: reqwest::Client,  // 10s timeout
}
```

- Endpoint: `POST https://api.sendgrid.com/v3/mail/send`
- Auth header: `Authorization: Bearer {api_key}`
- Body: SendGrid v3 mail/send JSON, `text/plain` content only.
- No retries in v1.

### Errors

```rust
pub enum EmailError {
    MissingConfig,
    Http(reqwest::StatusCode),
    Network(reqwest::Error),
    Serialize(serde_json::Error),
}
```

All errors → `tracing::warn!(channel="email", trigger=…, error=…)`. Never propagated to UI.
`401`/`403` from SendGrid → `tracing::error!` (key likely invalid).

### Key validation on save

When the user saves Settings with a new (or changed) `sendgrid_api_key`, fire an async health check:

- `GET https://api.sendgrid.com/v3/scopes` with the new key.
- On `401` → emit Tauri event `sendgrid-key-invalid` so the Settings UI can show a one-shot warning.
- Best-effort, does not block the save; absence of this event is not a positive confirmation.

## Outcomes

```rust
pub enum EmailOutcome {
    Sent,
    Buffered,            // Info-severity event added to digest
    SuppressedByConfig,  // missing key/from/to/disabled
    SuppressedByThrottle,
    Failed,              // client.send() returned Err
}
```

One `tracing::info` per outcome with the same structured fields as the OS channel (`trigger`, `outcome`, `session`, `subject`).

## UI changes

In the existing Settings → Notifications panel (frontend is plain TS, not React):

New subsection **"Email (SendGrid)"** rendered below the existing per-trigger toggles:

- `Enable email notifications` — master toggle (binds to `email_enabled`).
- `SendGrid API Key` — password input with show/hide, identical component used for the Anthropic key.
- `From email` — text input.
- `To email` — text input.
- `Digest window` — slider 5–60 minutes (binds to `email_digest_window_minutes`).

When the master toggle is on but any required field is empty, render an inline warning: "Email notifications need API key, from, and to." The toggle stays visually on; the backend's activation predicate is the source of truth for whether emails actually fire.

If a `sendgrid-key-invalid` event arrives, render a one-shot inline warning beside the API key field.

## Templates

`crates/app/src/email/templates.rs` exports two `const &str`:

```rust
pub const ESCALATION_TEMPLATE: &str = "\
[Covenant] {label}

Session: {session}
When:    {timestamp}
Cwd:     {cwd}

{title}

{body}
";

pub const DIGEST_TEMPLATE: &str = "\
[Covenant] Activity digest — {count} event(s)

Window: {window_start} → {window_end}

{entries}

—
This digest groups Info-severity events from the last {minutes} minutes.
";
```

Substitution is done with simple `str::replace`; no templating engine.

## Testing strategy (TDD)

| # | Layer                       | Test                                                                                          |
|---|-----------------------------|-----------------------------------------------------------------------------------------------|
| 1 | `email::client`             | `RecordingSendGridClient` captures sent `EmailMessage`s; verify shape against fixture.        |
| 2 | `email::digest`             | `tokio::time::pause()` + virtual clock: enqueue N events, advance window, assert 1 send.      |
| 3 | `email::digest`             | Empty window → no send.                                                                       |
| 4 | `email::throttle`           | Mirror of `notify::throttle` tests with 60s window.                                           |
| 5 | `email::gating`             | Each missing config field → `SuppressedByConfig`, no client call.                             |
| 6 | `email::severity_routing`   | `OperatorEscalate` → immediate send; `AomComplete` → buffer; verified via mock client.        |
| 7 | `notifications::dispatch`   | One trigger fans out to OS + email channels; both invoked in parallel.                        |
| 8 | `email::client` (real impl) | Build the SendGrid v3 JSON body and assert against a golden fixture (no live network).        |
| 9 | `settings`                  | Round-trip serialization with all new fields; back-compat with old settings.json missing them.|

## Migration / rollout

- Defaults are off (`email_enabled = false`, key absent), so existing users see zero behavior change.
- No schema migration needed; all new fields are `#[serde(default)]`.

## Open questions

None at this time. (Recipient cardinality, per-event vs. digest split, and template strategy resolved during brainstorming on 2026-05-05.)

## Future work (explicit out-of-scope)

- HTML templates with branding.
- Multi-recipient with per-trigger routing.
- Retries with exponential backoff for transient 5xx.
- Surfacing per-email delivery status in the UI.
- Webhook ingestion for SendGrid bounce/spam reports.
- Migrating `sendgrid_api_key` and `anthropic_api_key` to macOS Keychain (M3.5).
- Slack / Discord / SMS channels (same `notifications::dispatch` fanout pattern).
