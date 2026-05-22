//! Prompt construction + LLM dispatch for the teammate DM thread.
//!
//! Phase 2 keeps the dispatch simple: build a system prompt from the
//! operator's persona, build the user-side conversation from the last N
//! messages, call the provider via `collect_oneshot`, return the reply
//! text. No streaming, no rolling summary compaction yet.

use crate::operator_registry::Operator;
use crate::teammate::types::{MessageContent, Role, TaskMessage};

/// How many recent messages to include as conversation context.
/// Older messages drop off — Phase 3 may replace this with a rolling
/// summary, but for Phase 2 a flat window is fine.
pub const CONTEXT_WINDOW: usize = 20;

/// Max tokens the operator can return per reply. Conservative; the
/// AOM budget cap is the real cost guardrail.
pub const REPLY_MAX_TOKENS: u32 = 1024;

/// Build the system prompt for `operator`. The string is stable across
/// calls so Anthropic's prompt cache can hit on it.
pub fn build_system_prompt(operator: &Operator) -> String {
    let persona = operator.persona.trim();
    let voice = format!("{:?}", operator.voice).to_lowercase();
    let header = format!(
        "You are {name}, an operator inside Covenant — an AI-native terminal. \
         You are messaging the user directly in a side panel (DM). \
         Reply concisely; the panel is narrow. Plain text only, no Markdown \
         tables. Tone: {voice}.\n\
         \n\
         The user message may include a `# Terminal context` section listing \
         their open terminal tabs (sessions). One tab may be marked active \
         and includes a rolling summary, recent commands, and any in-flight \
         command. Use this when the user asks about their terminal. If a \
         tab is not in the context, do not claim to see it.\n\
         \n\
         You cannot execute commands yet — that ships in a later phase. If \
         the user asks you to run something, acknowledge and offer to walk \
         them through it instead.",
        name = operator.name,
        voice = voice,
    );
    if persona.is_empty() {
        header
    } else {
        format!("{header}\n\n# Persona\n\n{persona}")
    }
}

/// Turn the recent thread into the user-side message for the API call.
pub fn build_user_message(
    thread: &[TaskMessage],
    operator: &Operator,
    world_context: Option<&str>,
) -> String {
    let mut out = String::with_capacity(1024);
    if let Some(ctx) = world_context {
        out.push_str(ctx.trim());
        out.push_str("\n\n");
    }
    let start = thread.len().saturating_sub(CONTEXT_WINDOW);
    out.push_str("# Conversation so far\n\n");
    if start >= thread.len() {
        out.push_str("(no prior messages)\n");
    }
    for msg in &thread[start..] {
        let role_label = match msg.role {
            Role::User     => "User",
            Role::Operator => operator.name.as_str(),
            Role::System   => "System",
        };
        let text = match &msg.content {
            MessageContent::Text(t) => t.as_str(),
            _ => continue,
        };
        out.push_str(role_label);
        out.push_str(": ");
        out.push_str(text);
        out.push('\n');
    }
    out.push_str(&format!("\n# Your turn\n\nReply as {} (one message).", operator.name));
    out
}

use karl_agent::AskRequest;
use karl_agent::provider::collect_oneshot;
use thiserror::Error;

use crate::provider_resolve::{resolve_route, ResolveError};
use crate::settings::{Role as SettingsRole, Settings};

#[derive(Error, Debug)]
pub enum TeammateLlmError {
    #[error("no operator-role provider configured: {0}")]
    NoRoute(String),
    #[error("provider rejected the call: {0}")]
    Provider(String),
    #[error("provider returned an empty reply")]
    EmptyReply,
}

/// Call the LLM and return the operator's reply text.
///
/// Resolves the provider via the `Operator` settings role (so the user's
/// configured Anthropic key + base URL is honored), but overrides the
/// model with the operator's own `model` field — each persona can pick
/// its own.
pub async fn dispatch_reply(
    operator: &Operator,
    thread: &[TaskMessage],
    settings: &Settings,
    world_context: Option<&str>,
) -> Result<String, TeammateLlmError> {
    let resolved = resolve_route(settings, SettingsRole::Operator)
        .map_err(|e: ResolveError| TeammateLlmError::NoRoute(e.to_string()))?;
    let req = AskRequest {
        api_key: String::new(),
        model:   operator.model.clone(),
        system_prompt: build_system_prompt(operator),
        user_message:  build_user_message(thread, operator, world_context),
        max_tokens:    REPLY_MAX_TOKENS,
        thinking_budget: None,
        force_tool: None,
    };
    let resp = collect_oneshot(&*resolved.provider, req)
        .await
        .map_err(|e| TeammateLlmError::Provider(e.to_string()))?;
    let text = resp.text.trim().to_string();
    if text.is_empty() {
        return Err(TeammateLlmError::EmptyReply);
    }
    Ok(text)
}

// ── Phase 4a: multi-turn tool-use dispatch ──────────────────────────

use crate::teammate::anthropic_http::{
    self, AnthropicHttpError, AnthropicMessage, AnthropicResponse,
};
use crate::teammate::tools::{self, ToolEnv, ToolError};
use karl_agent::provider::ProviderKind;

const MAX_TOOL_ITERATIONS: usize = 8;

/// Progress event emitted during the tool-use loop. Callers (the
/// teammate send command) map these to Tauri events for the rail UI.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ToolProgress {
    /// A tool call is about to start (or has just produced a result).
    ToolCall { tool: String, args: serde_json::Value, ok: bool, error: Option<String> },
}

/// Like `dispatch_reply`, but supplies the operator with a `read_file`
/// tool and loops over assistant tool_use → user tool_result turns until
/// the model emits a plain-text turn. Anthropic-only; falls back to the
/// non-tool path for other providers.
pub async fn dispatch_reply_with_tools<F>(
    operator: &Operator,
    thread: &[TaskMessage],
    settings: &Settings,
    world_context: Option<&str>,
    tool_env: ToolEnv,
    mut on_progress: F,
) -> Result<String, TeammateLlmError>
where
    F: FnMut(ToolProgress) + Send,
{
    let resolved = resolve_route(settings, SettingsRole::Operator)
        .map_err(|e: ResolveError| TeammateLlmError::NoRoute(e.to_string()))?;
    if resolved.provider.kind() != ProviderKind::Anthropic {
        // Non-Anthropic providers don't yet have a tool-use path here.
        // Fall back to the text-only dispatch so Mibli still answers.
        return dispatch_reply(operator, thread, settings, world_context).await;
    }

    // Pull the api_key + base_url directly from settings — the trait
    // provider hides them. The Operator role must point at an Anthropic
    // provider (NoRoute would have errored above otherwise).
    let route = settings
        .model_routes
        .get(&SettingsRole::Operator)
        .ok_or_else(|| TeammateLlmError::NoRoute("operator route missing".into()))?;
    let provider_cfg = settings
        .providers
        .get(&route.provider_id)
        .ok_or_else(|| TeammateLlmError::NoRoute(format!("unknown provider {}", route.provider_id)))?;
    let api_key = provider_cfg
        .api_key
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_string();
    let base_url = provider_cfg
        .base_url
        .as_deref()
        .unwrap_or("https://api.anthropic.com")
        .to_string();

    let system_prompt = build_system_prompt(operator);
    let initial_user = build_user_message(thread, operator, world_context);
    let tools = vec![tools::read_file_tool_def()];

    let mut messages: Vec<AnthropicMessage> = vec![AnthropicMessage::user_text(initial_user)];

    for _ in 0..MAX_TOOL_ITERATIONS {
        let resp: AnthropicResponse = anthropic_http::post(
            &api_key,
            &base_url,
            &operator.model,
            &system_prompt,
            &messages,
            &tools,
            REPLY_MAX_TOKENS,
        )
        .await
        .map_err(|e: AnthropicHttpError| match e {
            AnthropicHttpError::MissingKey => TeammateLlmError::NoRoute("missing API key".into()),
            other => TeammateLlmError::Provider(other.to_string()),
        })?;

        let stop = resp.stop_reason.as_deref().unwrap_or("");
        if stop == "tool_use" {
            // 1) Echo the assistant turn back so the next request keeps
            //    the conversation continuous.
            let content_value = serde_json::Value::Array(resp.content.clone());
            messages.push(AnthropicMessage::assistant_blocks(content_value));

            // 2) Execute every tool call in this turn.
            let calls = anthropic_http::collect_tool_uses(&resp.content);
            let mut tool_results: Vec<serde_json::Value> = Vec::with_capacity(calls.len());
            for (id, name, input) in calls {
                let (out_text, ok, err) = match name.as_str() {
                    "read_file" => match tools::read_file(&tool_env, &input) {
                        Ok(text) => (text, true, None),
                        Err(e) => (format!("error: {}", e), false, Some(e.to_string())),
                    },
                    _ => (
                        format!("unknown tool: {}", name),
                        false,
                        Some(format!("unknown tool: {}", name)),
                    ),
                };
                on_progress(ToolProgress::ToolCall {
                    tool: name.clone(),
                    args: input,
                    ok,
                    error: err,
                });
                tool_results.push(serde_json::json!({
                    "type": "tool_result",
                    "tool_use_id": id,
                    "content": out_text,
                    "is_error": !ok,
                }));
            }
            messages.push(AnthropicMessage::user_tool_results(
                serde_json::Value::Array(tool_results),
            ));
            continue;
        }

        // Any other stop_reason ("end_turn", "stop_sequence", etc.):
        // the assistant emitted final text. Return it.
        let text = anthropic_http::extract_text(&resp.content).trim().to_string();
        if text.is_empty() {
            return Err(TeammateLlmError::EmptyReply);
        }
        return Ok(text);
    }

    Err(TeammateLlmError::Provider(
        "tool-use loop hit max iterations (8)".into(),
    ))
}

#[cfg(test)]
mod tool_progress_tests {
    use super::*;

    #[test]
    fn tool_progress_serializes_with_kind_tag() {
        let p = ToolProgress::ToolCall {
            tool: "read_file".into(),
            args: serde_json::json!({"path": "a.rs"}),
            ok: true,
            error: None,
        };
        let s = serde_json::to_value(&p).unwrap();
        assert_eq!(s["kind"], "tool_call");
        assert_eq!(s["tool"], "read_file");
        assert_eq!(s["args"]["path"], "a.rs");
        assert_eq!(s["ok"], true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::operator_registry::{OperatorId, VoiceTone};
    use crate::teammate::types::MessageId;
    use ulid::Ulid;

    fn sample_op(name: &str, persona: &str) -> Operator {
        Operator {
            id: OperatorId(Ulid::new()),
            name: name.into(),
            emoji: "🤖".into(),
            color: "#000".into(),
            tags: vec![],
            persona: persona.into(),
            escalate_threshold: 0.6,
            model: "claude-sonnet-4-6".into(),
            hard_constraints: String::new(),
            voice: VoiceTone::Terse,
            is_default: false,
            created_at_unix_ms: 0,
            updated_at_unix_ms: 0,
            xp: 0,
        }
    }

    fn text_msg(role: Role, text: &str) -> TaskMessage {
        TaskMessage {
            id: MessageId::new(),
            operator_id: OperatorId(Ulid::new()),
            task_id: None,
            role,
            content: MessageContent::Text(text.into()),
            created_at_unix_ms: 0,
        }
    }

    #[test]
    fn system_prompt_includes_name_and_persona() {
        let op = sample_op("Mibli", "Always answer in Spanish.");
        let p = build_system_prompt(&op);
        assert!(p.contains("Mibli"));
        assert!(p.contains("Always answer in Spanish."));
        assert!(p.contains("terse"));
    }

    #[test]
    fn system_prompt_omits_persona_section_when_empty() {
        let op = sample_op("Mibli", "");
        let p = build_system_prompt(&op);
        assert!(p.contains("Mibli"));
        assert!(!p.contains("# Persona"));
    }

    #[test]
    fn user_message_handles_empty_thread() {
        let op = sample_op("Mibli", "");
        let m = build_user_message(&[], &op, None);
        assert!(m.contains("no prior messages"));
        assert!(m.ends_with("Reply as Mibli (one message)."));
    }

    #[test]
    fn user_message_includes_recent_turns_with_role_labels() {
        let op = sample_op("Mibli", "");
        let thread = vec![
            text_msg(Role::User, "hola"),
            text_msg(Role::Operator, "hola, ¿en qué te ayudo?"),
            text_msg(Role::User, "¿qué hora es?"),
        ];
        let m = build_user_message(&thread, &op, None);
        assert!(m.contains("User: hola"));
        assert!(m.contains("Mibli: hola, ¿en qué te ayudo?"));
        assert!(m.contains("User: ¿qué hora es?"));
    }

    #[test]
    fn user_message_clamps_to_window() {
        let op = sample_op("Mibli", "");
        let mut thread = Vec::new();
        for i in 0..30 {
            thread.push(text_msg(Role::User, &format!("msg {i}")));
        }
        let m = build_user_message(&thread, &op, None);
        assert!(!m.contains("msg 0"));
        assert!(!m.contains("msg 9"));
        assert!(m.contains("msg 10"));
        assert!(m.contains("msg 29"));
    }

    #[test]
    fn user_message_includes_world_context_when_provided() {
        let op = sample_op("Mibli", "");
        let ctx = "# Terminal context\n\n## Active session\n- cwd: `/tmp/x`\n";
        let m = build_user_message(&[], &op, Some(ctx));
        assert!(m.starts_with("# Terminal context"));
        assert!(m.contains("/tmp/x"));
        assert!(m.contains("# Conversation so far"));
        assert!(m.contains("# Your turn"));
    }

    #[test]
    fn user_message_omits_world_context_when_none() {
        let op = sample_op("Mibli", "");
        let m = build_user_message(&[], &op, None);
        assert!(!m.contains("Terminal context"));
    }

    #[test]
    fn system_prompt_describes_terminal_context() {
        let op = sample_op("Mibli", "");
        let p = build_system_prompt(&op);
        assert!(p.contains("Terminal context"));
        assert!(p.contains("open terminal tabs"));
    }
}
