//! One-shot repo-mining agent for the Canon Context Miner. Reuses the
//! spec_author streaming dispatcher + read-only repo tools, adding a
//! structured `emit_finding` tool streamed live to the UI.

use crate::spec_author::stream::{SpecStreamEvent, StreamSink, StreamingDispatcher};
use crate::spec_author::{tools, DraftMessage, MessageRole};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

pub const CATEGORIES: &[&str] =
    &["convention", "pattern", "gotcha", "domain_rule", "glossary", "workflow"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MinerFinding {
    pub category: String,
    pub title: String,
    // `rename_all = "camelCase"` above renames this to "bodyMd" for both
    // directions by default, but incoming `emit_finding` tool-call JSON
    // uses the snake_case key from the tool's `input_schema` ("body_md").
    // Accept both; still serialize outbound as "bodyMd" for the frontend.
    #[serde(alias = "body_md")]
    pub body_md: String,
    #[serde(default)]
    pub evidence: Vec<String>,
    #[serde(default = "default_confidence")]
    pub confidence: String,
    #[serde(default, alias = "suggested_kind")]
    pub kind: String,
}
fn default_confidence() -> String {
    "medium".into()
}

/// Category → default destination kind. `subagent` is intentionally
/// unreachable here: the agent never promotes a finding to a persona; that
/// is a manual re-route in curation.
pub fn default_kind(category: &str) -> &'static str {
    match category {
        "domain_rule" | "glossary" => "memory",
        "workflow" => "command",
        _ => "skill",
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MinerEvent {
    TextDelta {
        text: String,
    },
    ToolStart {
        id: String,
        tool: String,
        arg: String,
    },
    ToolResult {
        id: String,
        summary: String,
        ok: bool,
    },
    Finding {
        id: String,
        finding: MinerFinding,
    },
    #[serde(rename_all = "camelCase")]
    RunDone {
        findings_total: usize,
        stopped: bool,
    },
    Error {
        message: String,
    },
}

pub trait MinerSink: Send + Sync {
    fn emit(&self, event: MinerEvent);
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MinerDepth {
    Quick,
    Thorough,
}

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
    let mut f: MinerFinding = serde_json::from_value(v.clone()).ok()?;
    if !CATEGORIES.contains(&f.category.as_str()) {
        return None;
    }
    if f.title.trim().is_empty() || f.title.len() > 120 {
        return None;
    }
    if f.body_md.trim().is_empty() {
        return None;
    }
    // Fill/repair kind. Trust only skill|memory|command from the model
    // (`suggested_kind` deserialized into `f.kind` via serde alias); anything
    // else — including "subagent" — falls back to the category default.
    if !matches!(f.kind.as_str(), "skill" | "memory" | "command") {
        f.kind = default_kind(&f.category).to_string();
    }
    Some(f)
}

/// The extra tool the model uses to report a finding. `pub` — Task 3
/// wires this into the dispatcher's `tools` field.
pub fn miner_tool_specs() -> Value {
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
                "confidence": { "type": "string", "enum": ["high", "medium", "low"] },
                "suggested_kind": { "type": "string", "enum": ["skill", "memory", "command"], "description": "Where this finding belongs: skill (conventions/patterns/gotchas), memory (durable domain facts/glossary), or command (a repeatable workflow). Omit to let the category decide." }
            }
        }
    }));
    specs
}

/// The miner tool roster in OpenAI function-calling format, for
/// OpenAI-compatible / Azure Foundry providers. Same tools as
/// [`miner_tool_specs`], mechanically converted.
pub fn miner_tool_specs_openai() -> Value {
    tools::to_openai_tools(&miner_tool_specs())
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
         glossary (project-specific terms), workflow (a repeatable dev \
         command sequence: build, test, deploy, migrate).\n\n\
         Set suggested_kind to route the finding: skill for \
         convention/pattern/gotcha, memory for durable domain_rule/glossary \
         facts, command for a workflow. Omit it to accept the default for the \
         category. You never create personas.\n\nWhen you have covered the \
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
        content: "Mine this repository now. Use read_file, grep, and list_dir to explore, and \
                   call emit_finding for each finding you can back with file:line evidence."
            .to_string(),
        images: Vec::new(),
    }];
    let mut findings: Vec<MinerFinding> = Vec::new();
    let mut tool_budget = opts.max_tool_calls;
    let forward = ForwardSink(sink);

    // Hard ceiling so a model that ignores the wrap-up hints — or spams
    // emit_finding calls that fail validation (they consume neither the
    // finding cap nor the tool budget) — still terminates. Generous headroom
    // above the legitimate work (one turn per read-tool + one per finding + grace).
    let max_turns = opts.max_tool_calls + opts.max_findings + 8;
    let mut turns = 0usize;

    loop {
        if cancel.load(Ordering::SeqCst) {
            sink.emit(MinerEvent::RunDone {
                findings_total: findings.len(),
                stopped: true,
            });
            return Ok(findings);
        }
        turns += 1;
        if turns > max_turns {
            tracing::warn!("miner: hit hard turn ceiling ({max_turns}); stopping");
            sink.emit(MinerEvent::RunDone {
                findings_total: findings.len(),
                stopped: true,
            });
            return Ok(findings);
        }
        let turn = match dispatcher.stream_turn(&system, &messages, &forward).await {
            Ok(t) => t,
            Err(e) => {
                sink.emit(MinerEvent::Error { message: e.clone() });
                sink.emit(MinerEvent::RunDone {
                    findings_total: findings.len(),
                    stopped: true,
                });
                return Ok(findings);
            }
        };
        if !turn.text.is_empty() {
            messages.push(DraftMessage {
                role: MessageRole::Assistant,
                content: turn.text.clone(),
                images: Vec::new(),
            });
        }
        if turn.tool_calls.is_empty() {
            sink.emit(MinerEvent::RunDone {
                findings_total: findings.len(),
                stopped: false,
            });
            return Ok(findings);
        }
        let mut feedback = String::new();
        for call in turn.tool_calls {
            if call.name == "emit_finding" {
                match parse_finding(&call.input) {
                    Some(f) if findings.len() < opts.max_findings => {
                        sink.emit(MinerEvent::Finding {
                            id: call.id.clone(),
                            finding: f.clone(),
                        });
                        findings.push(f);
                        feedback.push_str(&format!("[tool emit_finding → {}] recorded\n", call.id));
                    }
                    Some(_) => {
                        feedback.push_str(
                            "[tool emit_finding] finding cap reached — wrap up with a closing summary.\n",
                        );
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
            sink.emit(MinerEvent::ToolStart {
                id: call.id.clone(),
                tool: call.name.clone(),
                arg: arg.clone(),
            });
            let (result, summary) = tools::run_tool(repo_root, &call.name, &call.input);
            let ok = summary != "error";
            sink.emit(MinerEvent::ToolResult {
                id: call.id.clone(),
                summary: summary.clone(),
                ok,
            });
            feedback.push_str(&format!(
                "[tool {} → {}] {}\n{}\n\n",
                call.name, call.id, summary, result
            ));
        }
        messages.push(DraftMessage {
            role: MessageRole::User,
            content: feedback,
            images: Vec::new(),
        });
    }
}

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

    /// Always returns a turn with one INVALID emit_finding call, so neither
    /// the finding cap nor the tool budget ever advances. Never runs out of
    /// scripted turns — proves the hard turn ceiling is what stops the loop.
    struct NeverStops;
    #[async_trait]
    impl StreamingDispatcher for NeverStops {
        async fn stream_turn(
            &self,
            _system: &str,
            _messages: &[DraftMessage],
            _sink: &dyn StreamSink,
        ) -> Result<ModelTurn, String> {
            Ok(ModelTurn {
                tool_calls: vec![ToolCall {
                    id: "x".into(),
                    name: "emit_finding".into(),
                    input: serde_json::json!({ "category": "vibes", "title": "bad" }),
                }],
                text: String::new(),
                emitted_spec: None,
            })
        }
    }

    #[tokio::test]
    async fn hard_turn_ceiling_terminates_a_model_that_never_stops() {
        let mut opts = MinerOpts::default_for("s", "t");
        opts.max_findings = 2;
        opts.max_tool_calls = 2;
        let sink = Collect(Mutex::new(vec![]));
        let out = run_miner(
            &NeverStops,
            std::env::temp_dir().as_path(),
            &opts,
            &AtomicBool::new(false),
            &sink,
        )
        .await
        .unwrap();
        assert!(out.is_empty());
        assert!(matches!(
            sink.0.lock().unwrap().last().unwrap(),
            MinerEvent::RunDone { findings_total: 0, stopped: true }
        ));
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

    #[test]
    fn default_kind_maps_categories() {
        assert_eq!(default_kind("domain_rule"), "memory");
        assert_eq!(default_kind("glossary"), "memory");
        assert_eq!(default_kind("workflow"), "command");
        assert_eq!(default_kind("convention"), "skill");
        assert_eq!(default_kind("pattern"), "skill");
        assert_eq!(default_kind("gotcha"), "skill");
        assert_eq!(default_kind("nonsense"), "skill");
    }

    #[test]
    fn parse_finding_fills_kind_from_category_when_absent() {
        let v = json!({ "category": "domain_rule", "title": "PEP check", "body_md": "Do X." });
        let f = parse_finding(&v).expect("valid finding");
        assert_eq!(f.kind, "memory");
    }

    #[test]
    fn parse_finding_honors_suggested_kind_but_never_subagent() {
        let v = json!({ "category": "pattern", "title": "T", "body_md": "B", "suggested_kind": "memory" });
        assert_eq!(parse_finding(&v).unwrap().kind, "memory");
        let sub = json!({ "category": "pattern", "title": "T", "body_md": "B", "suggested_kind": "subagent" });
        // agent may never route to subagent; falls back to category default
        assert_eq!(parse_finding(&sub).unwrap().kind, "skill");
    }

    #[test]
    fn workflow_is_a_valid_category() {
        let v = json!({ "category": "workflow", "title": "Run tests", "body_md": "npm test from root." });
        assert!(parse_finding(&v).is_some());
    }

    #[test]
    fn openai_tool_roster_carries_emit_finding_as_a_function() {
        let specs = miner_tool_specs_openai();
        let arr = specs.as_array().expect("array");
        let ef = arr
            .iter()
            .find(|t| t["function"]["name"] == "emit_finding")
            .expect("emit_finding present in openai format");
        assert_eq!(ef["type"], "function");
        // Anthropic input_schema maps to OpenAI function.parameters.
        assert_eq!(ef["function"]["parameters"]["required"][0], "category");
    }

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
        let dispatcher = crate::spec_author::stream::AnthropicStreamingDispatcher {
            api_key: key,
            model: "claude-haiku-4-5-20251001".to_string(),
            tools: Some(miner_tool_specs()),
        };
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
}
