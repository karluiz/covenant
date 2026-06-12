# Local LLM Providers for Operators — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a provider abstraction to `karl_agent` so summary, chat, and operator roles can each independently target either Anthropic or a local OpenAI-compatible runtime (Ollama / LM Studio / llama.cpp server), and rebuild the Settings UI around per-role provider selection.

**Architecture:** Introduce an `LlmProvider` trait in `crates/agent`. Refactor the existing Anthropic SSE code into `AnthropicProvider`. Add `OpenAICompatProvider` that targets any `/v1/chat/completions` endpoint (Ollama exposes one natively at `:11434/v1`). Settings grows a `providers` map + a `model_routes` table keyed by role (`summary`, `chat`, `operator`, `triage`). Each call site (`summarizer.rs`, `drafts.rs`, `cross_session.rs`, `operator.rs`, `fix_proposer.rs`) resolves its role → `(provider_id, model)` → builds the matching client. The Settings UI gets a new "Providers" tab and a redesigned "Models" tab with provider+model dropdowns per role.

**Tech Stack:** Rust (tokio, reqwest, serde), TypeScript (Tauri 2 IPC), no new heavy deps. Reuses existing `reqwest` SSE plumbing.

**Out of scope for Phase 1:** Tool use against local providers (operator stays Anthropic-only in Phase 1; warning shown if user routes operator to local), prompt caching for local, per-operator overrides, dynamic model list autodetect.

---

## File Structure

**Rust — `crates/agent/src/`**
- Create `provider.rs` — `LlmProvider` trait, `ProviderKind` enum, `ProviderConfig`, capability flags.
- Create `provider/anthropic.rs` — moves Anthropic SSE body construction here; implements `LlmProvider`.
- Create `provider/openai_compat.rs` — OpenAI Chat Completions SSE client; implements `LlmProvider`.
- Modify `lib.rs` — re-export trait; keep `ask_oneshot*` / `ask_streaming` / `triage_oneshot` as thin wrappers that take a `&dyn LlmProvider` instead of an inline `api_key`.

**Rust — `crates/app/src/`**
- Modify `settings.rs` — add `ProvidersConfig` (`HashMap<String, ProviderEntry>`) and `ModelRoutes` (`HashMap<Role, RouteEntry>`). Migration: if `anthropic_api_key` is set and `providers` is empty, synthesize a default `anthropic` provider entry on load.
- Create `provider_resolve.rs` — `resolve_route(settings, role) -> Result<Box<dyn LlmProvider>, ResolveError>`. Single source of truth used by every caller.
- Modify `summarizer.rs`, `drafts.rs`, `cross_session.rs`, `fix_proposer.rs`, `operator.rs` — replace direct `AskRequest { api_key, model, … }` construction with `resolve_route(s, Role::X)` + role-specific call.

**TypeScript — `ui/src/settings/`**
- Modify `panel.ts` — replace single "Anthropic" tab. Add "Providers" tab (list + add/edit/delete) and redesign "Models" tab (per-role provider+model dropdowns).
- Create `providers.ts` — render Providers tab: list cards, add/edit form, connection test button.
- Create `model_routes.ts` — render Models tab: one row per role with two dropdowns, plus tool-use warning.

**Tests:**
- `crates/agent/tests/provider_anthropic.rs` — round-trip via the trait, mocked with `wiremock`.
- `crates/agent/tests/provider_openai_compat.rs` — same, including SSE chunk parsing.
- `crates/app/src/settings.rs` (inline `mod tests`) — migration, round-trip of `providers` + `model_routes`, defaults.
- `crates/app/src/provider_resolve.rs` (inline) — fallback to default provider, error when route points at missing provider.

---

## Task 1: Define the `LlmProvider` trait and capability metadata

**Files:**
- Create: `crates/agent/src/provider.rs`
- Modify: `crates/agent/src/lib.rs:9-11`

- [ ] **Step 1: Write the failing test**

Append to `crates/agent/src/provider.rs` (the file does not exist yet — create it, then add the test at the bottom):

```rust
//! Provider abstraction. A `LlmProvider` is anything that can stream a
//! Messages-shaped request and return text + token usage. Implementations
//! live in `provider/anthropic.rs` and `provider/openai_compat.rs`.

use crate::{AgentError, AgentEvent, AskRequest};
use async_trait::async_trait;

/// Stable identifier for a provider kind. The `id` of a configured
/// provider in settings is user-chosen; this enum is the *type*.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    Anthropic,
    OpenAiCompat,
}

/// Wire config for instantiating a provider. Comes from settings.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ProviderConfig {
    pub kind: ProviderKind,
    /// Required for Anthropic. Optional for OpenAI-compat (Ollama needs none).
    #[serde(default)]
    pub api_key: Option<String>,
    /// Base URL. Defaults filled in by `with_defaults`.
    #[serde(default)]
    pub base_url: Option<String>,
}

impl ProviderConfig {
    pub fn with_defaults(mut self) -> Self {
        if self.base_url.is_none() {
            self.base_url = Some(match self.kind {
                ProviderKind::Anthropic => "https://api.anthropic.com".to_string(),
                ProviderKind::OpenAiCompat => "http://localhost:11434/v1".to_string(),
            });
        }
        self
    }
}

/// Per-provider feature flags. Used by the UI to warn the user and by
/// call sites to degrade gracefully (no prompt caching → larger debounce).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capabilities {
    pub tool_use: bool,
    pub prompt_caching: bool,
    pub extended_thinking: bool,
}

#[async_trait]
pub trait LlmProvider: Send + Sync {
    fn kind(&self) -> ProviderKind;
    fn capabilities(&self) -> Capabilities;
    async fn ask_streaming(
        &self,
        req: AskRequest,
        on_event: Box<dyn FnMut(AgentEvent) + Send>,
    ) -> Result<(), AgentError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anthropic_defaults_to_official_base_url() {
        let cfg = ProviderConfig {
            kind: ProviderKind::Anthropic,
            api_key: Some("sk-ant".into()),
            base_url: None,
        }
        .with_defaults();
        assert_eq!(cfg.base_url.as_deref(), Some("https://api.anthropic.com"));
    }

    #[test]
    fn openai_compat_defaults_to_ollama() {
        let cfg = ProviderConfig {
            kind: ProviderKind::OpenAiCompat,
            api_key: None,
            base_url: None,
        }
        .with_defaults();
        assert_eq!(cfg.base_url.as_deref(), Some("http://localhost:11434/v1"));
    }
}
```

Then add to `crates/agent/src/lib.rs` right after the existing `pub mod` lines (line 9-11):

```rust
pub mod provider;
```

And add `async-trait = "0.1"` to `crates/agent/Cargo.toml` under `[dependencies]` if not already present.

- [ ] **Step 2: Run the test to verify it fails (compile error expected, then pass)**

Run: `cargo test -p karl_agent provider::tests --no-run`
Expected: compiles. Then `cargo test -p karl_agent provider::tests` — both tests PASS.

- [ ] **Step 3: Commit**

```bash
git add crates/agent/src/provider.rs crates/agent/src/lib.rs crates/agent/Cargo.toml
git commit -m "feat(agent): add LlmProvider trait + ProviderConfig"
```

---

## Task 2: Extract `AnthropicProvider` from `lib.rs`

**Files:**
- Create: `crates/agent/src/provider/anthropic.rs`
- Modify: `crates/agent/src/lib.rs:177-361` (the `ask_streaming` body)
- Modify: `crates/agent/src/provider.rs` (add `pub mod anthropic;`)

- [ ] **Step 1: Write the failing test**

Create `crates/agent/tests/provider_anthropic.rs`:

```rust
use karl_agent::provider::{Capabilities, LlmProvider, ProviderConfig, ProviderKind};
use karl_agent::provider::anthropic::AnthropicProvider;

#[test]
fn anthropic_provider_reports_full_capabilities() {
    let p = AnthropicProvider::new(ProviderConfig {
        kind: ProviderKind::Anthropic,
        api_key: Some("sk-ant".into()),
        base_url: None,
    }.with_defaults());
    assert_eq!(p.kind(), ProviderKind::Anthropic);
    let caps = p.capabilities();
    assert!(caps.tool_use);
    assert!(caps.prompt_caching);
    assert!(caps.extended_thinking);
}
```

- [ ] **Step 2: Run test (expect compile failure — AnthropicProvider doesn't exist yet)**

Run: `cargo test -p karl_agent --test provider_anthropic`
Expected: FAIL with `unresolved import karl_agent::provider::anthropic::AnthropicProvider`.

- [ ] **Step 3: Implement `AnthropicProvider`**

Create `crates/agent/src/provider/anthropic.rs`:

```rust
//! Anthropic Messages API implementation of `LlmProvider`.
//!
//! Body construction + SSE parsing extracted verbatim from the original
//! `ask_streaming` in `lib.rs`. The free function in `lib.rs` now
//! delegates to this implementation when given an Anthropic config.

use async_trait::async_trait;
use futures_util::StreamExt;

use crate::provider::{Capabilities, LlmProvider, ProviderConfig, ProviderKind};
use crate::{AgentError, AgentEvent, AskRequest, TokenUsage};

const ANTHROPIC_VERSION: &str = "2023-06-01";

pub struct AnthropicProvider {
    cfg: ProviderConfig,
}

impl AnthropicProvider {
    pub fn new(cfg: ProviderConfig) -> Self {
        Self { cfg }
    }

    fn url(&self) -> String {
        let base = self
            .cfg
            .base_url
            .as_deref()
            .unwrap_or("https://api.anthropic.com");
        format!("{}/v1/messages", base.trim_end_matches('/'))
    }
}

#[async_trait]
impl LlmProvider for AnthropicProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Anthropic
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            tool_use: true,
            prompt_caching: true,
            extended_thinking: true,
        }
    }

    async fn ask_streaming(
        &self,
        req: AskRequest,
        mut on_event: Box<dyn FnMut(AgentEvent) + Send>,
    ) -> Result<(), AgentError> {
        let api_key = self
            .cfg
            .api_key
            .as_deref()
            .filter(|k| !k.trim().is_empty())
            .ok_or(AgentError::MissingKey)?;

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(180))
            .build()?;

        let mut body = serde_json::json!({
            "model": req.model,
            "max_tokens": req.max_tokens,
            "stream": true,
            "system": [
                { "type": "text", "text": req.system_prompt,
                  "cache_control": { "type": "ephemeral" } }
            ],
            "messages": [
                { "role": "user", "content": req.user_message }
            ]
        });
        if let Some(tool) = req.force_tool.as_ref() {
            body["tools"] = serde_json::json!([tool]);
            let name = tool.get("name").and_then(|n| n.as_str()).unwrap_or("");
            body["tool_choice"] =
                serde_json::json!({ "type": "tool", "name": name });
        }
        if let Some(budget) = req.thinking_budget {
            body["thinking"] = serde_json::json!({
                "type": "enabled",
                "budget_tokens": budget,
            });
        }

        let response = client
            .post(self.url())
            .header("x-api-key", api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(AgentError::Api { status: status.as_u16(), body });
        }

        let mut stream = response.bytes_stream();
        let mut buffer: Vec<u8> = Vec::with_capacity(8 * 1024);

        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            buffer.extend_from_slice(&chunk);
            while let Some(idx) = find_double_newline(&buffer) {
                let raw: Vec<u8> = buffer.drain(..idx + 2).collect();
                let text = String::from_utf8_lossy(&raw);
                for line in text.lines() {
                    let Some(data) = line.strip_prefix("data:") else { continue };
                    let data = data.trim_start();
                    if data.is_empty() || data == "[DONE]" { continue }
                    let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
                        continue;
                    };
                    dispatch_event(&value, &mut on_event);
                    if value.get("type").and_then(|v| v.as_str()) == Some("message_stop") {
                        return Ok(());
                    }
                }
            }
        }
        on_event(AgentEvent::Done);
        Ok(())
    }
}

fn find_double_newline(buf: &[u8]) -> Option<usize> {
    buf.windows(2).position(|w| w == b"\n\n")
}

fn parse_usage(v: &serde_json::Value) -> Option<TokenUsage> {
    let get = |k: &str| {
        v.get(k).and_then(|x| x.as_u64()).map(|n| n as u32).unwrap_or(0)
    };
    Some(TokenUsage {
        input_tokens: get("input_tokens"),
        output_tokens: get("output_tokens"),
        cache_creation_input_tokens: get("cache_creation_input_tokens"),
        cache_read_input_tokens: get("cache_read_input_tokens"),
    })
}

fn dispatch_event(
    value: &serde_json::Value,
    on_event: &mut Box<dyn FnMut(AgentEvent) + Send>,
) {
    let event_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match event_type {
        "content_block_delta" => {
            let delta = value.get("delta");
            let dt = delta.and_then(|d| d.get("type")).and_then(|t| t.as_str()).unwrap_or("");
            match dt {
                "text_delta" => {
                    if let Some(t) = delta.and_then(|d| d.get("text")).and_then(|t| t.as_str()) {
                        on_event(AgentEvent::Delta(t.to_string()));
                    }
                }
                "thinking_delta" => {
                    if let Some(t) = delta.and_then(|d| d.get("thinking")).and_then(|t| t.as_str()) {
                        on_event(AgentEvent::ThinkingDelta(t.to_string()));
                    }
                }
                "input_json_delta" => {
                    if let Some(frag) = delta.and_then(|d| d.get("partial_json")).and_then(|t| t.as_str()) {
                        on_event(AgentEvent::ToolInputDelta {
                            tool_name: String::new(),
                            fragment: frag.to_string(),
                        });
                    }
                }
                _ => {}
            }
        }
        "message_start" => {
            if let Some(u) = value
                .get("message")
                .and_then(|m| m.get("usage"))
                .and_then(parse_usage)
            {
                on_event(AgentEvent::Usage(u));
            }
        }
        "message_delta" => {
            if let Some(u) = value.get("usage").and_then(parse_usage) {
                on_event(AgentEvent::Usage(u));
            }
            if let Some(r) = value
                .get("delta")
                .and_then(|d| d.get("stop_reason"))
                .and_then(|r| r.as_str())
            {
                on_event(AgentEvent::StopReason(r.to_string()));
            }
        }
        "content_block_start" => {
            let cb = value.get("content_block");
            if cb.and_then(|c| c.get("type")).and_then(|t| t.as_str()) == Some("tool_use") {
                let name = cb
                    .and_then(|c| c.get("name"))
                    .and_then(|n| n.as_str())
                    .unwrap_or("")
                    .to_string();
                on_event(AgentEvent::ToolInputDelta {
                    tool_name: name,
                    fragment: String::new(),
                });
            }
        }
        "content_block_stop" => {
            on_event(AgentEvent::ToolInputDone { tool_name: String::new() });
        }
        "message_stop" => {
            on_event(AgentEvent::Done);
        }
        _ => {}
    }
}
```

In `crates/agent/src/provider.rs`, add at the top right after the module doc-comment:

```rust
pub mod anthropic;
```

- [ ] **Step 4: Refactor `lib.rs:ask_streaming` to delegate**

Replace the body of `ask_streaming` in `crates/agent/src/lib.rs:177` so it constructs an `AnthropicProvider` from a minimal config and calls into the trait:

```rust
pub async fn ask_streaming<F>(req: AskRequest, on_event: F) -> Result<(), AgentError>
where
    F: FnMut(AgentEvent) + Send + 'static,
{
    use crate::provider::{LlmProvider, ProviderConfig, ProviderKind};
    let provider = crate::provider::anthropic::AnthropicProvider::new(
        ProviderConfig {
            kind: ProviderKind::Anthropic,
            api_key: Some(req.api_key.clone()),
            base_url: None,
        }
        .with_defaults(),
    );
    provider.ask_streaming(req, Box::new(on_event)).await
}
```

Remove the now-dead `ANTHROPIC_URL`, `ANTHROPIC_VERSION`, `find_double_newline`, and `parse_usage` constants/functions from `lib.rs` (they now live in `provider/anthropic.rs`).

- [ ] **Step 5: Run all agent tests**

Run: `cargo test -p karl_agent`
Expected: all existing triage tests + new `provider_anthropic` test PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/agent/src/provider.rs crates/agent/src/provider/anthropic.rs crates/agent/src/lib.rs crates/agent/tests/provider_anthropic.rs
git commit -m "refactor(agent): extract AnthropicProvider behind LlmProvider trait"
```

---

## Task 3: Implement `OpenAICompatProvider`

**Files:**
- Create: `crates/agent/src/provider/openai_compat.rs`
- Create: `crates/agent/tests/provider_openai_compat.rs`
- Modify: `crates/agent/src/provider.rs`

- [ ] **Step 1: Write the failing test**

Create `crates/agent/tests/provider_openai_compat.rs`:

```rust
use karl_agent::provider::openai_compat::OpenAiCompatProvider;
use karl_agent::provider::{Capabilities, LlmProvider, ProviderConfig, ProviderKind};

#[test]
fn reports_no_caching_or_thinking() {
    let p = OpenAiCompatProvider::new(ProviderConfig {
        kind: ProviderKind::OpenAiCompat,
        api_key: None,
        base_url: Some("http://localhost:11434/v1".into()),
    });
    let caps = p.capabilities();
    assert!(!caps.prompt_caching);
    assert!(!caps.extended_thinking);
    // Tool use defaults true at the provider level — the model still has
    // to support it. Phase 1 surfaces this in the UI as a soft warning.
    assert!(caps.tool_use);
    assert_eq!(p.kind(), ProviderKind::OpenAiCompat);
}
```

- [ ] **Step 2: Run test (expect compile failure)**

Run: `cargo test -p karl_agent --test provider_openai_compat`
Expected: FAIL with unresolved import.

- [ ] **Step 3: Implement the provider**

Create `crates/agent/src/provider/openai_compat.rs`:

```rust
//! OpenAI Chat Completions compatible provider. Targets any endpoint
//! that speaks the `/v1/chat/completions` streaming protocol — Ollama
//! (native at :11434/v1), LM Studio, llama.cpp `server`, vLLM, LocalAI,
//! and OpenAI itself.
//!
//! Phase 1 supports streaming text + usage tracking. Tool use, prompt
//! caching, and extended thinking are NOT translated — capabilities()
//! reports prompt_caching=false / extended_thinking=false so callers can
//! adapt (e.g. larger summarizer debounce).

use async_trait::async_trait;
use futures_util::StreamExt;

use crate::provider::{Capabilities, LlmProvider, ProviderConfig, ProviderKind};
use crate::{AgentError, AgentEvent, AskRequest, TokenUsage};

pub struct OpenAiCompatProvider {
    cfg: ProviderConfig,
}

impl OpenAiCompatProvider {
    pub fn new(cfg: ProviderConfig) -> Self {
        Self { cfg }
    }

    fn url(&self) -> String {
        let base = self
            .cfg
            .base_url
            .as_deref()
            .unwrap_or("http://localhost:11434/v1");
        format!("{}/chat/completions", base.trim_end_matches('/'))
    }
}

#[async_trait]
impl LlmProvider for OpenAiCompatProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::OpenAiCompat
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            tool_use: true, // provider-level; per-model gating happens in UI
            prompt_caching: false,
            extended_thinking: false,
        }
    }

    async fn ask_streaming(
        &self,
        req: AskRequest,
        mut on_event: Box<dyn FnMut(AgentEvent) + Send>,
    ) -> Result<(), AgentError> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(180))
            .build()?;

        let body = serde_json::json!({
            "model": req.model,
            "max_tokens": req.max_tokens,
            "stream": true,
            "stream_options": { "include_usage": true },
            "messages": [
                { "role": "system", "content": req.system_prompt },
                { "role": "user",   "content": req.user_message },
            ],
        });

        let mut request = client.post(self.url())
            .header("content-type", "application/json")
            .json(&body);
        if let Some(key) = self.cfg.api_key.as_deref().filter(|k| !k.trim().is_empty()) {
            request = request.bearer_auth(key);
        }

        let response = request.send().await?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(AgentError::Api { status: status.as_u16(), body });
        }

        let mut stream = response.bytes_stream();
        let mut buffer: Vec<u8> = Vec::with_capacity(8 * 1024);

        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            buffer.extend_from_slice(&chunk);
            while let Some(idx) = find_double_newline(&buffer) {
                let raw: Vec<u8> = buffer.drain(..idx + 2).collect();
                let text = String::from_utf8_lossy(&raw);
                for line in text.lines() {
                    let Some(data) = line.strip_prefix("data:") else { continue };
                    let data = data.trim_start();
                    if data.is_empty() { continue }
                    if data == "[DONE]" {
                        on_event(AgentEvent::Done);
                        return Ok(());
                    }
                    let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else {
                        continue;
                    };

                    if let Some(choice) = v.get("choices").and_then(|c| c.get(0)) {
                        if let Some(text) = choice
                            .get("delta")
                            .and_then(|d| d.get("content"))
                            .and_then(|t| t.as_str())
                        {
                            if !text.is_empty() {
                                on_event(AgentEvent::Delta(text.to_string()));
                            }
                        }
                        if let Some(reason) = choice
                            .get("finish_reason")
                            .and_then(|r| r.as_str())
                        {
                            on_event(AgentEvent::StopReason(reason.to_string()));
                        }
                    }

                    if let Some(usage) = v.get("usage") {
                        let get = |k: &str| {
                            usage.get(k).and_then(|n| n.as_u64()).map(|n| n as u32).unwrap_or(0)
                        };
                        on_event(AgentEvent::Usage(TokenUsage {
                            input_tokens: get("prompt_tokens"),
                            output_tokens: get("completion_tokens"),
                            cache_creation_input_tokens: 0,
                            cache_read_input_tokens: 0,
                        }));
                    }
                }
            }
        }
        on_event(AgentEvent::Done);
        Ok(())
    }
}

fn find_double_newline(buf: &[u8]) -> Option<usize> {
    buf.windows(2).position(|w| w == b"\n\n")
}
```

Register the module in `crates/agent/src/provider.rs`:

```rust
pub mod openai_compat;
```

- [ ] **Step 4: Run tests**

Run: `cargo test -p karl_agent`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/agent/src/provider/openai_compat.rs crates/agent/src/provider.rs crates/agent/tests/provider_openai_compat.rs
git commit -m "feat(agent): add OpenAI-compatible provider (Ollama / LM Studio / llama.cpp)"
```

---

## Task 4: Settings schema — providers + model routes

**Files:**
- Modify: `crates/app/src/settings.rs:22-84` (`Settings` struct), `:216-235` (Default), tests block

- [ ] **Step 1: Write the failing test**

Add at the bottom of `crates/app/src/settings.rs` inside the existing `#[cfg(test)] mod tests`:

```rust
    #[test]
    fn migrates_legacy_anthropic_key_into_providers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path,
            r#"{"anthropic_api_key":"sk-ant-legacy"}"#).unwrap();
        let s = load(&path);
        let anthropic = s.providers.get("anthropic").expect("default anthropic entry");
        assert_eq!(anthropic.api_key.as_deref(), Some("sk-ant-legacy"));
    }

    #[test]
    fn model_routes_default_to_anthropic_provider() {
        let s = Settings::default();
        let summary = s.model_routes.get(&Role::Summary).expect("summary route");
        assert_eq!(summary.provider_id, "anthropic");
        assert_eq!(summary.model, "claude-sonnet-4-6");
    }

    #[test]
    fn round_trip_preserves_ollama_provider() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let mut s = Settings::default();
        s.providers.insert(
            "ollama".into(),
            ProviderEntry {
                kind: karl_agent::provider::ProviderKind::OpenAiCompat,
                api_key: None,
                base_url: Some("http://localhost:11434/v1".into()),
                label: "Ollama (local)".into(),
            },
        );
        save(&path, &s).unwrap();
        let loaded = load(&path);
        assert!(loaded.providers.contains_key("ollama"));
    }
```

- [ ] **Step 2: Implement schema**

In `crates/app/src/settings.rs` add (near the top, after the existing imports):

```rust
use karl_agent::provider::ProviderKind;

#[derive(Debug, Clone, Copy, Hash, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Summary,
    Chat,
    Operator,
    Triage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderEntry {
    pub kind: ProviderKind,
    /// User-facing label rendered in the dropdowns.
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteEntry {
    pub provider_id: String,
    pub model: String,
}
```

Add two fields to `Settings` (insert right after `pub agent: AgentConfig,` around line 34):

```rust
    /// Configured LLM providers, keyed by user-chosen id (e.g.
    /// "anthropic", "ollama", "lmstudio"). Migration: empty map +
    /// legacy `anthropic_api_key` → synthesizes a default "anthropic"
    /// entry on load.
    #[serde(default)]
    pub providers: HashMap<String, ProviderEntry>,

    /// Per-role routing: which provider + model handles each role.
    #[serde(default = "default_model_routes")]
    pub model_routes: HashMap<Role, RouteEntry>,
```

Add the default helper:

```rust
fn default_model_routes() -> HashMap<Role, RouteEntry> {
    let mut m = HashMap::new();
    m.insert(Role::Summary, RouteEntry {
        provider_id: "anthropic".into(),
        model: "claude-sonnet-4-6".into(),
    });
    m.insert(Role::Chat, RouteEntry {
        provider_id: "anthropic".into(),
        model: "claude-opus-4-7".into(),
    });
    m.insert(Role::Operator, RouteEntry {
        provider_id: "anthropic".into(),
        model: "claude-sonnet-4-6".into(),
    });
    m.insert(Role::Triage, RouteEntry {
        provider_id: "anthropic".into(),
        model: karl_agent::DEFAULT_TRIAGE_MODEL.into(),
    });
    m
}

fn default_anthropic_entry(api_key: Option<String>) -> ProviderEntry {
    ProviderEntry {
        kind: ProviderKind::Anthropic,
        label: "Anthropic".into(),
        api_key,
        base_url: None,
    }
}
```

Update `Settings::default()` to populate `providers` with an empty Anthropic entry and `model_routes` from the helper:

```rust
impl Default for Settings {
    fn default() -> Self {
        let mut providers = HashMap::new();
        providers.insert("anthropic".into(), default_anthropic_entry(None));
        Self {
            anthropic_api_key: None,
            sendgrid_api_key: None,
            providers,
            model_routes: default_model_routes(),
            agent: AgentConfig::default(),
            // ... (rest unchanged)
            operator: OperatorConfig::default(),
            terminal: TerminalConfig::default(),
            window: WindowConfig::default(),
            aom: AomConfig::default(),
            notifications: NotificationConfig::default(),
            status_bar_enabled: default_status_bar_enabled(),
            tabbar_position: TabbarPosition::default(),
            ui_font_family: None,
            zsh_history_imported_at_unix_ms: None,
            familiars_enabled: false,
            telegram: TelegramSettings::default(),
        }
    }
}
```

Modify `load()` to perform the legacy-key migration. After the existing `serde_json::from_str` succeeds and before returning, insert:

```rust
fn migrate_legacy(mut s: Settings) -> Settings {
    if !s.providers.contains_key("anthropic") {
        s.providers.insert(
            "anthropic".into(),
            default_anthropic_entry(s.anthropic_api_key.clone()),
        );
    } else if let Some(entry) = s.providers.get_mut("anthropic") {
        // Legacy key wins only if the provider entry has no key yet.
        if entry.api_key.is_none() {
            entry.api_key = s.anthropic_api_key.clone();
        }
    }
    if s.model_routes.is_empty() {
        s.model_routes = default_model_routes();
    }
    s
}
```

Call `migrate_legacy(parsed)` instead of returning `parsed` directly in `load()`.

- [ ] **Step 3: Run the tests**

Run: `cargo test -p covenant settings::tests`
Expected: new tests + existing tests all PASS.

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/settings.rs
git commit -m "feat(settings): add providers map + per-role model routes"
```

---

## Task 5: `resolve_route` helper used by every caller

**Files:**
- Create: `crates/app/src/provider_resolve.rs`
- Modify: `crates/app/src/lib.rs` (`pub mod provider_resolve;`)

- [ ] **Step 1: Write the failing test**

Create `crates/app/src/provider_resolve.rs` with the test at the bottom:

```rust
//! Single resolver that turns a `Role` into an instantiated
//! `Box<dyn LlmProvider>` + the model string. Every place that used to
//! build an `AskRequest` with the bare `anthropic_api_key` now goes
//! through this.

use std::sync::Arc;

use karl_agent::provider::{
    anthropic::AnthropicProvider, openai_compat::OpenAiCompatProvider, LlmProvider,
    ProviderConfig, ProviderKind,
};

use crate::settings::{Role, Settings};

#[derive(Debug, thiserror::Error)]
pub enum ResolveError {
    #[error("no route configured for role {0:?}")]
    NoRoute(Role),
    #[error("route points at provider id `{0}` which is not configured")]
    UnknownProvider(String),
}

pub struct ResolvedRoute {
    pub provider: Arc<dyn LlmProvider>,
    pub model: String,
}

pub fn resolve_route(settings: &Settings, role: Role) -> Result<ResolvedRoute, ResolveError> {
    let route = settings
        .model_routes
        .get(&role)
        .ok_or(ResolveError::NoRoute(role))?;
    let entry = settings
        .providers
        .get(&route.provider_id)
        .ok_or_else(|| ResolveError::UnknownProvider(route.provider_id.clone()))?;
    let cfg = ProviderConfig {
        kind: entry.kind,
        api_key: entry.api_key.clone(),
        base_url: entry.base_url.clone(),
    }
    .with_defaults();
    let provider: Arc<dyn LlmProvider> = match entry.kind {
        ProviderKind::Anthropic => Arc::new(AnthropicProvider::new(cfg)),
        ProviderKind::OpenAiCompat => Arc::new(OpenAiCompatProvider::new(cfg)),
    };
    Ok(ResolvedRoute { provider, model: route.model.clone() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_default_summary_route_to_anthropic() {
        let s = Settings::default();
        let r = resolve_route(&s, Role::Summary).expect("route");
        assert_eq!(r.model, "claude-sonnet-4-6");
        assert_eq!(r.provider.kind(), ProviderKind::Anthropic);
    }

    #[test]
    fn errors_on_route_pointing_at_missing_provider() {
        let mut s = Settings::default();
        s.model_routes
            .get_mut(&Role::Summary)
            .unwrap()
            .provider_id = "nonexistent".into();
        let err = resolve_route(&s, Role::Summary).unwrap_err();
        assert!(matches!(err, ResolveError::UnknownProvider(_)));
    }
}
```

Register the module — find the existing `pub mod` lines in `crates/app/src/lib.rs` and add:

```rust
pub mod provider_resolve;
```

- [ ] **Step 2: Run tests**

Run: `cargo test -p covenant provider_resolve`
Expected: 2 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add crates/app/src/provider_resolve.rs crates/app/src/lib.rs
git commit -m "feat(app): add provider_resolve for per-role provider selection"
```

---

## Task 6: Migrate `summarizer.rs` to use `resolve_route`

**Files:**
- Modify: `crates/app/src/summarizer.rs:120-180`

- [ ] **Step 1: Read the current call site**

Run: `sed -n '115,185p' crates/app/src/summarizer.rs`
Expected: shows the block that pulls `anthropic_api_key` then builds an `AskRequest`.

- [ ] **Step 2: Replace with `resolve_route`**

In `crates/app/src/summarizer.rs`, replace the section that reads `anthropic_api_key` and the subsequent `ask_oneshot` call. The new shape:

```rust
use crate::provider_resolve::{resolve_route, ResolveError};
use crate::settings::Role;

// ... inside the function that summarizes ...
let resolved = match resolve_route(&s, Role::Summary) {
    Ok(r) => r,
    Err(ResolveError::UnknownProvider(_)) | Err(ResolveError::NoRoute(_)) => {
        tracing::warn!("summary: no provider configured, skipping");
        return;
    }
};

let req = karl_agent::AskRequest {
    api_key: String::new(), // legacy field — provider has its own
    model: resolved.model.clone(),
    system_prompt: sys.clone(),
    user_message: user.clone(),
    max_tokens: 800,
    thinking_budget: None,
    force_tool: None,
};

let summary = match resolved
    .provider
    .ask_streaming(req.clone(), Box::new(|_evt| {}))
    .await
{
    // existing handling — but we need text, so use the trait via a
    // small helper. See note below.
};
```

Because the trait gives streaming events but `ask_oneshot` collects text, add a helper to `crates/agent/src/provider.rs`:

```rust
use std::sync::{Arc, Mutex};

/// Collect a streamed call into a single String + final usage. Mirrors
/// the legacy `ask_oneshot_with_usage` but goes through the trait.
pub async fn collect_oneshot(
    provider: &dyn LlmProvider,
    req: AskRequest,
) -> Result<crate::AskResponse, AgentError> {
    let buffer = Arc::new(Mutex::new(String::new()));
    let usage = Arc::new(Mutex::new(crate::TokenUsage::default()));
    let stop_reason = Arc::new(Mutex::new(Option::<String>::None));
    let thinking = Arc::new(Mutex::new(String::new()));
    let buf_cb = buffer.clone();
    let usage_cb = usage.clone();
    let stop_cb = stop_reason.clone();
    let think_cb = thinking.clone();
    provider
        .ask_streaming(
            req,
            Box::new(move |evt| match evt {
                AgentEvent::Delta(t) => {
                    if let Ok(mut b) = buf_cb.lock() { b.push_str(&t); }
                }
                AgentEvent::ThinkingDelta(t) => {
                    if let Ok(mut b) = think_cb.lock() { b.push_str(&t); }
                }
                AgentEvent::Usage(u) => {
                    if let Ok(mut e) = usage_cb.lock() {
                        e.input_tokens = e.input_tokens.max(u.input_tokens);
                        e.output_tokens = e.output_tokens.max(u.output_tokens);
                        e.cache_creation_input_tokens =
                            e.cache_creation_input_tokens.max(u.cache_creation_input_tokens);
                        e.cache_read_input_tokens =
                            e.cache_read_input_tokens.max(u.cache_read_input_tokens);
                    }
                }
                AgentEvent::StopReason(r) => {
                    if let Ok(mut s) = stop_cb.lock() { *s = Some(r); }
                }
                _ => {}
            }),
        )
        .await?;
    let thinking_full = thinking.lock().map(|t| t.clone()).unwrap_or_default();
    let thinking_summary: String = thinking_full.chars().take(200).collect();
    Ok(crate::AskResponse {
        text: buffer.lock().map(|b| b.clone()).unwrap_or_default(),
        usage: usage.lock().map(|u| *u).unwrap_or_default(),
        stop_reason: stop_reason.lock().map(|s| s.clone()).unwrap_or_default(),
        thinking_summary,
        thinking_full: if thinking_full.is_empty() { vec![] } else { vec![thinking_full] },
    })
}
```

Then in `summarizer.rs`:

```rust
let resp = karl_agent::provider::collect_oneshot(&*resolved.provider, req).await;
```

- [ ] **Step 3: Build + run summarizer tests**

Run: `cargo test -p covenant summarizer`
Expected: existing tests PASS. (If a test required the legacy `anthropic_api_key` field directly, update it to set a provider entry instead.)

- [ ] **Step 4: Commit**

```bash
git add crates/agent/src/provider.rs crates/app/src/summarizer.rs
git commit -m "refactor(summarizer): route through provider_resolve"
```

---

## Task 7: Migrate `drafts.rs`, `cross_session.rs`, `fix_proposer.rs`

**Files:**
- Modify: `crates/app/src/drafts.rs:865-895`
- Modify: `crates/app/src/cross_session.rs:195-270`
- Modify: `crates/app/src/fix_proposer.rs:125-155`

- [ ] **Step 1: Apply the same pattern to each file**

For each, replace the `anthropic_api_key` read + `ask_oneshot` call with `resolve_route(&s, Role::Chat)` for `drafts.rs`/`cross_session.rs`/`fix_proposer.rs` (all use chat-tier models today) and `collect_oneshot`.

Example for `crates/app/src/fix_proposer.rs` (around line 125):

```rust
use crate::provider_resolve::resolve_route;
use crate::settings::Role;

let resolved = match resolve_route(&s, Role::Chat) {
    Ok(r) => r,
    Err(e) => {
        tracing::warn!(?e, "fix_proposer: provider unavailable");
        return None;
    }
};
let req = karl_agent::AskRequest {
    api_key: String::new(),
    model: resolved.model.clone(),
    system_prompt: sys,
    user_message: user,
    max_tokens: 1024,
    thinking_budget: None,
    force_tool: None,
};
let resp = karl_agent::provider::collect_oneshot(&*resolved.provider, req).await.ok()?;
```

- [ ] **Step 2: Build the workspace**

Run: `cargo build -p covenant`
Expected: clean build.

- [ ] **Step 3: Run app tests**

Run: `cargo test -p covenant`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/drafts.rs crates/app/src/cross_session.rs crates/app/src/fix_proposer.rs
git commit -m "refactor(callers): drafts/cross_session/fix_proposer use provider_resolve"
```

---

## Task 8: Migrate the operator call sites

**Files:**
- Modify: `crates/app/src/operator.rs:1690-1710`, `:2015-2030`, `:2130-2150`

- [ ] **Step 1: Operator decision call**

In the block at `operator.rs:2130` (the `ask_oneshot_with_usage` call), replace with:

```rust
let resolved = resolve_route(&s, Role::Operator)
    .map_err(|e| OperatorError::Provider(e.to_string()))?;
// Note: operator currently requires tool_use / thinking. If the
// resolved provider doesn't support them, log + fall through to
// SuggestOnly. Phase 1 keeps Anthropic as the only viable target;
// the UI warns the user when this route is set to OpenAI-compat.
let caps = resolved.provider.capabilities();
if req.force_tool.is_some() && !caps.tool_use {
    tracing::warn!("operator: provider lacks tool_use; suggesting only");
    return Ok(OperatorOutcome::SuggestOnly);
}
let resp = karl_agent::provider::collect_oneshot(&*resolved.provider, AskRequest {
    api_key: String::new(),
    model: resolved.model.clone(),
    // ... rest unchanged
}).await?;
```

- [ ] **Step 2: Triage call**

In the block at `operator.rs:2015` (the `triage_oneshot` call), use `Role::Triage`. Because `triage_oneshot` lives in `karl_agent`, add a trait-based variant in `crates/agent/src/provider.rs`:

```rust
pub async fn triage_via_provider(
    provider: &dyn LlmProvider,
    mut req: AskRequest,
) -> Result<(crate::TriageVerdict, crate::TokenUsage), AgentError> {
    req.system_prompt.push_str(crate::TRIAGE_OUTPUT_INSTRUCTIONS);
    if req.max_tokens == 0 || req.max_tokens > 128 { req.max_tokens = 64; }
    let resp = collect_oneshot(provider, req).await?;
    let verdict = crate::parse_triage_reply(&resp.text)?;
    Ok((verdict, resp.usage))
}
```

In `operator.rs`:

```rust
let resolved_t = resolve_route(&s, Role::Triage)?;
let triage_result = karl_agent::provider::triage_via_provider(
    &*resolved_t.provider,
    AskRequest {
        api_key: String::new(),
        model: resolved_t.model.clone(),
        // ... rest unchanged
    },
).await;
```

- [ ] **Step 3: Add `OperatorError::Provider` variant if needed**

In `crates/app/src/operator.rs`, find the `OperatorError` enum and add:

```rust
#[error("provider: {0}")]
Provider(String),
```

- [ ] **Step 4: Build + test**

Run: `cargo test -p covenant operator`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/operator.rs crates/agent/src/provider.rs
git commit -m "refactor(operator): decision + triage calls go through provider_resolve"
```

---

## Task 9: Tauri commands for provider CRUD + connection test

**Files:**
- Modify: `crates/app/src/lib.rs` — register new commands
- Create: `crates/app/src/providers_cmd.rs`

- [ ] **Step 1: Write the failing test**

Create `crates/app/src/providers_cmd.rs` with a unit test for the pure function `list_models_for(kind, base_url)`:

```rust
//! Tauri commands for the Settings → Providers UI: list/add/delete
//! provider entries, and probe a configured endpoint for the list of
//! available models. Pure helpers are testable; the Tauri command
//! wrappers below are thin adapters.

use karl_agent::provider::ProviderKind;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    /// Some providers (Ollama) report family/size; we keep a freeform
    /// label for the dropdown.
    pub label: Option<String>,
}

/// Hardcoded Anthropic model catalogue. We never hit the Anthropic API
/// just to populate a dropdown.
pub fn anthropic_models() -> Vec<ModelInfo> {
    [
        "claude-opus-4-7",
        "claude-sonnet-4-6",
        "claude-haiku-4-5",
        karl_agent::DEFAULT_TRIAGE_MODEL,
    ]
    .into_iter()
    .map(|id| ModelInfo { id: id.to_string(), label: None })
    .collect::<Vec<_>>()
}

pub async fn probe_openai_compat_models(base_url: &str) -> Result<Vec<ModelInfo>, String> {
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("{}: {}", resp.status(), url));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let items = body.get("data").and_then(|d| d.as_array()).cloned().unwrap_or_default();
    Ok(items
        .into_iter()
        .filter_map(|v| {
            let id = v.get("id").and_then(|s| s.as_str())?.to_string();
            Some(ModelInfo { id, label: None })
        })
        .collect())
}

#[tauri::command]
pub fn list_models_anthropic() -> Vec<ModelInfo> {
    anthropic_models()
}

#[tauri::command]
pub async fn list_models_openai_compat(base_url: String) -> Result<Vec<ModelInfo>, String> {
    probe_openai_compat_models(&base_url).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anthropic_catalogue_includes_opus_and_sonnet() {
        let ids: Vec<_> = anthropic_models().into_iter().map(|m| m.id).collect();
        assert!(ids.iter().any(|i| i == "claude-opus-4-7"));
        assert!(ids.iter().any(|i| i == "claude-sonnet-4-6"));
    }
}
```

Register in `crates/app/src/lib.rs`: add `pub mod providers_cmd;` and inside the `tauri::Builder::default().invoke_handler(tauri::generate_handler![…])` macro append `providers_cmd::list_models_anthropic, providers_cmd::list_models_openai_compat`.

- [ ] **Step 2: Build + test**

Run: `cargo test -p covenant providers_cmd`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add crates/app/src/providers_cmd.rs crates/app/src/lib.rs
git commit -m "feat(app): Tauri commands for provider catalogue + Ollama probe"
```

---

## Task 10: Settings UI — new Providers tab

**Files:**
- Create: `ui/src/settings/providers.ts`
- Modify: `ui/src/settings/panel.ts` (sidebar nav + section mount points)
- Modify: `ui/src/api.ts` (typed wrappers for new Tauri commands)

- [ ] **Step 1: Add typed Tauri wrappers**

In `ui/src/api.ts`, append:

```ts
export type ModelInfo = { id: string; label: string | null };

export async function listModelsAnthropic(): Promise<ModelInfo[]> {
  return invoke("list_models_anthropic");
}

export async function listModelsOpenAiCompat(baseUrl: string): Promise<ModelInfo[]> {
  return invoke("list_models_openai_compat", { baseUrl });
}
```

- [ ] **Step 2: Implement the Providers tab**

Create `ui/src/settings/providers.ts`:

```ts
import type { Settings } from "../api";
import { listModelsOpenAiCompat } from "../api";

type ProviderKind = "anthropic" | "openai_compat";

export interface ProviderEntry {
  kind: ProviderKind;
  label: string;
  api_key?: string | null;
  base_url?: string | null;
}

export function renderProvidersTab(
  root: HTMLElement,
  settings: Settings,
  onChange: (next: Settings) => void,
): void {
  root.innerHTML = "";

  const list = document.createElement("div");
  list.className = "providers-list";
  for (const [id, entry] of Object.entries(settings.providers ?? {})) {
    list.appendChild(renderProviderCard(id, entry, settings, onChange));
  }
  root.appendChild(list);

  const addBtn = document.createElement("button");
  addBtn.textContent = "+ Add provider";
  addBtn.className = "btn-secondary";
  addBtn.onclick = () => {
    const id = prompt("Provider id (e.g. ollama, lmstudio):")?.trim();
    if (!id || settings.providers?.[id]) return;
    const next = structuredClone(settings);
    next.providers = { ...(next.providers ?? {}) };
    next.providers[id] = {
      kind: "openai_compat",
      label: id,
      base_url: "http://localhost:11434/v1",
    };
    onChange(next);
  };
  root.appendChild(addBtn);
}

function renderProviderCard(
  id: string,
  entry: ProviderEntry,
  settings: Settings,
  onChange: (next: Settings) => void,
): HTMLElement {
  const card = document.createElement("div");
  card.className = "provider-card";

  const title = document.createElement("h3");
  title.textContent = `${entry.label} (${entry.kind})`;
  card.appendChild(title);

  if (entry.kind === "anthropic") {
    const keyInput = document.createElement("input");
    keyInput.type = "password";
    keyInput.placeholder = "sk-ant-...";
    keyInput.value = entry.api_key ?? "";
    keyInput.oninput = () => {
      const next = structuredClone(settings);
      next.providers[id] = { ...entry, api_key: keyInput.value };
      onChange(next);
    };
    card.appendChild(label("API key", keyInput));
  } else {
    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.value = entry.base_url ?? "http://localhost:11434/v1";
    urlInput.oninput = () => {
      const next = structuredClone(settings);
      next.providers[id] = { ...entry, base_url: urlInput.value };
      onChange(next);
    };
    card.appendChild(label("Base URL", urlInput));

    const testBtn = document.createElement("button");
    testBtn.textContent = "Test connection";
    const status = document.createElement("span");
    status.className = "provider-status";
    testBtn.onclick = async () => {
      status.textContent = "…";
      try {
        const models = await listModelsOpenAiCompat(urlInput.value);
        status.textContent = `OK — ${models.length} models`;
      } catch (e) {
        status.textContent = `Error: ${String(e)}`;
      }
    };
    card.appendChild(testBtn);
    card.appendChild(status);
  }

  if (id !== "anthropic") {
    const del = document.createElement("button");
    del.textContent = "Delete";
    del.className = "btn-danger";
    del.onclick = () => {
      if (!confirm(`Delete provider "${id}"?`)) return;
      const next = structuredClone(settings);
      next.providers = { ...next.providers };
      delete next.providers[id];
      onChange(next);
    };
    card.appendChild(del);
  }

  return card;
}

function label(text: string, input: HTMLElement): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "field";
  const span = document.createElement("span");
  span.textContent = text;
  wrap.appendChild(span);
  wrap.appendChild(input);
  return wrap;
}
```

- [ ] **Step 3: Wire the tab into `panel.ts`**

In `ui/src/settings/panel.ts`, locate the sidebar nav definitions (search for the `Anthropic` entry). Replace `Anthropic` with `Providers`. Replace the existing Anthropic-key/API-key section mount with a call to `renderProvidersTab(root, settings, onChange)`. Remove the inline "API key" input — it is now inside the Providers tab.

- [ ] **Step 4: Typecheck + visual smoke**

Run: `cd ui && pnpm typecheck`
Expected: clean.

Run: `pnpm tauri dev` and open Settings → Providers. Confirm: Anthropic entry shows with API key field; "+ Add provider" creates an Ollama entry; "Test connection" hits the local endpoint.

- [ ] **Step 5: Commit**

```bash
git add ui/src/settings/providers.ts ui/src/settings/panel.ts ui/src/api.ts
git commit -m "feat(settings-ui): Providers tab with add/delete/test"
```

---

## Task 11: Settings UI — per-role Models tab

**Files:**
- Create: `ui/src/settings/model_routes.ts`
- Modify: `ui/src/settings/panel.ts` (mount in the existing Models tab)

- [ ] **Step 1: Implement the Models tab**

Create `ui/src/settings/model_routes.ts`:

```ts
import type { Settings } from "../api";
import { listModelsAnthropic, listModelsOpenAiCompat } from "../api";

type Role = "summary" | "chat" | "operator" | "triage";

const ROLE_LABEL: Record<Role, string> = {
  summary:  "Summary",
  chat:     "Chat (⌘K)",
  operator: "Operator",
  triage:   "Triage (cheap classifier)",
};

const ROLE_HINT: Record<Role, string> = {
  summary:  "Used for per-session rolling summaries (frequent, cheap).",
  chat:     "Used when you ask the agent a question.",
  operator: "Tool use required — provider must support it.",
  triage:   "Used to gate expensive operator calls. Tiny model is fine.",
};

export function renderModelsTab(
  root: HTMLElement,
  settings: Settings,
  onChange: (next: Settings) => void,
): void {
  root.innerHTML = "";
  for (const role of ["summary", "chat", "operator", "triage"] as Role[]) {
    root.appendChild(renderRoleRow(role, settings, onChange));
  }
}

function renderRoleRow(
  role: Role,
  settings: Settings,
  onChange: (next: Settings) => void,
): HTMLElement {
  const route = settings.model_routes[role] ?? { provider_id: "anthropic", model: "" };
  const wrap = document.createElement("div");
  wrap.className = "model-route-row";

  const title = document.createElement("h4");
  title.textContent = ROLE_LABEL[role];
  wrap.appendChild(title);

  const providerSel = document.createElement("select");
  for (const [id, entry] of Object.entries(settings.providers ?? {})) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = entry.label;
    if (id === route.provider_id) opt.selected = true;
    providerSel.appendChild(opt);
  }

  const modelSel = document.createElement("select");
  const warn = document.createElement("p");
  warn.className = "field-warning";

  const refreshModels = async () => {
    const providerId = providerSel.value;
    const entry = settings.providers[providerId];
    modelSel.innerHTML = "";
    let models;
    try {
      if (entry.kind === "anthropic") {
        models = await listModelsAnthropic();
      } else {
        models = await listModelsOpenAiCompat(entry.base_url ?? "");
      }
    } catch (e) {
      const opt = document.createElement("option");
      opt.value = route.model;
      opt.textContent = `${route.model} (couldn't probe: ${e})`;
      modelSel.appendChild(opt);
      return;
    }
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.id;
      if (m.id === route.model) opt.selected = true;
      modelSel.appendChild(opt);
    }
    // If current model not in list, add a synthetic option so we don't drop it silently.
    if (![...modelSel.options].some((o) => o.value === route.model)) {
      const opt = document.createElement("option");
      opt.value = route.model;
      opt.textContent = `${route.model} (current)`;
      modelSel.appendChild(opt);
      modelSel.value = route.model;
    }
    updateWarning();
  };

  const updateWarning = () => {
    const providerId = providerSel.value;
    const entry = settings.providers[providerId];
    warn.textContent = "";
    if (role === "operator" && entry?.kind === "openai_compat") {
      warn.textContent =
        "⚠ Local providers don't translate Anthropic tool-use yet — operator will fall back to SuggestOnly.";
    } else {
      warn.textContent = ROLE_HINT[role];
    }
  };

  providerSel.onchange = () => {
    const next = structuredClone(settings);
    next.model_routes[role] = { provider_id: providerSel.value, model: route.model };
    onChange(next);
    refreshModels();
  };
  modelSel.onchange = () => {
    const next = structuredClone(settings);
    next.model_routes[role] = {
      provider_id: providerSel.value,
      model: modelSel.value,
    };
    onChange(next);
  };

  wrap.appendChild(labeled("Provider", providerSel));
  wrap.appendChild(labeled("Model", modelSel));
  wrap.appendChild(warn);

  refreshModels();
  return wrap;
}

function labeled(text: string, ctl: HTMLElement): HTMLElement {
  const w = document.createElement("label");
  w.className = "field";
  const span = document.createElement("span");
  span.textContent = text;
  w.appendChild(span);
  w.appendChild(ctl);
  return w;
}
```

- [ ] **Step 2: Replace the old Models section in `panel.ts`**

In `ui/src/settings/panel.ts`, find the section that renders `Summary model` / `Chat model (⌘K)` / `Max calls / minute / session` as free text inputs. Replace the two model inputs with a call to `renderModelsTab(modelsRoot, settings, onChange)`. Keep `Max calls / minute / session` (it's per-account, not per-role).

- [ ] **Step 3: Typecheck + manual smoke**

Run: `cd ui && pnpm typecheck`
Expected: clean.

Run: `pnpm tauri dev`. In Settings → Models, confirm: each role shows two dropdowns, Operator + local provider shows the SuggestOnly warning, switching provider repopulates the model dropdown.

- [ ] **Step 4: Commit**

```bash
git add ui/src/settings/model_routes.ts ui/src/settings/panel.ts
git commit -m "feat(settings-ui): per-role provider+model dropdowns"
```

---

## Task 12: Smoke test against a real Ollama install

**Files:** none — runtime verification only.

- [ ] **Step 1: Pull a small model**

Run: `ollama pull qwen2.5:3b` (skip if user doesn't have Ollama installed — note in PR).

- [ ] **Step 2: Configure summary route via the UI**

In Settings → Providers → + Add provider → id `ollama`, kind `openai_compat`, base URL `http://localhost:11434/v1`. Click Test connection — expect "OK — N models". Then Settings → Models → Summary → provider Ollama, model `qwen2.5:3b`. Save.

- [ ] **Step 3: Trigger a summary**

Open a new tab, run a few commands (`ls`, `cd ~`, `cat README.md`), wait ~30s for the rolling summary to fire.

- [ ] **Step 4: Verify in logs**

Run: `tail -50 ~/Library/Logs/com.karluiz.covenant/covenant.log | grep -i 'summarizer\|provider'`
Expected: log lines showing the call hit `localhost:11434` and produced text.

- [ ] **Step 5: Document in CHANGELOG and commit**

Add an entry to `CHANGELOG.md` under the next unreleased section:

```md
- **Local LLM providers (Phase 1):** Operators can now route summary/chat
  calls to Ollama, LM Studio, or any OpenAI-compatible local runtime.
  Configure under Settings → Providers, then assign per role under
  Settings → Models. Operator role stays on Anthropic for tool use;
  warning shown if you route it to a local provider.
```

Commit:

```bash
git add CHANGELOG.md
git commit -m "docs: changelog entry for local-LLM providers"
```

---

## Self-Review Notes

**Spec coverage:**
- Provider abstraction (Anthropic + Ollama/OpenAI-compat) → Tasks 1-3 ✓
- Per-role routing in settings + migration → Task 4 ✓
- Caller migration → Tasks 5-8 ✓
- Tauri commands for provider list/probe → Task 9 ✓
- Settings UI redesign (Providers tab + per-role Models tab) → Tasks 10-11 ✓
- End-to-end Ollama smoke test → Task 12 ✓

**Deferred to Phase 2/3** (not in this plan, intentionally):
- Tool-use translation for local providers (operator role with Ollama).
- Per-operator model override.
- Capability-aware UI gating (today: soft warning only).
- Anthropic prompt-caching reuse savings when routes change provider.

**Type consistency check:** `Role`, `ProviderKind`, `ProviderEntry`, `RouteEntry`, `ResolvedRoute`, `collect_oneshot`, `triage_via_provider`, `resolve_route` — names match between Rust types and TS schema (`provider_id`, `model`, `kind`, `label`, `api_key`, `base_url` — `snake_case` on the wire on both sides).

**Risk callout:** Tasks 6-8 touch hot paths (operator decision loop). Run `cargo test -p covenant` and a manual smoke through Settings before committing each one — the existing `AskRequest.api_key` field stays but is now ignored by the trait path; if any caller still relies on it (e.g. an integration test), it will fail loudly.
