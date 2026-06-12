# Azure Foundry Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Azure AI Foundry as a third `LlmProvider` (kinds: Azure OpenAI deployments + Azure AI Inference `/models`) with API-key auth, wired through settings, resolver, and the Providers UI tab.

**Architecture:** New `ProviderKind::AzureFoundry` variant. SSE parsing extracted from `openai_compat.rs` into `provider/openai_sse.rs` and reused by a new `provider/azure_foundry.rs`. `ProviderEntry` gains optional `azure_mode` / `azure_api_version` / `azure_deployment` fields. Resolver constructs the typed `AzureFoundryConfig`. UI adds a preset and a card variant with mode-aware fields plus a `list_models_azure_foundry` Tauri command.

**Tech Stack:** Rust + `reqwest` + `tokio` + `async-trait` + `wiremock` (tests); TypeScript + Tauri commands.

**Spec:** `docs/superpowers/specs/2026-05-22-azure-foundry-provider-design.md`

---

## File Structure

**Create:**
- `crates/agent/src/provider/openai_sse.rs` — shared SSE chunk parser (deltas, usage, tool_calls, finish_reason)
- `crates/agent/src/provider/azure_foundry.rs` — `AzureFoundryProvider`, `AzureFoundryConfig`, `AzureMode`
- `crates/agent/tests/provider_azure_foundry.rs` — wiremock integration tests

**Modify:**
- `crates/agent/src/provider/mod.rs` — add `AzureFoundry` to `ProviderKind`, export new module
- `crates/agent/src/provider/openai_compat.rs` — delegate SSE parsing to `openai_sse`
- `crates/app/src/settings.rs` — extend `ProviderEntry` with optional azure_* fields
- `crates/app/src/provider_resolve.rs` — third match arm + new error variants
- `crates/app/src/providers_cmd.rs` — `list_models_azure_foundry` command + helper
- `crates/app/src/lib.rs` — register the new Tauri command
- `ui/src/api.ts` — TS types for `azure_*` fields + `listModelsAzureFoundry` wrapper
- `ui/src/settings/providers.ts` — preset + mode-aware card

---

## Task 1: Add `AzureFoundry` variant to `ProviderKind`

**Files:**
- Modify: `crates/agent/src/provider/mod.rs`

- [ ] **Step 1: Write failing test**

Append to `#[cfg(test)] mod tests` in `crates/agent/src/provider/mod.rs`:

```rust
    #[test]
    fn azure_foundry_kind_round_trips_through_serde() {
        let k: ProviderKind = serde_json::from_str("\"azure_foundry\"").unwrap();
        assert_eq!(k, ProviderKind::AzureFoundry);
        let s = serde_json::to_string(&ProviderKind::AzureFoundry).unwrap();
        assert_eq!(s, "\"azure_foundry\"");
    }
```

- [ ] **Step 2: Run, verify it fails**

```
cargo test -p karl-agent provider::tests::azure_foundry_kind_round_trips -- --nocapture
```

Expected: FAIL (variant does not exist).

- [ ] **Step 3: Add variant**

In `crates/agent/src/provider/mod.rs`, change the enum:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    Anthropic,
    #[serde(rename = "openai_compat", alias = "open_ai_compat")]
    OpenAiCompat,
    AzureFoundry,
}
```

Also extend `collect_oneshot` so the new variant has an executor label. Find the `match provider.kind()` block and add:

```rust
        ProviderKind::AzureFoundry => "azure_foundry",
```

- [ ] **Step 4: Run test, verify pass**

```
cargo test -p karl-agent provider::tests
```

Expected: all pass.

- [ ] **Step 5: Commit**

```
git add crates/agent/src/provider/mod.rs
git commit -m "feat(agent): add AzureFoundry variant to ProviderKind"
```

---

## Task 2: Extract SSE parsing into `openai_sse.rs`

**Files:**
- Create: `crates/agent/src/provider/openai_sse.rs`
- Modify: `crates/agent/src/provider/mod.rs` (export module)
- Modify: `crates/agent/src/provider/openai_compat.rs` (delegate)

- [ ] **Step 1: Create the SSE module**

Write `crates/agent/src/provider/openai_sse.rs`:

```rust
//! Shared SSE chunk parser for OpenAI-shaped Chat Completions streams.
//! Used by both `openai_compat` and `azure_foundry`.

use crate::{AgentEvent, TokenUsage};

/// Find the next `\n\n` boundary in `buf`. Returns the index of the
/// first `\n` (so a `drain(..idx + 2)` consumes the whole separator).
pub fn find_double_newline(buf: &[u8]) -> Option<usize> {
    buf.windows(2).position(|w| w == b"\n\n")
}

/// Parse one drained event block (everything up to but not including
/// the `\n\n`) and emit `AgentEvent`s via `on_event`. Returns `true`
/// when the stream signaled `[DONE]`.
pub fn handle_event_block(text: &str, on_event: &mut dyn FnMut(AgentEvent)) -> bool {
    for line in text.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim_start();
        if data.is_empty() {
            continue;
        }
        if data == "[DONE]" {
            on_event(AgentEvent::Done);
            return true;
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
            if let Some(reason) = choice.get("finish_reason").and_then(|r| r.as_str()) {
                on_event(AgentEvent::StopReason(reason.to_string()));
            }
        }

        if let Some(usage) = v.get("usage") {
            let get = |k: &str| {
                usage
                    .get(k)
                    .and_then(|n| n.as_u64())
                    .map(|n| n as u32)
                    .unwrap_or(0)
            };
            on_event(AgentEvent::Usage(TokenUsage {
                input_tokens: get("prompt_tokens"),
                output_tokens: get("completion_tokens"),
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
            }));
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn done_marker_returns_true_and_emits_done() {
        let mut events = vec![];
        let done = handle_event_block("data: [DONE]", &mut |e| events.push(e));
        assert!(done);
        assert!(matches!(events.as_slice(), [AgentEvent::Done]));
    }

    #[test]
    fn content_delta_is_emitted() {
        let mut events = vec![];
        handle_event_block(
            r#"data: {"choices":[{"delta":{"content":"hi"}}]}"#,
            &mut |e| events.push(e),
        );
        match events.as_slice() {
            [AgentEvent::Delta(s)] => assert_eq!(s, "hi"),
            other => panic!("unexpected events: {other:?}"),
        }
    }

    #[test]
    fn usage_block_emits_token_counts() {
        let mut events = vec![];
        handle_event_block(
            r#"data: {"usage":{"prompt_tokens":12,"completion_tokens":34}}"#,
            &mut |e| events.push(e),
        );
        match events.as_slice() {
            [AgentEvent::Usage(u)] => {
                assert_eq!(u.input_tokens, 12);
                assert_eq!(u.output_tokens, 34);
            }
            other => panic!("unexpected events: {other:?}"),
        }
    }
}
```

- [ ] **Step 2: Export it**

In `crates/agent/src/provider/mod.rs`, add under the existing `pub mod` lines:

```rust
pub mod openai_sse;
```

- [ ] **Step 3: Make `openai_compat.rs` delegate**

In `crates/agent/src/provider/openai_compat.rs`:

1. Replace the local `find_double_newline` function (bottom of file) — delete it.
2. At the top of the file, after the `use crate::provider::{...}` line, add:

```rust
use crate::provider::openai_sse;
```

3. Inside `ask_streaming`, replace the inner `while let Some(idx) = find_double_newline(&buffer) { ... }` loop body with:

```rust
            while let Some(idx) = openai_sse::find_double_newline(&buffer) {
                let raw: Vec<u8> = buffer.drain(..idx + 2).collect();
                let text = String::from_utf8_lossy(&raw);
                let done = openai_sse::handle_event_block(&text, &mut |e| on_event(e));
                if done {
                    return Ok(());
                }
            }
```

(This replaces the block from `while let Some(idx) = find_double_newline(&buffer) {` through its closing `}` before `on_event(AgentEvent::Done); Ok(())`.)

- [ ] **Step 4: Run all existing tests, verify still pass**

```
cargo test -p karl-agent
```

Expected: all pass including `provider/openai_sse.rs` unit tests and any existing `provider_openai_compat.rs` integration tests.

- [ ] **Step 5: Commit**

```
git add crates/agent/src/provider/
git commit -m "refactor(agent): extract OpenAI SSE parsing into shared module"
```

---

## Task 3: Implement `AzureFoundryProvider` (config + URL/header logic)

**Files:**
- Create: `crates/agent/src/provider/azure_foundry.rs`
- Modify: `crates/agent/src/provider/mod.rs` (declare module)

- [ ] **Step 1: Declare the module**

In `crates/agent/src/provider/mod.rs`, add:

```rust
pub mod azure_foundry;
```

- [ ] **Step 2: Write the new file with config types + URL logic + a unit test**

Create `crates/agent/src/provider/azure_foundry.rs`:

```rust
//! Azure AI Foundry provider. Supports two modes:
//!  - `AzureOpenAi`: per-deployment endpoint
//!    `{endpoint}/openai/deployments/{deployment}/chat/completions?api-version=…`
//!  - `AiInference`: unified `/models` endpoint
//!    `{endpoint}/models/chat/completions?api-version=…`
//! Auth is `api-key` header in both modes (Bearer/Entra ID deferred).
//! Body shape is OpenAI Chat Completions; SSE handling reuses
//! `provider::openai_sse`.

use async_trait::async_trait;
use futures_util::StreamExt;

use crate::provider::{openai_sse, Capabilities, LlmProvider, ProviderKind};
use crate::{AgentError, AgentEvent, AskRequest};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AzureMode {
    AzureOpenAi,
    AiInference,
}

pub fn default_api_version(mode: AzureMode) -> &'static str {
    match mode {
        AzureMode::AzureOpenAi => "2024-10-21",
        AzureMode::AiInference => "2024-05-01-preview",
    }
}

#[derive(Debug, Clone)]
pub struct AzureFoundryConfig {
    pub mode: AzureMode,
    pub endpoint: String,
    pub api_key: String,
    pub api_version: String,
    pub deployment: Option<String>,
}

pub struct AzureFoundryProvider {
    cfg: AzureFoundryConfig,
}

impl AzureFoundryProvider {
    pub fn new(cfg: AzureFoundryConfig) -> Self {
        Self { cfg }
    }

    fn url(&self) -> String {
        let base = self.cfg.endpoint.trim_end_matches('/');
        match self.cfg.mode {
            AzureMode::AzureOpenAi => {
                let dep = self.cfg.deployment.as_deref().unwrap_or("");
                format!(
                    "{}/openai/deployments/{}/chat/completions?api-version={}",
                    base, dep, self.cfg.api_version
                )
            }
            AzureMode::AiInference => format!(
                "{}/models/chat/completions?api-version={}",
                base, self.cfg.api_version
            ),
        }
    }

    fn body(&self, req: &AskRequest) -> serde_json::Value {
        let mut b = serde_json::json!({
            "max_tokens": req.max_tokens,
            "stream": true,
            "stream_options": { "include_usage": true },
            "messages": [
                { "role": "system", "content": req.system_prompt },
                { "role": "user",   "content": req.user_message },
            ],
        });
        // In Azure OpenAI mode the deployment in the URL is authoritative —
        // sending `model` is rejected by some api-versions.
        if matches!(self.cfg.mode, AzureMode::AiInference) {
            b.as_object_mut()
                .unwrap()
                .insert("model".into(), serde_json::Value::String(req.model.clone()));
        }
        b
    }
}

#[async_trait]
impl LlmProvider for AzureFoundryProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::AzureFoundry
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            tool_use: true,
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

        let response = client
            .post(self.url())
            .header("content-type", "application/json")
            .header("api-key", &self.cfg.api_key)
            .json(&self.body(&req))
            .send()
            .await?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(AgentError::Api {
                status: status.as_u16(),
                body,
            });
        }

        let mut stream = response.bytes_stream();
        let mut buffer: Vec<u8> = Vec::with_capacity(8 * 1024);

        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            buffer.extend_from_slice(&chunk);
            while let Some(idx) = openai_sse::find_double_newline(&buffer) {
                let raw: Vec<u8> = buffer.drain(..idx + 2).collect();
                let text = String::from_utf8_lossy(&raw);
                let done = openai_sse::handle_event_block(&text, &mut |e| on_event(e));
                if done {
                    return Ok(());
                }
            }
        }
        on_event(AgentEvent::Done);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(mode: AzureMode, deployment: Option<&str>) -> AzureFoundryConfig {
        AzureFoundryConfig {
            mode,
            endpoint: "https://example.openai.azure.com".into(),
            api_key: "k".into(),
            api_version: default_api_version(mode).to_string(),
            deployment: deployment.map(|s| s.to_string()),
        }
    }

    #[test]
    fn azure_openai_url_includes_deployment_and_api_version() {
        let p = AzureFoundryProvider::new(cfg(AzureMode::AzureOpenAi, Some("gpt4o")));
        assert_eq!(
            p.url(),
            "https://example.openai.azure.com/openai/deployments/gpt4o/chat/completions?api-version=2024-10-21"
        );
    }

    #[test]
    fn ai_inference_url_uses_models_path() {
        let p = AzureFoundryProvider::new(cfg(AzureMode::AiInference, None));
        assert!(p.url().ends_with("/models/chat/completions?api-version=2024-05-01-preview"));
    }

    #[test]
    fn ai_inference_body_includes_model_field() {
        let p = AzureFoundryProvider::new(cfg(AzureMode::AiInference, None));
        let req = AskRequest {
            model: "Phi-3-medium".into(),
            max_tokens: 16,
            system_prompt: "s".into(),
            user_message: "u".into(),
            ..Default::default()
        };
        let b = p.body(&req);
        assert_eq!(b.get("model").and_then(|v| v.as_str()), Some("Phi-3-medium"));
    }

    #[test]
    fn azure_openai_body_omits_model_field() {
        let p = AzureFoundryProvider::new(cfg(AzureMode::AzureOpenAi, Some("gpt4o")));
        let req = AskRequest {
            model: "ignored".into(),
            max_tokens: 16,
            system_prompt: "s".into(),
            user_message: "u".into(),
            ..Default::default()
        };
        let b = p.body(&req);
        assert!(b.get("model").is_none());
    }

    #[test]
    fn default_api_versions_per_mode() {
        assert_eq!(default_api_version(AzureMode::AzureOpenAi), "2024-10-21");
        assert_eq!(default_api_version(AzureMode::AiInference), "2024-05-01-preview");
    }
}
```

> If `AskRequest` does not impl `Default`, drop the `..Default::default()` in tests and fill every field explicitly. Check `crates/agent/src/lib.rs` for the actual struct shape and adjust before running.

- [ ] **Step 3: Run unit tests**

```
cargo test -p karl-agent provider::azure_foundry
```

Expected: 5 tests pass.

- [ ] **Step 4: Commit**

```
git add crates/agent/src/provider/
git commit -m "feat(agent): AzureFoundryProvider with AzureOpenAi + AiInference modes"
```

---

## Task 4: Wiremock integration tests for Azure Foundry streaming

**Files:**
- Create: `crates/agent/tests/provider_azure_foundry.rs`

- [ ] **Step 1: Check existing test scaffolding**

Read `crates/agent/tests/provider_openai_compat.rs` to copy its `wiremock` setup style (imports, `ResponseTemplate`, SSE body construction). Mirror it.

- [ ] **Step 2: Write the integration test file**

Create `crates/agent/tests/provider_azure_foundry.rs` modeled on the openai_compat test file. Required test cases:

```rust
use karl_agent::provider::azure_foundry::{
    default_api_version, AzureFoundryConfig, AzureFoundryProvider, AzureMode,
};
use karl_agent::provider::LlmProvider;
use karl_agent::{AgentEvent, AskRequest};
use wiremock::matchers::{header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn sse_body() -> String {
    [
        r#"data: {"choices":[{"delta":{"content":"he"}}]}"#,
        "",
        r#"data: {"choices":[{"delta":{"content":"llo"}}]}"#,
        "",
        r#"data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3}}"#,
        "",
        "data: [DONE]",
        "",
        "",
    ]
    .join("\n")
}

fn req(model: &str) -> AskRequest {
    // Fill all fields explicitly. Match the struct shape in crates/agent/src/lib.rs.
    AskRequest {
        model: model.into(),
        max_tokens: 32,
        system_prompt: "sys".into(),
        user_message: "hi".into(),
        // ...remaining fields default-equivalent values (history: vec![], tools: vec![], etc.)
        ..Default::default()
    }
}

#[tokio::test]
async fn azure_openai_mode_hits_deployment_path_with_api_key_header() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/openai/deployments/my-dep/chat/completions"))
        .and(query_param("api-version", "2024-10-21"))
        .and(header("api-key", "secret"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(sse_body()),
        )
        .mount(&server)
        .await;

    let p = AzureFoundryProvider::new(AzureFoundryConfig {
        mode: AzureMode::AzureOpenAi,
        endpoint: server.uri(),
        api_key: "secret".into(),
        api_version: default_api_version(AzureMode::AzureOpenAi).into(),
        deployment: Some("my-dep".into()),
    });

    let mut text = String::new();
    let mut usage_seen = false;
    p.ask_streaming(
        req("ignored"),
        Box::new(|e| match e {
            AgentEvent::Delta(s) => text.push_str(&s),
            AgentEvent::Usage(_) => { /* set in outer scope via Arc/Mutex in real test */ }
            _ => {}
        }),
    )
    .await
    .expect("stream ok");
    assert_eq!(text, "hello");
    let _ = usage_seen;
}

#[tokio::test]
async fn ai_inference_mode_posts_to_models_chat_completions() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/models/chat/completions"))
        .and(query_param("api-version", "2024-05-01-preview"))
        .and(header("api-key", "k"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(sse_body()),
        )
        .mount(&server)
        .await;

    let p = AzureFoundryProvider::new(AzureFoundryConfig {
        mode: AzureMode::AiInference,
        endpoint: server.uri(),
        api_key: "k".into(),
        api_version: default_api_version(AzureMode::AiInference).into(),
        deployment: None,
    });

    p.ask_streaming(req("Phi-3"), Box::new(|_| {}))
        .await
        .expect("stream ok");
}

#[tokio::test]
async fn non_2xx_response_surfaces_agent_error() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(401).set_body_string("unauthorized"))
        .mount(&server)
        .await;

    let p = AzureFoundryProvider::new(AzureFoundryConfig {
        mode: AzureMode::AiInference,
        endpoint: server.uri(),
        api_key: "bad".into(),
        api_version: default_api_version(AzureMode::AiInference).into(),
        deployment: None,
    });

    let err = p
        .ask_streaming(req("x"), Box::new(|_| {}))
        .await
        .expect_err("should fail");
    match err {
        karl_agent::AgentError::Api { status, .. } => assert_eq!(status, 401),
        other => panic!("expected Api error, got {other:?}"),
    }
}
```

> The Delta/Usage capture in the first test needs `Arc<Mutex<…>>` because the closure is `FnMut + Send` and can't borrow stack locals — copy the pattern from `provider_openai_compat.rs` exactly.

- [ ] **Step 3: Run tests**

```
cargo test -p karl-agent --test provider_azure_foundry
```

Expected: 3 tests pass.

- [ ] **Step 4: Commit**

```
git add crates/agent/tests/provider_azure_foundry.rs
git commit -m "test(agent): wiremock coverage for Azure Foundry provider"
```

---

## Task 5: Extend `ProviderEntry` with azure_* fields

**Files:**
- Modify: `crates/app/src/settings.rs`

- [ ] **Step 1: Read current shape**

Open `crates/app/src/settings.rs`. Locate `ProviderEntry`. Note its current fields.

- [ ] **Step 2: Add fields**

Extend the struct (keep all existing fields exactly as they are):

```rust
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ProviderEntry {
    pub kind: karl_agent::provider::ProviderKind,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    // Azure Foundry only — ignored for other kinds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub azure_mode: Option<karl_agent::provider::azure_foundry::AzureMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub azure_api_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub azure_deployment: Option<String>,
}
```

> Match the existing attribute style — if existing fields use `#[serde(default)]` without `skip_serializing_if`, mirror that instead. Goal: backward-compatible deserialize from old configs.

- [ ] **Step 3: Verify legacy config still parses**

Add a test next to existing tests in `settings.rs` (or in its `#[cfg(test)] mod tests`):

```rust
    #[test]
    fn legacy_provider_entry_without_azure_fields_still_deserializes() {
        let json = r#"{"kind":"anthropic","label":"Anthropic","api_key":"sk-x"}"#;
        let e: ProviderEntry = serde_json::from_str(json).unwrap();
        assert!(e.azure_mode.is_none());
        assert!(e.azure_api_version.is_none());
        assert!(e.azure_deployment.is_none());
    }
```

- [ ] **Step 4: Run**

```
cargo test -p karl-app settings::
```

Expected: pass.

- [ ] **Step 5: Commit**

```
git add crates/app/src/settings.rs
git commit -m "feat(settings): add Azure Foundry fields to ProviderEntry"
```

---

## Task 6: Resolver builds `AzureFoundryProvider`

**Files:**
- Modify: `crates/app/src/provider_resolve.rs`

- [ ] **Step 1: Write failing tests**

Append to `#[cfg(test)] mod tests` in `crates/app/src/provider_resolve.rs`:

```rust
    use karl_agent::provider::azure_foundry::AzureMode;

    fn settings_with_azure_route(mode: AzureMode, deployment: Option<&str>) -> Settings {
        let mut s = Settings::default();
        s.providers.insert(
            "azure".into(),
            crate::settings::ProviderEntry {
                kind: ProviderKind::AzureFoundry,
                label: "Azure".into(),
                api_key: Some("k".into()),
                base_url: Some("https://example.openai.azure.com".into()),
                azure_mode: Some(mode),
                azure_api_version: None,
                azure_deployment: deployment.map(|s| s.to_string()),
            },
        );
        s.model_routes.get_mut(&Role::Summary).unwrap().provider_id = "azure".into();
        s.model_routes.get_mut(&Role::Summary).unwrap().model = "x".into();
        s
    }

    #[test]
    fn resolves_role_to_azure_foundry() {
        let s = settings_with_azure_route(AzureMode::AiInference, None);
        let r = resolve_route(&s, Role::Summary).expect("route");
        assert_eq!(r.provider.kind(), ProviderKind::AzureFoundry);
    }

    #[test]
    fn errors_when_azure_openai_mode_missing_deployment() {
        let s = settings_with_azure_route(AzureMode::AzureOpenAi, None);
        let err = resolve_route(&s, Role::Summary).unwrap_err();
        assert!(matches!(err, ResolveError::MissingAzureDeployment));
    }

    #[test]
    fn errors_when_azure_endpoint_missing() {
        let mut s = settings_with_azure_route(AzureMode::AiInference, None);
        s.providers.get_mut("azure").unwrap().base_url = None;
        let err = resolve_route(&s, Role::Summary).unwrap_err();
        assert!(matches!(err, ResolveError::MissingAzureEndpoint));
    }
```

- [ ] **Step 2: Run, verify fail**

```
cargo test -p karl-app provider_resolve
```

Expected: FAIL (new variants don't exist, AzureFoundry arm missing).

- [ ] **Step 3: Implement**

Edit `crates/app/src/provider_resolve.rs`:

1. Add error variants:

```rust
#[derive(Debug, thiserror::Error)]
pub enum ResolveError {
    #[error("no route configured for role {0:?}")]
    NoRoute(Role),
    #[error("route points at provider id `{0}` which is not configured")]
    UnknownProvider(String),
    #[error("Azure Foundry provider missing endpoint (base_url)")]
    MissingAzureEndpoint,
    #[error("Azure Foundry provider missing api_key")]
    MissingAzureApiKey,
    #[error("Azure Foundry provider missing azure_mode")]
    MissingAzureMode,
    #[error("Azure OpenAI mode requires a deployment name")]
    MissingAzureDeployment,
}
```

2. Add imports at the top:

```rust
use karl_agent::provider::azure_foundry::{
    default_api_version, AzureFoundryConfig, AzureFoundryProvider, AzureMode,
};
```

3. Extend the `match entry.kind` block with the new arm:

```rust
        ProviderKind::AzureFoundry => {
            let mode = entry.azure_mode.ok_or(ResolveError::MissingAzureMode)?;
            let endpoint = entry
                .base_url
                .clone()
                .filter(|s| !s.trim().is_empty())
                .ok_or(ResolveError::MissingAzureEndpoint)?;
            let api_key = entry
                .api_key
                .clone()
                .filter(|s| !s.trim().is_empty())
                .ok_or(ResolveError::MissingAzureApiKey)?;
            if mode == AzureMode::AzureOpenAi && entry.azure_deployment.is_none() {
                return Err(ResolveError::MissingAzureDeployment);
            }
            let api_version = entry
                .azure_api_version
                .clone()
                .unwrap_or_else(|| default_api_version(mode).to_string());
            Arc::new(AzureFoundryProvider::new(AzureFoundryConfig {
                mode,
                endpoint,
                api_key,
                api_version,
                deployment: entry.azure_deployment.clone(),
            }))
        }
```

> The existing `cfg` (`ProviderConfig`) construction stays for Anthropic / OpenAiCompat. The Azure arm builds its config directly and ignores `cfg`. Restructure if needed — easiest is to move the `let cfg = …` inside the two original arms.

- [ ] **Step 4: Run, verify pass**

```
cargo test -p karl-app provider_resolve
```

Expected: all pass (existing + 3 new).

- [ ] **Step 5: Commit**

```
git add crates/app/src/provider_resolve.rs
git commit -m "feat(resolver): wire Azure Foundry through resolve_route"
```

---

## Task 7: `list_models_azure_foundry` Tauri command

**Files:**
- Modify: `crates/app/src/providers_cmd.rs`
- Modify: `crates/app/src/lib.rs`

- [ ] **Step 1: Write failing test**

Append to `#[cfg(test)] mod tests` in `crates/app/src/providers_cmd.rs`:

```rust
    #[tokio::test]
    async fn probe_azure_ai_inference_models_parses_data_array() {
        use wiremock::matchers::{header, method, path, query_param};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/models"))
            .and(query_param("api-version", "2024-05-01-preview"))
            .and(header("api-key", "k"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{"id": "Phi-3"}, {"id": "Llama-3"}]
            })))
            .mount(&server)
            .await;

        let out = probe_azure_foundry_models(
            &server.uri(),
            "k",
            karl_agent::provider::azure_foundry::AzureMode::AiInference,
            "2024-05-01-preview",
        )
        .await
        .expect("ok");
        let ids: Vec<_> = out.into_iter().map(|m| m.id).collect();
        assert_eq!(ids, vec!["Phi-3", "Llama-3"]);
    }
```

> Confirm `wiremock` is in `crates/app/Cargo.toml` `[dev-dependencies]`. If not, add `wiremock = "0.6"` there and `tokio = { workspace = true, features = ["macros", "rt-multi-thread"] }` if missing.

- [ ] **Step 2: Run, verify fail**

```
cargo test -p karl-app providers_cmd::tests::probe_azure
```

Expected: FAIL (function doesn't exist).

- [ ] **Step 3: Implement**

Append to `crates/app/src/providers_cmd.rs`:

```rust
pub async fn probe_azure_foundry_models(
    endpoint: &str,
    api_key: &str,
    mode: karl_agent::provider::azure_foundry::AzureMode,
    api_version: &str,
) -> Result<Vec<ModelInfo>, String> {
    use karl_agent::provider::azure_foundry::AzureMode;
    let base = endpoint.trim_end_matches('/');
    let url = match mode {
        AzureMode::AzureOpenAi => format!("{}/openai/models?api-version={}", base, api_version),
        AzureMode::AiInference => format!("{}/models?api-version={}", base, api_version),
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .header("api-key", api_key)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("{}: {}", resp.status(), url));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let items = body
        .get("data")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(items
        .into_iter()
        .filter_map(|v| {
            let id = v.get("id").and_then(|s| s.as_str())?.to_string();
            Some(ModelInfo { id, label: None })
        })
        .collect())
}

#[tauri::command]
pub async fn list_models_azure_foundry(
    endpoint: String,
    api_key: String,
    mode: karl_agent::provider::azure_foundry::AzureMode,
    api_version: String,
) -> Result<Vec<ModelInfo>, String> {
    probe_azure_foundry_models(&endpoint, &api_key, mode, &api_version).await
}
```

- [ ] **Step 4: Register the command**

In `crates/app/src/lib.rs`, find the `tauri::generate_handler![…]` macro invocation containing `providers_cmd::list_models_openai_compat,` and add the line:

```rust
            providers_cmd::list_models_azure_foundry,
```

- [ ] **Step 5: Run tests**

```
cargo test -p karl-app providers_cmd
```

Expected: existing + new test pass. Also run `cargo build -p karl-app` to confirm the handler registration compiles.

- [ ] **Step 6: Commit**

```
git add crates/app/src/providers_cmd.rs crates/app/src/lib.rs crates/app/Cargo.toml
git commit -m "feat(app): list_models_azure_foundry Tauri command"
```

---

## Task 8: TS types + API wrapper

**Files:**
- Modify: `ui/src/api.ts`

- [ ] **Step 1: Locate `ProviderEntry` type**

In `ui/src/api.ts`, find the `ProviderEntry` interface (or type alias).

- [ ] **Step 2: Extend it and add the helper**

Add fields to `ProviderEntry`:

```ts
export interface ProviderEntry {
  kind: "anthropic" | "openai_compat" | "azure_foundry";
  label: string;
  api_key?: string;
  base_url?: string;
  // Azure Foundry only:
  azure_mode?: "azure_open_ai" | "ai_inference";
  azure_api_version?: string;
  azure_deployment?: string;
}
```

> If `kind` was previously typed differently, widen it. Match existing casing.

Add the API wrapper near `listModelsOpenAiCompat`:

```ts
export async function listModelsAzureFoundry(args: {
  endpoint: string;
  apiKey: string;
  mode: "azure_open_ai" | "ai_inference";
  apiVersion: string;
}): Promise<ModelInfo[]> {
  return invoke<ModelInfo[]>("list_models_azure_foundry", {
    endpoint: args.endpoint,
    apiKey: args.apiKey,
    mode: args.mode,
    apiVersion: args.apiVersion,
  });
}
```

- [ ] **Step 3: Typecheck**

```
cd ui && npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 4: Commit**

```
git add ui/src/api.ts
git commit -m "feat(ui/api): types and wrapper for Azure Foundry provider"
```

---

## Task 9: Settings → Providers UI (preset + card)

**Files:**
- Modify: `ui/src/settings/providers.ts`

- [ ] **Step 1: Add the preset**

In the `+ Add provider` form, change the `<select class="add-provider-preset">` HTML to include Azure:

```ts
formWrap.innerHTML = `
    <select class="add-provider-preset">
      <option value="ollama">Ollama (http://localhost:11434/v1)</option>
      <option value="lmstudio">LM Studio (http://localhost:1234/v1)</option>
      <option value="azure_foundry">Azure Foundry</option>
      <option value="custom">Custom OpenAI-compatible…</option>
    </select>
    <input class="add-provider-id" type="text" placeholder="id (e.g. ollama)" />
    <input class="add-provider-url" type="text" placeholder="base URL" />
    <button type="button" class="btn-secondary add-provider-confirm">Add</button>
    <button type="button" class="add-provider-cancel">Cancel</button>
`;
```

Extend `applyPreset`:

```ts
  const applyPreset = () => {
    if (preset.value === "ollama") {
      idInput.value = "ollama";
      urlInput.value = "http://localhost:11434/v1";
    } else if (preset.value === "lmstudio") {
      idInput.value = "lmstudio";
      urlInput.value = "http://localhost:1234/v1";
    } else if (preset.value === "azure_foundry") {
      idInput.value = "azure";
      urlInput.value = "";
    } else {
      idInput.value = "";
      urlInput.value = "http://localhost:8080/v1";
    }
  };
```

Extend the `confirmBtn.onclick` handler so Azure picks the right kind + defaults:

```ts
  confirmBtn.onclick = () => {
    const id = idInput.value.trim();
    const url = urlInput.value.trim();
    if (!id) { idInput.focus(); return; }
    if (settings.providers?.[id]) { idInput.focus(); return; }
    const next = JSON.parse(JSON.stringify(settings)) as Settings;
    next.providers = { ...(next.providers ?? {}) };
    if (preset.value === "azure_foundry") {
      next.providers[id] = {
        kind: "azure_foundry",
        label: id,
        base_url: url,
        api_key: "",
        azure_mode: "ai_inference",
        azure_api_version: "2024-05-01-preview",
      };
    } else {
      next.providers[id] = {
        kind: "openai_compat",
        label: id,
        base_url: url || "http://localhost:11434/v1",
      };
    }
    onChange(next);
  };
```

- [ ] **Step 2: Branch the card renderer for `azure_foundry`**

In `renderProviderCard`, before the final `if (id !== "anthropic")` delete-button block, replace the existing `if (entry.kind === "anthropic") { … } else { … }` branch with a three-way branch:

```ts
  if (entry.kind === "anthropic") {
    const keyInput = document.createElement("input");
    keyInput.type = "password";
    keyInput.placeholder = "sk-ant-...";
    keyInput.value = entry.api_key ?? "";
    keyInput.oninput = () => {
      const next = JSON.parse(JSON.stringify(settings)) as Settings;
      next.providers![id] = { ...entry, api_key: keyInput.value.trim() };
      onChange(next);
    };
    card.appendChild(labeled("API key", keyInput));
  } else if (entry.kind === "azure_foundry") {
    renderAzureFoundryCard(card, id, entry, settings, onChange);
  } else {
    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.value = entry.base_url ?? "http://localhost:11434/v1";
    urlInput.oninput = () => {
      const next = JSON.parse(JSON.stringify(settings)) as Settings;
      next.providers![id] = { ...entry, base_url: urlInput.value };
      onChange(next);
    };
    card.appendChild(labeled("Base URL", urlInput));

    const testBtn = document.createElement("button");
    testBtn.textContent = "Test connection";
    testBtn.type = "button";
    testBtn.className = "settings-btn";
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
```

- [ ] **Step 3: Implement `renderAzureFoundryCard`**

At the bottom of `ui/src/settings/providers.ts`, add the import update and the function:

At the top of the file, replace:
```ts
import { listModelsOpenAiCompat } from "../api";
```
with:
```ts
import { listModelsOpenAiCompat, listModelsAzureFoundry } from "../api";
```

Then append:

```ts
function renderAzureFoundryCard(
  card: HTMLElement,
  id: string,
  entry: ProviderEntry,
  settings: Settings,
  onChange: (next: Settings) => void,
): void {
  const update = (patch: Partial<ProviderEntry>) => {
    const next = JSON.parse(JSON.stringify(settings)) as Settings;
    next.providers![id] = { ...entry, ...patch };
    onChange(next);
  };

  const modeSelect = document.createElement("select");
  modeSelect.innerHTML = `
    <option value="ai_inference">AI Inference (/models)</option>
    <option value="azure_open_ai">Azure OpenAI (deployments)</option>
  `;
  modeSelect.value = entry.azure_mode ?? "ai_inference";
  modeSelect.onchange = () => {
    const mode = modeSelect.value as "ai_inference" | "azure_open_ai";
    const defaultVersion =
      mode === "azure_open_ai" ? "2024-10-21" : "2024-05-01-preview";
    update({
      azure_mode: mode,
      azure_api_version:
        !entry.azure_api_version ||
        entry.azure_api_version === "2024-05-01-preview" ||
        entry.azure_api_version === "2024-10-21"
          ? defaultVersion
          : entry.azure_api_version,
    });
  };
  card.appendChild(labeled("Mode", modeSelect));

  const endpoint = document.createElement("input");
  endpoint.type = "text";
  endpoint.placeholder = "https://my-resource.services.ai.azure.com";
  endpoint.value = entry.base_url ?? "";
  endpoint.oninput = () => update({ base_url: endpoint.value.trim() });
  card.appendChild(labeled("Endpoint", endpoint));

  const apiKey = document.createElement("input");
  apiKey.type = "password";
  apiKey.value = entry.api_key ?? "";
  apiKey.oninput = () => update({ api_key: apiKey.value.trim() });
  card.appendChild(labeled("API key", apiKey));

  const apiVersion = document.createElement("input");
  apiVersion.type = "text";
  apiVersion.value =
    entry.azure_api_version ??
    (entry.azure_mode === "azure_open_ai" ? "2024-10-21" : "2024-05-01-preview");
  apiVersion.oninput = () => update({ azure_api_version: apiVersion.value.trim() });
  card.appendChild(labeled("API version", apiVersion));

  const deploymentWrap = labeled("Deployment", (() => {
    const i = document.createElement("input");
    i.type = "text";
    i.placeholder = "e.g. gpt-4o-deployment";
    i.value = entry.azure_deployment ?? "";
    i.oninput = () => update({ azure_deployment: i.value.trim() });
    return i;
  })());
  deploymentWrap.style.display =
    (entry.azure_mode ?? "ai_inference") === "azure_open_ai" ? "" : "none";
  card.appendChild(deploymentWrap);

  // Re-toggle deployment visibility when mode changes (modeSelect.onchange
  // above triggers a full re-render via onChange, so this is belt-and-braces).

  const testBtn = document.createElement("button");
  testBtn.textContent = "Test connection";
  testBtn.type = "button";
  testBtn.className = "settings-btn";
  const status = document.createElement("span");
  status.className = "provider-status";
  testBtn.onclick = async () => {
    status.textContent = "…";
    try {
      const models = await listModelsAzureFoundry({
        endpoint: endpoint.value.trim(),
        apiKey: apiKey.value.trim(),
        mode: (entry.azure_mode ?? "ai_inference") as
          | "ai_inference"
          | "azure_open_ai",
        apiVersion: apiVersion.value.trim(),
      });
      status.textContent = `OK — ${models.length} models`;
    } catch (e) {
      status.textContent = `Error: ${String(e)}`;
    }
  };
  card.appendChild(testBtn);
  card.appendChild(status);
}
```

- [ ] **Step 4: Typecheck**

```
cd ui && npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 5: Smoke-test by hand**

Run the app, open Settings → Providers, add an "Azure Foundry" provider, fill in your test endpoint + key, switch modes, click "Test connection". Verify:
- Switching to "Azure OpenAI" shows the Deployment field; switching back hides it (note: the field's visibility depends on a full re-render — confirm `onChange` triggers a fresh `renderProvidersTab` call; if not, the card needs a manual `deploymentWrap.style.display` update inside `modeSelect.onchange`. Patch if needed.)
- Test connection against a real Azure resource returns `OK — N models`.

- [ ] **Step 6: Commit**

```
git add ui/src/settings/providers.ts
git commit -m "feat(ui/settings): Azure Foundry provider card with mode-aware fields"
```

---

## Task 10: Final integration check

**Files:**
- None (verification only)

- [ ] **Step 1: Full test suite**

```
cargo test --workspace
```

Expected: all pass.

- [ ] **Step 2: Build the app**

```
cd ui && npm run build && cd .. && cargo build --release -p karl-app
```

Expected: clean build.

- [ ] **Step 3: End-to-end sanity check**

Launch Covenant, configure an Azure Foundry provider with a real key, route the `Summary` role to it, run a command that triggers a summary, watch logs (`tracing` output) to confirm the request hits the expected URL with `api-key` header and the SSE stream produces deltas.

- [ ] **Step 4: Commit any tweaks discovered during the e2e check; otherwise nothing to commit.**
