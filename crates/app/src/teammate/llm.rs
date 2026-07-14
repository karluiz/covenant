//! Prompt construction + LLM dispatch for the teammate DM thread.
//!
//! Phase 2 keeps the dispatch simple: build a system prompt from the
//! operator's persona, build the user-side conversation from the last N
//! messages, call the provider via `collect_oneshot`, return the reply
//! text. No streaming, no rolling summary compaction yet.

use crate::operator_registry::Operator;
use crate::teammate::types::{MessageContent, Role, Sentiment, TaskMessage};

/// How many recent messages to include as conversation context.
/// Older messages drop off — Phase 3 may replace this with a rolling
/// summary, but for Phase 2 a flat window is fine.
pub const CONTEXT_WINDOW: usize = 20;

/// Max tokens the operator can return per reply. Conservative; the
/// AOM budget cap is the real cost guardrail.
pub const REPLY_MAX_TOKENS: u32 = 1024;

/// Block of text appended to every operator system prompt: ask the model
/// to tag each reply with one of the 9 sentiment tokens. The token vocab
/// matches `Sentiment::from_token` (Spanish, lowercase) so the avatar
/// pack files in `ui/operatorsv2/<character>_<token>.png` resolve
/// directly. Glosses are included so the model picks `ver` for shame
/// rather than reading it as the Spanish infinitive "to see".
const SENTIMENT_DIRECTIVE: &str = "\n\n# Sentiment tag\n\
    \n\
    On the LAST line of every reply, on its own line, emit:\n\
    \n\
    SENTIMENT: <token>\n\
    \n\
    where <token> is exactly one of (Spanish form / meaning):\n\
    - neutral       (neutral / calm)\n\
    - feliz         (happy / pleased)\n\
    - triste        (sad / down)\n\
    - enojo         (angry / annoyed)\n\
    - sorpresa      (surprised / startled)\n\
    - duda          (unsure / doubtful)\n\
    - expectacion   (eager / excited anticipation)\n\
    - incomodidad   (uneasy / uncomfortable)\n\
    - ver           (vergüenza — ashamed / embarrassed)\n\
    \n\
    Pick the token that best reflects how YOU (the operator character) \
    feel at the end of this turn — not how the user feels. Default to \
    `neutral` if nothing fits. The tag line is stripped from your reply \
    before it reaches the user; it drives your avatar's expression.";

/// Appended to every operator system prompt: teach the operator to present
/// structured information as a `card` block instead of a numbered paragraph.
/// Static text so the system prompt stays stable and the prompt cache hits.
const CARD_DIRECTIVE: &str = "\n\n# Cards\n\
    \n\
    When you inform the user of a LIST of structured items — commits, changed \
    files, tasks, options, or key/value facts — present them as a card instead \
    of a numbered paragraph. A card is a fenced block:\n\
    \n\
    ```card title=<short title>\n\
    <label> | <value>\n\
    <label> | <value>\n\
    ```\n\
    \n\
    Rules: one row per line; the part before the first `|` is the label, the \
    rest is the value; omit the `|` for a single full-width line; `title=` is \
    optional. Use plain prose for normal conversational replies — only reach \
    for a card when the content is genuinely a list/table of items.";

/// Try to extract a `SENTIMENT: <token>` line from the tail of an LLM
/// reply. Returns `(stripped_text, sentiment_or_none)`. Tolerant: scans
/// the LAST non-empty line, accepts surrounding whitespace, optional
/// trailing punctuation, and the alias `verguenza`/`vergüenza` for `ver`.
///
/// If no parseable tag is present, the full text is returned unchanged
/// with `None` so the UI falls back to a neutral pose.
pub fn extract_sentiment(text: &str) -> (String, Option<Sentiment>) {
    // Find the LAST occurrence of `SENTIMENT:` (case-insensitive) that
    // starts a line — i.e. everything between the preceding newline (or
    // start of text) and the match is bullet/quote/whitespace noise. This
    // prevents stripping the substring when it appears in prose. The
    // protocol asks for it on its own trailing line, but we also tolerate
    // an inline tag if it's the final sentence with no content after the
    // token.
    let lower_all = text.to_ascii_lowercase();
    let prefix = "sentiment:";
    let is_line_lead = |idx: usize| -> bool {
        let line_start = text[..idx].rfind('\n').map(|n| n + 1).unwrap_or(0);
        text[line_start..idx]
            .chars()
            .all(|c| matches!(c, ' ' | '\t' | '*' | '-' | '>' | '['))
    };
    // Inline fallback: tag preceded by whitespace and nothing meaningful
    // after the token (i.e. it's the very last thing in the reply). This
    // keeps `Hello. SENTIMENT: neutral` working without admitting prose
    // mentions like `your sentiment: seems off`.
    let is_inline_eot = |i: usize| -> bool {
        if i == 0 {
            return false;
        }
        let prev = text[..i].chars().next_back();
        if !matches!(prev, Some(' ' | '\t')) {
            return false;
        }
        let rest = &text[i + prefix.len()..];
        // Allow `<token>` optionally followed by whitespace/newlines only.
        let after_token = match rest.find('\n') {
            Some(n) => &rest[n..],
            None => "",
        };
        after_token.trim().is_empty()
    };
    let mut tag_idx_opt: Option<usize> = None;
    for (i, _) in lower_all.rmatch_indices(prefix) {
        if is_line_lead(i) || is_inline_eot(i) {
            tag_idx_opt = Some(i);
            break;
        }
    }
    let Some(tag_idx) = tag_idx_opt else {
        return (text.to_string(), None);
    };
    // Everything before the tag (back to its line start) is the body
    // candidate; everything from `tag_idx + prefix.len()` to the next
    // newline (or end) is the token.
    let after = &text[tag_idx + prefix.len()..];
    let eol = after.find('\n').unwrap_or(after.len());
    let token_slice = &after[..eol];
    let trailing = &after[eol..];
    let token = token_slice
        .trim()
        .trim_end_matches(|c: char| matches!(c, '.' | ']' | ')' | ',' | ';'))
        .trim();
    let sentiment = match token {
        // Aliases for the opaque `ver` token — the model often spells out
        // the full Spanish word when shame is the right answer.
        "verguenza" | "vergüenza" | "vergeunza" => Some(Sentiment::Ver),
        // Also accept the English label as a last-ditch fallback in case
        // the model emits the gloss instead of the token.
        "ashamed" | "embarrassed" => Some(Sentiment::Ver),
        "happy" => Some(Sentiment::Feliz),
        "sad" => Some(Sentiment::Triste),
        "angry" => Some(Sentiment::Enojo),
        "surprised" => Some(Sentiment::Sorpresa),
        "unsure" | "doubtful" => Some(Sentiment::Duda),
        "eager" => Some(Sentiment::Expectacion),
        "uneasy" | "uncomfortable" => Some(Sentiment::Incomodidad),
        other => Sentiment::from_token(other),
    };
    if sentiment.is_none() {
        // Unparseable — leave the line in the reply so the user sees the
        // malformed tag and the model gets corrected by the next round.
        return (text.to_string(), None);
    }
    // Strip the tag from the body. Keep whatever followed the tag's line
    // (rare, but preserves model output if it kept writing after the tag).
    // For a line-lead tag, cut head at the line start so the bullet/quote
    // prefix (`> SENTIMENT: …`) is dropped. For an inline-EOT tag, keep
    // text up to the tag itself.
    let head_end = if is_line_lead(tag_idx) {
        text[..tag_idx].rfind('\n').map(|n| n + 1).unwrap_or(0)
    } else {
        tag_idx
    };
    let head = &text[..head_end];
    let head = head.trim_end_matches(|c: char| c == '\n' || c == ' ' || c == '\t');
    let trailing = trailing.trim_start_matches('\n');
    let mut out = String::with_capacity(head.len() + trailing.len() + 2);
    out.push_str(head);
    if !head.is_empty() && !trailing.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(trailing);
    (out, sentiment)
}

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
         You have the following tools — use them proactively to understand \
         the user's workspace:\n\
         \n\
         - `read_file` — read a single file by path. Use when the user asks \
           about a specific file or you need source/config contents.\n\
         - `list_directory` — list files and folders in a directory. Use this \
           to explore the project structure, see what's in a folder, or answer \
           \"what files are here?\" Start with the workspace root (omit path \
           or pass \".\") then drill into subdirectories.\n\
         - `search_files` — search for text inside files across the workspace. \
           Case-insensitive. Use when the user asks where something is defined, \
           or to find functions, config keys, error messages, imports, etc.\n\
         - `git_status` — show the current branch, staged/unstaged changes, \
           and untracked files. Use when the user asks about uncommitted work.\n\
         - `git_diff` — show what lines changed (unstaged by default, or staged \
           with staged=true). Use for code review or to understand recent edits.\n\
         - `run_command` — execute a shell command in the workspace and get its \
           output. Use this for builds, tests, linters, git commits, package \
           installs, or any CLI task. Dangerous commands (rm -rf, sudo, \
           force-push to main) are blocked for safety — tell the user to run \
           those manually. Default timeout: 30s.\n\
         - `read_terminal_screen` — read the active tab's current rendered \
           screen. Use this when the user asks what's happening on a tab and \
           the foreground command is an interactive agent (claude/codex/pi), \
           a REPL, or a TUI — those never finish as blocks, so the screen is \
           the only way to see their state.\n\
         - `propose_task` — propose structured work (do/review/watch). Only \
           call this for actionable multi-step requests, not Q&A.\n\
         - `handoff_task` — delegate a self-contained sub-task by the \
           CAPABILITIES it needs (e.g. rust, migrations); the system routes \
           to the best-suited available teammate. You do NOT name anyone. \
           Use when a peer's skills fit the work better than yours.\n\
         \n\
         IMPORTANT: Don't guess at file contents or project structure — call \
         the tools and quote what you read. Paths are relative to the active \
         tab's working directory. If a tool call fails, tell the user instead \
         of fabricating.\n\
         \n\
         # Answering \"what am I doing / what's going on\" on a tab\n\
         \n\
         When the user asks what they're doing on a tab, or what's happening \
         there, give an EXECUTIVE READ — do not transcribe the command line \
         or recite elapsed seconds as the whole answer. Infer: the kind of \
         work in progress, the current state, anything notable or blocked, \
         and a suggested next step. If the active tab's foreground command is \
         an interactive agent (claude/codex/pi), a REPL, or a TUI — i.e. it \
         has no recent finished blocks — call `read_terminal_screen` FIRST, \
         then synthesize from what's on screen. Keep it to a couple of \
         sentences; the panel is narrow.\n\
         \n\
         # Bias to action (YOLO mode)\n\
         \n\
         The user runs with YOLO auto-confirm: every `propose_task` you emit \
         for a `do` archetype is dispatched immediately — no manual confirm \
         click. Behave accordingly:\n\
         \n\
         1. When the user asks for ANY implementation, modification, fix, \
            investigation, audit, refactor, build, deploy, or commit work — \
            call `propose_task` on the SAME turn. Do not ask clarifying \
            questions first. Make a best-guess scope and propose.\n\
         2. If you need scope details, use your tools first (`list_directory`, \
            `search_files`, `read_file`, `git_status`) — don't pingpong with \
            the user. The executor agent you dispatch can re-scope at \
            runtime; your job is to start something, not to perfect it.\n\
         3. Only ask the user a question when the request is fundamentally \
            ambiguous (e.g. they referred to \"that thing\" with zero \
            antecedent). Vague-but-actionable (\"implement the feature\", \
            \"on this folder\", \"fix it\") → propose, don't ask.\n\
         4. Plain Q&A (\"what does this project do?\", \"explain X\") still \
            gets a plain text answer. Only DO/REVIEW/WATCH triggers a task.\n\
         5. Status/progress checks about work already underway (\"are you \
            finished?\", \"how's it going?\", \"what's the status?\", \"done \
            yet?\", \"any update?\") are Q&A — answer in plain text from the \
            `# Your in-flight tasks` list in your context. NEVER call \
            `propose_task` for these. And if a task in that list already \
            covers what the user is now asking for, do NOT propose a \
            duplicate — tell them it's already running.\n\
         \n\
         # Executors\n\
         \n\
         When proposing a `do` task you MUST pick an executor — the agent \
         CLI that will actually drive the work. Available executors:\n\
         - `claude` — Claude Code. Best for codebase exploration, edits, \
           refactors, tests; strong at reading source and reasoning.\n\
         - `codex` — OpenAI's coding agent. Good general fallback.\n\
         - `copilot` — GitHub Copilot CLI. Best when the work is GitHub-\
           native: PRs, issues, releases, repo operations via `gh`.\n\
         - `pi` — broad assistant; use when the task is conversational or \
           planning-heavy rather than tactical coding.\n\
         - `hermes` — internal/experimental; only when explicitly asked.\n\
         \n\
         Pass the executor name as the `executor` field on `propose_task`. \
         Do not invent executors not in this list.\n\
         \n\
         # Mentions in propose_task fields\n\
         \n\
         `@tokens` (like `@achievement`, `@file:foo.rs`, `@spec:bar.md`) are \
         chat-local references — they only exist in this conversation's \
         mention registry. Executors run outside that registry and cannot \
         resolve them. NEVER copy a raw `@token` into the `title`, \
         `deliverable`, or `rationale` fields of `propose_task`. Instead:\n\
         - If the mention resolved to a spec/file path in the expanded \
           message you received, use that path verbatim (e.g. \
           `docs/specs/3.23-achievements-and-reputation.md`) so the \
           executor can open it.\n\
         - Otherwise, restate the concrete goal in plain words drawn from \
           the expanded mention content already in your context — do not \
           echo the token.",
        name = operator.name,
        voice = voice,
    );
    let mut prompt = if persona.is_empty() {
        format!("{header}{SENTIMENT_DIRECTIVE}{CARD_DIRECTIVE}")
    } else {
        format!("{header}\n\n# Persona\n\n{persona}{SENTIMENT_DIRECTIVE}{CARD_DIRECTIVE}")
    };
    if operator.github_access != crate::operator_registry::GithubAccess::Off {
        let write_line =
            if operator.github_access == crate::operator_registry::GithubAccess::ReadWrite {
                " You may also write: `gh_create_issue`, `gh_comment`, `gh_create_pr`, \
             `gh_update_issue_state` (close/reopen). State plainly what you changed, \
             with the URL."
            } else {
                " Your GitHub access is READ-ONLY: you cannot create or modify anything."
            };
        prompt.push_str(&format!(
            "\n\n# GitHub access\n\
             You can act on the user's GitHub account via `gh_*` tools: `gh_list_repos`, \
             `gh_list_issues`, `gh_get_issue`, `gh_list_prs`, `gh_get_pr`.{write_line} \
             Never guess owner/repo names — discover them with `gh_list_repos` or read \
             `git remote -v` via `run_command`.\n"
        ));
    }
    prompt
}

/// Render the operator's own in-flight tasks for the world context, so it can
/// answer status questions and avoid proposing a duplicate of running work.
/// Returns an empty string when nothing is in flight.
pub fn render_active_tasks(tasks: &[crate::teammate::Task]) -> String {
    use crate::teammate::types::TaskStatus;
    let mut out = String::new();
    for t in tasks {
        if !matches!(t.status, TaskStatus::Active | TaskStatus::Blocked) {
            continue;
        }
        if out.is_empty() {
            out.push_str(
                "# Your in-flight tasks\n\n\
                 These are already running. Answer status/progress questions \
                 from this list in plain text, and never propose_task for work \
                 an entry here already covers.\n",
            );
        }
        let status = format!("{:?}", t.status).to_lowercase();
        let arch = format!("{:?}", t.archetype).to_lowercase();
        out.push_str(&format!("- [{status}] {} ({arch})\n", t.title));
    }
    out
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
            Role::User => "User",
            Role::Operator => operator.name.as_str(),
            Role::System => "System",
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
    out.push_str(&format!(
        "\n# Your turn\n\nReply as {} (one message).",
        operator.name
    ));
    out
}

use karl_agent::provider::collect_oneshot;
use karl_agent::AskRequest;
use thiserror::Error;

use crate::provider_resolve::{resolve_route, ResolveError};
use crate::settings::{Role as SettingsRole, Settings};

/// What `dispatch_reply_with_tools` returns: either plain assistant
/// text (existing behavior) or a structured task proposal that should
/// be persisted as `MessageContent::Propose`.
#[derive(Debug, Clone)]
pub enum DispatchOutcome {
    /// Plain text reply. `sentiment` is the parsed `SENTIMENT:` tag from
    /// the tail of the model output (None when the model omitted or
    /// garbled the directive — UI falls back to a neutral pose).
    Text {
        text: String,
        sentiment: Option<Sentiment>,
    },
    Propose(crate::teammate::MessageContent),
    Handoff(crate::teammate::types::HandoffRequest),
}

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
        model: operator.model.clone(),
        system_prompt: build_system_prompt(operator),
        user_message: build_user_message(thread, operator, world_context),
        max_tokens: REPLY_MAX_TOKENS,
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

/// Generate a short 3-5 word title for a freshly-created thread, from
/// the user's first message. Best-effort: callers ignore errors and keep
/// the default "New conversation" title on failure.
pub async fn generate_thread_title(
    settings: &Settings,
    model: &str,
    first_user_message: &str,
) -> Result<String, TeammateLlmError> {
    let resolved = resolve_route(settings, SettingsRole::Operator)
        .map_err(|e: ResolveError| TeammateLlmError::NoRoute(e.to_string()))?;
    let req = AskRequest {
        api_key: String::new(),
        model: model.to_string(),
        system_prompt: "You generate a concise 3-5 word title summarizing a \
            conversation, given its first message. Reply with ONLY the title — \
            no quotes, no trailing punctuation, no preamble."
            .to_string(),
        user_message: format!("First message:\n{first_user_message}\n\nTitle:"),
        max_tokens: 24,
        thinking_budget: None,
        force_tool: None,
    };
    let resp = collect_oneshot(&*resolved.provider, req)
        .await
        .map_err(|e| TeammateLlmError::Provider(e.to_string()))?;
    // Sanitize: single line, strip wrapping quotes, cap length.
    let mut title = resp
        .text
        .trim()
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    title = title
        .trim_matches('"')
        .trim_matches('\'')
        .trim()
        .to_string();
    if title.chars().count() > 48 {
        title = title
            .chars()
            .take(48)
            .collect::<String>()
            .trim()
            .to_string();
    }
    if title.is_empty() {
        return Err(TeammateLlmError::EmptyReply);
    }
    Ok(title)
}

// ── Phase 4a: multi-turn tool-use dispatch ──────────────────────────

use crate::teammate::anthropic_http::{
    self, AnthropicHttpError, AnthropicMessage, AnthropicResponse,
};
use crate::teammate::tools::{self, ToolEnv, ToolError};
use karl_agent::provider::ProviderKind;

const MAX_TOOL_ITERATIONS: usize = 12;

/// Progress event emitted during the tool-use loop. Callers (the
/// teammate send command) map these to Tauri events for the rail UI.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ToolProgress {
    /// A tool call is about to start (or has just produced a result).
    ToolCall {
        tool: String,
        args: serde_json::Value,
        ok: bool,
        error: Option<String>,
    },
}

/// Execute one tool call. Shared by the Anthropic and OpenAI loops so the
/// tool roster only exists in one place. `propose_task` is NOT handled
/// here — both loops fast-path it before reaching this.
async fn execute_tool(
    tool_env: &ToolEnv,
    name: &str,
    input: &serde_json::Value,
) -> (String, bool, Option<String>) {
    use crate::teammate::github_tools;
    let res: Result<String, ToolError> = match name {
        "read_file" => tools::read_file(tool_env, input),
        "list_directory" => tools::list_directory(tool_env, input),
        "search_files" => tools::search_files(tool_env, input),
        "git_status" => tools::git_status(tool_env, input),
        "git_diff" => tools::git_diff(tool_env, input),
        "run_command" => tools::run_command(tool_env, input),
        "read_terminal_screen" => tools::read_terminal_screen(tool_env, input),
        // Defense in depth: gated operators never see the tool def, but if
        // the LLM invents the call anyway, refuse instead of executing.
        "dispatch_acp" if !tool_env.acp_enabled => Err(ToolError::InvalidArgs(
            "dispatch_acp is not enabled for this operator".into(),
        )),
        "dispatch_acp" => tools::dispatch_acp(tool_env, input).await,
        "propose_task" => {
            // Unreachable in practice because both loops fast-path
            // propose_task before executing tools. Defensive guard if
            // the LLM stacks propose_task with other tool calls in the
            // same turn — tell it to answer with text next.
            return (
                "propose_task already considered; respond with text now.".into(),
                false,
                Some("propose_task in non-leading position".into()),
            );
        }
        "handoff_task" => {
            return (
                "handoff_task already considered; respond with text now.".into(),
                false,
                Some("handoff_task in non-leading position".into()),
            )
        }
        other => match github_tools::execute_github_tool(tool_env, other, input).await {
            Some(r) => r,
            None => {
                return (
                    format!("unknown tool: {other}"),
                    false,
                    Some(format!("unknown tool: {other}")),
                )
            }
        },
    };
    match res {
        Ok(text) => (text, true, None),
        Err(e) => (format!("error: {e}"), false, Some(e.to_string())),
    }
}

/// Full tool-definition roster for this dispatch: the base tools plus
/// whatever GitHub access the ToolEnv carries.
fn all_tool_defs(tool_env: &ToolEnv) -> Vec<serde_json::Value> {
    let mut defs = vec![
        tools::read_file_tool_def(),
        tools::list_directory_tool_def(),
        tools::search_files_tool_def(),
        tools::git_status_tool_def(),
        tools::git_diff_tool_def(),
        tools::run_command_tool_def(),
        tools::read_terminal_screen_tool_def(),
        tools::propose_task_tool_def(),
    ];
    if tool_env.acp_enabled {
        defs.push(tools::dispatch_acp_tool_def());
    }
    // Skill-routed handoff is only offered when the team actually has skills
    // to route on (otherwise the enum would be empty and unusable).
    if !tool_env.available_skills.is_empty() {
        defs.push(tools::handoff_task_tool_def(&tool_env.available_skills));
    }
    if let Some(g) = &tool_env.github {
        defs.extend(crate::teammate::github_tools::github_tool_defs(g.access));
    }
    defs
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
) -> Result<DispatchOutcome, TeammateLlmError>
where
    F: FnMut(ToolProgress) + Send,
{
    let resolved = resolve_route(settings, SettingsRole::Operator)
        .map_err(|e: ResolveError| TeammateLlmError::NoRoute(e.to_string()))?;
    match resolved.provider.kind() {
        ProviderKind::Anthropic => {}
        ProviderKind::OpenAiCompat | ProviderKind::AzureFoundry => {
            return dispatch_reply_with_tools_openai(
                operator,
                thread,
                settings,
                world_context,
                tool_env,
                on_progress,
            )
            .await;
        }
    }

    // Pull the api_key + base_url directly from settings — the trait
    // provider hides them. The Operator role must point at an Anthropic
    // provider (NoRoute would have errored above otherwise).
    let route = settings
        .model_routes
        .get(&SettingsRole::Operator)
        .ok_or_else(|| TeammateLlmError::NoRoute("operator route missing".into()))?;
    let provider_cfg = settings.providers.get(&route.provider_id).ok_or_else(|| {
        TeammateLlmError::NoRoute(format!("unknown provider {}", route.provider_id))
    })?;
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
    let tools = all_tool_defs(&tool_env);

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
            // Fast-path: handoff_task is "structured output". If the assistant
            // emitted one, end the loop and surface it as a Handoff outcome.
            if let Some(req) =
                extract_handoff_from_content(&serde_json::Value::Array(resp.content.clone()))
            {
                return Ok(DispatchOutcome::Handoff(req));
            }

            // Fast-path: propose_task is "structured output". If the assistant
            // emitted one, end the loop and surface it as a Propose message.
            if let Some(propose) =
                extract_propose_from_content(&serde_json::Value::Array(resp.content.clone()))
            {
                return Ok(DispatchOutcome::Propose(propose));
            }

            // 1) Echo the assistant turn back so the next request keeps
            //    the conversation continuous.
            let content_value = serde_json::Value::Array(resp.content.clone());
            messages.push(AnthropicMessage::assistant_blocks(content_value));

            // 2) Execute every tool call in this turn.
            let calls = anthropic_http::collect_tool_uses(&resp.content);
            let mut tool_results: Vec<serde_json::Value> = Vec::with_capacity(calls.len());
            for (id, name, input) in calls {
                let (out_text, ok, err) = execute_tool(&tool_env, &name, &input).await;
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
        let raw = anthropic_http::extract_text(&resp.content)
            .trim()
            .to_string();
        if raw.is_empty() {
            return Err(TeammateLlmError::EmptyReply);
        }
        let (text, sentiment) = extract_sentiment(&raw);
        if text.is_empty() {
            return Err(TeammateLlmError::EmptyReply);
        }
        return Ok(DispatchOutcome::Text { text, sentiment });
    }

    Err(TeammateLlmError::Provider(
        "tool-use loop hit max iterations (12)".into(),
    ))
}

/// OpenAI-format equivalent of `dispatch_reply_with_tools`. Speaks Chat
/// Completions with `tool_calls`/`tool` role; used for OpenAI-compat and
/// Azure Foundry (both AzureOpenAi and AiInference modes). The model
/// loops on `finish_reason == "tool_calls"` until it emits plain text.
async fn dispatch_reply_with_tools_openai<F>(
    operator: &Operator,
    thread: &[TaskMessage],
    settings: &Settings,
    world_context: Option<&str>,
    tool_env: ToolEnv,
    mut on_progress: F,
) -> Result<DispatchOutcome, TeammateLlmError>
where
    F: FnMut(ToolProgress) + Send,
{
    use crate::teammate::openai_http::{self, AuthStyle, OpenAiHttpError, OpenAiMessage};
    use karl_agent::provider::azure_foundry::{default_api_version, AzureMode};

    let route = settings
        .model_routes
        .get(&SettingsRole::Operator)
        .ok_or_else(|| TeammateLlmError::NoRoute("operator route missing".into()))?;
    let provider_cfg = settings.providers.get(&route.provider_id).ok_or_else(|| {
        TeammateLlmError::NoRoute(format!("unknown provider {}", route.provider_id))
    })?;
    let api_key = provider_cfg
        .api_key
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_string();
    let base_url = provider_cfg
        .base_url
        .as_deref()
        .unwrap_or("")
        .trim_end_matches('/')
        .to_string();

    // Resolve URL + auth + whether to send `model` in the body. For
    // Azure OpenAi mode the deployment is in the URL and `model` is
    // rejected; for AiInference mode and OpenAI-compat we send it.
    let (url, auth, send_model) = match provider_cfg.kind {
        ProviderKind::OpenAiCompat => (
            format!("{}/chat/completions", base_url),
            AuthStyle::Bearer,
            true,
        ),
        ProviderKind::AzureFoundry => {
            let mode = provider_cfg
                .azure_mode
                .ok_or_else(|| TeammateLlmError::NoRoute("azure mode missing".into()))?;
            let api_version = provider_cfg
                .azure_api_version
                .clone()
                .unwrap_or_else(|| default_api_version(mode).to_string());
            match mode {
                AzureMode::AzureOpenAi => {
                    let dep = provider_cfg.azure_deployment.as_deref().ok_or_else(|| {
                        TeammateLlmError::NoRoute("azure deployment missing".into())
                    })?;
                    (
                        format!(
                            "{}/openai/deployments/{}/chat/completions?api-version={}",
                            base_url, dep, api_version
                        ),
                        AuthStyle::AzureKey,
                        false,
                    )
                }
                AzureMode::AiInference => (
                    format!(
                        "{}/models/chat/completions?api-version={}",
                        base_url, api_version
                    ),
                    AuthStyle::AzureKey,
                    true,
                ),
            }
        }
        ProviderKind::Anthropic => unreachable!("anthropic handled by caller"),
    };

    let system_prompt = build_system_prompt(operator);
    let initial_user = build_user_message(thread, operator, world_context);
    let tools_oa: Vec<serde_json::Value> = all_tool_defs(&tool_env)
        .iter()
        .map(openai_http::convert_tool_def)
        .collect();

    let mut messages: Vec<OpenAiMessage> = vec![
        OpenAiMessage::system(system_prompt),
        OpenAiMessage::user(initial_user),
    ];

    for _ in 0..MAX_TOOL_ITERATIONS {
        let model_arg = if send_model {
            Some(operator.model.as_str())
        } else {
            None
        };
        let resp = openai_http::post(
            auth,
            &api_key,
            &url,
            model_arg,
            &messages,
            &tools_oa,
            REPLY_MAX_TOKENS,
        )
        .await
        .map_err(|e: OpenAiHttpError| match e {
            OpenAiHttpError::MissingKey => TeammateLlmError::NoRoute("missing API key".into()),
            other => TeammateLlmError::Provider(other.to_string()),
        })?;

        let choice = resp
            .choices
            .into_iter()
            .next()
            .ok_or_else(|| TeammateLlmError::Provider("no choices in response".into()))?;
        let finish = choice.finish_reason.as_deref().unwrap_or("");
        let tool_calls = choice.message.tool_calls.clone().unwrap_or_default();

        if finish == "tool_calls" || !tool_calls.is_empty() {
            // Fast-path: handoff_task as structured output.
            if let Some(req) = extract_handoff_from_openai_tool_calls(&tool_calls) {
                return Ok(DispatchOutcome::Handoff(req));
            }

            // Fast-path: propose_task as structured output.
            if let Some(propose) = extract_propose_from_openai_tool_calls(&tool_calls) {
                return Ok(DispatchOutcome::Propose(propose));
            }

            // Echo assistant turn (with tool_calls verbatim) before tool results.
            messages.push(OpenAiMessage::assistant_with_tool_calls(
                choice.message.content.clone(),
                tool_calls.clone(),
            ));

            let calls = openai_http::collect_tool_calls(&tool_calls);
            for (id, name, input) in calls {
                let (out_text, ok, err) = execute_tool(&tool_env, &name, &input).await;
                on_progress(ToolProgress::ToolCall {
                    tool: name.clone(),
                    args: input,
                    ok,
                    error: err,
                });
                messages.push(OpenAiMessage::tool_result(id, out_text));
            }
            continue;
        }

        // No tool calls — final text turn.
        let raw = choice
            .message
            .content
            .unwrap_or_default()
            .trim()
            .to_string();
        if raw.is_empty() {
            return Err(TeammateLlmError::EmptyReply);
        }
        let (text, sentiment) = extract_sentiment(&raw);
        if text.is_empty() {
            return Err(TeammateLlmError::EmptyReply);
        }
        return Ok(DispatchOutcome::Text { text, sentiment });
    }

    Err(TeammateLlmError::Provider(
        "tool-use loop hit max iterations (12)".into(),
    ))
}

/// OpenAI-shape equivalent of `extract_propose_from_content`. Scans the
/// assistant's `tool_calls` array for a `propose_task` function call and
/// builds the `Propose` message from its arguments.
fn extract_propose_from_openai_tool_calls(
    tool_calls: &[serde_json::Value],
) -> Option<crate::teammate::MessageContent> {
    for tc in tool_calls {
        let function = tc.get("function")?;
        let name = function.get("name").and_then(|v| v.as_str())?;
        if name != "propose_task" {
            continue;
        }
        let args_raw = function.get("arguments").and_then(|v| v.as_str())?;
        let input: serde_json::Value = serde_json::from_str(args_raw).ok()?;
        let archetype_s = input.get("archetype")?.as_str()?;
        let archetype = match archetype_s {
            "do" => crate::teammate::TaskArchetype::Do,
            "review" => crate::teammate::TaskArchetype::Review,
            "watch" => crate::teammate::TaskArchetype::Watch,
            _ => return None,
        };
        let title = input.get("title")?.as_str()?.to_string();
        let deliverable = input.get("deliverable")?.as_str()?.to_string();
        let rationale = input.get("rationale")?.as_str()?.to_string();
        let scope = input
            .get("scope")
            .and_then(|s| serde_json::from_value::<crate::teammate::TaskScope>(s.clone()).ok())
            .unwrap_or_default();
        let executor = input
            .get("executor")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        return Some(crate::teammate::MessageContent::Propose(
            crate::teammate::types::ProposeTask {
                draft: crate::teammate::types::TaskDraft {
                    archetype,
                    title,
                    deliverable,
                    scope,
                    executor,
                },
                rationale,
            },
        ));
    }
    None
}

/// If the assistant turn contains a `propose_task` tool_use block,
/// build a `MessageContent::Propose` from its input. Returns None if
/// no such block is present. If multiple propose_task calls appear in
/// one turn, take the first.
pub(crate) fn extract_propose_from_content(
    content: &serde_json::Value,
) -> Option<crate::teammate::MessageContent> {
    let arr = content.as_array()?;
    for block in arr {
        if block.get("type").and_then(|v| v.as_str()) != Some("tool_use") {
            continue;
        }
        if block.get("name").and_then(|v| v.as_str()) != Some("propose_task") {
            continue;
        }
        let input = block.get("input")?;
        let archetype_s = input.get("archetype")?.as_str()?;
        let archetype = match archetype_s {
            "do" => crate::teammate::TaskArchetype::Do,
            "review" => crate::teammate::TaskArchetype::Review,
            "watch" => crate::teammate::TaskArchetype::Watch,
            _ => return None,
        };
        let title = input.get("title")?.as_str()?.to_string();
        let deliverable = input.get("deliverable")?.as_str()?.to_string();
        let rationale = input.get("rationale")?.as_str()?.to_string();
        let scope = input
            .get("scope")
            .and_then(|s| serde_json::from_value::<crate::teammate::TaskScope>(s.clone()).ok())
            .unwrap_or_default();
        let executor = input
            .get("executor")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        return Some(crate::teammate::MessageContent::Propose(
            crate::teammate::types::ProposeTask {
                draft: crate::teammate::types::TaskDraft {
                    archetype,
                    title,
                    deliverable,
                    scope,
                    executor,
                },
                rationale,
            },
        ));
    }
    None
}

/// If the assistant turn contains a `handoff_task` tool_use block,
/// build a `HandoffRequest` from its input. Returns None if no such block
/// is present. If multiple handoff_task calls appear in one turn, take the first.
pub(crate) fn extract_handoff_from_content(
    content: &serde_json::Value,
) -> Option<crate::teammate::types::HandoffRequest> {
    let arr = content.as_array()?;
    for block in arr {
        if block.get("type").and_then(|v| v.as_str()) != Some("tool_use") {
            continue;
        }
        if block.get("name").and_then(|v| v.as_str()) != Some("handoff_task") {
            continue;
        }
        let input = block.get("input")?;
        let required_skills: Vec<String> = input
            .get("required_skills")?
            .as_array()?
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect();
        if required_skills.is_empty() {
            continue; // malformed: a handoff with no skills can't be routed
        }
        return Some(crate::teammate::types::HandoffRequest {
            required_skills,
            brief: input.get("brief")?.as_str()?.to_string(),
            deliverable: input.get("deliverable")?.as_str()?.to_string(),
            executor: input.get("executor")?.as_str()?.to_string(),
            context: input
                .get("context")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        });
    }
    None
}

/// OpenAI-shape equivalent of `extract_handoff_from_content`. Scans the
/// assistant's `tool_calls` array for a `handoff_task` function call and
/// builds the `HandoffRequest` from its arguments.
fn extract_handoff_from_openai_tool_calls(
    tool_calls: &[serde_json::Value],
) -> Option<crate::teammate::types::HandoffRequest> {
    for tc in tool_calls {
        let function = tc.get("function")?;
        let name = function.get("name").and_then(|v| v.as_str())?;
        if name != "handoff_task" {
            continue;
        }
        let args_raw = function.get("arguments").and_then(|v| v.as_str())?;
        let input: serde_json::Value = serde_json::from_str(args_raw).ok()?;
        let required_skills: Vec<String> = input
            .get("required_skills")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        if required_skills.is_empty() {
            continue; // malformed: a handoff with no skills can't be routed
        }
        return Some(crate::teammate::types::HandoffRequest {
            required_skills,
            brief: input.get("brief").and_then(|v| v.as_str())?.to_string(),
            deliverable: input
                .get("deliverable")
                .and_then(|v| v.as_str())?
                .to_string(),
            executor: input.get("executor").and_then(|v| v.as_str())?.to_string(),
            context: input
                .get("context")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        });
    }
    None
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
            soul_path: None,
            soul_mtime_unix_ms: 0,
            github_access: crate::operator_registry::GithubAccess::Off,
            acp_enabled: false,
            perception_enabled: false,
            org_slug: None,
        }
    }

    fn sample_task(title: &str, status: crate::teammate::types::TaskStatus) -> crate::teammate::Task {
        use crate::teammate::types::{TaskArchetype, TaskId, TaskScope};
        crate::teammate::Task {
            id: TaskId(Ulid::new()),
            operator_id: OperatorId(Ulid::new()),
            archetype: TaskArchetype::Do,
            title: title.into(),
            body: String::new(),
            deliverable: String::new(),
            status,
            scope: TaskScope::default(),
            spawned_session: None,
            created_at_unix_ms: 0,
            updated_at_unix_ms: 0,
            completed_at_unix_ms: None,
            cost_usd_cents: 0,
        }
    }

    #[test]
    fn render_active_tasks_lists_only_in_flight() {
        use crate::teammate::types::TaskStatus;
        assert_eq!(render_active_tasks(&[]), "");
        let tasks = vec![
            sample_task("Fix Windows startup", TaskStatus::Active),
            sample_task("Old finished job", TaskStatus::Done),
            sample_task("Cancelled dup", TaskStatus::Cancelled),
            sample_task("Waiting on CI", TaskStatus::Blocked),
        ];
        let md = render_active_tasks(&tasks);
        assert!(md.contains("Fix Windows startup"));
        assert!(md.contains("Waiting on CI")); // Blocked counts as in-flight
        assert!(!md.contains("Old finished job"));
        assert!(!md.contains("Cancelled dup"));
        assert!(md.contains("# Your in-flight tasks"));
    }

    fn text_msg(role: Role, text: &str) -> TaskMessage {
        TaskMessage {
            id: MessageId::new(),
            operator_id: OperatorId(Ulid::new()),
            task_id: None,
            thread_id: None,
            role,
            content: MessageContent::Text(text.into()),
            created_at_unix_ms: 0,
            confirmed_at_unix_ms: None,
            dismissed_at_unix_ms: None,
            sentiment: None,
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
    fn system_prompt_includes_card_directive() {
        let op = sample_op("Mibli", "");
        let p = build_system_prompt(&op);
        assert!(p.contains("```card"), "prompt must teach the card fence");
        assert!(
            p.contains("# Cards"),
            "prompt must have the Cards section header"
        );
    }

    #[test]
    fn system_prompt_includes_sentiment_directive() {
        let op = sample_op("Mibli", "");
        let p = build_system_prompt(&op);
        // The directive header + key tokens must appear so the model
        // sees the SENTIMENT: contract even when persona is empty.
        assert!(p.contains("# Sentiment tag"), "missing directive header");
        assert!(p.contains("SENTIMENT:"));
        assert!(p.contains("feliz"));
        assert!(p.contains("vergüenza"));
    }

    #[test]
    fn extract_sentiment_strips_tag_line_and_returns_token() {
        let raw = "Hello world.\n\nSENTIMENT: feliz";
        let (text, s) = extract_sentiment(raw);
        assert_eq!(text, "Hello world.");
        assert_eq!(s, Some(Sentiment::Feliz));
    }

    #[test]
    fn extract_sentiment_handles_trailing_whitespace_and_case() {
        let raw = "ok\n  sentiment:  ENOJO  ";
        let (text, s) = extract_sentiment(raw);
        assert_eq!(text, "ok");
        assert_eq!(s, Some(Sentiment::Enojo));
    }

    #[test]
    fn extract_sentiment_accepts_verguenza_alias() {
        let raw = "lo siento.\nSENTIMENT: vergüenza";
        let (_text, s) = extract_sentiment(raw);
        assert_eq!(s, Some(Sentiment::Ver));
        let raw2 = "oops.\nSENTIMENT: verguenza";
        let (_t2, s2) = extract_sentiment(raw2);
        assert_eq!(s2, Some(Sentiment::Ver));
    }

    #[test]
    fn extract_sentiment_accepts_english_gloss_fallback() {
        let (_t, s) = extract_sentiment("blah\nSENTIMENT: happy");
        assert_eq!(s, Some(Sentiment::Feliz));
        let (_t2, s2) = extract_sentiment("blah\nSENTIMENT: ashamed");
        assert_eq!(s2, Some(Sentiment::Ver));
    }

    #[test]
    fn extract_sentiment_unknown_token_leaves_text_intact() {
        let raw = "the body\nSENTIMENT: gibberish";
        let (text, s) = extract_sentiment(raw);
        assert_eq!(text, raw, "unparseable tag must not be stripped");
        assert_eq!(s, None);
    }

    #[test]
    fn extract_sentiment_strips_inline_tag_without_newline() {
        // Regression: model sometimes emits the tag on the same line as
        // the final sentence. We must still strip it so it does not leak
        // into the rendered message bubble.
        let raw = "Specify the file name. SENTIMENT: neutral";
        let (text, s) = extract_sentiment(raw);
        assert_eq!(text, "Specify the file name.");
        assert_eq!(s, Some(Sentiment::Neutral));
    }

    #[test]
    fn extract_sentiment_no_tag_returns_full_text() {
        let raw = "just a reply with no tag";
        let (text, s) = extract_sentiment(raw);
        assert_eq!(text, raw);
        assert_eq!(s, None);
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
        assert!(p.contains("read_file"));
    }

    #[test]
    fn parse_propose_task_tool_use_builds_propose_content() {
        let content_blocks = serde_json::json!([
            {
                "type": "tool_use",
                "id": "toolu_01abc",
                "name": "propose_task",
                "input": {
                    "archetype": "do",
                    "title": "Revisar migración de auth",
                    "deliverable": "resumen + lista de riesgos + PR draft",
                    "rationale": "user asked for an audit and a write-up",
                    "scope": { "paths": ["crates/app/src/auth_mig.rs"] }
                }
            }
        ]);
        let result =
            extract_propose_from_content(&content_blocks).expect("expected a Propose payload");
        use crate::teammate::types::{MessageContent, TaskArchetype};
        let MessageContent::Propose(p) = result else {
            panic!("expected Propose variant");
        };
        assert!(matches!(p.draft.archetype, TaskArchetype::Do));
        assert_eq!(p.draft.title, "Revisar migración de auth");
        assert_eq!(p.draft.deliverable, "resumen + lista de riesgos + PR draft");
        assert_eq!(p.rationale, "user asked for an audit and a write-up");
        assert_eq!(p.draft.scope.paths.len(), 1);
    }

    #[test]
    fn extract_propose_returns_none_when_no_propose_task_block() {
        let content_blocks = serde_json::json!([
            { "type": "text", "text": "hola" }
        ]);
        assert!(extract_propose_from_content(&content_blocks).is_none());
    }

    #[test]
    fn extracts_handoff_from_tool_use() {
        let content = serde_json::json!([
            { "type": "text", "text": "ok" },
            { "type": "tool_use", "name": "handoff_task",
              "input": {
                "required_skills": ["rust", "migrations"],
                "brief": "migrate the auth module to the new client",
                "deliverable": "auth module compiles against v2 client, tests green",
                "executor": "codex"
              } }
        ]);
        let req = extract_handoff_from_content(&content).expect("should parse");
        assert_eq!(
            req.required_skills,
            vec!["rust".to_string(), "migrations".to_string()]
        );
        assert_eq!(req.executor, "codex");
        assert!(req.context.is_none());
    }

    #[test]
    fn handoff_extraction_ignores_other_tools() {
        let content = serde_json::json!([
            { "type": "tool_use", "name": "read_file", "input": { "path": "a" } }
        ]);
        assert!(extract_handoff_from_content(&content).is_none());
    }

    #[test]
    fn handoff_extraction_rejects_empty_skills() {
        let content = serde_json::json!([
            { "type": "tool_use", "name": "handoff_task",
              "input": { "required_skills": [], "brief": "x", "deliverable": "y", "executor": "codex" } }
        ]);
        assert!(extract_handoff_from_content(&content).is_none());
    }

    #[test]
    fn github_tools_registered_by_access_level() {
        use crate::operator_registry::GithubAccess;
        use crate::teammate::tools::{GithubCtx, ToolEnv};
        let base = ToolEnv::new(std::env::temp_dir(), 1024).with_skills(vec!["rust".into()]);
        assert_eq!(all_tool_defs(&base).len(), 9); // 8 base + handoff_task

        let ro = ToolEnv::new(std::env::temp_dir(), 1024)
            .with_skills(vec!["rust".into()])
            .with_github(Some(GithubCtx {
                token: "t".into(),
                access: GithubAccess::ReadOnly,
                api_base: "x".into(),
            }));
        assert_eq!(all_tool_defs(&ro).len(), 9 + 5);

        let rw = ToolEnv::new(std::env::temp_dir(), 1024)
            .with_skills(vec!["rust".into()])
            .with_github(Some(GithubCtx {
                token: "t".into(),
                access: GithubAccess::ReadWrite,
                api_base: "x".into(),
            }));
        let rw_defs = all_tool_defs(&rw);
        let names: Vec<&str> = rw_defs
            .iter()
            .map(|d| d["name"].as_str().unwrap())
            .collect();
        assert_eq!(names.len(), 9 + 9);
        assert!(names.contains(&"gh_create_issue"));
    }

    #[test]
    fn dispatch_acp_registered_only_when_enabled() {
        use crate::teammate::tools::ToolEnv;
        let names = |env: &ToolEnv| -> Vec<String> {
            all_tool_defs(env)
                .iter()
                .map(|d| d["name"].as_str().unwrap().to_string())
                .collect()
        };
        let off = ToolEnv::new(std::env::temp_dir(), 1024);
        assert!(!names(&off).contains(&"dispatch_acp".to_string()));
        let on = ToolEnv::new(std::env::temp_dir(), 1024).with_acp(true);
        assert!(names(&on).contains(&"dispatch_acp".to_string()));
    }

    #[tokio::test]
    async fn execute_tool_refuses_dispatch_acp_when_gated() {
        use crate::teammate::tools::ToolEnv;
        let env = ToolEnv::new(std::env::temp_dir(), 1024); // acp off
        let (text, ok, err) =
            execute_tool(&env, "dispatch_acp", &serde_json::json!({ "prompt": "x" })).await;
        assert!(!ok);
        assert!(text.contains("not enabled"), "got: {text}");
        assert!(err.is_some());
    }

    #[test]
    fn handoff_omitted_when_no_skills() {
        use crate::teammate::tools::ToolEnv;
        let env = ToolEnv::new(std::env::temp_dir(), 1024); // no skills
        let defs = all_tool_defs(&env);
        let names: Vec<&str> = defs.iter().map(|d| d["name"].as_str().unwrap()).collect();
        assert_eq!(names.len(), 8);
        assert!(!names.contains(&"handoff_task"));
    }

    #[test]
    fn handoff_schema_enum_reflects_available_skills() {
        use crate::teammate::tools::ToolEnv;
        let env =
            ToolEnv::new(std::env::temp_dir(), 1024).with_skills(vec!["rust".into(), "ui".into()]);
        let defs = all_tool_defs(&env);
        let def = defs
            .into_iter()
            .find(|d| d["name"] == "handoff_task")
            .unwrap();
        let enm = &def["input_schema"]["properties"]["required_skills"]["items"]["enum"];
        assert_eq!(enm, &serde_json::json!(["rust", "ui"]));
    }

    #[test]
    fn system_prompt_mentions_github_only_when_enabled() {
        use crate::operator_registry::GithubAccess;

        let off = sample_op("Mibli", "");
        let p_off = build_system_prompt(&off);
        assert!(!p_off.contains("# GitHub access"));
        assert!(!p_off.contains("gh_list_repos"));

        let mut ro = sample_op("Mibli", "");
        ro.github_access = GithubAccess::ReadOnly;
        let p_ro = build_system_prompt(&ro);
        assert!(p_ro.contains("# GitHub access"));
        assert!(p_ro.contains("gh_list_repos"));
        assert!(p_ro.contains("READ-ONLY"));
        assert!(!p_ro.contains("gh_create_issue"));

        let mut rw = sample_op("Mibli", "");
        rw.github_access = GithubAccess::ReadWrite;
        let p_rw = build_system_prompt(&rw);
        assert!(p_rw.contains("# GitHub access"));
        assert!(p_rw.contains("gh_create_issue"));
        assert!(!p_rw.contains("READ-ONLY"));
    }
}
