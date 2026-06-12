# Azure Foundry as an LLM Provider

**Status:** Draft
**Author:** Karluiz (via Claude)
**Date:** 2026-05-22

## Goal

Let users route Covenant's roles (Summary, Teammate, Triage, …) to models served by **Azure AI Foundry**. Two Foundry surfaces in scope:

1. **Azure OpenAI deployments** — `https://{resource}.openai.azure.com/openai/deployments/{deployment}/chat/completions?api-version=…`
2. **Azure AI Inference (`/models`)** — `https://{resource}.services.ai.azure.com/models/chat/completions?api-version=…`

Both use `api-key` header auth in v0. Entra ID / `DefaultAzureCredential` is **out of scope** but the config shape leaves room for it.

## Non-goals

- Entra ID / Bearer token auth (follow-up).
- Serverless MaaS per-model endpoints as a first-class flavor — each can be modeled as an "AI Inference" `ProviderEntry` pointing at its own URL.
- Claude-on-Foundry using Anthropic Messages shape — for now use the existing `Anthropic` provider with a custom `base_url`.
- Prompt caching telemetry (Azure does not expose `cache_*_input_tokens`).

## Architecture

### Provider enum

`crates/agent/src/provider/mod.rs`:

```rust
pub enum ProviderKind {
    Anthropic,
    OpenAiCompat,
    AzureFoundry,         // NEW
}
```

`ProviderConfig` stays the generic carrier (`api_key`, `base_url`). Azure-specific knobs ride on `ProviderEntry` in settings and are forwarded into a typed `AzureFoundryConfig` at construction time.

### New impl: `provider/azure_foundry.rs`

```rust
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AzureMode { AzureOpenAi, AiInference }

pub struct AzureFoundryConfig {
    pub mode: AzureMode,
    pub endpoint: String,           // base resource URL, no trailing slash
    pub api_key: String,
    pub api_version: String,        // default per mode
    pub deployment: Option<String>, // required iff mode == AzureOpenAi
}

pub struct AzureFoundryProvider { client: reqwest::Client, cfg: AzureFoundryConfig }

#[async_trait]
impl LlmProvider for AzureFoundryProvider {
    fn kind(&self) -> ProviderKind { ProviderKind::AzureFoundry }
    fn capabilities(&self) -> Capabilities {
        Capabilities { tool_use: true, prompt_caching: false, extended_thinking: false }
    }
    async fn ask_streaming(
        &self,
        req: AskRequest,
        on_event: Box<dyn FnMut(AgentEvent) + Send>,
    ) -> Result<(), AgentError> { /* see below */ }
}
```

**URL construction:**

| mode | URL |
|---|---|
| `AzureOpenAi` | `{endpoint}/openai/deployments/{deployment}/chat/completions?api-version={api_version}` |
| `AiInference` | `{endpoint}/models/chat/completions?api-version={api_version}` |

**Auth header:** `api-key: {api_key}` in both modes (Azure AI Inference also accepts this; Bearer is the alternative we are deferring).

**Body:** OpenAI Chat Completions shape, identical to what `openai_compat.rs` already builds. In `AzureOpenAi` mode, `body.model` is omitted (deployment in URL is authoritative); in `AiInference` mode, `body.model` is the catalog model id from `req.model`.

**Defaults via `with_defaults`-style helper:**
- `api_version` defaults: `2024-10-21` for `AzureOpenAi`, `2024-05-01-preview` for `AiInference`.
- No `base_url` fallback — `endpoint` is required from settings.

### Shared SSE plumbing

Extract from `openai_compat.rs` into a private module `provider/openai_sse.rs`:
- SSE line parsing (`data: …`)
- Delta → `AgentEvent::Delta` mapping
- `tool_calls` accumulator → `AgentEvent::ToolUse`
- `usage` → `TokenUsage` (only `input_tokens`/`output_tokens` for Azure; cache fields stay 0)
- `finish_reason` → `AgentEvent::StopReason`

Both `OpenAiCompatProvider` and `AzureFoundryProvider` call into this module. This refactor is in-scope because it directly serves the new provider; we are not touching unrelated code.

### Settings shape

`crates/app/src/settings.rs` — extend `ProviderEntry`:

```rust
pub struct ProviderEntry {
    pub kind: ProviderKind,
    pub label: String,
    #[serde(default)] pub api_key: Option<String>,
    #[serde(default)] pub base_url: Option<String>,
    // NEW — only meaningful when kind == AzureFoundry
    #[serde(default)] pub azure_mode: Option<AzureMode>,
    #[serde(default)] pub azure_api_version: Option<String>,
    #[serde(default)] pub azure_deployment: Option<String>,
}
```

All new fields are `Option`, default-skipped on serialize, ignored by Anthropic/OpenAiCompat constructors.

### Resolver

`crates/app/src/provider_resolve.rs` — add the third match arm:

```rust
ProviderKind::AzureFoundry => {
    let mode = entry.azure_mode.ok_or(/* MissingAzureMode */)?;
    let endpoint = entry.base_url.clone().ok_or(/* MissingEndpoint */)?;
    let api_key = entry.api_key.clone().ok_or(/* MissingApiKey */)?;
    let api_version = entry.azure_api_version.clone()
        .unwrap_or_else(|| default_api_version(mode));
    if mode == AzureMode::AzureOpenAi && entry.azure_deployment.is_none() {
        return Err(/* MissingDeployment */);
    }
    Arc::new(AzureFoundryProvider::new(AzureFoundryConfig {
        mode, endpoint, api_key, api_version,
        deployment: entry.azure_deployment.clone(),
    }))
}
```

`ResolveError` gains variants for each required-field failure.

## UI

### Settings → Providers tab (`ui/src/settings/providers.ts`)

**Add-provider preset list** gains `"azure_foundry"` (label: "Azure Foundry"), which seeds:

```ts
{
  kind: "azure_foundry",
  label: "Azure Foundry",
  base_url: "",
  azure_mode: "ai_inference",
  azure_api_version: "2024-05-01-preview",
}
```

**Provider card** branches on `entry.kind === "azure_foundry"`:

- Mode select: `Azure OpenAI` / `AI Inference` — on change, swap default `api_version` if the user has not edited it.
- Endpoint input (text)
- API key input (password, trimmed on input)
- API version input (text, prefilled with default per mode)
- Deployment input (text, **only rendered when mode === azure_openai**)
- "Test connection" button → calls `listModelsAzureFoundry({ endpoint, apiKey, mode, apiVersion })`, shows `OK — N models` or `Error: …`.
- Delete button (same as openai_compat).

### New Tauri command

`list_models_azure_foundry(endpoint, api_key, mode, api_version) -> Vec<String>`:
- `AzureOpenAi`: `GET {endpoint}/openai/models?api-version={v}`
- `AiInference`: `GET {endpoint}/models?api-version={v}`
- Both with `api-key` header. Parses `data[].id`.

### Model-routes tab

No structural change. The role → `{provider_id, model}` mapping already iterates configured providers. For Azure OpenAI mode the `model` field should equal the deployment name (or whatever the user wants; the resolver uses `deployment` from the entry, not `route.model`). We document this in a tooltip on the role row when the chosen provider is Azure Foundry in `AzureOpenAi` mode.

## Tests

Backend (`crates/agent/tests/provider_azure_foundry.rs`, `wiremock`-based):

- `azure_openai_mode_uses_deployment_in_url_and_api_key_header`
- `ai_inference_mode_posts_to_models_chat_completions`
- `streams_deltas_usage_and_stop_reason_via_sse`
- `tool_use_round_trip_emits_tool_use_event`
- `error_responses_surface_agent_error_with_status`

Provider config:
- `azure_foundry_default_api_version_per_mode` in `provider/azure_foundry.rs` `#[cfg(test)]`.

Resolver:
- `resolves_role_to_azure_foundry` in `provider_resolve.rs`.
- `errors_when_azure_openai_mode_missing_deployment`.

UI: lightweight unit test on the providers-tab preset seeding (Vitest already in repo if applicable; otherwise smoke-test by hand and document in PR).

## Migration / compatibility

- Existing `Settings` JSON files have no `azure_*` fields → deserialize fine due to `#[serde(default)]`.
- `ProviderKind` gains a variant; serde rename is `azure_foundry`. Older versions of Covenant reading a newer settings file would fail to parse the entry — acceptable since users opt in.

## Open questions

- Should `model` in a route override the `deployment` in Azure OpenAI mode? **Decision:** no — `deployment` is the source of truth. `model` on the route is ignored in that mode (UI hides/disables it).
- Do we need rate-limit handling specific to Azure (e.g. honoring `Retry-After`)? **Decision:** defer; the existing error path already surfaces 429s as `AgentError`.

## Out of scope (recap)

- Entra ID auth.
- MaaS per-model URLs as a distinct kind.
- Claude-on-Foundry via Messages shape.
- Prompt-caching telemetry.
