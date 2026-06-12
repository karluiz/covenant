# Premium Spec Creator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the modal-chat Spec Creator with an immersive full-screen, animated authoring surface backed by a real read-only research agent (Opus 4.8 + extended thinking) that greps/reads the repo and streams its reasoning, tool calls, and the assembling spec into the UI via Tauri events.

**Architecture:** Three phases. **Phase 1 (backend):** add a streaming research path to `crates/agent` — read-only repo tools (`grep`/`read_file`/`list_dir`), path-safety jail, and a streaming tool-loop dispatcher that emits typed events through a callback. A new Tauri command bridges those callback events to `spec://{draftId}/event` Tauri emits. **Phase 2 (frontend):** build the immersive surface, activity-stream renderer, live-spec renderer, and phase spine — driven by an injectable event source so it's testable against a mocked stream. **Phase 3:** wire the real Tauri event channel into the surface, preserve the chooser/publish/AOM flow, and verify end-to-end.

**Tech Stack:** Rust (tokio, reqwest streaming SSE, serde, async-trait, ulid), Tauri 2 events, TypeScript (strict), Vite, xterm-adjacent DOM/CSS animation. Reference visual: `docs/superpowers/specs/premium-spec-creator-mockup.html`.

---

## Shared Event Protocol (the contract between phases)

All events for a draft are emitted on Tauri topic **`spec://{draftId}/event`** with this discriminated-union payload (serde `#[serde(tag = "kind", rename_all = "snake_case")]`). The TS mirror lives in `ui/src/spec-chat/events.ts`.

```ts
export type SpecStreamEvent =
  | { kind: 'thinking_delta'; text: string }
  | { kind: 'text_delta'; text: string }            // assistant prose (the question)
  | { kind: 'tool_start'; id: string; tool: 'grep' | 'read_file' | 'list_dir'; arg: string }
  | { kind: 'tool_result'; id: string; summary: string; ok: boolean }   // summary e.g. "9 matches"
  | { kind: 'section_update'; section: SpecSectionKey; markdown: string; status: 'filling' | 'done' }
  | { kind: 'phase'; section: SpecSectionKey }       // which section is now active
  | { kind: 'turn_done'; awaiting_user: boolean }    // turn ended; agent waits for the user
  | { kind: 'final'; markdown: string }              // full validated spec emitted
  | { kind: 'error'; message: string };

export type SpecSectionKey =
  | 'goal' | 'out_of_scope' | 'acceptance' | 'file_boundaries' | 'complexity' | 'open_questions';
```

Rust mirror: `enum SpecStreamEvent` in `crates/agent/src/spec_author/stream.rs` with the same `kind` tags and snake_case fields.

---

## File Structure

**Backend (Rust)**
- `crates/agent/src/spec_author/tools.rs` (new) — tool defs + executors (`grep`, `read_file`, `list_dir`), repo-root jail, path-safety.
- `crates/agent/src/spec_author/stream.rs` (new) — `SpecStreamEvent` enum, `StreamSink` callback trait, `StreamingDispatcher` trait, `AnthropicStreamingDispatcher`, and `step_streaming()` tool-loop.
- `crates/agent/src/spec_author.rs` (modify) — add `mod tools; mod stream;` and re-exports; keep existing `step`/`step_with_context` untouched.
- `crates/agent/src/spec_author/prompt.md` (modify) — exploration-first, tool-use, same 6-section output contract.
- `crates/app/src/lib.rs` (modify) — new `spec_author_stream_step` command that takes `app: tauri::AppHandle`, runs `step_streaming`, emits `spec://{id}/event`.

**Frontend (TypeScript)**
- `ui/src/spec-chat/events.ts` (new) — `SpecStreamEvent` type + `SpecEventSource` interface (injectable).
- `ui/src/spec-chat/stream-state.ts` (new) — reducer turning events into observable view state.
- `ui/src/spec-chat/activity-stream.ts` (new) — left column renderer (thinking blocks, tool rows, bubbles).
- `ui/src/spec-chat/live-spec.ts` (new) — right column renderer (ghost→typed→done) + phase spine driver.
- `ui/src/spec-chat/immersive.ts` (new) — full-screen surface shell, entrance/exit, Esc capture, composer, publish bar.
- `ui/src/spec-chat/immersive.css` (new) — ported from the mockup tokens/animations.
- `ui/src/spec-chat/tauri-event-source.ts` (new) — real `SpecEventSource` over `listen("spec://…/event")`.
- `ui/src/spec-chat/index.ts` (modify) — chooser routes Resume/Start-new → immersive; Blank → wizard.
- `ui/src/api.ts` (modify) — add `specAuthorStreamStep(draftId, userMsg, cwd)` invoke wrapper.

---

# Phase 1 — Backend streaming research agent

### Task 1: Path-safety jail

**Files:**
- Create: `crates/agent/src/spec_author/tools.rs`
- Modify: `crates/agent/src/spec_author.rs` (add `mod tools;` near top, after `const SYSTEM_PROMPT`)
- Test: inline `#[cfg(test)]` in `tools.rs`

- [ ] **Step 1: Write the failing test**

In `crates/agent/src/spec_author/tools.rs`:

```rust
//! Read-only repo tools for the streaming spec author. All file access is
//! confined to a canonicalized repo root.

use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error, PartialEq)]
pub enum ToolError {
    #[error("path escapes repo root")]
    Escape,
    #[error("path not found")]
    NotFound,
    #[error("blocked secret path")]
    Secret,
}

/// Secret directory fragments that are always rejected regardless of root.
const SECRET_FRAGMENTS: &[&str] = &[".ssh", ".aws", ".gnupg", ".config/gh"];

/// Resolve `rel` against canonical `root`, rejecting escapes and secret paths.
pub fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, ToolError> {
    unimplemented!()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        let d = std::env::temp_dir().join("spec-tools-test-root");
        std::fs::create_dir_all(d.join("src")).unwrap();
        std::fs::write(d.join("src/a.rs"), "fn main() {}").unwrap();
        std::fs::canonicalize(&d).unwrap()
    }

    #[test]
    fn allows_path_inside_root() {
        let r = root();
        assert_eq!(safe_join(&r, "src/a.rs").unwrap(), r.join("src/a.rs"));
    }

    #[test]
    fn rejects_parent_escape() {
        let r = root();
        assert_eq!(safe_join(&r, "../../etc/passwd").unwrap_err(), ToolError::Escape);
    }

    #[test]
    fn rejects_absolute_outside() {
        let r = root();
        assert_eq!(safe_join(&r, "/etc/passwd").unwrap_err(), ToolError::Escape);
    }

    #[test]
    fn rejects_secret_fragment() {
        let r = root();
        assert_eq!(safe_join(&r, ".ssh/id_rsa").unwrap_err(), ToolError::Secret);
    }

    #[test]
    fn missing_path_errors() {
        let r = root();
        assert_eq!(safe_join(&r, "src/nope.rs").unwrap_err(), ToolError::NotFound);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p karl_agent spec_author::tools::tests -- --nocapture`
Expected: FAIL — `safe_join` calls `unimplemented!()` (panics).

- [ ] **Step 3: Write minimal implementation**

Replace the `safe_join` body:

```rust
pub fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, ToolError> {
    let rel_norm = rel.replace('\\', "/");
    if SECRET_FRAGMENTS.iter().any(|f| rel_norm.contains(f)) {
        return Err(ToolError::Secret);
    }
    let candidate = if Path::new(&rel_norm).is_absolute() {
        PathBuf::from(&rel_norm)
    } else {
        root.join(&rel_norm)
    };
    let canon = std::fs::canonicalize(&candidate).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => ToolError::NotFound,
        _ => ToolError::Escape,
    })?;
    if !canon.starts_with(root) {
        return Err(ToolError::Escape);
    }
    Ok(canon)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p karl_agent spec_author::tools::tests`
Expected: PASS (5 tests).

- [ ] **Step 5: Add module declaration**

In `crates/agent/src/spec_author.rs`, immediately after line 14 (`const SYSTEM_PROMPT…`):

```rust
pub mod tools;
pub mod stream;
```

(`stream` is created in Task 4; until then add only `pub mod tools;` and add `pub mod stream;` in Task 4.)

- [ ] **Step 6: Commit**

```bash
git add crates/agent/src/spec_author/tools.rs crates/agent/src/spec_author.rs
git commit -m "feat(spec-author): repo-jailed path safety for read-only tools"
```

---

### Task 2: Tool executors (grep / read_file / list_dir)

**Files:**
- Modify: `crates/agent/src/spec_author/tools.rs`
- Test: inline `#[cfg(test)]`

- [ ] **Step 1: Write the failing test**

Append to `tools.rs` (above the existing `mod tests` close — add new test fns inside it):

```rust
// add inside `mod tests`:
    #[test]
    fn read_file_returns_lines_with_range() {
        let r = root();
        let out = read_file(&r, "src/a.rs", None).unwrap();
        assert!(out.contains("fn main"));
    }

    #[test]
    fn read_file_caps_bytes() {
        let r = root();
        let big = "x".repeat(50_000);
        std::fs::write(r.join("src/big.txt"), &big).unwrap();
        let out = read_file(&r, "src/big.txt", None).unwrap();
        assert!(out.len() <= 32_768, "got {}", out.len());
    }

    #[test]
    fn grep_counts_matches() {
        let r = root();
        let hits = grep(&r, "fn main", Some("src")).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].contains("a.rs"));
    }

    #[test]
    fn list_dir_lists_entries() {
        let r = root();
        let entries = list_dir(&r, "src").unwrap();
        assert!(entries.iter().any(|e| e.ends_with("a.rs")));
    }
```

And declare the signatures (with `unimplemented!()`) above `mod tests`:

```rust
/// Read a file (jailed). Optional `range` = "start-end" 1-based line range.
/// Output is byte-capped at 32 KiB.
pub fn read_file(root: &Path, rel: &str, range: Option<&str>) -> Result<String, ToolError> {
    unimplemented!()
}

/// Literal-substring grep over files under `dir` (default whole root).
/// Returns up to 50 `path:line: text` hit strings.
pub fn grep(root: &Path, needle: &str, dir: Option<&str>) -> Result<Vec<String>, ToolError> {
    unimplemented!()
}

/// List immediate entries of a directory (jailed), dirs suffixed with `/`.
pub fn list_dir(root: &Path, rel: &str) -> Result<Vec<String>, ToolError> {
    unimplemented!()
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p karl_agent spec_author::tools::tests`
Expected: FAIL — `unimplemented!()` panics.

- [ ] **Step 3: Write minimal implementation**

Replace the three bodies:

```rust
const READ_CAP: usize = 32_768;

pub fn read_file(root: &Path, rel: &str, range: Option<&str>) -> Result<String, ToolError> {
    let path = safe_join(root, rel)?;
    let text = std::fs::read_to_string(&path).map_err(|_| ToolError::NotFound)?;
    let sliced = match range.and_then(parse_range) {
        Some((start, end)) => text
            .lines()
            .skip(start.saturating_sub(1))
            .take(end.saturating_sub(start) + 1)
            .collect::<Vec<_>>()
            .join("\n"),
        None => text,
    };
    Ok(sliced.chars().take(READ_CAP).collect())
}

fn parse_range(r: &str) -> Option<(usize, usize)> {
    let (a, b) = r.split_once('-')?;
    Some((a.trim().parse().ok()?, b.trim().parse().ok()?))
}

pub fn grep(root: &Path, needle: &str, dir: Option<&str>) -> Result<Vec<String>, ToolError> {
    let base = match dir {
        Some(d) => safe_join(root, d)?,
        None => root.to_path_buf(),
    };
    let mut hits = Vec::new();
    let walker = walk(&base);
    for file in walker {
        if hits.len() >= 50 {
            break;
        }
        let Ok(text) = std::fs::read_to_string(&file) else { continue };
        for (i, line) in text.lines().enumerate() {
            if line.contains(needle) {
                let rel = file.strip_prefix(root).unwrap_or(&file).display();
                hits.push(format!("{}:{}: {}", rel, i + 1, line.trim()));
                if hits.len() >= 50 {
                    break;
                }
            }
        }
    }
    Ok(hits)
}

pub fn list_dir(root: &Path, rel: &str) -> Result<Vec<String>, ToolError> {
    let path = safe_join(root, rel)?;
    let mut out = Vec::new();
    for e in std::fs::read_dir(&path).map_err(|_| ToolError::NotFound)? {
        let Ok(e) = e else { continue };
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        out.push(if is_dir { format!("{}/", name) } else { name });
    }
    out.sort();
    Ok(out)
}

/// Recursive file walk, skipping dotdirs, target/, node_modules/. Bounded.
fn walk(base: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut stack = vec![base.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if files.len() > 5000 {
            break;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name == "target" || name == "node_modules" {
                continue;
            }
            let p = e.path();
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                stack.push(p);
            } else {
                files.push(p);
            }
        }
    }
    files
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p karl_agent spec_author::tools::tests`
Expected: PASS (9 tests total).

- [ ] **Step 5: Commit**

```bash
git add crates/agent/src/spec_author/tools.rs
git commit -m "feat(spec-author): grep/read_file/list_dir read-only tool executors"
```

---

### Task 3: Tool dispatch (name + JSON args → result string)

**Files:**
- Modify: `crates/agent/src/spec_author/tools.rs`
- Test: inline

- [ ] **Step 1: Write the failing test**

Add to `tools.rs` (signature above `mod tests`):

```rust
use serde_json::Value;

/// JSON tool schemas for the Anthropic `tools` request field.
pub fn tool_specs() -> Value {
    unimplemented!()
}

/// Execute a tool call by name with JSON `input`; returns (result_text, summary).
pub fn run_tool(root: &Path, name: &str, input: &Value) -> (String, String) {
    unimplemented!()
}
```

Add tests inside `mod tests`:

```rust
    #[test]
    fn run_tool_grep_summarizes() {
        let r = root();
        let (text, summary) = run_tool(&r, "grep",
            &serde_json::json!({"needle":"fn main","dir":"src"}));
        assert!(text.contains("a.rs"));
        assert_eq!(summary, "1 match");
    }

    #[test]
    fn run_tool_unknown_is_error() {
        let r = root();
        let (text, summary) = run_tool(&r, "rm", &serde_json::json!({}));
        assert_eq!(summary, "error");
        assert!(text.contains("unknown tool"));
    }

    #[test]
    fn tool_specs_lists_three_tools() {
        let specs = tool_specs();
        assert_eq!(specs.as_array().unwrap().len(), 3);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p karl_agent spec_author::tools::tests`
Expected: FAIL — `unimplemented!()`.

- [ ] **Step 3: Write minimal implementation**

```rust
pub fn tool_specs() -> Value {
    serde_json::json!([
        {
            "name": "grep",
            "description": "Literal substring search across repo files. Returns up to 50 path:line hits.",
            "input_schema": { "type": "object",
                "properties": { "needle": {"type":"string"}, "dir": {"type":"string"} },
                "required": ["needle"] }
        },
        {
            "name": "read_file",
            "description": "Read a repo file. Optional 1-based line range 'start-end'. Capped at 32KiB.",
            "input_schema": { "type": "object",
                "properties": { "path": {"type":"string"}, "range": {"type":"string"} },
                "required": ["path"] }
        },
        {
            "name": "list_dir",
            "description": "List immediate entries of a repo directory.",
            "input_schema": { "type": "object",
                "properties": { "path": {"type":"string"} }, "required": ["path"] }
        }
    ])
}

fn pluralize(n: usize, noun: &str) -> String {
    format!("{} {}{}", n, noun, if n == 1 { "" } else { "s" })
}

pub fn run_tool(root: &Path, name: &str, input: &Value) -> (String, String) {
    let s = |k: &str| input.get(k).and_then(|v| v.as_str());
    match name {
        "grep" => match grep(root, s("needle").unwrap_or(""), s("dir")) {
            Ok(hits) => (hits.join("\n"), pluralize(hits.len(), "match")),
            Err(e) => (format!("error: {e}"), "error".into()),
        },
        "read_file" => match read_file(root, s("path").unwrap_or(""), s("range")) {
            Ok(text) => (text, "read".into()),
            Err(e) => (format!("error: {e}"), "error".into()),
        },
        "list_dir" => match list_dir(root, s("path").unwrap_or("")) {
            Ok(entries) => (entries.join("\n"), pluralize(entries.len(), "entry")),
            Err(e) => (format!("error: {e}"), "error".into()),
        },
        other => (format!("unknown tool: {other}"), "error".into()),
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p karl_agent spec_author::tools::tests`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/agent/src/spec_author/tools.rs
git commit -m "feat(spec-author): tool dispatch + Anthropic tool schemas"
```

---

### Task 4: Stream event type + sink trait

**Files:**
- Create: `crates/agent/src/spec_author/stream.rs`
- Modify: `crates/agent/src/spec_author.rs` (ensure `pub mod stream;` present from Task 1 Step 5)
- Test: inline

- [ ] **Step 1: Write the failing test**

`crates/agent/src/spec_author/stream.rs`:

```rust
//! Streaming tool-loop for the premium spec author.

use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SpecStreamEvent {
    ThinkingDelta { text: String },
    TextDelta { text: String },
    ToolStart { id: String, tool: String, arg: String },
    ToolResult { id: String, summary: String, ok: bool },
    SectionUpdate { section: String, markdown: String, status: String },
    Phase { section: String },
    TurnDone { awaiting_user: bool },
    Final { markdown: String },
    Error { message: String },
}

/// Callback sink the dispatcher pushes events into.
pub trait StreamSink: Send + Sync {
    fn emit(&self, event: SpecStreamEvent);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct VecSink(Mutex<Vec<SpecStreamEvent>>);
    impl StreamSink for VecSink {
        fn emit(&self, e: SpecStreamEvent) { self.0.lock().unwrap().push(e); }
    }

    #[test]
    fn event_serializes_snake_case_tag() {
        let e = SpecStreamEvent::ToolStart {
            id: "1".into(), tool: "grep".into(), arg: "fn main".into() };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["kind"], "tool_start");
        assert_eq!(v["tool"], "grep");
    }

    #[test]
    fn sink_collects() {
        let sink = VecSink(Mutex::new(vec![]));
        sink.emit(SpecStreamEvent::TurnDone { awaiting_user: true });
        assert_eq!(sink.0.lock().unwrap().len(), 1);
    }
}
```

- [ ] **Step 2: Run test to verify it fails (or compiles)**

Run: `cargo test -p karl_agent spec_author::stream::tests`
Expected: PASS (this task is pure type+trait; it should compile and pass). If `pub mod stream;` is missing, FAIL to compile — add it to `spec_author.rs`.

- [ ] **Step 3: (no impl needed — verify)**

The types above are the implementation. Confirm `spec_author.rs` has `pub mod stream;`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p karl_agent spec_author::stream::tests`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/agent/src/spec_author/stream.rs crates/agent/src/spec_author.rs
git commit -m "feat(spec-author): SpecStreamEvent + StreamSink trait"
```

---

### Task 5: Streaming dispatcher trait + tool-loop (`step_streaming`) with a mock

**Files:**
- Modify: `crates/agent/src/spec_author/stream.rs`
- Test: inline (mock dispatcher; no network)

This task implements the loop logic and tests it against a scripted mock so the agentic worker never needs a live API key.

- [ ] **Step 1: Write the failing test**

Add to `stream.rs` (above `mod tests`):

```rust
use crate::spec_author::{tools, DraftMessage, MessageRole, SpecDraft, DraftStatus, Phase};
use async_trait::async_trait;
use std::path::Path;

/// One model turn's parsed output from a streaming response.
pub struct ModelTurn {
    /// Tool calls the model requested this turn (empty = it answered).
    pub tool_calls: Vec<ToolCall>,
    /// Assistant prose accumulated this turn.
    pub text: String,
    /// True if the text contained a closed <spec>…</spec>.
    pub emitted_spec: Option<String>,
}

#[derive(Clone)]
pub struct ToolCall { pub id: String, pub name: String, pub input: serde_json::Value }

/// Streams one model turn, pushing thinking/text/tool events into `sink` as they
/// arrive, and returns the parsed turn. `tool_results` carries prior tool output
/// to feed back (Anthropic tool_result blocks).
#[async_trait]
pub trait StreamingDispatcher: Send + Sync {
    async fn stream_turn(
        &self,
        system: &str,
        messages: &[DraftMessage],
        sink: &dyn StreamSink,
    ) -> Result<ModelTurn, String>;
}

/// Run the agentic tool-loop for one user message: repeatedly stream a turn,
/// execute any tool calls (emitting tool_start/tool_result), feed results back,
/// until the model answers or emits a spec. Enforces `max_tool_calls`.
pub async fn step_streaming<D: StreamingDispatcher>(
    dispatcher: &D,
    draft: &mut SpecDraft,
    user_msg: String,
    repo_root: &Path,
    system: &str,
    sink: &dyn StreamSink,
    max_tool_calls: usize,
) -> Result<(), String> {
    unimplemented!()
}
```

Test inside `mod tests`:

```rust
    use crate::spec_author::{SpecDraft, DraftStatus, Phase};
    use ulid::Ulid;

    // Mock: first turn requests one grep; second turn answers with text.
    struct ScriptedDispatcher { calls: Mutex<usize> }
    #[async_trait]
    impl StreamingDispatcher for ScriptedDispatcher {
        async fn stream_turn(&self, _sys: &str, _msgs: &[DraftMessage], sink: &dyn StreamSink)
            -> Result<ModelTurn, String> {
            let mut n = self.calls.lock().unwrap();
            *n += 1;
            if *n == 1 {
                sink.emit(SpecStreamEvent::ThinkingDelta { text: "looking".into() });
                Ok(ModelTurn {
                    tool_calls: vec![ToolCall { id: "t1".into(), name: "list_dir".into(),
                        input: serde_json::json!({"path":"."}) }],
                    text: String::new(), emitted_spec: None })
            } else {
                sink.emit(SpecStreamEvent::TextDelta { text: "What's the goal?".into() });
                Ok(ModelTurn { tool_calls: vec![], text: "What's the goal?".into(),
                    emitted_spec: None })
            }
        }
    }

    fn fresh_draft() -> SpecDraft {
        SpecDraft { id: Ulid::new(), messages: vec![], partial_md: None,
            last_updated: chrono::Utc::now(),
            status: DraftStatus::InProgress { phase: Phase::Goal } }
    }

    #[tokio::test]
    async fn loop_executes_tool_then_answers() {
        let root = std::env::temp_dir();
        let sink = VecSink(Mutex::new(vec![]));
        let mut draft = fresh_draft();
        let disp = ScriptedDispatcher { calls: Mutex::new(0) };
        step_streaming(&disp, &mut draft, "hi".into(), &root, "sys", &sink, 40).await.unwrap();
        let events = sink.0.lock().unwrap();
        // expect a tool_start, a tool_result, a text_delta, and a turn_done
        assert!(events.iter().any(|e| matches!(e, SpecStreamEvent::ToolStart { .. })));
        assert!(events.iter().any(|e| matches!(e, SpecStreamEvent::ToolResult { .. })));
        assert!(events.iter().any(|e| matches!(e, SpecStreamEvent::TurnDone { awaiting_user: true })));
        // user + assistant messages recorded
        assert!(draft.messages.len() >= 2);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p karl_agent spec_author::stream::tests::loop_executes_tool_then_answers`
Expected: FAIL — `unimplemented!()`.

- [ ] **Step 3: Write minimal implementation**

Replace `step_streaming` body:

```rust
pub async fn step_streaming<D: StreamingDispatcher>(
    dispatcher: &D,
    draft: &mut SpecDraft,
    user_msg: String,
    repo_root: &Path,
    system: &str,
    sink: &dyn StreamSink,
    max_tool_calls: usize,
) -> Result<(), String> {
    draft.messages.push(DraftMessage { role: MessageRole::User, content: user_msg });
    let mut tool_budget = max_tool_calls;

    loop {
        let turn = dispatcher.stream_turn(system, &draft.messages, sink).await?;

        if !turn.text.is_empty() {
            draft.messages.push(DraftMessage {
                role: MessageRole::Assistant, content: turn.text.clone() });
        }

        if let Some(md) = turn.emitted_spec {
            if crate::spec_author::validate_spec_markdown(&md).is_ok() {
                draft.partial_md = Some(md.clone());
                draft.status = DraftStatus::Ready;
                sink.emit(SpecStreamEvent::Final { markdown: md });
                return Ok(());
            }
        }

        if turn.tool_calls.is_empty() {
            sink.emit(SpecStreamEvent::TurnDone { awaiting_user: true });
            return Ok(());
        }

        // Execute tools, feed results back as a synthetic user message.
        let mut feedback = String::new();
        for call in turn.tool_calls {
            if tool_budget == 0 {
                sink.emit(SpecStreamEvent::Error {
                    message: "tool-call budget exhausted".into() });
                sink.emit(SpecStreamEvent::TurnDone { awaiting_user: true });
                return Ok(());
            }
            tool_budget -= 1;
            let arg = call.input.to_string();
            sink.emit(SpecStreamEvent::ToolStart {
                id: call.id.clone(), tool: call.name.clone(), arg });
            let (result, summary) = tools::run_tool(repo_root, &call.name, &call.input);
            sink.emit(SpecStreamEvent::ToolResult {
                id: call.id.clone(), summary, ok: !result.starts_with("error") });
            feedback.push_str(&format!("[tool {} → {}]\n{}\n\n", call.name, call.id, result));
        }
        draft.messages.push(DraftMessage { role: MessageRole::User, content: feedback });
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p karl_agent spec_author::stream::tests`
Expected: PASS.

- [ ] **Step 5: Add a budget-exhaustion test**

Add inside `mod tests`:

```rust
    struct AlwaysToolDispatcher;
    #[async_trait]
    impl StreamingDispatcher for AlwaysToolDispatcher {
        async fn stream_turn(&self, _s: &str, _m: &[DraftMessage], _sink: &dyn StreamSink)
            -> Result<ModelTurn, String> {
            Ok(ModelTurn { tool_calls: vec![ToolCall { id: "x".into(),
                name: "list_dir".into(), input: serde_json::json!({"path":"."}) }],
                text: String::new(), emitted_spec: None })
        }
    }

    #[tokio::test]
    async fn budget_exhaustion_terminates() {
        let sink = VecSink(Mutex::new(vec![]));
        let mut draft = fresh_draft();
        step_streaming(&AlwaysToolDispatcher, &mut draft, "hi".into(),
            &std::env::temp_dir(), "sys", &sink, 2).await.unwrap();
        let events = sink.0.lock().unwrap();
        assert!(events.iter().any(|e| matches!(e, SpecStreamEvent::Error { .. })));
    }
```

Run: `cargo test -p karl_agent spec_author::stream::tests`
Expected: PASS (loop terminates, no infinite loop).

- [ ] **Step 6: Commit**

```bash
git add crates/agent/src/spec_author/stream.rs
git commit -m "feat(spec-author): step_streaming agentic tool-loop with budget cap"
```

---

### Task 6: Real Anthropic streaming dispatcher (SSE + thinking + tools)

**Files:**
- Modify: `crates/agent/src/spec_author/stream.rs`
- Test: none automated (network). Manual smoke via the Tauri command in Task 7. The loop logic is already covered by Task 5's mocks.

> This task wires the real network call. There is no unit test (it requires a live key); correctness of the *loop* is covered in Task 5. Keep this struct thin: it only parses one streamed turn into `ModelTurn` and emits deltas.

- [ ] **Step 1: Implement `AnthropicStreamingDispatcher`**

Add to `stream.rs`:

```rust
use futures_util::StreamExt;

pub struct AnthropicStreamingDispatcher {
    pub api_key: String,
    pub model: String,
}

#[async_trait]
impl StreamingDispatcher for AnthropicStreamingDispatcher {
    async fn stream_turn(
        &self,
        system: &str,
        messages: &[DraftMessage],
        sink: &dyn StreamSink,
    ) -> Result<ModelTurn, String> {
        let client = reqwest::Client::new();
        let api_messages: Vec<serde_json::Value> = messages.iter().map(|m| {
            let role = match m.role { MessageRole::User => "user", MessageRole::Assistant => "assistant" };
            serde_json::json!({ "role": role, "content": m.content })
        }).collect();

        let body = serde_json::json!({
            "model": self.model,
            "max_tokens": 8192,
            "stream": true,
            "thinking": { "type": "enabled", "budget_tokens": 4000 },
            "system": [{ "type": "text", "text": system,
                "cache_control": { "type": "ephemeral" } }],
            "tools": tools::tool_specs(),
            "messages": api_messages,
        });

        let resp = client.post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body).send().await.map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
            return Err(format!("anthropic {}: {}", resp.status(),
                resp.text().await.unwrap_or_default()));
        }

        let mut stream = resp.bytes_stream();
        let mut buf = String::new();
        let mut text = String::new();
        let mut tool_calls: Vec<ToolCall> = Vec::new();
        // partial tool-input accumulation keyed by content-block index
        let mut tool_json: std::collections::HashMap<usize, (String, String, String)> =
            std::collections::HashMap::new(); // idx -> (id, name, partial_input)

        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(|e| e.to_string())?;
            buf.push_str(&String::from_utf8_lossy(&bytes));
            // SSE frames are separated by blank lines; data: lines carry JSON.
            while let Some(pos) = buf.find("\n\n") {
                let frame = buf[..pos].to_string();
                buf.drain(..pos + 2);
                for line in frame.lines() {
                    let Some(data) = line.strip_prefix("data: ") else { continue };
                    let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else { continue };
                    parse_sse_event(&v, sink, &mut text, &mut tool_json);
                }
            }
        }

        for (_idx, (id, name, raw)) in tool_json.into_iter() {
            let input = serde_json::from_str(&raw).unwrap_or(serde_json::json!({}));
            tool_calls.push(ToolCall { id, name, input });
        }
        let emitted_spec = crate::spec_author::extract_spec_pub(&text);
        Ok(ModelTurn { tool_calls, text, emitted_spec })
    }
}

fn parse_sse_event(
    v: &serde_json::Value,
    sink: &dyn StreamSink,
    text: &mut String,
    tool_json: &mut std::collections::HashMap<usize, (String, String, String)>,
) {
    match v["type"].as_str() {
        Some("content_block_start") => {
            let idx = v["index"].as_u64().unwrap_or(0) as usize;
            if v["content_block"]["type"] == "tool_use" {
                tool_json.insert(idx, (
                    v["content_block"]["id"].as_str().unwrap_or("").to_string(),
                    v["content_block"]["name"].as_str().unwrap_or("").to_string(),
                    String::new()));
            }
        }
        Some("content_block_delta") => {
            let idx = v["index"].as_u64().unwrap_or(0) as usize;
            match v["delta"]["type"].as_str() {
                Some("thinking_delta") => {
                    if let Some(t) = v["delta"]["thinking"].as_str() {
                        sink.emit(SpecStreamEvent::ThinkingDelta { text: t.to_string() });
                    }
                }
                Some("text_delta") => {
                    if let Some(t) = v["delta"]["text"].as_str() {
                        text.push_str(t);
                        sink.emit(SpecStreamEvent::TextDelta { text: t.to_string() });
                    }
                }
                Some("input_json_delta") => {
                    if let Some(partial) = v["delta"]["partial_json"].as_str() {
                        if let Some(entry) = tool_json.get_mut(&idx) { entry.2.push_str(partial); }
                    }
                }
                _ => {}
            }
        }
        _ => {}
    }
}
```

- [ ] **Step 2: Expose `extract_spec` for reuse**

In `crates/agent/src/spec_author.rs`, add a public wrapper near the private `extract_spec` (line ~490):

```rust
/// Public re-export of the `<spec>` extractor for the streaming module.
pub fn extract_spec_pub(text: &str) -> Option<String> {
    extract_spec(text)
}
```

- [ ] **Step 3: Add deps**

In `crates/agent/Cargo.toml`, ensure under `[dependencies]`:

```toml
futures-util = "0.3"
```

(reqwest already present; it needs the `stream` feature — confirm `reqwest = { version = "…", features = ["json", "stream"] }`. If `stream` is absent, add it.)

- [ ] **Step 4: Compile check**

Run: `cargo build -p karl_agent`
Expected: builds clean (no test for network path).

- [ ] **Step 5: Commit**

```bash
git add crates/agent/src/spec_author/stream.rs crates/agent/src/spec_author.rs crates/agent/Cargo.toml
git commit -m "feat(spec-author): Anthropic SSE streaming dispatcher (thinking+tools)"
```

---

### Task 7: Tauri command bridging the loop to `spec://{id}/event`

**Files:**
- Modify: `crates/app/src/lib.rs`
- Test: none automated (Tauri runtime). Manual smoke described in Step 4.

- [ ] **Step 1: Add the command**

After `spec_author_step` (line ~2734) in `lib.rs`, add:

```rust
struct TauriSink {
    app: tauri::AppHandle,
    topic: String,
}
impl karl_agent::spec_author::stream::StreamSink for TauriSink {
    fn emit(&self, event: karl_agent::spec_author::stream::SpecStreamEvent) {
        let _ = self.app.emit(&self.topic, &event);
    }
}

#[tauri::command]
async fn spec_author_stream_step(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    draft_id: Option<String>,
    user_msg: String,
    cwd: Option<String>,
) -> Result<String, String> {
    use karl_agent::spec_author as sa;
    let api_key = {
        let s = state.settings.lock().await;
        s.anthropic_api_key.clone().ok_or("no api key configured — open Settings (⌘,)")?
    };
    let base_dir = sa::home_covenant_dir().map_err(|e| e.to_string())?;

    let mut draft = match draft_id {
        Some(ref id) => sa::load_draft_default(id.parse::<Ulid>().map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?,
        None => sa::SpecDraft {
            id: Ulid::new(), messages: vec![], partial_md: None,
            last_updated: chrono::Utc::now(),
            status: sa::DraftStatus::InProgress { phase: sa::Phase::Goal },
        },
    };
    let draft_id_str = draft.id.to_string();
    let topic = format!("spec://{}/event", draft_id_str);

    // Build system prompt with repo context on first turn.
    let cwd_path = cwd.as_ref().map(std::path::PathBuf::from);
    let repo_root = cwd_path.clone()
        .and_then(|p| std::fs::canonicalize(p).ok())
        .unwrap_or_else(|| base_dir.clone());
    let system = if draft.messages.is_empty() {
        match cwd_path.as_deref().and_then(sa::build_repo_context) {
            Some(ctx) => format!("{}{}", sa::SYSTEM_PROMPT_PUB, ctx),
            None => sa::SYSTEM_PROMPT_PUB.to_string(),
        }
    } else { sa::SYSTEM_PROMPT_PUB.to_string() };

    let sink = TauriSink { app: app.clone(), topic: topic.clone() };
    let dispatcher = sa::stream::AnthropicStreamingDispatcher {
        api_key, model: "claude-opus-4-8".into(),
    };

    let result = sa::stream::step_streaming(
        &dispatcher, &mut draft, user_msg, &repo_root, &system, &sink, 40).await;

    draft.last_updated = chrono::Utc::now();
    let _ = sa::save_draft(&base_dir, &draft);

    if let Err(e) = result {
        let _ = app.emit(&topic, &sa::stream::SpecStreamEvent::Error { message: e.clone() });
        return Err(e);
    }
    Ok(draft_id_str)
}
```

- [ ] **Step 2: Expose `SYSTEM_PROMPT` and register the command**

In `crates/agent/src/spec_author.rs`, after line 14 add:

```rust
/// Public re-export of the base system prompt for the app layer.
pub const SYSTEM_PROMPT_PUB: &str = SYSTEM_PROMPT;
```

In `lib.rs`, add `spec_author_stream_step` to the `tauri::generate_handler![…]` list (search for `spec_author_step,` and add the new name beside it).

- [ ] **Step 3: Build**

Run: `cargo build -p covenant`
Expected: builds clean.

- [ ] **Step 4: Manual smoke (with a real key configured)**

Run the app (`npm run tauri:dev`), open devtools, and in the console:

```js
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
let id;
await listen('spec://placeholder/event', () => {}); // replaced below
const draftId = await invoke('spec_author_stream_step',
  { draftId: null, userMsg: 'Esc does not close my modals', cwd: '<repo path>' });
```

Better: first call returns the draftId; subscribe to `spec://${draftId}/event` *before* the call by passing a known id is not possible (id is server-minted). For the smoke, log inside a wildcard by subscribing right after mint isn't race-free — instead temporarily `console.log` every emit in the Rust sink, or accept that Phase 3 wires subscription correctly via the two-call handshake (see Task 12). For this smoke, confirm the command returns a draftId and the terminal logs show `grep`/`read` tool execution.
Expected: command resolves with a ULID; tracing shows tool calls; a draft JSON appears in `~/.covenant/spec-drafts/`.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/lib.rs crates/agent/src/spec_author.rs
git commit -m "feat(app): spec_author_stream_step bridging tool-loop to spec:// events"
```

---

# Phase 2 — Frontend immersive UI (against a mocked event source)

### Task 8: Event types + injectable source

**Files:**
- Create: `ui/src/spec-chat/events.ts`
- Test: `ui/src/spec-chat/events.test.ts` (Vitest — match the project's test runner; if none, see Step 2 note)

- [ ] **Step 1: Write the types + a mock source**

`ui/src/spec-chat/events.ts`:

```ts
export type SpecSectionKey =
  | 'goal' | 'out_of_scope' | 'acceptance' | 'file_boundaries' | 'complexity' | 'open_questions';

export type SpecStreamEvent =
  | { kind: 'thinking_delta'; text: string }
  | { kind: 'text_delta'; text: string }
  | { kind: 'tool_start'; id: string; tool: 'grep' | 'read_file' | 'list_dir'; arg: string }
  | { kind: 'tool_result'; id: string; summary: string; ok: boolean }
  | { kind: 'section_update'; section: SpecSectionKey; markdown: string; status: 'filling' | 'done' }
  | { kind: 'phase'; section: SpecSectionKey }
  | { kind: 'turn_done'; awaiting_user: boolean }
  | { kind: 'final'; markdown: string }
  | { kind: 'error'; message: string };

/** Abstraction over the event channel so the UI is testable without Tauri. */
export interface SpecEventSource {
  /** Start a turn; events arrive via the callback registered in `subscribe`. */
  send(draftId: string | null, userMsg: string, cwd: string | null): Promise<string>;
  subscribe(cb: (e: SpecStreamEvent) => void): () => void;
}

/** In-memory source that replays a scripted event list — for tests + Storybook-style preview. */
export function mockEventSource(script: SpecStreamEvent[], delayMs = 0): SpecEventSource {
  const subs = new Set<(e: SpecStreamEvent) => void>();
  return {
    subscribe(cb) { subs.add(cb); return () => subs.delete(cb); },
    async send() {
      for (const e of script) {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        subs.forEach((cb) => cb(e));
      }
      return 'mock-draft-id';
    },
  };
}
```

- [ ] **Step 2: Write the failing test**

> Check `ui/package.json` for the test runner. If `vitest` is present, use `.test.ts` as below. If the project has **no** frontend test runner, skip the automated test for UI tasks and rely on the mock-source manual preview (Task 11 Step 4); note this deviation in the commit.

`ui/src/spec-chat/events.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mockEventSource } from './events';

describe('mockEventSource', () => {
  it('replays scripted events to subscribers', async () => {
    const src = mockEventSource([
      { kind: 'phase', section: 'goal' },
      { kind: 'turn_done', awaiting_user: true },
    ]);
    const seen: string[] = [];
    src.subscribe((e) => seen.push(e.kind));
    await src.send(null, 'hi', null);
    expect(seen).toEqual(['phase', 'turn_done']);
  });
});
```

- [ ] **Step 3: Run test to verify it fails then passes**

Run: `cd ui && npx vitest run src/spec-chat/events.test.ts`
Expected: PASS (types + mock are the implementation). If it fails to find vitest, follow Step 2's note.

- [ ] **Step 4: Commit**

```bash
git add ui/src/spec-chat/events.ts ui/src/spec-chat/events.test.ts
git commit -m "feat(spec-chat): stream event types + injectable mock source"
```

---

### Task 9: Stream reducer (events → view state)

**Files:**
- Create: `ui/src/spec-chat/stream-state.ts`
- Test: `ui/src/spec-chat/stream-state.test.ts`

- [ ] **Step 1: Write the failing test**

`ui/src/spec-chat/stream-state.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createStreamState } from './stream-state';

describe('createStreamState', () => {
  it('accumulates thinking + tool activity and tracks sections', () => {
    const s = createStreamState();
    s.apply({ kind: 'phase', section: 'goal' });
    s.apply({ kind: 'thinking_delta', text: 'look' });
    s.apply({ kind: 'thinking_delta', text: 'ing' });
    s.apply({ kind: 'tool_start', id: 't1', tool: 'grep', arg: '{"needle":"x"}' });
    s.apply({ kind: 'tool_result', id: 't1', summary: '3 matches', ok: true });
    s.apply({ kind: 'section_update', section: 'goal', markdown: 'Esc closes modals', status: 'done' });
    s.apply({ kind: 'turn_done', awaiting_user: true });

    expect(s.activePhase()).toBe('goal');
    expect(s.thinking()).toBe('looking');
    expect(s.tools()).toHaveLength(1);
    expect(s.tools()[0].summary).toBe('3 matches');
    expect(s.section('goal')).toEqual({ markdown: 'Esc closes modals', status: 'done' });
    expect(s.awaitingUser()).toBe(true);
  });

  it('appends final markdown and flips ready', () => {
    const s = createStreamState();
    s.apply({ kind: 'final', markdown: '## Goal\n...' });
    expect(s.finalMarkdown()).toContain('## Goal');
    expect(s.ready()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/spec-chat/stream-state.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

`ui/src/spec-chat/stream-state.ts`:

```ts
import type { SpecStreamEvent, SpecSectionKey } from './events';

export interface ToolActivity { id: string; tool: string; arg: string; summary?: string; ok?: boolean; }
export interface SectionView { markdown: string; status: 'filling' | 'done'; }

export interface StreamState {
  apply(e: SpecStreamEvent): void;
  activePhase(): SpecSectionKey | null;
  thinking(): string;
  text(): string;
  tools(): readonly ToolActivity[];
  section(k: SpecSectionKey): SectionView | null;
  awaitingUser(): boolean;
  finalMarkdown(): string | null;
  ready(): boolean;
  error(): string | null;
  onChange(cb: () => void): () => void;
}

export function createStreamState(): StreamState {
  let phase: SpecSectionKey | null = null;
  let thinking = '';
  let text = '';
  const tools: ToolActivity[] = [];
  const sections = new Map<SpecSectionKey, SectionView>();
  let awaiting = false;
  let finalMd: string | null = null;
  let err: string | null = null;
  const subs = new Set<() => void>();
  const fire = () => subs.forEach((cb) => cb());

  return {
    apply(e) {
      switch (e.kind) {
        case 'phase': phase = e.section; break;
        case 'thinking_delta': thinking += e.text; break;
        case 'text_delta': text += e.text; break;
        case 'tool_start': tools.push({ id: e.id, tool: e.tool, arg: e.arg }); break;
        case 'tool_result': {
          const t = tools.find((x) => x.id === e.id);
          if (t) { t.summary = e.summary; t.ok = e.ok; }
          break;
        }
        case 'section_update': sections.set(e.section, { markdown: e.markdown, status: e.status }); break;
        case 'turn_done': awaiting = e.awaiting_user; break;
        case 'final': finalMd = e.markdown; break;
        case 'error': err = e.message; break;
      }
      fire();
    },
    activePhase: () => phase,
    thinking: () => thinking,
    text: () => text,
    tools: () => tools,
    section: (k) => sections.get(k) ?? null,
    awaitingUser: () => awaiting,
    finalMarkdown: () => finalMd,
    ready: () => finalMd != null,
    error: () => err,
    onChange(cb) { subs.add(cb); return () => subs.delete(cb); },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npx vitest run src/spec-chat/stream-state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/spec-chat/stream-state.ts ui/src/spec-chat/stream-state.test.ts
git commit -m "feat(spec-chat): stream reducer mapping events to view state"
```

---

### Task 10: CSS port + activity-stream & live-spec renderers

**Files:**
- Create: `ui/src/spec-chat/immersive.css` (port tokens/animations from `docs/superpowers/specs/premium-spec-creator-mockup.html`)
- Create: `ui/src/spec-chat/activity-stream.ts`
- Create: `ui/src/spec-chat/live-spec.ts`
- Test: `ui/src/spec-chat/live-spec.test.ts` (jsdom — DOM assertions, no animation timing)

> Animation/visual fidelity is verified manually against the mockup (Task 11 Step 4). Automated tests cover only the **DOM structure** the renderers produce from state.

- [ ] **Step 1: Port the CSS**

Copy the `<style>` block from the mockup into `immersive.css`, scoping selectors under a `.spec-creator` root (prefix every top-level rule). Keep the `:root` custom properties. This is a mechanical port — no logic.

- [ ] **Step 2: Write the failing test for live-spec**

`ui/src/spec-chat/live-spec.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mountLiveSpec } from './live-spec';
import { createStreamState } from './stream-state';

describe('mountLiveSpec', () => {
  let host: HTMLElement;
  beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); });

  it('renders six section cards and marks done sections', () => {
    const state = createStreamState();
    mountLiveSpec(host, state);
    expect(host.querySelectorAll('.sec').length).toBe(6);

    state.apply({ kind: 'section_update', section: 'goal', markdown: 'Esc closes', status: 'done' });
    const goal = host.querySelector('.sec[data-key="goal"]')!;
    expect(goal.classList.contains('done')).toBe(true);
    expect(goal.textContent).toContain('Esc closes');
  });

  it('marks the active phase node on the spine', () => {
    const state = createStreamState();
    mountLiveSpec(host, state);
    state.apply({ kind: 'phase', section: 'acceptance' });
    const node = host.querySelector('.node[data-key="acceptance"]')!;
    expect(node.classList.contains('active')).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ui && npx vitest run src/spec-chat/live-spec.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `live-spec.ts`**

```ts
import type { StreamState } from './stream-state';
import type { SpecSectionKey } from './events';

const SECTIONS: { key: SpecSectionKey; title: string }[] = [
  { key: 'goal', title: 'Goal' },
  { key: 'out_of_scope', title: 'Out of scope' },
  { key: 'acceptance', title: 'Acceptance criteria' },
  { key: 'file_boundaries', title: 'File boundaries' },
  { key: 'complexity', title: 'Complexity' },
  { key: 'open_questions', title: 'Open questions' },
];

export function mountLiveSpec(host: HTMLElement, state: StreamState): () => void {
  const spine = document.createElement('div');
  spine.className = 'spine';
  const spec = document.createElement('div');
  spec.className = 'spec';
  for (const s of SECTIONS) {
    const node = document.createElement('div');
    node.className = 'node'; node.dataset.key = s.key;
    node.innerHTML = `<span class="dot"></span><span class="label">${s.title}</span>`;
    spine.appendChild(node);

    const sec = document.createElement('div');
    sec.className = 'sec'; sec.dataset.key = s.key;
    sec.innerHTML = `<div class="stitle"><span class="badge"></span>${s.title}</div>`
      + `<div class="content"><div class="ghost"><span></span><span></span><span></span></div></div>`;
    spec.appendChild(sec);
  }
  host.appendChild(spine);
  host.appendChild(spec);

  const render = () => {
    const active = state.activePhase();
    spine.querySelectorAll<HTMLElement>('.node').forEach((n) =>
      n.classList.toggle('active', n.dataset.key === active));
    for (const s of SECTIONS) {
      const view = state.section(s.key);
      if (!view) continue;
      const sec = spec.querySelector<HTMLElement>(`.sec[data-key="${s.key}"]`)!;
      sec.querySelector('.content')!.textContent = view.markdown;
      sec.classList.toggle('active', s.key === active);
      sec.classList.toggle('done', view.status === 'done');
      if (view.status === 'done') sec.querySelector('.badge')!.textContent = '✓';
    }
  };
  const off = state.onChange(render);
  render();
  return () => { off(); host.removeChild(spine); host.removeChild(spec); };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ui && npx vitest run src/spec-chat/live-spec.test.ts`
Expected: PASS.

- [ ] **Step 6: Write + pass a test for `activity-stream.ts`**

`ui/src/spec-chat/activity-stream.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mountActivityStream } from './activity-stream';
import { createStreamState } from './stream-state';

describe('mountActivityStream', () => {
  let host: HTMLElement;
  beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); });

  it('renders a tool row with verb, arg and result summary', () => {
    const state = createStreamState();
    mountActivityStream(host, state);
    state.apply({ kind: 'tool_start', id: 't1', tool: 'grep', arg: '{"needle":"onKeydown"}' });
    state.apply({ kind: 'tool_result', id: 't1', summary: '4 matches', ok: true });
    const row = host.querySelector('.tool')!;
    expect(row.textContent).toContain('grep');
    expect(row.textContent).toContain('4 matches');
  });

  it('renders a thinking block', () => {
    const state = createStreamState();
    mountActivityStream(host, state);
    state.apply({ kind: 'thinking_delta', text: 'reasoning…' });
    expect(host.querySelector('.think')!.textContent).toContain('reasoning');
  });
});
```

Then implement `activity-stream.ts`:

```ts
import type { StreamState } from './stream-state';

export function mountActivityStream(host: HTMLElement, state: StreamState): () => void {
  const stream = document.createElement('div');
  stream.className = 'stream';
  host.appendChild(stream);

  let thinkEl: HTMLElement | null = null;
  const toolEls = new Map<string, HTMLElement>();

  const render = () => {
    // thinking (collapsed-but-peeking)
    const think = state.thinking();
    if (think) {
      if (!thinkEl) {
        thinkEl = document.createElement('div');
        thinkEl.className = 'think collapsed';
        thinkEl.innerHTML = `<div class="head"><span class="chev">▶</span> thinking</div><div class="body"></div>`;
        thinkEl.querySelector('.head')!.addEventListener('click', () =>
          thinkEl!.classList.toggle('collapsed'));
        stream.appendChild(thinkEl);
      }
      thinkEl.querySelector('.body')!.textContent = think;
    }
    // tool rows
    for (const t of state.tools()) {
      let row = toolEls.get(t.id);
      if (!row) {
        row = document.createElement('div');
        row.className = 'tool running';
        stream.appendChild(row);
        toolEls.set(t.id, row);
      }
      const hit = t.summary
        ? `<span class="hit">${t.summary}</span>` : '';
      row.innerHTML = `<span class="verb">${t.tool}</span> <span class="path">${t.arg}</span>${hit}`;
      row.classList.toggle('running', t.summary == null);
    }
    stream.scrollTop = stream.scrollHeight;
  };
  const off = state.onChange(render);
  render();
  return () => { off(); host.removeChild(stream); };
}
```

Run: `cd ui && npx vitest run src/spec-chat/activity-stream.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add ui/src/spec-chat/immersive.css ui/src/spec-chat/activity-stream.ts \
  ui/src/spec-chat/live-spec.ts ui/src/spec-chat/*.test.ts
git commit -m "feat(spec-chat): activity-stream + live-spec renderers (+CSS port)"
```

---

### Task 11: Immersive surface shell (entrance, composer, publish bar, Esc)

**Files:**
- Create: `ui/src/spec-chat/immersive.ts`
- Test: `ui/src/spec-chat/immersive.test.ts` (jsdom — structure + Esc + composer wiring; not animation timing)

- [ ] **Step 1: Write the failing test**

`ui/src/spec-chat/immersive.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountImmersiveSpecCreator } from './immersive';
import { mockEventSource } from './events';

describe('mountImmersiveSpecCreator', () => {
  let host: HTMLElement;
  beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); });

  it('opens with both columns and a composer', () => {
    const src = mockEventSource([]);
    mountImmersiveSpecCreator({ host, source: src, cwd: null });
    expect(host.querySelector('.left')).toBeTruthy();
    expect(host.querySelector('.right')).toBeTruthy();
    expect(host.querySelector('textarea')).toBeTruthy();
  });

  it('submitting the composer calls source.send', async () => {
    const send = vi.fn(async () => 'd1');
    const src = { send, subscribe: () => () => {} };
    const inst = mountImmersiveSpecCreator({ host, source: src, cwd: '/repo' });
    const ta = host.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'Esc broken';
    inst.submit();
    expect(send).toHaveBeenCalledWith(null, 'Esc broken', '/repo');
  });

  it('Esc triggers onClose', () => {
    const onClose = vi.fn();
    mountImmersiveSpecCreator({ host, source: mockEventSource([]), cwd: null, onClose });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/spec-chat/immersive.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `immersive.ts`**

```ts
import './immersive.css';
import type { SpecEventSource } from './events';
import { createStreamState } from './stream-state';
import { mountActivityStream } from './activity-stream';
import { mountLiveSpec } from './live-spec';

export interface ImmersiveOpts {
  host: HTMLElement;
  source: SpecEventSource;
  cwd: string | null;
  draftId?: string | null;
  onClose?: () => void;
  onPublish?: (markdown: string, draftId: string) => void;
}

export interface ImmersiveInstance { submit(): void; close(): void; }

export function mountImmersiveSpecCreator(opts: ImmersiveOpts): ImmersiveInstance {
  const state = createStreamState();
  let draftId: string | null = opts.draftId ?? null;

  const root = document.createElement('div');
  root.className = 'spec-creator';
  root.innerHTML = `
    <div class="scrim"></div>
    <div class="creator" role="dialog" aria-label="Spec Creator">
      <header>
        <div class="brand">✦ Spec Creator</div>
        <div class="spine-host" style="flex:1"></div>
        <div class="kbd">esc</div>
      </header>
      <div class="stage">
        <div class="left"><div class="col-head">Reasoning &amp; exploration</div>
          <div class="stream-host"></div>
          <div class="composer"><div class="box">
            <textarea rows="1" placeholder="Describe the problem…"></textarea>
            <button class="send">▸</button></div></div>
        </div>
        <div class="right"><div class="col-head">Specification</div>
          <div class="spec-host"></div>
          <div class="publishbar"><div class="summary"></div>
            <button class="btn primary" disabled>Review &amp; publish</button></div>
        </div>
      </div>
    </div>`;
  opts.host.appendChild(root);
  requestAnimationFrame(() => root.classList.add('open'));

  mountActivityStream(root.querySelector('.stream-host')!, state);
  mountLiveSpec(root.querySelector('.spine-host')!, state);
  // move the spine into the header host, spec into the right host:
  const spine = root.querySelector('.spine-host .spine');
  if (spine) root.querySelector('header .spine-host')?.appendChild(spine);

  const off = opts.source.subscribe((e) => state.apply(e));

  const pubBtn = root.querySelector('.btn.primary') as HTMLButtonElement;
  state.onChange(() => {
    if (state.ready()) {
      pubBtn.disabled = false;
      root.querySelector('.publishbar')!.classList.add('ready');
      (root.querySelector('.summary') as HTMLElement).textContent =
        `${state.tools().length} tool calls · ready to publish`;
    }
  });
  pubBtn.addEventListener('click', () => {
    const md = state.finalMarkdown();
    if (md && draftId) opts.onPublish?.(md, draftId);
  });

  const ta = root.querySelector('textarea') as HTMLTextAreaElement;
  const submit = () => {
    const text = ta.value.trim();
    if (!text) return;
    ta.value = '';
    opts.source.send(draftId, text, opts.cwd).then((id) => { draftId = id; });
  };
  root.querySelector('.send')!.addEventListener('click', submit);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });

  // Esc via capture-phase (works even when terminal is focused) — matches shortcuts/panel.ts.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  };
  document.addEventListener('keydown', onKey, true);

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    off();
    root.classList.remove('open');
    setTimeout(() => root.remove(), 420);
    opts.onClose?.();
  };

  return { submit, close };
}
```

- [ ] **Step 4: Run tests + manual preview**

Run: `cd ui && npx vitest run src/spec-chat/immersive.test.ts`
Expected: PASS.

Manual preview: temporarily wire a dev entry that mounts `mountImmersiveSpecCreator` with `mockEventSource(scriptedEvents, 300)` (reuse the event sequence from the mockup) and compare side-by-side with `premium-spec-creator-mockup.html`. Confirm: entrance animation, thinking peek, tool rows, sections filling, spine advancing, publish enabling. Remove the dev entry before committing.

- [ ] **Step 5: Commit**

```bash
git add ui/src/spec-chat/immersive.ts ui/src/spec-chat/immersive.test.ts
git commit -m "feat(spec-chat): immersive surface shell (entrance, composer, publish, Esc)"
```

---

# Phase 3 — Wire real backend + preserve chooser/publish flow

### Task 12: Real Tauri event source + api wrapper

**Files:**
- Create: `ui/src/spec-chat/tauri-event-source.ts`
- Modify: `ui/src/api.ts`
- Test: none automated (Tauri). Verified in Task 13 end-to-end.

> **Subscription handshake:** the backend mints the draftId, but the UI must subscribe to `spec://{id}/event` *before* events flow. Solution: for a **new** draft, the UI generates the ULID client-side and passes it as `draftId`, subscribing first. Adjust `spec_author_stream_step` to accept the client id when `draft_id` is `Some` and treat an unknown-on-disk id as a fresh draft with that id.

- [ ] **Step 1: Adjust the backend to honor a client-supplied new id**

In `lib.rs` `spec_author_stream_step`, change the draft-load arm so a `Some(id)` that fails to load becomes a fresh draft with that id:

```rust
    let mut draft = match draft_id {
        Some(ref id) => {
            let ulid = id.parse::<Ulid>().map_err(|e| e.to_string())?;
            sa::load_draft_default(ulid).unwrap_or_else(|_| sa::SpecDraft {
                id: ulid, messages: vec![], partial_md: None,
                last_updated: chrono::Utc::now(),
                status: sa::DraftStatus::InProgress { phase: sa::Phase::Goal },
            })
        }
        None => sa::SpecDraft {
            id: Ulid::new(), messages: vec![], partial_md: None,
            last_updated: chrono::Utc::now(),
            status: sa::DraftStatus::InProgress { phase: sa::Phase::Goal },
        },
    };
```

Rebuild: `cargo build -p covenant` → clean. Commit:

```bash
git add crates/app/src/lib.rs
git commit -m "feat(app): accept client-supplied draft id for pre-subscription handshake"
```

- [ ] **Step 2: Add the api wrapper**

In `ui/src/api.ts` (near the other spec wrappers, ~line 1540):

```ts
export async function specAuthorStreamStep(
  draftId: string | null, userMsg: string, cwd: string | null,
): Promise<string> {
  return invoke<string>('spec_author_stream_step', { draftId, userMsg, cwd });
}
```

- [ ] **Step 3: Implement the Tauri event source**

`ui/src/spec-chat/tauri-event-source.ts`:

```ts
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { ulid } from 'ulid'; // if not present, generate a ULID inline; see note
import type { SpecEventSource, SpecStreamEvent } from './events';
import { specAuthorStreamStep } from '../api';

/** Real source. For a new draft, mints the id client-side so we can subscribe
 *  to `spec://{id}/event` BEFORE the backend emits. */
export function tauriEventSource(initialDraftId: string | null): SpecEventSource {
  let currentId = initialDraftId;
  const subs = new Set<(e: SpecStreamEvent) => void>();
  let unlisten: UnlistenFn | null = null;
  let listenedId: string | null = null;

  async function ensureListening(id: string) {
    if (listenedId === id) return;
    if (unlisten) unlisten();
    unlisten = await listen<SpecStreamEvent>(`spec://${id}/event`, (ev) =>
      subs.forEach((cb) => cb(ev.payload)));
    listenedId = id;
  }

  return {
    subscribe(cb) { subs.add(cb); return () => subs.delete(cb); },
    async send(draftId, userMsg, cwd) {
      const id = draftId ?? currentId ?? ulid();
      currentId = id;
      await ensureListening(id);            // subscribe BEFORE backend emits
      await specAuthorStreamStep(id, userMsg, cwd);
      return id;
    },
  };
}
```

> Note: if `ulid` isn't a frontend dep, generate one inline (Crockford base32 of timestamp+random) or add the `ulid` npm package. Confirm in `ui/package.json`.

- [ ] **Step 4: Commit**

```bash
git add ui/src/spec-chat/tauri-event-source.ts ui/src/api.ts
git commit -m "feat(spec-chat): real Tauri event source with pre-subscription handshake"
```

---

### Task 13: Chooser → immersive wiring + publish/AOM preservation

**Files:**
- Modify: `ui/src/spec-chat/index.ts`
- Test: none automated; end-to-end manual verification.

- [ ] **Step 1: Inspect current chooser**

Read `ui/src/spec-chat/index.ts`. Identify where "Start a new one" / "Resume" currently call `mountSpecChatPanel`, and where "Blank draft" routes to the wizard.

- [ ] **Step 2: Route Resume/Start-new to the immersive surface**

Replace the panel-mount for those two options with:

```ts
import { mountImmersiveSpecCreator } from './immersive';
import { tauriEventSource } from './tauri-event-source';
import { specAuthorMarkPublished } from '../api';

function openImmersive(host: HTMLElement, opts: { draftId: string | null; cwd: string | null }) {
  const source = tauriEventSource(opts.draftId);
  mountImmersiveSpecCreator({
    host,
    source,
    cwd: opts.cwd,
    draftId: opts.draftId,
    onPublish: (markdown, draftId) => {
      // Reuse the existing publish path: open the wizard pre-filled to set id/slug,
      // then mark the draft published on success.
      openPublishFlow(markdown, draftId);
    },
  });
}
```

Wire "Start a new one" → `openImmersive(host, { draftId: null, cwd })` and "Resume <id>" → `openImmersive(host, { draftId: id, cwd })`. Leave "Blank draft (no chat)" pointing at the existing wizard route unchanged.

`openPublishFlow` reuses the existing draft-wizard publish entry (the same one today's `onPublishRequest` used) — pass `markdown` as the wizard's `initialBody` and call `specAuthorMarkPublished(draftId)` on success, exactly as the current chat panel does. Copy that call sequence verbatim from the current `index.ts`/`panel.ts` publish handler so detector/AOM behavior is identical.

- [ ] **Step 3: Build + typecheck**

Run: `cd ui && npm run build` (or the project's typecheck script)
Expected: no TS errors.

- [ ] **Step 4: End-to-end manual verification (real key + a git repo cwd)**

Run `npm run tauri:dev`. Open Spec Creator → "Start a new one". Type: "Esc doesn't close my modals when the terminal is focused."
Expect, in order:
1. Immersive surface animates in; workspace blurs behind.
2. Left column shows streamed thinking (collapsed-but-peeking) and real `grep`/`read_file`/`list_dir` rows with hit summaries.
3. Right column sections fill and go green; spine advances.
4. A question bubble appears; you answer; loop continues.
5. On final spec, publish bar enables → "Review & publish" opens the existing publish flow → spec lands in `docs/specs/` → AOM "Set Mission" toast appears (unchanged behavior).
6. Esc closes the surface at any point, even with the terminal focused.

- [ ] **Step 5: Commit**

```bash
git add ui/src/spec-chat/index.ts
git commit -m "feat(spec-chat): route chooser to immersive creator; preserve publish/AOM flow"
```

---

### Task 14: Prompt revision (exploration-first, tool-aware)

**Files:**
- Modify: `crates/agent/src/spec_author/prompt.md`
- Test: none (prose). Behavior verified in Task 13.

- [ ] **Step 1: Revise the prompt**

Edit `prompt.md` to:
- Instruct the agent it has read-only tools (`grep`, `read_file`, `list_dir`) and SHOULD explore the repo before asking generic questions or asserting file boundaries.
- Keep the **exact** 6-section output contract and the `<spec>…</spec>` emission rule (unchanged — the validator and `extract_spec` depend on `## Goal` … `## Open questions`).
- Tell it to emit a `section_update`-worthy summary as it locks each section (the backend currently derives sections from the final spec; if per-section live updates are desired mid-conversation, instruct the agent to restate the current section's draft text in a fenced block tagged `<!--section:goal-->…` — **optional enhancement**; the baseline fills sections from the final `<spec>` on emit).
- Preserve language-following behavior from the existing prompt.

> Baseline behavior without extra prompt machinery: sections populate on `final`. To get *live* section fills (sections appearing before the final spec), add a follow-up task to parse `<!--section:KEY-->` markers in `text_delta` accumulation and emit `SectionUpdate` from `step_streaming`. Mark this as a stretch — the core experience (thinking + tools live, sections on emit) works without it.

- [ ] **Step 2: Commit**

```bash
git add crates/agent/src/spec_author/prompt.md
git commit -m "feat(spec-author): exploration-first, tool-aware system prompt"
```

---

### Task 15: Live section fills (stretch — pulls the 'spec assembling' animation forward)

**Files:**
- Modify: `crates/agent/src/spec_author/stream.rs`, `crates/agent/src/spec_author/prompt.md`
- Test: inline unit test on the marker parser

> Without this, sections fill at `final`. With it, each section materializes as the agent locks it — matching the mockup's section-by-section assembly. Implement only after Task 13 proves the core loop.

- [ ] **Step 1: Write the failing test**

In `stream.rs` `mod tests`:

```rust
    #[test]
    fn extracts_section_markers() {
        let text = "Working on it.\n<!--section:goal-->Esc closes modals.<!--/section-->\nMore.";
        let secs = super::parse_section_markers(text);
        assert_eq!(secs, vec![("goal".to_string(), "Esc closes modals.".to_string())]);
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p karl_agent spec_author::stream::tests::extracts_section_markers`
Expected: FAIL — `parse_section_markers` undefined.

- [ ] **Step 3: Implement + emit SectionUpdate**

Add to `stream.rs`:

```rust
pub(crate) fn parse_section_markers(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("<!--section:") {
        let after = &rest[start + "<!--section:".len()..];
        let Some(key_end) = after.find("-->") else { break };
        let key = after[..key_end].to_string();
        let body = &after[key_end + 3..];
        let Some(end) = body.find("<!--/section-->") else { break };
        out.push((key, body[..end].trim().to_string()));
        rest = &body[end + "<!--/section-->".len()..];
    }
    out
}
```

In the `text_delta` accumulation path of `step_streaming`'s turn handling, after a turn's `text` is known, parse markers and emit:

```rust
        for (key, md) in parse_section_markers(&turn.text) {
            sink.emit(SpecStreamEvent::Phase { section: key.clone() });
            sink.emit(SpecStreamEvent::SectionUpdate {
                section: key, markdown: md, status: "done".into() });
        }
```

(Place this right after the `if !turn.text.is_empty()` block in `step_streaming`.)

Update `prompt.md` to instruct emitting `<!--section:KEY-->text<!--/section-->` for each locked section (KEY ∈ the six snake_case keys) during conversation.

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p karl_agent spec_author::stream::tests`
Expected: PASS.

- [ ] **Step 5: Re-run end-to-end (Task 13 Step 4)** and confirm sections now fill mid-conversation.

- [ ] **Step 6: Commit**

```bash
git add crates/agent/src/spec_author/stream.rs crates/agent/src/spec_author/prompt.md
git commit -m "feat(spec-author): live per-section fills via section markers"
```

---

## Self-Review notes (already folded into tasks)

- **Spec coverage:** immersive takeover (T11), thinking/tools live (T6/T10), live spec (T10/T15), phase spine (T10), publish/AOM preserved (T13), read-only jailed tools (T1–T3), token/tool caps (T5 budget), Opus 4.8 + thinking (T6/T7), chooser preserved + Blank→wizard (T13), Esc capture-phase (T11). Entrance/publish animations are CSS in the ported stylesheet (T10/T11), verified manually vs. the mockup.
- **Type consistency:** `SpecStreamEvent` snake_case tags identical across Rust (T4) and TS (T8); `SpecSectionKey` values identical; `step_streaming` signature stable from T5 onward; `run_tool`/`tool_specs` names consistent T3→T6.
- **Open questions from the spec** (interruptibility, nested-modal layering, thinking persistence, cap UX) are deliberately deferred — current plan: atomic turns with an Esc/stop close, publish flow reuses the wizard (no nested modal inside the surface), thinking is ephemeral (not persisted), tool cap surfaces an `error` event + `turn_done`. Revisit after T13 if you want richer handling.
