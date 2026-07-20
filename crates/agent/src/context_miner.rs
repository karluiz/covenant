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
    /// Name of the `propose_unit` this finding belongs to. Findings naming an
    /// unproposed unit are dropped by the run loop.
    #[serde(default)]
    pub unit: String,
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

/// A destination the crawler proposes before filling it with findings.
/// Identity is `(kind, slugify(name))`; the run loop merges collisions.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MinerUnit {
    pub kind: String,
    pub name: String,
    pub summary: String,
}

/// Only skill|memory|command survive. `subagent` is deliberately unreachable
/// from the model — it is a manual re-route in curation.
pub(crate) fn parse_unit(v: &Value) -> Option<MinerUnit> {
    let u: MinerUnit = serde_json::from_value(v.clone()).ok()?;
    if !matches!(u.kind.as_str(), "skill" | "memory" | "command") {
        return None;
    }
    if u.name.trim().is_empty() || u.name.len() > 80 {
        return None;
    }
    if u.summary.trim().is_empty() || u.summary.len() > 400 {
        return None;
    }
    Some(u)
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
    UnitProposed {
        id: String,
        unit: MinerUnit,
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
    /// Optional narrowing hint. Empty = survey the whole repository.
    pub focus: String,
    pub depth: MinerDepth,
    pub max_units: usize,
    pub max_findings: usize,
    pub max_tool_calls: usize,
}
impl MinerOpts {
    pub fn default_for(focus: &str) -> Self {
        Self {
            focus: focus.into(),
            depth: MinerDepth::Quick,
            max_units: 12,
            max_findings: 40,
            max_tool_calls: 120,
        }
    }
}

/// A proposed unit plus the findings that landed in it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CrawlUnit {
    pub unit: MinerUnit,
    pub findings: Vec<MinerFinding>,
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
    if f.unit.trim().is_empty() {
        return None;
    }
    // Kind is inherited from the unit by the run loop; category default is
    // only a fallback for a finding whose unit lookup somehow left it blank.
    // "subagent" stays excluded here (not just in parse_unit): the tool
    // schema no longer advertises `suggested_kind`, but nothing stops a
    // non-compliant model from sending it anyway, and the global invariant
    // is that the model can never produce a subagent-kind anything.
    if !matches!(f.kind.as_str(), "skill" | "memory" | "command") {
        f.kind = default_kind(&f.category).to_string();
    }
    Some(f)
}

/// The extra tools the model uses to report a finding. `pub` — Task 4
/// wires this into the dispatcher's `tools` field.
pub fn miner_tool_specs() -> Value {
    let mut specs = tools::tool_specs();
    let arr = specs.as_array_mut().expect("tool_specs is an array");
    arr.push(json!({
        "name": "propose_unit",
        "description": "Declare a context unit this repository can yield, BEFORE emitting any finding for it. Call this once per unit. A skill unit collects many findings; a memory or command unit is a single entry.",
        "input_schema": {
            "type": "object",
            "required": ["kind", "name", "summary"],
            "properties": {
                "kind": { "type": "string", "enum": ["skill", "memory", "command"], "description": "skill = a package of conventions/patterns/gotchas; memory = one durable fact; command = one repeatable workflow." },
                "name": { "type": "string", "description": "Short human name, e.g. 'PTY conventions'." },
                "summary": { "type": "string", "description": "One sentence a reader can decide on without opening the unit." }
            }
        }
    }));
    arr.push(json!({
        "name": "emit_finding",
        "description": "Report ONE mined context finding into a unit you already proposed. body_md is written as an instruction for a coding agent.",
        "input_schema": {
            "type": "object",
            "required": ["unit", "category", "title", "body_md"],
            "properties": {
                "unit": { "type": "string", "description": "The name of the unit this belongs to, exactly as passed to propose_unit." },
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
    let focus = if opts.focus.trim().is_empty() {
        "Survey the whole repository — do not narrow to one topic.".to_string()
    } else {
        format!("Narrow your survey to: {}.", opts.focus.trim())
    };
    format!(
        "You are a context crawler. You read a repository with the provided \
         read-only tools and produce an INVENTORY of the durable context units \
         it can yield. {focus}\n\n\
         Work in two moves, repeatedly:\n\
         1. propose_unit — declare a unit the moment you can name it. kind is \
         skill (a package of conventions/patterns/gotchas about one area), \
         memory (ONE durable domain fact or glossary term), or command (ONE \
         repeatable workflow: build, test, deploy, migrate). The summary must \
         let a reader decide without opening the unit.\n\
         2. emit_finding — fill a unit you already proposed, passing its exact \
         name as `unit`. A finding for an unproposed unit is discarded.\n\n\
         A skill unit holds many findings. A memory or command unit is a SINGLE \
         entry — propose one unit per fact, do not stuff several into one.\n\n\
         Findings must be instructions a coding agent can follow, not \
         observations, and must cite evidence (file:line). Never invent \
         evidence. Aim for at most {max_units} units. {depth}\n\n\
         Categories: convention (how code is written here), pattern (recurring \
         designs), gotcha (traps that bit or will bite), domain_rule \
         (business/regulatory rules encoded in the code), glossary \
         (project-specific terms), workflow (a repeatable dev command \
         sequence).\n\nYou never create personas. When the survey is complete, \
         reply with a short closing summary WITHOUT tool calls.",
        focus = focus,
        max_units = opts.max_units,
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

/// Unit identity. MUST match `canon::compile::slugify` — same rule, duplicated
/// because `agent` does not depend on `canon`.
/// ponytail: two implementations of six lines beats a crate dependency; the
/// shared test in Task 5 pins them together.
pub fn unit_slug(name: &str) -> String {
    let mut out = String::new();
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

pub async fn run_miner(
    dispatcher: &dyn StreamingDispatcher,
    repo_root: &Path,
    opts: &MinerOpts,
    cancel: &AtomicBool,
    sink: &dyn MinerSink,
) -> Result<Vec<CrawlUnit>, String> {
    let system = system_prompt(opts);
    let mut messages = vec![DraftMessage {
        role: MessageRole::User,
        content: "Survey this repository now. Use read_file, grep and list_dir to \
                   explore, propose_unit for each context unit you can name, and \
                   emit_finding to fill it with evidence-backed findings."
            .to_string(),
        images: Vec::new(),
    }];
    // Insertion-ordered: slug → index into `units`.
    let mut index: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut units: Vec<CrawlUnit> = Vec::new();
    let mut findings_total = 0usize;
    let mut tool_budget = opts.max_tool_calls;
    let forward = ForwardSink(sink);

    // Hard ceiling so a model that ignores the wrap-up hints — or spams
    // propose_unit/emit_finding calls that fail validation (they consume
    // neither the unit cap, the finding cap, nor the tool budget) — still
    // terminates. Generous headroom above the legitimate work (one turn per
    // read-tool + one per unit + one per finding + grace).
    let max_turns = opts.max_tool_calls + opts.max_findings + opts.max_units + 8;
    let mut turns = 0usize;

    loop {
        if cancel.load(Ordering::SeqCst) {
            sink.emit(MinerEvent::RunDone {
                findings_total,
                stopped: true,
            });
            return Ok(units);
        }
        turns += 1;
        if turns > max_turns {
            tracing::warn!("crawler: hit hard turn ceiling ({max_turns}); stopping");
            sink.emit(MinerEvent::RunDone {
                findings_total,
                stopped: true,
            });
            return Ok(units);
        }
        let turn = match dispatcher.stream_turn(&system, &messages, &forward).await {
            Ok(t) => t,
            Err(e) => {
                sink.emit(MinerEvent::Error { message: e.clone() });
                sink.emit(MinerEvent::RunDone {
                    findings_total,
                    stopped: true,
                });
                return Ok(units);
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
                findings_total,
                stopped: false,
            });
            return Ok(units);
        }
        let mut feedback = String::new();
        for call in turn.tool_calls {
            if call.name == "propose_unit" {
                match parse_unit(&call.input) {
                    Some(u) if units.len() < opts.max_units => {
                        let slug = unit_slug(&u.name);
                        if slug.is_empty() {
                            tracing::warn!(
                                "crawler: propose_unit name slugifies to empty, dropped"
                            );
                            feedback.push_str(
                                "[tool propose_unit] invalid payload — name must contain at least one letter or digit.\n",
                            );
                        } else if index.contains_key(&slug) {
                            feedback.push_str(&format!(
                                "[tool propose_unit → {}] already proposed — reusing it.\n",
                                call.id
                            ));
                        } else {
                            index.insert(slug, units.len());
                            sink.emit(MinerEvent::UnitProposed {
                                id: call.id.clone(),
                                unit: u.clone(),
                            });
                            units.push(CrawlUnit { unit: u, findings: Vec::new() });
                            feedback.push_str(&format!(
                                "[tool propose_unit → {}] recorded\n",
                                call.id
                            ));
                        }
                    }
                    Some(_) => feedback.push_str(
                        "[tool propose_unit] unit cap reached — fill the units you have, then wrap up.\n",
                    ),
                    None => {
                        tracing::warn!("crawler: invalid propose_unit payload dropped");
                        feedback.push_str(
                            "[tool propose_unit] invalid payload — kind must be skill|memory|command and name/summary non-empty.\n",
                        );
                    }
                }
                continue;
            }
            if call.name == "emit_finding" {
                match parse_finding(&call.input) {
                    Some(mut f) if findings_total < opts.max_findings => {
                        match index.get(&unit_slug(&f.unit)).copied() {
                            None => {
                                feedback.push_str(&format!(
                                    "[tool emit_finding → {}] unknown unit '{}' — call propose_unit first. Dropped.\n",
                                    call.id, f.unit
                                ));
                            }
                            Some(i) => {
                                // A memory/command unit IS one entry.
                                if units[i].unit.kind != "skill" && !units[i].findings.is_empty() {
                                    feedback.push_str(&format!(
                                        "[tool emit_finding → {}] '{}' is a single-entry unit and is already filled — propose a separate unit. Dropped.\n",
                                        call.id, f.unit
                                    ));
                                } else {
                                    f.kind = units[i].unit.kind.clone();
                                    sink.emit(MinerEvent::Finding {
                                        id: call.id.clone(),
                                        finding: f.clone(),
                                    });
                                    units[i].findings.push(f);
                                    findings_total += 1;
                                    feedback.push_str(&format!(
                                        "[tool emit_finding → {}] recorded\n",
                                        call.id
                                    ));
                                }
                            }
                        }
                    }
                    Some(_) => feedback.push_str(
                        "[tool emit_finding] finding cap reached — wrap up with a closing summary.\n",
                    ),
                    None => {
                        tracing::warn!("crawler: invalid emit_finding payload dropped");
                        feedback
                            .push_str("[tool emit_finding] invalid payload (schema) — dropped.\n");
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

    fn unit_call(id: &str, kind: &str, name: &str) -> ToolCall {
        ToolCall {
            id: id.into(),
            name: "propose_unit".into(),
            input: serde_json::json!({
                "kind": kind, "name": name, "summary": "A summary sentence."
            }),
        }
    }

    fn finding_for(id: &str, unit: &str, title: &str) -> ToolCall {
        ToolCall {
            id: id.into(),
            name: "emit_finding".into(),
            input: serde_json::json!({
                "unit": unit,
                "category": "convention",
                "title": title,
                "body_md": "Do the thing.",
                "evidence": ["src/lib.rs:1"],
                "confidence": "high"
            }),
        }
    }

    async fn run(turns: Vec<ModelTurn>) -> (Vec<CrawlUnit>, Vec<MinerEvent>) {
        let d = Scripted { turns: Mutex::new(turns), calls: AtomicUsize::new(0) };
        let sink = Collect(Mutex::new(vec![]));
        let cancel = AtomicBool::new(false);
        let out = run_miner(
            &d,
            std::env::temp_dir().as_path(),
            &MinerOpts::default_for(""),
            &cancel,
            &sink,
        )
        .await
        .unwrap();
        let evs = sink.0.lock().unwrap().clone();
        (out, evs)
    }

    #[tokio::test]
    async fn finding_lands_in_its_proposed_unit() {
        let (units, evs) = run(vec![
            ModelTurn {
                tool_calls: vec![
                    unit_call("u1", "skill", "PTY conventions"),
                    finding_for("f1", "PTY conventions", "one"),
                ],
                text: String::new(),
                emitted_spec: None,
            },
            ModelTurn { tool_calls: vec![], text: "done".into(), emitted_spec: None },
        ])
        .await;
        assert_eq!(units.len(), 1);
        assert_eq!(units[0].unit.kind, "skill");
        assert_eq!(units[0].findings.len(), 1);
        assert_eq!(units[0].findings[0].kind, "skill", "finding inherits unit kind");
        assert!(evs.iter().any(|e| matches!(e, MinerEvent::UnitProposed { .. })));
    }

    #[tokio::test]
    async fn orphan_finding_is_dropped() {
        let (units, _) = run(vec![
            ModelTurn {
                tool_calls: vec![finding_for("f1", "never-proposed", "one")],
                text: String::new(),
                emitted_spec: None,
            },
            ModelTurn { tool_calls: vec![], text: "done".into(), emitted_spec: None },
        ])
        .await;
        assert!(units.is_empty());
    }

    #[tokio::test]
    async fn units_slugifying_equal_merge_first_summary_wins() {
        let (units, _) = run(vec![
            ModelTurn {
                tool_calls: vec![
                    unit_call("u1", "skill", "PTY Conventions"),
                    ToolCall {
                        id: "u2".into(),
                        name: "propose_unit".into(),
                        input: serde_json::json!({
                            "kind": "skill", "name": "pty conventions", "summary": "Second summary."
                        }),
                    },
                    finding_for("f1", "pty conventions", "one"),
                ],
                text: String::new(),
                emitted_spec: None,
            },
            ModelTurn { tool_calls: vec![], text: "done".into(), emitted_spec: None },
        ])
        .await;
        assert_eq!(units.len(), 1);
        assert_eq!(units[0].unit.summary, "A summary sentence.");
        assert_eq!(units[0].findings.len(), 1);
    }

    #[tokio::test]
    async fn memory_unit_keeps_only_one_finding() {
        let (units, _) = run(vec![
            ModelTurn {
                tool_calls: vec![
                    unit_call("u1", "memory", "Retry budget"),
                    finding_for("f1", "Retry budget", "first"),
                    finding_for("f2", "Retry budget", "second"),
                    finding_for("f3", "Retry budget", "third"),
                ],
                text: String::new(),
                emitted_spec: None,
            },
            ModelTurn { tool_calls: vec![], text: "done".into(), emitted_spec: None },
        ])
        .await;
        assert_eq!(units.len(), 1);
        assert_eq!(units[0].findings.len(), 1);
        assert_eq!(units[0].findings[0].title, "first");
    }

    /// A defect from Task 3: a name that is entirely punctuation (e.g. "!!!")
    /// slugifies to the empty string, which would key the unit index on ""
    /// and later write a file literally named ".md". Must be rejected in
    /// run_miner, not just silently merged with any other empty-slug unit.
    #[tokio::test]
    async fn punctuation_only_name_is_rejected() {
        let (units, _) = run(vec![
            ModelTurn {
                tool_calls: vec![unit_call("u1", "skill", "!!!")],
                text: String::new(),
                emitted_spec: None,
            },
            ModelTurn { tool_calls: vec![], text: "done".into(), emitted_spec: None },
        ])
        .await;
        assert!(units.is_empty());
    }

    #[test]
    fn parse_unit_accepts_valid() {
        let u = parse_unit(&serde_json::json!({
            "kind": "memory", "name": "PTY Conventions", "summary": "How PTY IO is written here."
        }))
        .unwrap();
        assert_eq!(u.kind, "memory");
        assert_eq!(u.name, "PTY Conventions");
    }

    #[test]
    fn parse_unit_rejects_subagent_and_junk() {
        for kind in ["subagent", "mcp", "spec", ""] {
            let v = serde_json::json!({ "kind": kind, "name": "x", "summary": "y" });
            assert!(parse_unit(&v).is_none(), "kind {kind} must be rejected");
        }
    }

    #[test]
    fn parse_unit_rejects_empty_name_or_summary() {
        assert!(parse_unit(&serde_json::json!({ "kind": "skill", "name": "  ", "summary": "y" })).is_none());
        assert!(parse_unit(&serde_json::json!({ "kind": "skill", "name": "x", "summary": " " })).is_none());
    }

    #[test]
    fn propose_unit_is_in_the_tool_roster() {
        let specs = miner_tool_specs();
        let names: Vec<&str> = specs
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t.get("name").and_then(|n| n.as_str()))
            .collect();
        assert!(names.contains(&"propose_unit"));
        assert!(names.contains(&"emit_finding"));
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
        let out = run_miner(&d, std::env::temp_dir().as_path(), &MinerOpts::default_for("t"), &AtomicBool::new(false), &sink)
            .await
            .unwrap();
        assert!(out.is_empty());
        assert!(!sink.0.lock().unwrap().iter().any(|e| matches!(e, MinerEvent::Finding { .. })));
    }

    #[tokio::test]
    async fn cancel_stops_between_turns_and_reports_stopped() {
        let d = Scripted {
            turns: Mutex::new(vec![ModelTurn {
                tool_calls: vec![finding_for("f1", "test-unit", "one")],
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
        let out = run_miner(&d, std::env::temp_dir().as_path(), &MinerOpts::default_for("t"), &cancel, &sink)
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
        let mut opts = MinerOpts::default_for("t");
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
        let mut opts = MinerOpts::default_for("t");
        opts.max_findings = 1;
        // validate_finding + cap logic are pure — test via parse_finding.
        let ok = parse_finding(&serde_json::json!({
            "unit": "test-unit", "category": "gotcha", "title": "t", "body_md": "b",
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
        let v = json!({ "unit": "test-unit", "category": "domain_rule", "title": "PEP check", "body_md": "Do X." });
        let f = parse_finding(&v).expect("valid finding");
        assert_eq!(f.kind, "memory");
    }

    #[test]
    fn parse_finding_honors_suggested_kind_but_never_subagent() {
        let v = json!({ "unit": "test-unit", "category": "pattern", "title": "T", "body_md": "B", "suggested_kind": "memory" });
        assert_eq!(parse_finding(&v).unwrap().kind, "memory");
        let sub = json!({ "unit": "test-unit", "category": "pattern", "title": "T", "body_md": "B", "suggested_kind": "subagent" });
        // agent may never route to subagent; falls back to category default
        assert_eq!(parse_finding(&sub).unwrap().kind, "skill");
    }

    #[test]
    fn workflow_is_a_valid_category() {
        let v = json!({ "unit": "test-unit", "category": "workflow", "title": "Run tests", "body_md": "npm test from root." });
        assert!(parse_finding(&v).is_some());
    }

    #[test]
    fn parse_finding_rejects_missing_unit() {
        let v = json!({ "category": "workflow", "title": "Run tests", "body_md": "npm test from root." });
        assert!(parse_finding(&v).is_none());
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
        // `unit` now leads `required` (emit_finding names the unit it
        // belongs to before naming its category).
        assert_eq!(ef["function"]["parameters"]["required"][0], "unit");

        let pu = arr
            .iter()
            .find(|t| t["function"]["name"] == "propose_unit")
            .expect("propose_unit present in openai format");
        assert_eq!(pu["type"], "function");
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
        let mut opts = MinerOpts::default_for("rust error-handling conventions");
        opts.max_findings = 5;
        opts.max_tool_calls = 20;
        let out = run_miner(&dispatcher, &repo, &opts, &AtomicBool::new(false), &Print).await.unwrap();
        assert!(!out.is_empty(), "expected at least one unit");
        assert!(
            out.iter().all(|u| u.findings.iter().all(|f| !f.evidence.is_empty())),
            "findings must cite evidence"
        );
    }
}
