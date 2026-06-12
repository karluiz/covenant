# ⌘K Action Palette Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the markdown-streaming ⌘K overlay with an Action Palette: structured tool-use response, top-1 command chip, ⏎ inserts into the active PTY, ⌘⏎ runs (unless Destructive).

**Architecture:** Backend switches the agent call from free-text streaming to Anthropic tool-use (single `respond` tool). A new `risk` classifier in `crates/agent` reuses the existing safety regex set. The Tauri command emits two event kinds (`explanation_delta`, `response_final`). Frontend drops the fenced-code parser and renders a two-zone overlay: explanation block + optional command chip + follow-up chips. Keybindings invoke existing `write_to_session` for insert vs. run.

**Tech Stack:** Rust + tokio + reqwest (`crates/agent`), Tauri commands + Channels (`crates/app`), TypeScript + Vite (`ui/src`).

---

## File Structure

**Create:**
- `crates/agent/src/safety.rs` — `Risk` enum + `classify(cmd: &str) -> Risk` with hard-blocklist regex set
- `crates/agent/src/respond_tool.rs` — `respond` tool JSON schema constant + `AgentResponse` / `CommandAction` types + JSON-fragment accumulator for streaming tool input

**Modify:**
- `crates/agent/src/lib.rs` — re-export `safety` and `respond_tool`; extend `AgentEvent` with `ToolInputDelta(String)` and `ToolInputDone(Value)`; emit those from `ask_streaming` when the server returns a tool-use content block
- `crates/app/src/lib.rs` — `ask_agent`: switch system prompt; pass the `respond` tool in the request; accumulate tool input JSON; emit two new Tauri events (`agent://{session}/explanation` and `agent://{session}/response`); keep the existing `on_token` channel firing for explanation text so backwards-compat with callers (none) isn't broken — actually replace it
- `ui/src/api.ts` — replace `askAgent` signature: returns explanation deltas + a final `AgentResponse`; add typed callbacks
- `ui/src/agent/panel.ts` — full rewrite of the renderer; drop fenced-code parser + Copy-button delegation; add chip + follow-up rendering + keybinding matrix
- `ui/src/styles.css` — `.agent-chip`, `.agent-risk-*`, `.agent-followup` styles

**Test:**
- `crates/agent/src/safety.rs` (inline `#[cfg(test)]` module) — classifier matrix
- `crates/agent/src/respond_tool.rs` (inline) — JSON fragment accumulator
- Manual integration: real PTY tab, every keybinding × every risk level

---

### Task 1: Risk classifier

**Files:**
- Create: `crates/agent/src/safety.rs`
- Modify: `crates/agent/src/lib.rs` (add `pub mod safety;`)

- [ ] **Step 1: Write the failing tests**

Create `crates/agent/src/safety.rs`:

```rust
//! Risk classification for proposed agent commands. Reuses the hard
//! blocklist from CLAUDE.md so the UI can never paint a "safe" badge
//! on something we would refuse to auto-execute.

use once_cell::sync::Lazy;
use regex::RegexSet;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Risk {
    Safe,
    Mutates,
    Destructive,
}

static DESTRUCTIVE: Lazy<RegexSet> = Lazy::new(|| {
    RegexSet::new([
        r"(?x) \b rm \s .* (-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r) ",
        r"(?x) \b ( sudo | doas | su ) \b ",
        r"(?x) \b curl \b .* \| \s* (sh|bash|zsh|fish) \b ",
        r"(?x) \b wget \b .* \| \s* (sh|bash|zsh|fish) \b ",
        r"(?x) \b ( dd | mkfs(\.[a-z0-9]+)? | fdisk ) \b ",
        r"(?x) :\(\)\{",
        r"(?x) > \s* ~/\.(ssh|aws|config/gh) ",
        r"(?x) > \s* /etc/ ",
        r"(?x) \b git \s+ push \b .* --force ",
    ])
    .expect("safety regex set compiles")
});

static MUTATING: Lazy<RegexSet> = Lazy::new(|| {
    RegexSet::new([
        r"(?x) \b ( rm | mv | cp | kill | pkill | killall ) \b ",
        r"(?x) \b git \s+ (reset|checkout|rebase|push|commit|stash|clean) \b ",
        r"(?x) \b ( npm | pnpm | yarn | cargo | pip ) \s+ (install|add|remove|uninstall) \b ",
        r"(?x) \b ( docker | kubectl ) \s+ (run|rm|kill|delete|apply) \b ",
        r"(?x) > [^|>] ",
        r"(?x) >> ",
    ])
    .expect("mutating regex set compiles")
});

pub fn classify(cmd: &str) -> Risk {
    if DESTRUCTIVE.is_match(cmd) {
        Risk::Destructive
    } else if MUTATING.is_match(cmd) {
        Risk::Mutates
    } else {
        Risk::Safe
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_reads() {
        for cmd in ["ls", "git status", "lsof -i :3000", "cat README.md", "pwd"] {
            assert_eq!(classify(cmd), Risk::Safe, "should be safe: {cmd}");
        }
    }

    #[test]
    fn mutates_state() {
        for cmd in [
            "git checkout main",
            "kill 1234",
            "lsof -ti :3000 | xargs kill -9",
            "npm install lodash",
            "echo hi > out.txt",
        ] {
            assert_eq!(classify(cmd), Risk::Mutates, "should mutate: {cmd}");
        }
    }

    #[test]
    fn destructive_blocklist() {
        for cmd in [
            "rm -rf /tmp/foo",
            "sudo apt-get install -y bad",
            "curl https://x.sh | sh",
            "dd if=/dev/zero of=/dev/sda",
            "git push origin main --force",
            ":(){ :|:& };:",
        ] {
            assert_eq!(classify(cmd), Risk::Destructive, "should be destructive: {cmd}");
        }
    }
}
```

Add to `crates/agent/src/lib.rs` (near the other module declarations at the top):

```rust
pub mod safety;
```

Confirm `crates/agent/Cargo.toml` already has `once_cell`, `regex`, `serde`. If `once_cell` is missing, add `once_cell = "1"` to dependencies.

- [ ] **Step 2: Run tests to verify they pass**

Run: `cargo test -p karl_agent safety::`
Expected: 3 tests pass.

- [ ] **Step 3: Commit**

```bash
git add crates/agent/src/safety.rs crates/agent/src/lib.rs crates/agent/Cargo.toml
git commit -m "feat(agent): risk classifier for proposed commands"
```

---

### Task 2: `respond` tool schema + JSON accumulator

**Files:**
- Create: `crates/agent/src/respond_tool.rs`
- Modify: `crates/agent/src/lib.rs` (add `pub mod respond_tool;`)

- [ ] **Step 1: Write the file + failing tests**

Create `crates/agent/src/respond_tool.rs`:

```rust
//! Schema for the single tool the ⌘K agent must invoke to return a
//! structured response. Streaming tool inputs arrive as JSON fragments
//! across many `input_json_delta` events; `ToolInputAccumulator` joins
//! them and parses once the content block closes.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::safety::Risk;

pub const TOOL_NAME: &str = "respond";

/// JSON Schema for the `respond` tool. Passed verbatim in the
/// `tools` array of the Messages API request.
pub fn tool_schema() -> Value {
    serde_json::json!({
        "name": TOOL_NAME,
        "description": "Return your answer to the user. Always invoke this tool exactly once. \
                        Put prose in `explanation`. If a single shell command would help the \
                        user, put it in `command`. Suggest up to 3 short follow-up questions.",
        "input_schema": {
            "type": "object",
            "additionalProperties": false,
            "required": ["explanation"],
            "properties": {
                "explanation": {
                    "type": "string",
                    "description": "Plain prose. May be empty if the command is self-evident."
                },
                "command": {
                    "type": ["object", "null"],
                    "additionalProperties": false,
                    "required": ["cmd", "rationale"],
                    "properties": {
                        "cmd": { "type": "string", "description": "Single shell-ready line, no $ prefix, no fences." },
                        "rationale": { "type": "string", "description": "One short sentence." },
                        "cwd_hint": { "type": ["string", "null"] }
                    }
                },
                "followups": {
                    "type": "array",
                    "maxItems": 3,
                    "items": { "type": "string" }
                }
            }
        }
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentResponse {
    pub explanation: String,
    #[serde(default)]
    pub command: Option<CommandAction>,
    #[serde(default)]
    pub followups: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandAction {
    pub cmd: String,
    pub rationale: String,
    /// Backend-overridden, never trusted from the model.
    #[serde(default = "default_risk")]
    pub risk: Risk,
    #[serde(default)]
    pub cwd_hint: Option<String>,
}

fn default_risk() -> Risk {
    Risk::Safe
}

/// Joins streaming `input_json_delta` fragments for a single tool_use
/// content block. Call `push` for every delta, then `finish` to parse.
#[derive(Default, Debug)]
pub struct ToolInputAccumulator {
    buf: String,
}

impl ToolInputAccumulator {
    pub fn push(&mut self, fragment: &str) {
        self.buf.push_str(fragment);
    }

    pub fn finish(self) -> Result<AgentResponse, serde_json::Error> {
        // Anthropic sends `{}` if the model emits no input. Tolerate.
        let raw = if self.buf.trim().is_empty() {
            "{}".to_string()
        } else {
            self.buf
        };
        let mut resp: AgentResponse = serde_json::from_str(&raw)?;
        // Force-classify the command risk; never trust the model.
        if let Some(c) = resp.command.as_mut() {
            c.risk = crate::safety::classify(&c.cmd);
        }
        Ok(resp)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accumulates_and_classifies() {
        let mut acc = ToolInputAccumulator::default();
        acc.push(r#"{"explanation":"kills the port","command":{"cmd":"#);
        acc.push(r#""lsof -ti :3000 | xargs kill -9","rationale":"frees 3000""#);
        acc.push(r#"},"followups":["which process is it?"]}"#);
        let r = acc.finish().unwrap();
        assert_eq!(r.explanation, "kills the port");
        let c = r.command.expect("command present");
        assert_eq!(c.risk, Risk::Mutates);
        assert_eq!(r.followups.len(), 1);
    }

    #[test]
    fn empty_input_is_ok() {
        let acc = ToolInputAccumulator::default();
        let r = acc.finish().unwrap();
        assert!(r.explanation.is_empty());
        assert!(r.command.is_none());
    }

    #[test]
    fn destructive_classification_overrides_model() {
        let mut acc = ToolInputAccumulator::default();
        acc.push(r#"{"explanation":"x","command":{"cmd":"rm -rf /tmp/x","rationale":"clean","risk":"safe"}}"#);
        let r = acc.finish().unwrap();
        assert_eq!(r.command.unwrap().risk, Risk::Destructive);
    }
}
```

Add to `crates/agent/src/lib.rs`:

```rust
pub mod respond_tool;
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cargo test -p karl_agent respond_tool::`
Expected: 3 tests pass.

- [ ] **Step 3: Commit**

```bash
git add crates/agent/src/respond_tool.rs crates/agent/src/lib.rs
git commit -m "feat(agent): respond tool schema + streaming JSON accumulator"
```

---

### Task 3: Stream tool-use events from `ask_streaming`

**Files:**
- Modify: `crates/agent/src/lib.rs`

Currently `ask_streaming` only surfaces `text_delta` and `thinking_delta`. We need to expose tool-use input fragments and a final parsed response.

- [ ] **Step 1: Extend `AgentEvent`**

Find the `AgentEvent` enum in `crates/agent/src/lib.rs` (search `enum AgentEvent`). Add two variants:

```rust
/// Streaming JSON fragment of a tool_use input block.
ToolInputDelta { tool_name: String, fragment: String },
/// Tool_use content block closed. The accumulated JSON is parsed
/// upstream by the caller using `respond_tool::ToolInputAccumulator`.
ToolInputDone { tool_name: String },
```

- [ ] **Step 2: Accept an optional tool in `AskRequest`**

Find `pub struct AskRequest` (line ~28). Add a field:

```rust
/// If `Some`, sent in the `tools` array and `tool_choice` is forced
/// to this name so the model must invoke it.
pub force_tool: Option<serde_json::Value>,
```

In the request body construction (line ~177), after the `messages` field is set:

```rust
if let Some(tool) = req.force_tool.as_ref() {
    body["tools"] = serde_json::json!([tool]);
    let name = tool.get("name").and_then(|n| n.as_str()).unwrap_or("");
    body["tool_choice"] = serde_json::json!({ "type": "tool", "name": name });
}
```

- [ ] **Step 3: Surface tool_use deltas in the SSE loop**

In the SSE handler (search `"content_block_delta"`), inside the `match delta_type`, add:

```rust
"input_json_delta" => {
    if let Some(frag) = delta
        .and_then(|d| d.get("partial_json"))
        .and_then(|t| t.as_str())
    {
        // We don't have the block's tool name in this event;
        // the caller tracks `current_tool_name` via content_block_start.
        on_event(AgentEvent::ToolInputDelta {
            tool_name: String::new(),
            fragment: frag.to_string(),
        });
    }
}
```

Also handle `content_block_start` and `content_block_stop` at the top-level event match (sibling to `content_block_delta`):

```rust
"content_block_start" => {
    let cb = value.get("content_block");
    if cb.and_then(|c| c.get("type")).and_then(|t| t.as_str()) == Some("tool_use") {
        let name = cb
            .and_then(|c| c.get("name"))
            .and_then(|n| n.as_str())
            .unwrap_or("")
            .to_string();
        on_event(AgentEvent::ToolInputDelta { tool_name: name, fragment: String::new() });
    }
}
"content_block_stop" => {
    on_event(AgentEvent::ToolInputDone { tool_name: String::new() });
}
```

(Tool-name tracking is best-effort — the caller in `crates/app` only ever forces the `respond` tool so a single accumulator suffices.)

- [ ] **Step 4: Build and run agent tests**

Run: `cargo build -p karl_agent && cargo test -p karl_agent`
Expected: builds clean, all existing tests pass, Tasks 1+2 tests still green.

- [ ] **Step 5: Commit**

```bash
git add crates/agent/src/lib.rs
git commit -m "feat(agent): expose tool_use input deltas in streaming"
```

---

### Task 4: Wire `ask_agent` Tauri command to tool-use

**Files:**
- Modify: `crates/app/src/lib.rs` (function `ask_agent` around line 1833 and `SYSTEM_PROMPT` constant just above it)

- [ ] **Step 1: Update the system prompt**

Replace the existing `SYSTEM_PROMPT` constant. Find the string starting `"You are the super-agent for Covenant…"` and replace its tail (`"Plain text only (no markdown, no code fences)."`) with:

```
Always respond by invoking the `respond` tool exactly once. \
Put prose in `explanation`. If a single shell command would directly \
help, put it in `command` with a one-sentence rationale. Prefer top-1: \
do not list alternatives in prose. Suggest up to 3 short follow-up \
questions the user might ask next. Keep everything terse.
```

- [ ] **Step 2: Change the `ask_agent` signature**

Replace the existing `on_token: Channel<String>` parameter with two channels:

```rust
#[tauri::command]
async fn ask_agent(
    state: State<'_, AppState>,
    session_id: String,
    question: String,
    on_explanation: Channel<String>,
    on_response: Channel<serde_json::Value>,
) -> Result<(), String> {
```

- [ ] **Step 3: Build the request with the `respond` tool and accumulate the response**

Find the `karl_agent::AskRequest { ... }` construction (around line 1900). Replace:

```rust
let req = karl_agent::AskRequest {
    api_key,
    model: model_chat,
    system_prompt: SYSTEM_PROMPT.to_string(),
    user_message,
    max_tokens: 1024,
    thinking_budget: None,
    force_tool: Some(karl_agent::respond_tool::tool_schema()),
};

use std::sync::{Arc, Mutex};
let acc = Arc::new(Mutex::new(karl_agent::respond_tool::ToolInputAccumulator::default()));
let acc_for_cb = acc.clone();
let on_resp = on_response.clone();
let on_expl = on_explanation.clone();

karl_agent::ask_streaming(req, move |event| match event {
    karl_agent::AgentEvent::Delta(text) => {
        let _ = on_expl.send(text);
    }
    karl_agent::AgentEvent::ToolInputDelta { fragment, .. } => {
        if !fragment.is_empty() {
            acc_for_cb.lock().unwrap().push(&fragment);
        }
    }
    karl_agent::AgentEvent::ToolInputDone { .. } => {
        // We don't parse here — `ask_streaming` may still emit other
        // events. Parse in the outer scope after the future resolves.
    }
    karl_agent::AgentEvent::Usage(_)
    | karl_agent::AgentEvent::Done
    | karl_agent::AgentEvent::ThinkingDelta(_)
    | karl_agent::AgentEvent::StopReason(_) => {}
})
.await
.map_err(|e| e.to_string())?;

// Parse the accumulated tool input and ship it to the UI. A model
// that returned only text (no tool_use) yields the empty-input
// fallback — explanation comes through `on_explanation`.
let parsed = {
    let inner = Arc::try_unwrap(acc).map(|m| m.into_inner().unwrap()).unwrap_or_else(|arc| {
        std::mem::take(&mut *arc.lock().unwrap())
    });
    inner.finish().map_err(|e| format!("parse respond tool: {e}"))?
};
let value = serde_json::to_value(&parsed).map_err(|e| e.to_string())?;
let _ = on_response.send(value);

Ok(())
```

`std::mem::take` requires `ToolInputAccumulator: Default` — already derived in Task 2.

- [ ] **Step 4: Confirm `force_tool` field is the only `AskRequest` change for other callers**

Grep for other `AskRequest {` usages:

```bash
rg "AskRequest \{" crates
```

For each call site that does NOT need a tool, add `force_tool: None,` to keep the struct literal valid.

- [ ] **Step 5: Build the workspace**

Run: `cargo build`
Expected: clean build, no warnings about unused channels.

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/lib.rs crates/agent/src/lib.rs
git commit -m "feat(app): ask_agent uses respond tool with structured output"
```

---

### Task 5: Frontend API wrapper

**Files:**
- Modify: `ui/src/api.ts` (function `askAgent` around line 684)

- [ ] **Step 1: Replace the wrapper**

Find the existing `askAgent` export and replace it:

```ts
export interface CommandAction {
  cmd: string;
  rationale: string;
  risk: "safe" | "mutates" | "destructive";
  cwd_hint?: string | null;
}

export interface AgentResponse {
  explanation: string;
  command: CommandAction | null;
  followups: string[];
}

export async function askAgent(
  sessionId: string,
  question: string,
  onExplanation: (delta: string) => void,
  onResponse: (resp: AgentResponse) => void,
): Promise<void> {
  const { Channel } = await import("@tauri-apps/api/core");
  const explChan = new Channel<string>();
  explChan.onmessage = (msg) => onExplanation(msg);
  const respChan = new Channel<AgentResponse>();
  respChan.onmessage = (msg) => onResponse(msg);
  return invoke<void>("ask_agent", {
    sessionId,
    question,
    onExplanation: explChan,
    onResponse: respChan,
  });
}
```

(If `Channel` is already imported at the top of the file, drop the dynamic import and use the existing import directly. Check `grep -n "from \"@tauri-apps/api/core\"" ui/src/api.ts` first.)

- [ ] **Step 2: Build the frontend**

Run: `cd ui && pnpm tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add ui/src/api.ts
git commit -m "feat(ui): askAgent returns structured response + explanation stream"
```

---

### Task 6: Panel rewrite — two-zone renderer

**Files:**
- Modify: `ui/src/agent/panel.ts` (full rewrite)

- [ ] **Step 1: Replace the file**

Overwrite `ui/src/agent/panel.ts` with:

```ts
// ⌘K Action Palette. The agent returns a structured response via
// tool-use: optional explanation text (streamed), optional top-1
// command chip, and 0–3 follow-up questions. ⏎ inserts the command
// into the active PTY without a trailing newline; ⌘⏎ runs it (unless
// risk=destructive, which downgrades to insert + warning).

import { askAgent, writeToSession, type AgentResponse, type CommandAction } from "../api";
import { Icons } from "../icons";

export class AgentPanel {
  private modal: HTMLElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private explEl: HTMLElement | null = null;
  private chipEl: HTMLElement | null = null;
  private followupsEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private inProgress = false;
  private lastCommand: CommandAction | null = null;
  private explBuffer = "";

  constructor(
    private readonly mountHost: HTMLElement,
    private readonly getActiveSessionId: () => string | null,
  ) {}

  isOpen(): boolean {
    return this.modal !== null;
  }

  toggle(): void {
    if (this.isOpen()) this.close();
    else this.open();
  }

  open(): void {
    if (this.isOpen()) return;
    this.render();
  }

  openWithSeed(seed: string): void {
    if (!this.isOpen()) this.render();
    if (this.inputEl) {
      this.inputEl.value = seed;
      this.inputEl.focus();
      this.inputEl.setSelectionRange(seed.length, seed.length);
    }
  }

  close(): void {
    if (!this.modal) return;
    this.modal.remove();
    this.modal = null;
    this.inputEl = null;
    this.explEl = null;
    this.chipEl = null;
    this.followupsEl = null;
    this.statusEl = null;
    this.inProgress = false;
    this.lastCommand = null;
  }

  private render(): void {
    const overlay = document.createElement("div");
    overlay.className = "agent-overlay";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.close();
    });

    const card = document.createElement("div");
    card.className = "agent-card";
    overlay.appendChild(card);

    card.innerHTML = `
      <div class="agent-input-row">
        <span class="agent-prompt-label">⌘K</span>
        <input type="text" class="agent-input" placeholder="ask the super-agent…" autocomplete="off" spellcheck="false" />
        <span class="agent-status" aria-live="polite"></span>
      </div>
      <div class="agent-explanation"></div>
      <div class="agent-chip-slot"></div>
      <div class="agent-followups"></div>
    `;

    this.inputEl = card.querySelector<HTMLInputElement>(".agent-input")!;
    this.explEl = card.querySelector<HTMLElement>(".agent-explanation")!;
    this.chipEl = card.querySelector<HTMLElement>(".agent-chip-slot")!;
    this.followupsEl = card.querySelector<HTMLElement>(".agent-followups")!;
    this.statusEl = card.querySelector<HTMLElement>(".agent-status")!;

    this.inputEl.addEventListener("keydown", (e) => this.onInputKey(e));
    overlay.addEventListener("keydown", (e) => this.onGlobalKey(e));

    this.mountHost.appendChild(overlay);
    this.modal = overlay;
    this.inputEl.focus();
  }

  private onInputKey(e: KeyboardEvent): void {
    if (e.key !== "Enter" || this.inProgress) return;
    const q = this.inputEl!.value.trim();
    if (q.length === 0) {
      // Empty input + ⏎: trigger the chip's insert action if any.
      if (this.lastCommand) {
        e.preventDefault();
        void this.doInsert(this.lastCommand, false);
      }
      return;
    }
    e.preventDefault();
    void this.ask(q);
  }

  private onGlobalKey(e: KeyboardEvent): void {
    if (!this.lastCommand) return;
    const cmd = this.lastCommand;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void this.doInsert(cmd, true);
    } else if ((e.key === "c" || e.key === "C") && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
      // Only intercept ⌘C when the input isn't selecting text. If the
      // user has a real selection we let the browser handle it.
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      e.preventDefault();
      void navigator.clipboard.writeText(cmd.cmd).then(() => this.setStatus("copied"));
    }
  }

  private async ask(question: string): Promise<void> {
    if (!this.explEl || !this.chipEl || !this.followupsEl || !this.inputEl || !this.statusEl) return;
    const sessionId = this.getActiveSessionId();
    if (!sessionId) {
      this.showError("no active session");
      return;
    }
    this.inProgress = true;
    this.lastCommand = null;
    this.explBuffer = "";
    this.explEl.textContent = "";
    this.chipEl.innerHTML = "";
    this.followupsEl.innerHTML = "";
    this.setStatus("thinking…");

    try {
      await askAgent(
        sessionId,
        question,
        (delta) => {
          this.explBuffer += delta;
          if (this.explEl) this.explEl.textContent = this.explBuffer;
          this.setStatus("");
        },
        (resp) => this.renderFinal(resp),
      );
    } catch (err) {
      this.showError(String(err));
    } finally {
      this.inProgress = false;
      if (this.inputEl) {
        this.inputEl.value = "";
        this.inputEl.focus();
      }
    }
  }

  private renderFinal(resp: AgentResponse): void {
    if (!this.explEl || !this.chipEl || !this.followupsEl) return;
    // Some models won't stream `explanation` as text deltas — it
    // arrives only inside the tool input. Use whichever has content.
    if (this.explBuffer.length === 0 && resp.explanation.length > 0) {
      this.explEl.textContent = resp.explanation;
    }
    this.lastCommand = resp.command;
    this.chipEl.innerHTML = resp.command ? this.renderChip(resp.command) : "";
    this.followupsEl.innerHTML = resp.followups
      .map(
        (q, i) => `<button type="button" class="agent-followup" data-i="${i}">${escapeHtml(q)}</button>`,
      )
      .join("");
    this.followupsEl.querySelectorAll<HTMLButtonElement>(".agent-followup").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.i);
        const q = resp.followups[idx];
        if (q && this.inputEl) {
          this.inputEl.value = q;
          void this.ask(q);
        }
      });
    });
  }

  private renderChip(c: CommandAction): string {
    const hints = `<span class="agent-chip-hints">
        <kbd>⏎</kbd> insert &nbsp;
        <kbd>⌘⏎</kbd> ${c.risk === "destructive" ? "<s>run</s>" : "run"} &nbsp;
        <kbd>⌘C</kbd> copy
      </span>`;
    return `
      <div class="agent-chip agent-risk-${c.risk}">
        <div class="agent-chip-head">
          <span class="agent-risk-badge">${c.risk}</span>
          <span class="agent-chip-rationale">${escapeHtml(c.rationale)}</span>
        </div>
        <pre class="agent-chip-cmd"><code>${escapeHtml(c.cmd)}</code></pre>
        <div class="agent-chip-foot">${hints}</div>
      </div>
    `;
  }

  private async doInsert(c: CommandAction, withEnter: boolean): Promise<void> {
    const sessionId = this.getActiveSessionId();
    if (!sessionId) return this.showError("no active session");
    const destructive = c.risk === "destructive";
    const append = withEnter && !destructive ? "\r" : "";
    try {
      await writeToSession(sessionId, c.cmd + append);
      if (destructive && withEnter) {
        this.setStatus("destructive — inserted, press Enter in shell to confirm");
      }
      this.close();
    } catch (err) {
      this.showError(String(err));
    }
  }

  private setStatus(msg: string): void {
    if (!this.statusEl) return;
    this.statusEl.textContent = msg;
    this.statusEl.classList.remove("err");
  }

  private showError(msg: string): void {
    if (this.statusEl) {
      this.statusEl.textContent = msg;
      this.statusEl.classList.add("err");
    }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
```

- [ ] **Step 2: Verify `writeToSession` is exported from `ui/src/api.ts`**

Run: `grep -n "export.*writeToSession\|writeToSession" ui/src/api.ts | head -5`
Expected: an `export async function writeToSession(...)` already exists. If not, find the existing `write_to_session` invoke wrapper (it's used by `ui/src/main.ts` for typing into the terminal) and add an `export` if missing.

- [ ] **Step 3: TypeScript check**

Run: `cd ui && pnpm tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add ui/src/agent/panel.ts
git commit -m "feat(ui): ⌘K palette renders structured response + command chip"
```

---

### Task 7: Styles

**Files:**
- Modify: `ui/src/styles.css`

- [ ] **Step 1: Locate the existing `.agent-*` block**

Run: `grep -n "agent-overlay\|agent-card\|agent-code\|agent-input" ui/src/styles.css | head -20`
Note the line range of the existing agent styles.

- [ ] **Step 2: Replace stale rules + add new ones**

Delete the rules for `.agent-code`, `.agent-code-head`, `.agent-code-copy`, `.agent-code-body`, `.agent-code-lang`, `.agent-code-streaming`, `.agent-inline-code`, `.agent-text` (these no longer exist in the new panel).

Append the new chip + followup styles to the same agent block (adjust to match the existing visual language — borders, radius, font-family — by reading nearby rules first):

```css
.agent-explanation {
  padding: 8px 14px;
  color: var(--text-muted);
  white-space: pre-wrap;
  font-size: 13px;
  line-height: 1.5;
}
.agent-explanation:empty {
  display: none;
}

.agent-chip-slot:empty {
  display: none;
}
.agent-chip {
  margin: 4px 12px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-1);
  overflow: hidden;
}
.agent-chip-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  font-size: 11px;
  border-bottom: 1px solid var(--border);
}
.agent-risk-badge {
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 600;
}
.agent-risk-safe .agent-risk-badge { background: #1f3a26; color: #8fd8a0; }
.agent-risk-mutates .agent-risk-badge { background: #3a2f1f; color: #e0bb6b; }
.agent-risk-destructive .agent-risk-badge { background: #3a1f1f; color: #e08080; }
.agent-chip-rationale {
  color: var(--text-muted);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-chip-cmd {
  margin: 0;
  padding: 10px 12px;
  font-family: var(--mono);
  font-size: 13px;
  overflow-x: auto;
  white-space: pre;
}
.agent-chip-foot {
  padding: 6px 10px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-dim);
}
.agent-chip-hints kbd {
  font-family: var(--mono);
  font-size: 10px;
  padding: 1px 4px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--surface-2);
}

.agent-followups {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 12px 10px;
}
.agent-followups:empty { display: none; }
.agent-followup {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 11px;
  color: var(--text);
  cursor: pointer;
}
.agent-followup:hover { background: var(--surface-3); }
```

(If the codebase uses different CSS variable names, substitute them — `grep -n "^  --" ui/src/styles.css | head -20` lists what's available.)

- [ ] **Step 3: Launch the app and verify visually**

Run: `pnpm tauri dev`
- Open ⌘K
- Ask "kill whatever is on port 3000"
- Confirm: explanation streams in, chip renders with `MUTATES` badge, follow-ups appear
- ⏎ → command lands in the active PTY, overlay closes
- Reopen, repeat with ⌘⏎ → command runs (newline appended)
- Reopen, ask "rm -rf /tmp" or similar → chip badge is `DESTRUCTIVE`, ⌘⏎ inserts without newline and shows the warning toast

- [ ] **Step 4: Commit**

```bash
git add ui/src/styles.css
git commit -m "feat(ui): action palette chip + followup styles"
```

---

### Task 8: Sanity sweep + final commit

- [ ] **Step 1: Full workspace check**

```bash
cargo test --workspace
cd ui && pnpm tsc --noEmit && pnpm lint
```

Expected: all green.

- [ ] **Step 2: Manual smoke test**

In a fresh `pnpm tauri dev` session:
- `git status` request → safe chip, ⌘⏎ executes cleanly
- "show files in /tmp" → safe chip
- "free port 3000" → mutates chip
- "wipe my git history" → destructive chip, ⌘⏎ inserts but doesn't run
- Follow-up chip click → input refills + submits

- [ ] **Step 3: If anything misbehaves, fix and re-commit** (do not amend earlier task commits).
