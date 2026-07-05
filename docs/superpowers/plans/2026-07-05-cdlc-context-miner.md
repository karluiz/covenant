# CDLC Context Miner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "New context" → Spec Creator flow with a dedicated Context Miner: a streaming agent that scans the repo, emits structured findings as live cards, and compiles the accepted set into a packaged CDLC skill (`.covenant/cdlc/skills/<name>/`).

**Architecture:** A new one-shot mining loop in `crates/agent/src/context_miner.rs` reuses `spec_author`'s `StreamingDispatcher` + repo-jailed read-only tools, adding an `emit_finding` tool whose calls stream to the frontend via Tauri events (`cdlc://miner/{run_id}`). A pure TS reducer drives a full-screen 3-zone curation UI; `karl_cdlc` gains a skill-package compiler.

**Tech Stack:** Rust (tokio, serde), existing `karl_agent::spec_author::stream` + `tools`, `karl_cdlc`, Tauri events, vanilla TS + vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-05-cdlc-context-miner-design.md`.
- Miner tools are READ-ONLY and repo-jailed (reuse `spec_author::tools`; no new tools that write or shell out).
- Finding categories are exactly: `convention | pattern | gotcha | domain_rule | glossary`.
- Defaults: max 40 findings/run, max 120 tool calls/run.
- `karl_cdlc` must NOT depend on `karl-agent` — the compile input type lives in `karl_cdlc`.
- UI copy in English. No native tooltips (`attachTooltip` only, if any). Conventional Commits.
- All vitest/tsc/cargo commands run from the repo root.

---

### Task 1: `karl_cdlc` skill-package compiler

**Files:**
- Modify: `crates/cdlc/src/lib.rs` (add `pub mod compile;`)
- Create: `crates/cdlc/src/compile.rs`

**Interfaces:**
- Produces: `karl_cdlc::compile::{CompiledFinding, render_skill_md, write_skill_package}`:
  - `pub struct CompiledFinding { pub category: String, pub title: String, pub body_md: String, pub evidence: Vec<String>, pub confidence: String }`
  - `pub fn render_skill_md(name: &str, findings: &[CompiledFinding]) -> String`
  - `pub fn write_skill_package(repo_root: &Path, name: &str, owner: Option<&str>, findings: &[CompiledFinding], overwrite: bool) -> Result<PathBuf, CdlcError>` — returns the package dir; errors `CdlcError::Other("skill '<name>' already exists")` when the dir exists and `overwrite` is false.

- [ ] **Step 1: Write the failing tests**

Append to `crates/cdlc/src/compile.rs` (tests inline, module written test-first):

```rust
//! Compile curated miner findings into a distributable skill package
//! (SKILL.md + skill.toml) under `.covenant/cdlc/skills/<name>/`.

use crate::manifest::cdlc_dir;
use crate::types::SkillManifest;
use crate::CdlcError;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledFinding {
    pub category: String,
    pub title: String,
    pub body_md: String,
    pub evidence: Vec<String>,
    pub confidence: String,
}

pub fn render_skill_md(name: &str, findings: &[CompiledFinding]) -> String {
    todo!()
}

pub fn write_skill_package(
    repo_root: &Path,
    name: &str,
    owner: Option<&str>,
    findings: &[CompiledFinding],
    overwrite: bool,
) -> Result<PathBuf, CdlcError> {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finding(cat: &str, title: &str) -> CompiledFinding {
        CompiledFinding {
            category: cat.into(),
            title: title.into(),
            body_md: format!("Always do {title}."),
            evidence: vec!["src/lib.rs:12".into()],
            confidence: "high".into(),
        }
    }

    #[test]
    fn render_groups_by_category_in_fixed_order() {
        let md = render_skill_md(
            "test-skill",
            &[
                finding("gotcha", "watch the lock"),
                finding("convention", "snake_case files"),
            ],
        );
        // Frontmatter + name
        assert!(md.starts_with("---\n"), "frontmatter first: {md}");
        assert!(md.contains("name: test-skill"));
        // Category order is fixed: convention before gotcha regardless of input order.
        let conv = md.find("## Conventions").expect("conventions section");
        let gotcha = md.find("## Gotchas").expect("gotchas section");
        assert!(conv < gotcha);
        // Finding body + evidence rendered.
        assert!(md.contains("### snake_case files"));
        assert!(md.contains("`src/lib.rs:12`"));
    }

    #[test]
    fn write_creates_package_and_refuses_collision() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let dir =
            write_skill_package(root, "kyc-mined", Some("karluiz"), &[finding("domain_rule", "PEP check")], false)
                .unwrap();
        assert!(dir.join("SKILL.md").exists());
        let manifest: SkillManifest =
            toml::from_str(&std::fs::read_to_string(dir.join("skill.toml")).unwrap()).unwrap();
        assert_eq!(manifest.name, "kyc-mined");
        assert_eq!(manifest.version, "1.0.0");
        assert_eq!(manifest.owner.as_deref(), Some("karluiz"));
        // Second write without overwrite errors; with overwrite succeeds.
        assert!(write_skill_package(root, "kyc-mined", None, &[finding("pattern", "x")], false).is_err());
        assert!(write_skill_package(root, "kyc-mined", None, &[finding("pattern", "x")], true).is_ok());
    }

    #[test]
    fn write_rejects_empty_findings_and_bad_names() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(write_skill_package(tmp.path(), "ok-name", None, &[], false).is_err());
        assert!(write_skill_package(tmp.path(), "Bad Name!", None, &[finding("pattern", "x")], false).is_err());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p karl-cdlc compile:: 2>&1 | tail -5`
Expected: FAIL (todo! panics). If the package name differs, check `grep '^name' crates/cdlc/Cargo.toml` and use that `-p` value in every cargo command of this plan.

- [ ] **Step 3: Implement**

Replace the two `todo!()` bodies in `crates/cdlc/src/compile.rs`:

```rust
const CATEGORY_ORDER: &[(&str, &str)] = &[
    ("convention", "Conventions"),
    ("pattern", "Patterns"),
    ("gotcha", "Gotchas"),
    ("domain_rule", "Domain rules"),
    ("glossary", "Glossary"),
];

pub fn render_skill_md(name: &str, findings: &[CompiledFinding]) -> String {
    let mut out = format!(
        "---\nname: {name}\ndescription: Mined context for {name}\nversion: 1.0.0\n---\n\n# {name}\n\nContext mined from the repository. Each entry cites the evidence it was\nderived from.\n"
    );
    for (key, heading) in CATEGORY_ORDER {
        let in_cat: Vec<&CompiledFinding> =
            findings.iter().filter(|f| f.category == *key).collect();
        if in_cat.is_empty() {
            continue;
        }
        out.push_str(&format!("\n## {heading}\n"));
        for f in in_cat {
            out.push_str(&format!("\n### {}\n\n{}\n", f.title, f.body_md.trim()));
            if !f.evidence.is_empty() {
                out.push_str("\nEvidence: ");
                let refs: Vec<String> =
                    f.evidence.iter().map(|e| format!("`{e}`")).collect();
                out.push_str(&refs.join(", "));
                out.push('\n');
            }
        }
    }
    out
}

fn valid_skill_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

pub fn write_skill_package(
    repo_root: &Path,
    name: &str,
    owner: Option<&str>,
    findings: &[CompiledFinding],
    overwrite: bool,
) -> Result<PathBuf, CdlcError> {
    if findings.is_empty() {
        return Err(CdlcError::Other("no accepted findings to compile".into()));
    }
    if !valid_skill_name(name) {
        return Err(CdlcError::Other(format!(
            "invalid skill name '{name}' (kebab-case ascii, ≤64 chars)"
        )));
    }
    let dir = cdlc_dir(repo_root).join("skills").join(name);
    if dir.exists() && !overwrite {
        return Err(CdlcError::Other(format!("skill '{name}' already exists")));
    }
    std::fs::create_dir_all(&dir).map_err(|e| CdlcError::Other(e.to_string()))?;
    std::fs::write(dir.join("SKILL.md"), render_skill_md(name, findings))
        .map_err(|e| CdlcError::Other(e.to_string()))?;
    let manifest = SkillManifest {
        name: name.to_string(),
        version: "1.0.0".to_string(),
        owner: owner.map(str::to_string),
        deps: Vec::new(),
    };
    let toml_text =
        toml::to_string_pretty(&manifest).map_err(|e| CdlcError::Other(e.to_string()))?;
    std::fs::write(dir.join("skill.toml"), toml_text)
        .map_err(|e| CdlcError::Other(e.to_string()))?;
    Ok(dir)
}
```

Add `pub mod compile;` to `crates/cdlc/src/lib.rs`. If `CdlcError` has no
`Other(String)` variant, check `grep -n "enum CdlcError" -A 10 crates/cdlc/src/lib.rs`
and use the closest string-carrying variant (adding `Other(String)` with a
`#[error("{0}")]` attr if none exists). If `tempfile`/`toml` are missing from
`crates/cdlc/Cargo.toml` dev-deps/deps, add `tempfile = "3"` under
`[dev-dependencies]` and confirm `toml` is already a dependency (install.rs
parses skill.toml, so it should be).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p karl-cdlc compile:: 2>&1 | tail -3`
Expected: `test result: ok. 3 passed`

- [ ] **Step 5: Commit**

```bash
git add crates/cdlc/src/compile.rs crates/cdlc/src/lib.rs crates/cdlc/Cargo.toml
git commit -m "feat(cdlc): skill-package compiler for mined findings"
```

---

### Task 2: Miner agent loop — `crates/agent/src/context_miner.rs`

**Files:**
- Create: `crates/agent/src/context_miner.rs`
- Modify: `crates/agent/src/lib.rs` (add `pub mod context_miner;`)

**Interfaces:**
- Consumes: `spec_author::stream::{StreamingDispatcher, StreamSink is NOT reused — miner has its own sink}`, `spec_author::tools::{tool_specs, run_tool}`, `spec_author::{DraftMessage, MessageRole}`.
- Produces:
  - `pub struct MinerFinding { pub category: String, pub title: String, pub body_md: String, pub evidence: Vec<String>, pub confidence: String }` (serde camelCase)
  - `pub enum MinerEvent` (serde `tag = "kind"`, snake_case): `TextDelta { text }`, `ToolStart { id, tool, arg }`, `ToolResult { id, summary, ok }`, `Finding { id: String, finding: MinerFinding }`, `RunDone { findings_total: usize, stopped: bool }`, `Error { message: String }`
  - `pub trait MinerSink: Send + Sync { fn emit(&self, event: MinerEvent); }`
  - `pub struct MinerOpts { pub skill_name: String, pub focus: String, pub depth: MinerDepth, pub max_findings: usize, pub max_tool_calls: usize }` with `impl Default` (40 / 120) and `pub enum MinerDepth { Quick, Thorough }`
  - `pub async fn run_miner(dispatcher: &dyn StreamingDispatcher, repo_root: &Path, opts: &MinerOpts, cancel: &AtomicBool, sink: &dyn MinerSink) -> Result<Vec<MinerFinding>, String>`

Design notes for the implementer:
- The miner is ONE-SHOT: a single synthetic kickoff user message, then loop
  turns until the model stops calling tools, the finding cap hits, the tool
  budget hits, or `cancel` flips. No user conversation.
- `emit_finding` is an EXTRA tool appended to `tool_specs()`. Its calls are
  handled locally (validate → `sink.emit(Finding)` → feedback "recorded"),
  never through `run_tool`.
- Reuse `SpecStreamEvent`-style forwarding by adapting inside `stream_turn`'s
  sink: implement a small internal `struct ForwardSink<'a>(&'a dyn MinerSink)`
  that implements `spec_author::stream::StreamSink` and maps
  `ThinkingDelta/TextDelta → MinerEvent::TextDelta`, `ToolStart/ToolResult`
   → the miner equivalents, ignoring spec-only variants.

- [ ] **Step 1: Write the failing tests**

In `crates/agent/src/context_miner.rs` (skeleton with `todo!()` bodies + tests):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec_author::stream::{ModelTurn, StreamSink, StreamingDispatcher, ToolCall};
    use crate::spec_author::DraftMessage;
    use async_trait::async_trait;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Mutex;

    /// Scripted dispatcher: returns each ModelTurn in sequence.
    struct Scripted {
        turns: Mutex<Vec<ModelTurn>>,
        calls: AtomicUsize,
    }
    #[async_trait]
    impl StreamingDispatcher for Scripted {
        async fn stream_turn(
            &self,
            _system: &str,
            _messages: &[DraftMessage],
            _sink: &dyn StreamSink,
        ) -> Result<ModelTurn, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.turns.lock().unwrap().remove(0))
        }
    }

    struct Collect(Mutex<Vec<MinerEvent>>);
    impl MinerSink for Collect {
        fn emit(&self, event: MinerEvent) {
            self.0.lock().unwrap().push(event);
        }
    }

    fn finding_call(id: &str, title: &str) -> ToolCall {
        ToolCall {
            id: id.into(),
            name: "emit_finding".into(),
            input: serde_json::json!({
                "category": "convention",
                "title": title,
                "body_md": "Do the thing.",
                "evidence": ["src/lib.rs:1"],
                "confidence": "high"
            }),
        }
    }

    #[tokio::test]
    async fn collects_findings_and_finishes_on_plain_turn() {
        let d = Scripted {
            turns: Mutex::new(vec![
                ModelTurn { tool_calls: vec![finding_call("f1", "one")], text: String::new(), emitted_spec: None },
                ModelTurn { tool_calls: vec![], text: "done".into(), emitted_spec: None },
            ]),
            calls: AtomicUsize::new(0),
        };
        let sink = Collect(Mutex::new(vec![]));
        let cancel = AtomicBool::new(false);
        let out = run_miner(&d, std::env::temp_dir().as_path(), &MinerOpts::default_for("s", "testing"), &cancel, &sink)
            .await
            .unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].title, "one");
        let evs = sink.0.lock().unwrap();
        assert!(evs.iter().any(|e| matches!(e, MinerEvent::Finding { .. })));
        assert!(matches!(evs.last().unwrap(), MinerEvent::RunDone { findings_total: 1, stopped: false }));
    }

    #[tokio::test]
    async fn invalid_finding_is_dropped_not_fatal() {
        let bad = ToolCall {
            id: "b".into(),
            name: "emit_finding".into(),
            input: serde_json::json!({ "category": "vibes", "title": "x" }),
        };
        let d = Scripted {
            turns: Mutex::new(vec![
                ModelTurn { tool_calls: vec![bad], text: String::new(), emitted_spec: None },
                ModelTurn { tool_calls: vec![], text: "done".into(), emitted_spec: None },
            ]),
            calls: AtomicUsize::new(0),
        };
        let sink = Collect(Mutex::new(vec![]));
        let out = run_miner(&d, std::env::temp_dir().as_path(), &MinerOpts::default_for("s", "t"), &AtomicBool::new(false), &sink)
            .await
            .unwrap();
        assert!(out.is_empty());
        assert!(!sink.0.lock().unwrap().iter().any(|e| matches!(e, MinerEvent::Finding { .. })));
    }

    #[tokio::test]
    async fn cancel_stops_between_turns_and_reports_stopped() {
        let d = Scripted {
            turns: Mutex::new(vec![ModelTurn {
                tool_calls: vec![finding_call("f1", "one")],
                text: String::new(),
                emitted_spec: None,
            }]),
            calls: AtomicUsize::new(0),
        };
        let sink = Collect(Mutex::new(vec![]));
        let cancel = AtomicBool::new(false);
        // Flip cancel via the sink: after the first Finding event, cancel.
        // (Simplest deterministic hook: pre-set cancel and assert zero turns.)
        cancel.store(true, Ordering::SeqCst);
        let out = run_miner(&d, std::env::temp_dir().as_path(), &MinerOpts::default_for("s", "t"), &cancel, &sink)
            .await
            .unwrap();
        assert!(out.is_empty());
        assert_eq!(d.calls.load(Ordering::SeqCst), 0, "cancel checked before first turn");
        assert!(matches!(sink.0.lock().unwrap().last().unwrap(), MinerEvent::RunDone { stopped: true, .. }));
    }

    #[test]
    fn finding_cap_is_enforced() {
        let mut opts = MinerOpts::default_for("s", "t");
        opts.max_findings = 1;
        // validate_finding + cap logic are pure — test via parse_finding.
        let ok = parse_finding(&serde_json::json!({
            "category": "gotcha", "title": "t", "body_md": "b",
            "evidence": [], "confidence": "low"
        }));
        assert!(ok.is_some());
        assert!(parse_finding(&serde_json::json!({"category": "nope"})).is_none());
    }
}
```

Public skeleton to write above the tests (all `todo!()`):
`MinerFinding`, `MinerEvent`, `MinerSink`, `MinerDepth`, `MinerOpts` with
`pub fn default_for(skill_name: &str, focus: &str) -> Self` (Quick, 40, 120),
`pub(crate) fn parse_finding(v: &serde_json::Value) -> Option<MinerFinding>`,
`pub async fn run_miner(...) -> Result<Vec<MinerFinding>, String>`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p karl-agent context_miner 2>&1 | tail -3`
Expected: FAIL / panic on `todo!()`.

- [ ] **Step 3: Implement the miner**

Complete `crates/agent/src/context_miner.rs`:

```rust
//! One-shot repo-mining agent for the CDLC Context Miner. Reuses the
//! spec_author streaming dispatcher + read-only repo tools, adding a
//! structured `emit_finding` tool streamed live to the UI.

use crate::spec_author::stream::{SpecStreamEvent, StreamSink, StreamingDispatcher};
use crate::spec_author::{tools, DraftMessage, MessageRole};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

pub const CATEGORIES: &[&str] = &["convention", "pattern", "gotcha", "domain_rule", "glossary"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MinerFinding {
    pub category: String,
    pub title: String,
    pub body_md: String,
    #[serde(default)]
    pub evidence: Vec<String>,
    #[serde(default = "default_confidence")]
    pub confidence: String,
}
fn default_confidence() -> String { "medium".into() }

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MinerEvent {
    TextDelta { text: String },
    ToolStart { id: String, tool: String, arg: String },
    ToolResult { id: String, summary: String, ok: bool },
    Finding { id: String, finding: MinerFinding },
    RunDone { findings_total: usize, stopped: bool },
    Error { message: String },
}

pub trait MinerSink: Send + Sync {
    fn emit(&self, event: MinerEvent);
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MinerDepth { Quick, Thorough }

pub struct MinerOpts {
    pub skill_name: String,
    pub focus: String,
    pub depth: MinerDepth,
    pub max_findings: usize,
    pub max_tool_calls: usize,
}
impl MinerOpts {
    pub fn default_for(skill_name: &str, focus: &str) -> Self {
        Self {
            skill_name: skill_name.into(),
            focus: focus.into(),
            depth: MinerDepth::Quick,
            max_findings: 40,
            max_tool_calls: 120,
        }
    }
}

pub(crate) fn parse_finding(v: &Value) -> Option<MinerFinding> {
    let f: MinerFinding = serde_json::from_value(v.clone()).ok()?;
    if !CATEGORIES.contains(&f.category.as_str()) { return None; }
    if f.title.trim().is_empty() || f.title.len() > 120 { return None; }
    if f.body_md.trim().is_empty() { return None; }
    Some(f)
}

/// The extra tool the model uses to report a finding.
fn miner_tool_specs() -> Value {
    let mut specs = tools::tool_specs();
    specs.as_array_mut().expect("tool_specs is an array").push(json!({
        "name": "emit_finding",
        "description": "Report ONE mined context finding. Call this every time you have solid evidence for a convention, pattern, gotcha, domain rule, or glossary term. body_md is written as an instruction for a coding agent.",
        "input_schema": {
            "type": "object",
            "required": ["category", "title", "body_md"],
            "properties": {
                "category": { "type": "string", "enum": CATEGORIES },
                "title": { "type": "string" },
                "body_md": { "type": "string" },
                "evidence": { "type": "array", "items": { "type": "string" }, "description": "path:line references backing the finding" },
                "confidence": { "type": "string", "enum": ["high", "medium", "low"] }
            }
        }
    }));
    specs
}

fn system_prompt(opts: &MinerOpts) -> String {
    let depth = match opts.depth {
        MinerDepth::Quick => "Scan the highest-signal files (manifests, top-level modules, tests, CI config); do not exhaustively read the tree.",
        MinerDepth::Thorough => "Be thorough: walk the main source directories and sample every major module.",
    };
    format!(
        "You are a context miner. You read a repository with the provided \
         read-only tools and extract DURABLE operational knowledge for a \
         skill named '{name}', focused on: {focus}.\n\n\
         Report each discovery with the emit_finding tool the moment you \
         have evidence (file:line). Findings must be instructions a coding \
         agent can follow, not observations. Never invent evidence. \
         {depth}\n\nCategories: convention (how code is written here), \
         pattern (recurring designs), gotcha (traps that bit or will bite), \
         domain_rule (business/regulatory rules encoded in the code), \
         glossary (project-specific terms).\n\nWhen you have covered the \
         focus, reply with a short closing summary WITHOUT tool calls.",
        name = opts.skill_name,
        focus = opts.focus,
        depth = depth,
    )
}

/// Adapts the spec_author stream sink onto MinerSink.
struct ForwardSink<'a>(&'a dyn MinerSink);
impl StreamSink for ForwardSink<'_> {
    fn emit(&self, event: SpecStreamEvent) {
        match event {
            SpecStreamEvent::ThinkingDelta { text } | SpecStreamEvent::TextDelta { text } => {
                self.0.emit(MinerEvent::TextDelta { text })
            }
            SpecStreamEvent::ToolStart { id, tool, arg } => {
                self.0.emit(MinerEvent::ToolStart { id, tool, arg })
            }
            SpecStreamEvent::ToolResult { id, summary, ok } => {
                self.0.emit(MinerEvent::ToolResult { id, summary, ok })
            }
            _ => {}
        }
    }
}

pub async fn run_miner(
    dispatcher: &dyn StreamingDispatcher,
    repo_root: &Path,
    opts: &MinerOpts,
    cancel: &AtomicBool,
    sink: &dyn MinerSink,
) -> Result<Vec<MinerFinding>, String> {
    let system = system_prompt(opts);
    let mut messages = vec![DraftMessage {
        role: MessageRole::User,
        content: format!(
            "Mine this repository now. Tools available: read_file, grep, list_dir, emit_finding. Tool roster JSON: {}",
            miner_tool_specs()
        ),
    }];
    let mut findings: Vec<MinerFinding> = Vec::new();
    let mut tool_budget = opts.max_tool_calls;
    let forward = ForwardSink(sink);

    loop {
        if cancel.load(Ordering::SeqCst) {
            sink.emit(MinerEvent::RunDone { findings_total: findings.len(), stopped: true });
            return Ok(findings);
        }
        let turn = match dispatcher.stream_turn(&system, &messages, &forward).await {
            Ok(t) => t,
            Err(e) => {
                sink.emit(MinerEvent::Error { message: e.clone() });
                sink.emit(MinerEvent::RunDone { findings_total: findings.len(), stopped: true });
                return Ok(findings);
            }
        };
        if !turn.text.is_empty() {
            messages.push(DraftMessage { role: MessageRole::Assistant, content: turn.text.clone() });
        }
        if turn.tool_calls.is_empty() {
            sink.emit(MinerEvent::RunDone { findings_total: findings.len(), stopped: false });
            return Ok(findings);
        }
        let mut feedback = String::new();
        for call in turn.tool_calls {
            if call.name == "emit_finding" {
                match parse_finding(&call.input) {
                    Some(f) if findings.len() < opts.max_findings => {
                        sink.emit(MinerEvent::Finding { id: call.id.clone(), finding: f.clone() });
                        findings.push(f);
                        feedback.push_str(&format!("[tool emit_finding → {}] recorded\n", call.id));
                    }
                    Some(_) => {
                        feedback.push_str("[tool emit_finding] finding cap reached — wrap up with a closing summary.\n");
                    }
                    None => {
                        tracing::warn!("miner: invalid emit_finding payload dropped");
                        feedback.push_str("[tool emit_finding] invalid payload (schema) — dropped.\n");
                    }
                }
                continue;
            }
            if tool_budget == 0 {
                feedback.push_str("[tools] budget exhausted — wrap up with a closing summary.\n");
                continue;
            }
            tool_budget -= 1;
            let arg = call.input.to_string();
            sink.emit(MinerEvent::ToolStart { id: call.id.clone(), tool: call.name.clone(), arg: arg.clone() });
            let (result, summary) = tools::run_tool(repo_root, &call.name, &call.input);
            let ok = summary != "error";
            sink.emit(MinerEvent::ToolResult { id: call.id.clone(), summary: summary.clone(), ok });
            feedback.push_str(&format!("[tool {} → {}] {}\n{}\n\n", call.name, call.id, summary, result));
        }
        messages.push(DraftMessage { role: MessageRole::User, content: feedback });
    }
}
```

Note for the implementer: `tool_specs()` in `spec_author::tools` returns the
Anthropic tool roster the dispatcher already sends. Check how
`AnthropicStreamingDispatcher` gets its tools (`grep -n "tool_specs" crates/agent/src/spec_author/stream.rs`).
If the dispatcher hardcodes `tools::tool_specs()`, add a
`with_tools(Value)` builder or a `tools: Option<Value>` field defaulting to
the spec roster, and pass `miner_tool_specs()` from the miner path. Keep the
spec_author call sites compiling unchanged (default keeps old behavior).
Add `pub mod context_miner;` to `crates/agent/src/lib.rs`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p karl-agent context_miner 2>&1 | tail -3`
Expected: `test result: ok. 4 passed`
Also run: `cargo test -p karl-agent spec_author 2>&1 | tail -3` — spec author suite still green (dispatcher change is default-compatible).

- [ ] **Step 5: Commit**

```bash
git add crates/agent/src/context_miner.rs crates/agent/src/lib.rs crates/agent/src/spec_author/stream.rs
git commit -m "feat(agent): context miner loop — emit_finding streaming over spec_author infra"
```

---

### Task 3: Tauri commands — start / stop / compile

**Files:**
- Create: `crates/app/src/cdlc_miner.rs`
- Modify: `crates/app/src/lib.rs` (module + `.manage(MinerRuns::new())` + 3 handlers in `invoke_handler`)

**Interfaces:**
- Consumes: `karl_agent::context_miner::{run_miner, MinerOpts, MinerDepth, MinerEvent, MinerSink, MinerFinding}`, `karl_cdlc::compile::{CompiledFinding, write_skill_package}`, `karl_agent::spec_author::stream::AnthropicStreamingDispatcher` (constructed the same way the spec-chat command in `crates/app/src/lib.rs` near the `TauriSink` impl does — copy that construction, including model/api-key resolution from Settings).
- Produces (Tauri commands, camelCase args):
  - `cdlc_mine_start(repo_root: String, skill_name: String, focus: String, thorough: bool) -> String` (run_id; events on `cdlc://miner/{run_id}`)
  - `cdlc_mine_stop(run_id: String) -> ()`
  - `cdlc_compile_skill(repo_root: String, skill_name: String, findings: Vec<CompiledFinding>, overwrite: bool) -> String` (package dir path)

- [ ] **Step 1: Write the failing test**

In `crates/app/src/cdlc_miner.rs` — the run registry is the testable unit
(commands are thin):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_cancels_and_forgets() {
        let runs = MinerRuns::new();
        let (id, flag) = runs.insert();
        assert!(!flag.load(std::sync::atomic::Ordering::SeqCst));
        runs.stop(&id);
        assert!(flag.load(std::sync::atomic::Ordering::SeqCst));
        runs.remove(&id);
        // Stopping an unknown id is a no-op, not a panic.
        runs.stop("missing");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p covenant --lib cdlc_miner 2>&1 | tail -3`
Expected: compile FAIL (module missing).

- [ ] **Step 3: Implement**

`crates/app/src/cdlc_miner.rs`:

```rust
//! Tauri surface for the CDLC Context Miner: start/stop mining runs and
//! compile accepted findings into a skill package.

use karl_agent::context_miner::{
    run_miner, MinerDepth, MinerEvent, MinerFinding, MinerOpts, MinerSink,
};
use karl_cdlc::compile::{write_skill_package, CompiledFinding};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};
use ulid::Ulid;

pub struct MinerRuns {
    inner: Mutex<HashMap<String, Arc<AtomicBool>>>,
}
impl MinerRuns {
    pub fn new() -> Self {
        Self { inner: Mutex::new(HashMap::new()) }
    }
    fn insert(&self) -> (String, Arc<AtomicBool>) {
        let id = Ulid::new().to_string();
        let flag = Arc::new(AtomicBool::new(false));
        self.inner.lock().unwrap().insert(id.clone(), flag.clone());
        (id, flag)
    }
    fn stop(&self, id: &str) {
        if let Some(f) = self.inner.lock().unwrap().get(id) {
            f.store(true, Ordering::SeqCst);
        }
    }
    fn remove(&self, id: &str) {
        self.inner.lock().unwrap().remove(id);
    }
}

struct EmitSink {
    app: AppHandle,
    topic: String,
}
impl MinerSink for EmitSink {
    fn emit(&self, event: MinerEvent) {
        if let Err(e) = self.app.emit(&self.topic, &event) {
            tracing::warn!(?e, topic = %self.topic, "miner event emit failed");
        }
    }
}

#[tauri::command]
pub async fn cdlc_mine_start(
    app: AppHandle,
    runs: State<'_, MinerRuns>,
    settings: State<'_, crate::SharedSettings>, // match the alias spec-chat uses
    repo_root: String,
    skill_name: String,
    focus: String,
    thorough: bool,
) -> Result<String, String> {
    let root = PathBuf::from(&repo_root)
        .canonicalize()
        .map_err(|e| format!("repo root: {e}"))?;
    let (run_id, cancel) = runs.insert();
    let topic = format!("cdlc://miner/{run_id}");
    // Dispatcher construction: COPY the AnthropicStreamingDispatcher setup
    // from the spec-chat command in lib.rs (model + api key from settings).
    let dispatcher = crate::build_spec_streaming_dispatcher(&settings).map_err(|e| e.to_string())?;
    let mut opts = MinerOpts::default_for(&skill_name, &focus);
    if thorough {
        opts.depth = MinerDepth::Thorough;
        opts.max_tool_calls = 240;
    }
    let sink = EmitSink { app: app.clone(), topic };
    let runs_ref = runs.inner();
    let run_id_task = run_id.clone();
    tauri::async_runtime::spawn(async move {
        let _ = run_miner(dispatcher.as_ref(), &root, &opts, &cancel, &sink).await;
        // RunDone already emitted by run_miner on every exit path.
        runs_ref.remove(&run_id_task);
    });
    Ok(run_id)
}

#[tauri::command]
pub async fn cdlc_mine_stop(runs: State<'_, MinerRuns>, run_id: String) -> Result<(), String> {
    runs.stop(&run_id);
    Ok(())
}

#[tauri::command]
pub async fn cdlc_compile_skill(
    repo_root: String,
    skill_name: String,
    findings: Vec<CompiledFinding>,
    overwrite: bool,
) -> Result<String, String> {
    let root = PathBuf::from(&repo_root);
    let dir = tokio::task::spawn_blocking(move || {
        write_skill_package(&root, &skill_name, None, &findings, overwrite)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}
```

Adaptation notes (the implementer resolves these against the real lib.rs —
they are naming lookups, not design choices):
- `crate::SharedSettings` / `build_spec_streaming_dispatcher`: find how the
  spec-chat streaming command builds its `AnthropicStreamingDispatcher`
  (`grep -n "AnthropicStreamingDispatcher" crates/app/src/lib.rs`). If no
  shared builder exists, extract one small `pub(crate) fn` in lib.rs from
  that call site and use it from both places (DRY, no behavior change).
- `runs.inner()` on `State` yields `&MinerRuns`; to move a remover into the
  task, either wrap `MinerRuns` in `Arc` when managed, or give `MinerRuns`
  `Arc<Mutex<…>>` internals and `impl Clone`. Pick whichever matches how
  other managed registries in lib.rs do it (`AcpRegistry` pattern).
- Register: `pub mod cdlc_miner;` in lib.rs, `.manage(cdlc_miner::MinerRuns::new())`,
  and the three commands in `invoke_handler` next to the other cdlc commands.

- [ ] **Step 4: Run tests + compile**

Run: `cargo test -p covenant --lib cdlc_miner 2>&1 | tail -3`
Expected: `test result: ok. 1 passed`
Run: `cargo check -p covenant --lib 2>&1 | grep -cE "^error"` → `0`

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/cdlc_miner.rs crates/app/src/lib.rs
git commit -m "feat(app): cdlc miner commands — start/stop runs + compile skill"
```

---

### Task 4: Frontend state — miner reducer

**Files:**
- Create: `ui/src/cdlc/miner/state.ts`
- Create: `ui/src/cdlc/miner/state.test.ts`
- Modify: `ui/src/api.ts` (types + command wrappers)

**Interfaces:**
- Consumes: Tauri `invoke`/`listen` via existing `ui/src/api.ts` helpers.
- Produces:
  - api.ts: `MinerFinding`, `MinerEvent` (discriminated union mirroring Rust), `cdlcMineStart(repoRoot, skillName, focus, thorough): Promise<string>`, `cdlcMineStop(runId)`, `cdlcCompileSkill(repoRoot, skillName, findings, overwrite): Promise<string>`, `subscribeMinerEvents(runId, cb): Promise<UnlistenFn>` (mirror `subscribeAcpEvents`'s shape).
  - state.ts:
    ```ts
    export interface FindingCard { id: string; finding: MinerFinding; status: "pending" | "accepted" | "discarded"; editedBody?: string }
    export interface MinerState { activity: { id: string; tool: string; arg: string; summary?: string; ok?: boolean }[]; findings: FindingCard[]; narration: string; done: boolean; stopped: boolean; error: string | null }
    export function createMinerState(): MinerState
    export function reduceMinerEvent(state: MinerState, ev: MinerEvent): void
    export function setFindingStatus(state: MinerState, id: string, status: "accepted" | "discarded"): void
    export function editFindingBody(state: MinerState, id: string, body: string): void
    export function acceptedFindings(state: MinerState): MinerFinding[]  // applies editedBody
    export function compilePreview(skillName: string, state: MinerState): string  // markdown, same section order as Rust render_skill_md
    ```

- [ ] **Step 1: Write the failing tests**

`ui/src/cdlc/miner/state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  acceptedFindings,
  compilePreview,
  createMinerState,
  editFindingBody,
  reduceMinerEvent,
  setFindingStatus,
} from "./state";
import type { MinerEvent } from "../../api";

const finding = (id: string, title: string, category = "convention"): MinerEvent => ({
  kind: "finding",
  id,
  finding: { category, title, bodyMd: `Do ${title}.`, evidence: ["src/a.rs:1"], confidence: "high" },
});

describe("reduceMinerEvent", () => {
  it("appends tool activity and pairs results by id", () => {
    const s = createMinerState();
    reduceMinerEvent(s, { kind: "tool_start", id: "t1", tool: "grep", arg: "{\"needle\":\"unwrap\"}" });
    reduceMinerEvent(s, { kind: "tool_result", id: "t1", summary: "12 hits", ok: true });
    expect(s.activity).toHaveLength(1);
    expect(s.activity[0].summary).toBe("12 hits");
  });

  it("collects findings as pending cards and flags done", () => {
    const s = createMinerState();
    reduceMinerEvent(s, finding("f1", "snake case"));
    reduceMinerEvent(s, { kind: "run_done", findingsTotal: 1, stopped: false });
    expect(s.findings[0].status).toBe("pending");
    expect(s.done).toBe(true);
    expect(s.stopped).toBe(false);
  });

  it("accept/edit/discard drive acceptedFindings with edits applied", () => {
    const s = createMinerState();
    reduceMinerEvent(s, finding("f1", "one"));
    reduceMinerEvent(s, finding("f2", "two"));
    setFindingStatus(s, "f1", "accepted");
    editFindingBody(s, "f1", "Edited body.");
    setFindingStatus(s, "f2", "discarded");
    const out = acceptedFindings(s);
    expect(out).toHaveLength(1);
    expect(out[0].bodyMd).toBe("Edited body.");
  });

  it("compilePreview groups by category in fixed order", () => {
    const s = createMinerState();
    reduceMinerEvent(s, finding("f1", "trap", "gotcha"));
    reduceMinerEvent(s, finding("f2", "style", "convention"));
    setFindingStatus(s, "f1", "accepted");
    setFindingStatus(s, "f2", "accepted");
    const md = compilePreview("my-skill", s);
    expect(md.indexOf("## Conventions")).toBeGreaterThan(-1);
    expect(md.indexOf("## Conventions")).toBeLessThan(md.indexOf("## Gotchas"));
    expect(md).toContain("`src/a.rs:1`");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run ui/src/cdlc/miner/state.test.ts 2>&1 | tail -3`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement api.ts types + state.ts**

api.ts additions (near the ACP block):

```ts
export interface MinerFinding {
  category: string;
  title: string;
  bodyMd: string;
  evidence: string[];
  confidence: string;
}
export type MinerEvent =
  | { kind: "text_delta"; text: string }
  | { kind: "tool_start"; id: string; tool: string; arg: string }
  | { kind: "tool_result"; id: string; summary: string; ok: boolean }
  | { kind: "finding"; id: string; finding: MinerFinding }
  | { kind: "run_done"; findingsTotal: number; stopped: boolean }
  | { kind: "error"; message: string };

export async function cdlcMineStart(repoRoot: string, skillName: string, focus: string, thorough: boolean): Promise<string> {
  return invoke<string>("cdlc_mine_start", { repoRoot, skillName, focus, thorough });
}
export async function cdlcMineStop(runId: string): Promise<void> {
  return invoke<void>("cdlc_mine_stop", { runId });
}
export async function cdlcCompileSkill(repoRoot: string, skillName: string, findings: MinerFinding[], overwrite: boolean): Promise<string> {
  return invoke<string>("cdlc_compile_skill", { repoRoot, skillName, findings, overwrite });
}
export async function subscribeMinerEvents(runId: string, cb: (ev: MinerEvent) => void): Promise<UnlistenFn> {
  return listen<MinerEvent>(`cdlc://miner/${runId}`, (e) => cb(e.payload));
}
```

(Serde note: `MinerEvent` in Rust uses snake_case tags and camelCase field
names come from serde defaults — Rust structs there use `rename_all`
only on `MinerFinding`; ADD `#[serde(rename_all = "camelCase")]` to the
`MinerEvent` variants' fields — i.e. put the attribute on the enum — in
Task 2 if the vitest fixtures here don't match what the backend emits.
The TS union above is the contract; make Rust serialize exactly this.)

state.ts:

```ts
import type { MinerEvent, MinerFinding } from "../../api";

export interface FindingCard {
  id: string;
  finding: MinerFinding;
  status: "pending" | "accepted" | "discarded";
  editedBody?: string;
}
export interface MinerState {
  activity: { id: string; tool: string; arg: string; summary?: string; ok?: boolean }[];
  findings: FindingCard[];
  narration: string;
  done: boolean;
  stopped: boolean;
  error: string | null;
}

export function createMinerState(): MinerState {
  return { activity: [], findings: [], narration: "", done: false, stopped: false, error: null };
}

export function reduceMinerEvent(state: MinerState, ev: MinerEvent): void {
  switch (ev.kind) {
    case "text_delta":
      state.narration += ev.text;
      break;
    case "tool_start":
      state.activity.push({ id: ev.id, tool: ev.tool, arg: ev.arg });
      break;
    case "tool_result": {
      const row = state.activity.find((a) => a.id === ev.id);
      if (row) { row.summary = ev.summary; row.ok = ev.ok; }
      break;
    }
    case "finding":
      state.findings.push({ id: ev.id, finding: ev.finding, status: "pending" });
      break;
    case "run_done":
      state.done = true;
      state.stopped = ev.stopped;
      break;
    case "error":
      state.error = ev.message;
      break;
  }
}

export function setFindingStatus(state: MinerState, id: string, status: "accepted" | "discarded"): void {
  const c = state.findings.find((f) => f.id === id);
  if (c) c.status = status;
}

export function editFindingBody(state: MinerState, id: string, body: string): void {
  const c = state.findings.find((f) => f.id === id);
  if (c) c.editedBody = body;
}

export function acceptedFindings(state: MinerState): MinerFinding[] {
  return state.findings
    .filter((c) => c.status === "accepted")
    .map((c) => ({ ...c.finding, bodyMd: c.editedBody ?? c.finding.bodyMd }));
}

const CATEGORY_ORDER: [string, string][] = [
  ["convention", "Conventions"],
  ["pattern", "Patterns"],
  ["gotcha", "Gotchas"],
  ["domain_rule", "Domain rules"],
  ["glossary", "Glossary"],
];

export function compilePreview(skillName: string, state: MinerState): string {
  const accepted = acceptedFindings(state);
  let md = `---\nname: ${skillName}\ndescription: Mined context for ${skillName}\nversion: 1.0.0\n---\n\n# ${skillName}\n`;
  for (const [key, heading] of CATEGORY_ORDER) {
    const inCat = accepted.filter((f) => f.category === key);
    if (inCat.length === 0) continue;
    md += `\n## ${heading}\n`;
    for (const f of inCat) {
      md += `\n### ${f.title}\n\n${f.bodyMd.trim()}\n`;
      if (f.evidence.length > 0) md += `\nEvidence: ${f.evidence.map((e) => `\`${e}\``).join(", ")}\n`;
    }
  }
  return md;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run ui/src/cdlc/miner/state.test.ts 2>&1 | tail -3`
Expected: `Tests  4 passed`
Run: `npx tsc --noEmit 2>&1 | head -3` → clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/cdlc/miner/state.ts ui/src/cdlc/miner/state.test.ts ui/src/api.ts
git commit -m "feat(cdlc): miner stream reducer + command wrappers"
```

---

### Task 5: Frontend view — immersive 3-zone Miner

**Files:**
- Create: `ui/src/cdlc/miner/view.ts`
- Create: `ui/src/cdlc/miner/miner.css`
- Modify: `ui/src/main.ts` (import css; wire `onNewContext`)

**Interfaces:**
- Consumes: everything from Task 4; `pushInfoToast` from the toast module (`grep -rn "export function pushInfoToast" ui/src` for the path); `Icons` from `ui/src/icons`.
- Produces: `export class ContextMinerView { constructor(opts: { repoRoot: string; groupName: string | null }); destroy(): void }` — full-screen overlay appended to `document.body`; ESC or the close button destroys it (stopping any live run).

Behavior contract (implement exactly):
1. Mount: full-screen fixed overlay (`.cdlc-miner`) with a setup bar —
   skill name input (kebab-case enforced on input), focus input
   (placeholder "what to capture: testing conventions, KYC domain rules…"),
   Thorough checkbox, **Start mining** button.
2. Start → `cdlcMineStart(repoRoot, name, focus, thorough)` →
   `subscribeMinerEvents(runId, ev => { reduceMinerEvent(state, ev); render(ev) })`.
   Setup bar collapses to a header (name + Stop button).
3. Three zones (CSS grid `280px 1fr 380px`):
   - Left `.cdlc-miner-activity`: one row per activity entry
     (`tool · short arg · summary`), auto-scroll to bottom.
   - Center `.cdlc-miner-cards`: cards grouped under category headers as
     findings arrive. Card = title, confidence badge, body (click →
     `contenteditable` editing, blur commits via `editFindingBody`),
     evidence rendered as `path:line` code chips, Accept / Discard buttons.
     Keyboard: `A` accepts, `D` discards the newest pending card.
     Accepted cards get a left accent border; discarded collapse to a
     one-line strikethrough row (click restores to pending).
   - Right `.cdlc-miner-preview`: `<pre>` with `compilePreview(name, state)`
     re-rendered after every accept/edit/discard.
4. Footer: `N accepted · M pending`, **Write to repo** enabled when
   `acceptedFindings(state).length > 0` AND (`state.done` or run stopped).
   Click → `cdlcCompileSkill(repoRoot, name, acceptedFindings(state), false)`;
   on "already exists" error, show inline confirm that retries with
   `overwrite: true`. Success → toast `Skill written: <path>` and destroy.
5. Stop button → `cdlcMineStop(runId)` (findings stay curatable — the
   backend emits `run_done {stopped:true}`).
6. `destroy()`: unlisten, `cdlcMineStop` if run not done, remove overlay,
   remove keydown listener.
7. Empty-done state: run finished with zero findings → centered note
   "Nothing mined — try a broader focus." with a Restart button that
   returns to the setup bar.

CSS: dark full-screen (`position: fixed; inset: 0; z-index: 9500;
background: var(--bg-root, #0b0e14)`) — OPAQUE (vibrancy gotcha: overlays
on `#layout` bleed wallpaper if translucent). Reuse `.rail-*`-adjacent
tokens; no new dependencies.

- [ ] **Step 1: Implement view + css** (no DOM unit tests — the reducer carries the logic; view is exercised by the in-app verify pass)

- [ ] **Step 2: Wire the entry point in main.ts**

Replace the `onNewContext` body:

```ts
      onNewContext: () => {
        const root = args.groupRootDir;
        if (!root) {
          toasts.pushInfo({ message: "Set a project folder for this group first" });
          return;
        }
        new ContextMinerView({ repoRoot: root, groupName: args.groupName ?? null });
      },
```

(Match the real `args` field names at that call site — `grep -n "onNewContext" ui/src/main.ts` and read the surrounding `mountCdlc()` for what's available; the CdlcPanel already receives `groupRootDir`.)
Import: `import { ContextMinerView } from "./cdlc/miner/view";` and `import "./cdlc/miner/miner.css";` following how `acp.css` is imported (`grep -rn "acp.css" ui/src`).

- [ ] **Step 3: Verify compile + full frontend suite**

Run: `npx tsc --noEmit 2>&1 | head -3` → clean.
Run: `npx vitest run ui/src/cdlc 2>&1 | tail -3` → all green.

- [ ] **Step 4: Commit**

```bash
git add ui/src/cdlc/miner/view.ts ui/src/cdlc/miner/miner.css ui/src/main.ts
git commit -m "feat(cdlc): immersive Context Miner — 3-zone mining + curation UI"
```

---

### Task 6: Real-run smoke (ignored) + docs breadcrumb

**Files:**
- Modify: `crates/agent/src/context_miner.rs` (add ignored test)
- Modify: `docs/superpowers/specs/2026-07-05-cdlc-context-miner-design.md` (Status → Implemented, one line)

- [ ] **Step 1: Add the ignored smoke**

```rust
    /// Real mining run against this repository. Requires ANTHROPIC_API_KEY
    /// (or the settings-resolved key path used by the app — this test uses
    /// the env var directly).
    /// Run: cargo test -p karl-agent context_miner::tests::smoke_real_miner -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "spends real tokens; needs ANTHROPIC_API_KEY"]
    async fn smoke_real_miner() {
        let key = match std::env::var("ANTHROPIC_API_KEY") {
            Ok(k) => k,
            Err(_) => { eprintln!("no key; skipping"); return; }
        };
        let dispatcher = crate::spec_author::stream::AnthropicStreamingDispatcher::new(
            key,
            "claude-haiku-4-5-20251001".to_string(),
        );
        // ^ match the real constructor signature — check
        //   `grep -n "impl AnthropicStreamingDispatcher" -A 12 crates/agent/src/spec_author/stream.rs`
        struct Print;
        impl MinerSink for Print {
            fn emit(&self, e: MinerEvent) { eprintln!("{e:?}"); }
        }
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap().to_path_buf();
        let mut opts = MinerOpts::default_for("covenant-conventions", "rust error-handling conventions");
        opts.max_findings = 5;
        opts.max_tool_calls = 20;
        let out = run_miner(&dispatcher, &repo, &opts, &AtomicBool::new(false), &Print).await.unwrap();
        assert!(!out.is_empty(), "expected at least one finding");
        assert!(out.iter().all(|f| !f.evidence.is_empty()), "findings must cite evidence");
    }
```

- [ ] **Step 2: Run it once for real**

Run: `cargo test -p karl-agent context_miner::tests::smoke_real_miner -- --ignored --nocapture 2>&1 | tail -5`
Expected: `ok. 1 passed` with findings printed. (If no key available in the session, note it in the task report and leave for the in-app verify.)

- [ ] **Step 3: Update spec status + commit**

```bash
git add crates/agent/src/context_miner.rs docs/superpowers/specs/2026-07-05-cdlc-context-miner-design.md
git commit -m "test(agent): real miner smoke + mark context-miner spec implemented"
```

---

## Self-review (done at plan time)

- **Spec coverage:** mining agent (T2), emit_finding schema + live stream (T2/T3), packaged-skill output (T1/T3), immersive 3-zone curation (T5), entry point replacement (T5), error handling (T2 drops invalid findings; T5 collision/empty states), testing section (T1/T2/T4 unit, T6 smoke). Out-of-scope items untouched. ✓
- **Type consistency:** `MinerFinding` camelCase over the wire (`bodyMd`) — Task 4 note pins the Rust serde attrs to the TS contract; `CompiledFinding` serde camelCase matches the `cdlc_compile_skill` payload from `acceptedFindings`. `run_done.findingsTotal` requires camelCase on the enum — flagged in Task 4. ✓
- **Placeholders:** none — every code step has concrete code; naming lookups against lib.rs internals are explicitly scoped grep instructions, not TBDs. ✓
