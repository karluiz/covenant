//! Tauri commands for Familiars.
//!
//! These are thin glue around `karl_familiar::FamiliarManager`. The
//! Familiar memory layer holds a rusqlite `Connection` (which is
//! `!Sync`); operations that span an `await` while holding the memory
//! lock are therefore not `Send`. Where that bites tauri's
//! Send-requiring command futures we offload to `spawn_blocking` and
//! drive a current-thread runtime inside.

use karl_familiar::agent::ChatAgent;
use karl_familiar::directive::DefaultSafety;
use karl_familiar::summarizer::AnthropicLlm;
use karl_familiar::{FamiliarConfig, FamiliarId, FamiliarManager, Style};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;

#[derive(Debug, Serialize)]
pub struct FamiliarSummary {
    pub id: String,
    pub session_id: String,
    pub name: String,
    pub style: String,
    pub daily_cap_usd: f64,
}

#[derive(Debug, Deserialize)]
pub struct ChatInput {
    pub familiar_id: String,
    pub user_text: String,
}

#[derive(Debug, Serialize)]
pub struct ChatOutput {
    pub assistant_text: String,
    pub directive_id: Option<String>,
    pub directive_kind: Option<String>,
    pub directive_payload: Option<String>,
    pub directive_rationale: Option<String>,
    pub safety_block_reason: Option<String>,
}

fn parse_id(s: &str) -> Result<FamiliarId, String> {
    let u: ulid::Ulid = s
        .parse()
        .map_err(|e: ulid::DecodeError| e.to_string())?;
    Ok(FamiliarId(u))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn parse_style(s: &str) -> Style {
    match s {
        "concise" => Style::Concise,
        "formal" => Style::Formal,
        "sarcastic" => Style::Sarcastic,
        _ => Style::Conversational,
    }
}

#[tauri::command]
pub async fn familiar_list(
    mgr: State<'_, Arc<FamiliarManager>>,
) -> Result<Vec<FamiliarSummary>, String> {
    let list = mgr.list().await;
    Ok(list
        .into_iter()
        .map(|f| FamiliarSummary {
            id: f.id.to_string(),
            session_id: f.session_id,
            name: f.config.name,
            style: format!("{:?}", f.config.style).to_lowercase(),
            daily_cap_usd: f.config.daily_cap_usd,
        })
        .collect())
}

#[tauri::command]
pub async fn familiar_spawn(
    session_id: String,
    name: String,
    style: String,
    daily_cap_usd: f64,
    mgr: State<'_, Arc<FamiliarManager>>,
) -> Result<String, String> {
    let cfg = FamiliarConfig {
        name,
        style: parse_style(&style),
        daily_cap_usd,
    };
    let id = mgr
        .spawn(session_id, cfg)
        .await
        .map_err(|e| e.to_string())?;
    Ok(id.to_string())
}

#[tauri::command]
pub async fn familiar_update_config(
    familiar_id: String,
    name: String,
    style: String,
    daily_cap_usd: f64,
    mgr: State<'_, Arc<FamiliarManager>>,
) -> Result<(), String> {
    let id = parse_id(&familiar_id)?;
    let cfg = FamiliarConfig {
        name,
        style: parse_style(&style),
        daily_cap_usd,
    };
    mgr.update_config(id, cfg)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn familiar_chat(
    input: ChatInput,
    mgr: State<'_, Arc<FamiliarManager>>,
    api_key: State<'_, crate::AnthropicKey>,
) -> Result<ChatOutput, String> {
    let id = parse_id(&input.familiar_id)?;
    let key = api_key.0.clone();
    if key.trim().is_empty() {
        return Err("ANTHROPIC_API_KEY not set".to_string());
    }
    let mgr_arc: Arc<FamiliarManager> = mgr.inner().clone();
    let user_text = input.user_text;

    // The chat turn holds a `MutexGuard<Memory>` (rusqlite Connection,
    // !Sync) across awaits, so the future is not Send. Drive it on a
    // dedicated blocking thread with its own current-thread runtime.
    let result = tokio::task::spawn_blocking(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| format!("runtime build: {e}"))?;
        rt.block_on(async move {
            let mem = mgr_arc.memory_of(id).await.map_err(|e| e.to_string())?;
            let cfg = mgr_arc.config_of(id).await.map_err(|e| e.to_string())?;
            let llm = AnthropicLlm::sonnet(key);
            let mem_guard = mem.lock().await;
            let safety = DefaultSafety;
            let agent = ChatAgent {
                memory: &mem_guard,
                llm: &llm,
                safety: &safety,
                config: &cfg,
            };
            let turn = agent
                .turn(now_ms(), &user_text)
                .await
                .map_err(|e| e.to_string())?;
            Ok::<ChatOutput, String>(ChatOutput {
                assistant_text: turn.assistant_text,
                directive_id: turn.proposed_directive.as_ref().map(|d| d.id.clone()),
                directive_kind: turn
                    .proposed_directive
                    .as_ref()
                    .map(|d| format!("{:?}", d.kind).to_lowercase()),
                directive_payload: turn
                    .proposed_directive
                    .as_ref()
                    .map(|d| d.payload.clone()),
                directive_rationale: turn
                    .proposed_directive
                    .as_ref()
                    .map(|d| d.rationale.clone()),
                safety_block_reason: turn.safety_block_reason,
            })
        })
    })
    .await
    .map_err(|e| format!("join: {e}"))?;
    result
}
