# Handoff Skill-Based Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace name-addressed inter-operator handoff (`to_operator: "<name>"`) with capability-addressed routing: the delegator declares the skills the work needs, and the router picks the best-suited available teammate.

**Architecture:** Operators' existing `tags` become their skillset. `handoff_task` swaps `to_operator` for `required_skills`, whose schema enum is the live union of all operators' tags (so the LLM can only request skills that exist — no names, no hallucination). A new pure matcher `resolve_by_skills` ranks candidates by `(available, overlap_count, xp)`, excluding the delegator, and returns the winner or `None`. The safety gate's `UnknownOperator` becomes `NoCapableOperator`. No storage migration — `tags` already persists.

**Tech Stack:** Rust, Tokio, `serde_json`. Tests are `#[test]` / `#[tokio::test]` using the existing teammate test helpers. One small frontend edit (TS label) in `ui/src/settings/operators.ts`.

**Spec:** `docs/superpowers/specs/2026-06-16-handoff-skill-routing-design.md`

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `crates/app/src/teammate/handoff_safety.rs` | rename `UnknownOperator` → `NoCapableOperator` + message + tests | modify |
| `crates/app/src/teammate/handoff.rs` | add `skill_union`, `overlap_count`, `resolve_by_skills`; route uses skills; remove old `resolve`; tests | modify |
| `crates/app/src/teammate/types.rs` | `HandoffRequest.to_operator` → `required_skills: Vec<String>` | modify |
| `crates/app/src/teammate/tools.rs` | `handoff_task_tool_def(available_skills)` — `required_skills` enum; `ToolEnv.available_skills` + `with_skills` | modify |
| `crates/app/src/teammate/llm.rs` | both extractors parse `required_skills`; `all_tool_defs` conditionally includes handoff; prompt blurb; tests | modify |
| `crates/app/src/teammate/commands.rs` | thread `skill_union(roster)` into `ToolEnv` | modify |
| `ui/src/settings/operators.ts` | relabel "Tags" → "Skills" (both editors) | modify |

Each task leaves the workspace compiling and green.

---

## Task 1: Rename safety reject `UnknownOperator` → `NoCapableOperator`

**Files:**
- Modify: `crates/app/src/teammate/handoff_safety.rs`
- Modify: `crates/app/src/teammate/handoff.rs` (one test assertion references the old variant)

- [ ] **Step 1: Update the test assertions first**

In `crates/app/src/teammate/handoff_safety.rs`, replace the `rejects_unknown_operator` test (currently ~line 93) with:

```rust
    #[test]
    fn rejects_no_capable_operator() {
        let a = op();
        let mut i = base(a, op());
        i.to = None;
        assert_eq!(decide(&i), Err(HandoffReject::NoCapableOperator));
    }
```

In `crates/app/src/teammate/handoff.rs`, the test `rejects_unknown_operator` (~line 204) asserts `HandoffReject::UnknownOperator`. Leave that test alone for now — it will be rewritten in Task 4 when `route` switches to skills. To keep this task compiling, only the variant name must resolve; update that one assertion's variant token:

Find:
```rust
        assert!(matches!(r, RouteResult::Rejected { reason: HandoffReject::UnknownOperator, .. }));
```
Replace:
```rust
        assert!(matches!(r, RouteResult::Rejected { reason: HandoffReject::NoCapableOperator, .. }));
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p covenant_lib handoff_safety 2>&1 | tail -20`
Expected: FAIL — `no variant named NoCapableOperator found for enum HandoffReject`.

- [ ] **Step 3: Rename the variant and its message**

In `handoff_safety.rs`, in the `HandoffReject` enum, change `UnknownOperator,` to `NoCapableOperator,`.

In the `message()` match, change:
```rust
            HandoffReject::UnknownOperator => "no operator by that name".into(),
```
to:
```rust
            HandoffReject::NoCapableOperator => "no available teammate has the requested skills".into(),
```

In `decide()`, change the `None` arm:
```rust
        None => return Err(HandoffReject::NoCapableOperator),
```

Update the doc comment on `GateInput.to` from `// None = name didn't resolve` to `// None = no operator matched the requested skills`.

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p covenant_lib handoff_safety 2>&1 | tail -20`
Expected: PASS (7 tests).
Run: `cargo build -p covenant_lib 2>&1 | tail -5`
Expected: builds clean (handoff.rs assertion now resolves).

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/teammate/handoff_safety.rs crates/app/src/teammate/handoff.rs
git commit -m "refactor(handoff): rename UnknownOperator reject to NoCapableOperator"
```

---

## Task 2: Skill-matching helpers (pure, additive)

**Files:**
- Modify: `crates/app/src/teammate/handoff.rs` (add three functions + tests; do NOT remove old `resolve` yet)

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block in `handoff.rs` (the module already has `mk_operator`, which returns an owned `Operator` with public fields). Append:

```rust
    fn with_skills(name: &str, tags: &[&str], xp: u64) -> Operator {
        let mut o = mk_operator(name);
        o.tags = tags.iter().map(|s| s.to_string()).collect();
        o.xp = xp;
        o
    }

    #[test]
    fn skill_union_normalizes_dedups_sorts() {
        let roster = vec![
            with_skills("A", &["Rust", "migrations"], 0),
            with_skills("B", &["rust", "UI"], 0),
        ];
        assert_eq!(super::skill_union(&roster), vec!["migrations", "rust", "ui"]);
    }

    #[test]
    fn overlap_is_case_insensitive_and_deduped() {
        let tags = vec!["Rust".to_string(), "rust".to_string(), "ui".to_string()];
        assert_eq!(super::overlap_count(&tags, &["RUST".into()]), 1);
        assert_eq!(super::overlap_count(&tags, &["rust".into(), "ui".into()]), 2);
        assert_eq!(super::overlap_count(&tags, &["python".into()]), 0);
    }

    #[test]
    fn resolve_picks_highest_overlap() {
        let from = OperatorId(ulid::Ulid::new());
        let a = with_skills("A", &["rust"], 0);
        let b = with_skills("B", &["rust", "migrations"], 0);
        let roster = vec![a, b.clone()];
        let got = super::resolve_by_skills(&roster, &["rust".into(), "migrations".into()], from, |_| true);
        assert_eq!(got, Some(b.id));
    }

    #[test]
    fn resolve_excludes_delegator() {
        let a = with_skills("A", &["rust"], 999);
        let roster = vec![a.clone()];
        // delegator IS the only skilled operator → excluded → None
        let got = super::resolve_by_skills(&roster, &["rust".into()], a.id, |_| true);
        assert_eq!(got, None);
    }

    #[test]
    fn resolve_prefers_available_over_busy_at_equal_score() {
        let busy = with_skills("Busy", &["rust"], 1000);
        let free = with_skills("Free", &["rust"], 0);
        let from = OperatorId(ulid::Ulid::new());
        let roster = vec![busy.clone(), free.clone()];
        // busy has way more XP but is unavailable; free should win
        let got = super::resolve_by_skills(&roster, &["rust".into()], from, |id| id == free.id);
        assert_eq!(got, Some(free.id));
    }

    #[test]
    fn resolve_prefers_higher_xp_at_equal_score_and_availability() {
        let lo = with_skills("Lo", &["rust"], 10);
        let hi = with_skills("Hi", &["rust"], 90);
        let from = OperatorId(ulid::Ulid::new());
        let roster = vec![lo, hi.clone()];
        let got = super::resolve_by_skills(&roster, &["rust".into()], from, |_| true);
        assert_eq!(got, Some(hi.id));
    }

    #[test]
    fn resolve_none_on_zero_overlap() {
        let a = with_skills("A", &["rust"], 0);
        let from = OperatorId(ulid::Ulid::new());
        let roster = vec![a];
        assert_eq!(super::resolve_by_skills(&roster, &["python".into()], from, |_| true), None);
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p covenant_lib teammate::handoff:: 2>&1 | tail -20`
Expected: FAIL — `cannot find function skill_union` / `overlap_count` / `resolve_by_skills`.

- [ ] **Step 3: Add the helpers**

In `handoff.rs`, at module scope (near the existing `fn resolve`, which stays for now), add:

```rust
/// Lowercase, trim, dedup, and sort the union of all operators' tags — the
/// team's skill vocabulary. Advertised in the `handoff_task` tool schema so
/// the delegator can only request skills that exist.
pub fn skill_union(roster: &[Operator]) -> Vec<String> {
    let mut set: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for o in roster {
        for t in &o.tags {
            let s = t.trim().to_ascii_lowercase();
            if !s.is_empty() {
                set.insert(s);
            }
        }
    }
    set.into_iter().collect()
}

/// How many DISTINCT requested skills an operator covers (case-insensitive).
fn overlap_count(op_tags: &[String], required: &[String]) -> usize {
    let req: std::collections::HashSet<String> = required
        .iter()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    op_tags
        .iter()
        .map(|t| t.trim().to_ascii_lowercase())
        .filter(|t| req.contains(t))
        .collect::<std::collections::HashSet<_>>()
        .len()
}

/// Resolve the best-suited peer for `required` skills. Excludes `from`
/// (no self-handoff). Ranks candidates by `(available, overlap, xp)`
/// descending — availability outranks raw skill match so the work goes to
/// someone who can start now. Returns `None` when no operator overlaps
/// at least one requested skill.
fn resolve_by_skills(
    roster: &[Operator],
    required: &[String],
    from: OperatorId,
    is_available: impl Fn(OperatorId) -> bool,
) -> Option<OperatorId> {
    roster
        .iter()
        .filter(|o| o.id != from)
        .filter_map(|o| {
            let c = overlap_count(&o.tags, required);
            (c > 0).then_some((o, c))
        })
        .max_by_key(|(o, c)| (is_available(o.id) as u8, *c, o.xp))
        .map(|(o, _)| o.id)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p covenant_lib teammate::handoff:: 2>&1 | tail -25`
Expected: PASS (the new 7 helper tests plus the existing route tests still green; old `resolve` is unused-but-present — if clippy/`-D warnings` is on locally and flags dead code, ignore until Task 4 removes it; a plain `cargo test` only warns).

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/teammate/handoff.rs
git commit -m "feat(handoff): skill_union + overlap + resolve_by_skills matcher"
```

---

## Task 3: Swap the contract — `required_skills` everywhere, route by skills

This is the atomic type swap: `HandoffRequest.to_operator` → `required_skills` ripples to the two extractors, the tool def schema, and `route`. Done together so the crate stays compiling.

**Files:**
- Modify: `crates/app/src/teammate/types.rs`
- Modify: `crates/app/src/teammate/llm.rs`
- Modify: `crates/app/src/teammate/tools.rs`
- Modify: `crates/app/src/teammate/handoff.rs`

- [ ] **Step 1: Rewrite the extraction + route tests to the new shape**

In `llm.rs` tests, replace the `extracts_handoff_from_tool_use` test body (the JSON currently has `"to_operator": "Kiro"`, ~line 1267) with:

```rust
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
        assert_eq!(req.required_skills, vec!["rust".to_string(), "migrations".to_string()]);
        assert_eq!(req.executor, "codex");
        assert!(req.context.is_none());
    }
```

(The `handoff_extraction_ignores_other_tools` test needs no change.)

In `handoff.rs` tests, update the `req` helper (~line 184) and the route tests:

```rust
    fn req(skills: &[&str]) -> HandoffRequest {
        HandoffRequest {
            required_skills: skills.iter().map(|s| s.to_string()).collect(),
            brief: "do the thing".into(),
            deliverable: "thing done".into(),
            executor: "codex".into(),
            context: None,
        }
    }
```

Then update the four existing route tests. The `fixture()` builds Zeta + Kiro with **empty** tags today; give Kiro a skill so it can be matched. Replace the fixture's operator construction so Kiro has tags, and rewrite the tests:

```rust
    #[tokio::test]
    async fn happy_path_creates_task_and_edge() {
        let (s, rt, roster, zeta, kiro) = fixture().await;
        let _ = kiro; // kiro id unused directly
        let r = route(&s, &rt, &roster, zeta, ThreadId::new(), &req(&["rust"]), 100).await.unwrap();
        let acc = match r { RouteResult::Accepted(a) => a, _ => panic!("expected accept") };
        assert_eq!(acc.executor, "codex");
        let edge = s.teammate_get_handoff_by_task(acc.task.id).await.unwrap().unwrap();
        assert_eq!(edge.status, HandoffStatus::Running);
        assert_eq!(edge.depth, 0);
        assert!(matches!(rt.state(acc.task.operator_id), Some(OperatorState::OnTask { .. })));
    }

    #[tokio::test]
    async fn rejects_no_capable_operator() {
        let (s, rt, roster, zeta, _kiro) = fixture().await;
        let r = route(&s, &rt, &roster, zeta, ThreadId::new(), &req(&["python"]), 100).await.unwrap();
        assert!(matches!(r, RouteResult::Rejected { reason: HandoffReject::NoCapableOperator, .. }));
    }

    #[tokio::test]
    async fn excludes_delegator_from_routing() {
        // Only the delegator (Zeta) carries the skill → no peer matches → NoCapableOperator.
        let (s, rt, roster, zeta, _kiro) = fixture().await;
        let r = route(&s, &rt, &roster, zeta, ThreadId::new(), &req(&["ops"]), 100).await.unwrap();
        assert!(matches!(r, RouteResult::Rejected { reason: HandoffReject::NoCapableOperator, .. }));
    }

    #[tokio::test]
    async fn rejects_busy_receiver() {
        let (s, rt, roster, zeta, kiro) = fixture().await;
        rt.start_task(kiro, TaskId::new(), None).unwrap(); // Kiro (only "rust" peer) is busy
        let r = route(&s, &rt, &roster, zeta, ThreadId::new(), &req(&["rust"]), 100).await.unwrap();
        assert!(matches!(r, RouteResult::Rejected { reason: HandoffReject::ReceiverBusy, .. }));
    }
```

Update `fixture()` so Zeta has skill `"ops"` and Kiro has skill `"rust"` (so the tests above resolve as intended). Find the two `mk_operator("Zeta")` / `mk_operator("Kiro")` lines in `fixture()` and set their tags:

```rust
        let mut zeta = mk_operator("Zeta");
        zeta.tags = vec!["ops".into()];
        let mut kiro = mk_operator("Kiro");
        kiro.tags = vec!["rust".into()];
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p covenant_lib teammate::handoff:: extracts_handoff_from_tool_use 2>&1 | tail -25`
Expected: FAIL to **compile** — `HandoffRequest` has no field `required_skills` (and old code still sets `to_operator`).

- [ ] **Step 3a: Swap the type** in `types.rs` (~line 271):

```rust
/// Parsed `handoff_task` tool input (LLM boundary), before routing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HandoffRequest {
    /// Capabilities the work needs; the router resolves these to a teammate.
    pub required_skills: Vec<String>,
    pub brief: String,
    pub deliverable: String,
    pub executor: String,
    #[serde(default)]
    pub context: Option<String>,
}
```

- [ ] **Step 3b: Update both extractors** in `llm.rs`.

In `extract_handoff_from_content` (~line 963), replace the `to_operator` line with a `required_skills` parse:

```rust
        return Some(crate::teammate::types::HandoffRequest {
            required_skills: input
                .get("required_skills")?
                .as_array()?
                .iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect(),
            brief:       input.get("brief")?.as_str()?.to_string(),
            deliverable: input.get("deliverable")?.as_str()?.to_string(),
            executor:    input.get("executor")?.as_str()?.to_string(),
            context:     input.get("context").and_then(|v| v.as_str()).map(|s| s.to_string()),
        });
```

In `extract_handoff_from_openai_tool_calls` (~line 988), apply the identical change to its `HandoffRequest { ... }` constructor (same field swap).

- [ ] **Step 3c: Update the tool def schema** in `tools.rs` (`handoff_task_tool_def`, ~line 654). Keep the no-arg signature for now (the dynamic enum + skills param arrive in Task 4); swap `to_operator` for a free-form `required_skills` array and update `required`/description:

```rust
pub fn handoff_task_tool_def() -> Value {
    serde_json::json!({
        "name": "handoff_task",
        "description":
            "Delegate a concrete, self-contained unit of work to ANOTHER operator by the \
             CAPABILITIES it needs. The system routes to the best-suited available teammate — \
             you do NOT name anyone. Use when a peer's skills fit the work better than yours. \
             Restate the goal in plain words — never pass a raw @token (the receiver has no \
             access to your mention registry).",
        "input_schema": {
            "type": "object",
            "required": ["required_skills", "brief", "deliverable", "executor"],
            "properties": {
                "required_skills": {
                    "type": "array",
                    "items": { "type": "string" },
                    "minItems": 1,
                    "description": "The capabilities the work needs (e.g. [\"rust\", \"migrations\"]). The system routes to the best-suited available teammate."
                },
                "brief":       { "type": "string", "description": "Self-contained description of the work. No @tokens." },
                "deliverable": { "type": "string", "description": "What 'done' looks like." },
                "executor": {
                    "type": "string",
                    "enum": ["claude", "codex", "copilot", "pi", "hermes"],
                    "description": "Which executor CLI the receiver should drive."
                },
                "context": { "type": "string", "description": "Optional already-resolved facts (file contents, paths) to inline for the receiver." }
            }
        }
    })
}
```

- [ ] **Step 3d: Route by skills** in `handoff.rs`. Replace the `resolve` call at the top of `route` (~line 45):

Find:
```rust
    // 1. Resolve target.
    let to = resolve(roster, &req.to_operator);
```
Replace:
```rust
    // 1. Resolve target by capability — best-suited AVAILABLE peer, self excluded.
    let to = resolve_by_skills(
        roster,
        &req.required_skills,
        from_operator_id,
        |id| !matches!(runtime.state(id), Some(OperatorState::OnTask { .. })),
    );
```

Then DELETE the now-unused old `resolve` fn (the `fn resolve(roster, name)` at ~line 30) and its doc comment.

- [ ] **Step 3e: Update the system-prompt blurb** in `llm.rs` (the `handoff_task` line in the tool-list section of `build_system_prompt`, search for `handoff_task` near the prompt text ~line 217):

```
         - `handoff_task` — delegate a self-contained sub-task by the \
           CAPABILITIES it needs (e.g. rust, migrations); the system routes \
           to the best-suited available teammate. You do NOT name anyone. \
           Use when a peer's skills fit the work better than yours.\n\
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p covenant_lib teammate::handoff:: 2>&1 | tail -25`
Expected: PASS (4 route tests).
Run: `cargo test -p covenant_lib extracts_handoff_from_tool_use handoff_extraction_ignores_other_tools 2>&1 | tail -15`
Expected: PASS (2 tests).
Run: `cargo build -p covenant_lib 2>&1 | tail -10`
Expected: clean (old `resolve` removed; no `to_operator` references remain).

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/teammate/types.rs crates/app/src/teammate/llm.rs \
        crates/app/src/teammate/tools.rs crates/app/src/teammate/handoff.rs
git commit -m "feat(handoff): route by required_skills instead of operator name"
```

---

## Task 4: Dynamic skill enum + omit-when-no-skills plumbing

Advertise the team's real skill vocabulary in the tool schema, and drop the tool entirely when no operator has any skills.

**Files:**
- Modify: `crates/app/src/teammate/tools.rs` (`ToolEnv` + `handoff_task_tool_def` signature)
- Modify: `crates/app/src/teammate/llm.rs` (`all_tool_defs` conditional + tests)
- Modify: `crates/app/src/teammate/commands.rs` (attach skills to `ToolEnv`)

- [ ] **Step 1: Write the failing tests**

In `llm.rs` tests, replace the `github_tools_registered_by_access_level` test (~line 1287) so each `ToolEnv` carries a skill (keeping `handoff_task` present) and add two new tests:

```rust
    #[test]
    fn github_tools_registered_by_access_level() {
        use crate::operator_registry::GithubAccess;
        use crate::teammate::tools::{GithubCtx, ToolEnv};
        let base = ToolEnv::new(std::env::temp_dir(), 1024).with_skills(vec!["rust".into()]);
        assert_eq!(all_tool_defs(&base).len(), 9); // 8 base + handoff_task

        let ro = ToolEnv::new(std::env::temp_dir(), 1024)
            .with_skills(vec!["rust".into()])
            .with_github(Some(GithubCtx { token: "t".into(), access: GithubAccess::ReadOnly, api_base: "x".into() }));
        assert_eq!(all_tool_defs(&ro).len(), 9 + 5);

        let rw = ToolEnv::new(std::env::temp_dir(), 1024)
            .with_skills(vec!["rust".into()])
            .with_github(Some(GithubCtx { token: "t".into(), access: GithubAccess::ReadWrite, api_base: "x".into() }));
        let names: Vec<&str> = all_tool_defs(&rw).iter().map(|d| d["name"].as_str().unwrap()).collect();
        assert_eq!(names.len(), 9 + 9);
        assert!(names.contains(&"gh_create_issue"));
    }

    #[test]
    fn handoff_omitted_when_no_skills() {
        use crate::teammate::tools::ToolEnv;
        let env = ToolEnv::new(std::env::temp_dir(), 1024); // no skills
        let names: Vec<&str> = all_tool_defs(&env).iter().map(|d| d["name"].as_str().unwrap()).collect();
        assert_eq!(names.len(), 8);
        assert!(!names.contains(&"handoff_task"));
    }

    #[test]
    fn handoff_schema_enum_reflects_available_skills() {
        use crate::teammate::tools::ToolEnv;
        let env = ToolEnv::new(std::env::temp_dir(), 1024).with_skills(vec!["rust".into(), "ui".into()]);
        let def = all_tool_defs(&env).into_iter().find(|d| d["name"] == "handoff_task").unwrap();
        let enm = &def["input_schema"]["properties"]["required_skills"]["items"]["enum"];
        assert_eq!(enm, &serde_json::json!(["rust", "ui"]));
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p covenant_lib handoff_omitted_when_no_skills handoff_schema_enum_reflects_available_skills 2>&1 | tail -20`
Expected: FAIL — `no method named with_skills found for struct ToolEnv`.

- [ ] **Step 3a: Add `available_skills` to `ToolEnv`** in `tools.rs`.

In the `ToolEnv` struct (~line 37), add a field after `github`:

```rust
    /// The team's skill vocabulary (union of all operators' tags), used to
    /// build the `handoff_task` `required_skills` enum. Empty → the
    /// `handoff_task` tool is omitted (nothing to route on).
    pub available_skills: Vec<String>,
```

In `ToolEnv::new` (~line 71), initialize it:

```rust
    pub fn new(root: PathBuf, max_bytes_per_file: usize) -> Self {
        Self { root, max_bytes_per_file, active_screen: None, github: None, available_skills: Vec::new() }
    }
```

Add a builder next to `with_github`:

```rust
    /// Attach the team's skill vocabulary (builder style).
    pub fn with_skills(mut self, skills: Vec<String>) -> Self {
        self.available_skills = skills;
        self
    }
```

- [ ] **Step 3b: Make the tool def take the vocabulary** in `tools.rs`. Change the signature and inject the enum:

```rust
pub fn handoff_task_tool_def(available_skills: &[String]) -> Value {
```

and within its schema, change the `required_skills.items` from `{ "type": "string" }` to:

```rust
                    "items": { "type": "string", "enum": available_skills },
```

(`serde_json::json!` serializes the `&[String]` as a JSON array.)

- [ ] **Step 3c: Conditionally include handoff** in `llm.rs` `all_tool_defs` (~line 535). Remove `tools::handoff_task_tool_def(),` from the static `vec!` and push it conditionally after the base list, before the github block:

```rust
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
```

- [ ] **Step 3d: Attach skills at the dispatch site** in `commands.rs` (~line 237). The `ToolEnv` is built there and `registry_bg` (the roster handle) is already in scope (cloned at line 134). Change:

```rust
            let tool_env = crate::teammate::tools::ToolEnv::new(root, 200 * 1024)
                .with_screen(active_screen);
```
to:

```rust
            let tool_env = crate::teammate::tools::ToolEnv::new(root, 200 * 1024)
                .with_screen(active_screen)
                .with_skills(crate::teammate::handoff::skill_union(&registry_bg.list()));
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p covenant_lib handoff_omitted_when_no_skills handoff_schema_enum_reflects_available_skills github_tools_registered_by_access_level 2>&1 | tail -20`
Expected: PASS (3 tests).
Run: `cargo build -p covenant_lib 2>&1 | tail -10`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/teammate/tools.rs crates/app/src/teammate/llm.rs crates/app/src/teammate/commands.rs
git commit -m "feat(handoff): advertise dynamic skill enum, omit handoff_task when no skills"
```

---

## Task 5: Relabel "Tags" → "Skills" in the operator editor

The `tags` field IS the skillset now; the UI should say so. No data change.

**Files:**
- Modify: `ui/src/settings/operators.ts` (two label sites: ~line 407 and ~line 1264)

- [ ] **Step 1: Update the markup-template label** (~line 407)

Find:
```ts
        <label>Tags <span class="muted">(comma-separated)</span></label>
```
Replace:
```ts
        <label>Skills <span class="muted">(comma-separated — drive who gets handed work)</span></label>
```

- [ ] **Step 2: Update the programmatic label** (~line 1264)

Find:
```ts
    identity.append(labeled("Tags", tags));
```
Replace:
```ts
    identity.append(labeled("Skills", tags));
```

- [ ] **Step 3: Verify the frontend builds**

Run: `cd ui && npx tsc --noEmit 2>&1 | tail -15`
Expected: no new type errors (label text change only; the `data-bind="tags"` attribute and `view.tags` field are untouched).

- [ ] **Step 4: Commit**

```bash
git add ui/src/settings/operators.ts
git commit -m "feat(handoff): relabel operator Tags as Skills (routing capability)"
```

---

## Task 6: Full suite + clippy gate

- [ ] **Step 1: Teammate suite**

Run: `cargo test -p covenant_lib teammate:: 2>&1 | tail -30`
Expected: all green (new skill tests + existing teammate tests).

> Per `reference_covenant_test_gotchas`: keep filters narrow — telegram long-poll tests can hang under a broad `cargo test`; `context::tests` version tests can fail environmentally. macOS has no `timeout`. If a broad run hangs, `pkill covenant_lib` and re-run the narrow filter.

- [ ] **Step 2: Clippy**

Run: `cargo clippy -p covenant_lib 2>&1 | tail -30`
Expected: no new warnings in `handoff.rs` / `handoff_safety.rs` / `tools.rs` / `llm.rs`. In particular, confirm no dead-code warning for a leftover `resolve` (it was removed in Task 3).

- [ ] **Step 3: Commit any fixups**

```bash
git add -A && git commit -m "chore(handoff): clippy + skill-routing test pass"
```

---

## Self-review notes

- **Spec coverage:** §Changes.1 tool contract → T3 (schema) + T4 (dynamic enum); .2 types → T3; .3 extraction/threading → T3 (extractors) + T4 (ToolEnv + commands); .4 router → T2 (matcher) + T3 (route swap); .5 safety rename → T1; .6 prompt → T3; .7 event unchanged → no task (verified); .8 UI relabel → T5. Testing section → tests embedded per task + T6 gate.
- **Type consistency:** `HandoffRequest.required_skills: Vec<String>` is defined in T3 and consumed identically by both extractors (T3) and the `req(&["..."])` test helper (T3). `resolve_by_skills(roster, required, from, is_available)` defined in T2, called in T3's `route` with the runtime-availability closure. `skill_union(roster)` defined in T2, used in T4's `commands.rs`. `ToolEnv::with_skills` (T4) matches its use in T4 tests and `commands.rs`. `HandoffReject::NoCapableOperator` (T1) is asserted in T3's route tests.
- **Green between tasks:** T1 isolated rename; T2 purely additive (old `resolve` kept); T3 swaps the type + all its references in one commit (old `resolve` removed here); T4 plumbs the enum (handoff always-included in T3 → conditional in T4, with tests updated in the same task); T5 frontend-only; T6 gate.
- **No placeholders:** every code step shows the actual code; every run step shows the command + expected outcome.
- **Sequencing reminder:** this plan lands before the UI auto-spawn plan (`2026-06-16-inter-operator-handoff-ui-design.md`), which is unaffected by the addressing change (it consumes a resolved `to_operator` id from the `teammate-handoff-routed` event).
