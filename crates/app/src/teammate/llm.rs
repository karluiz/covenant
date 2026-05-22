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
