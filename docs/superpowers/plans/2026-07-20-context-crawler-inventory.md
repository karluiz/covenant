# Context Crawler Inventory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Context Miner from a "find me one named skill" search into a whole-repo crawl that produces an inventory of candidate context units, each row carrying its Canon state (new / exists / changed / detected).

**Architecture:** Three layers change bottom-up. (1) `crates/canon` learns to overwrite md entries in place and to resolve a `(kind, slug, body)` triple against what Canon already holds. (2) `crates/agent`'s miner gains a `propose_unit` tool so the model declares units before filling them with findings, and drops `skill_name` from its options. (3) `crates/app` swaps the single-skill compile command for a unit-list one and exposes state resolution, then the UI renders an inventory instead of a flat card list.

**Tech Stack:** Rust (tokio, serde, thiserror), Tauri 2 commands, TypeScript + Vite (no framework), Vitest, `cargo test`.

**Spec:** `docs/superpowers/specs/2026-07-20-context-crawler-inventory-design.md`

## Global Constraints

- Working directory is the worktree `.claude/worktrees/context-crawler` on branch `worktree-context-crawler`. Do not `cd` to the main checkout.
- **Never run `git add -A`** — this worktree's `node_modules` is a symlink and `-A` commits it, clobbering main's deps. Stage every path explicitly.
- **Never run a bare `cargo test`** on the `covenant` crate — `telegram::tests` hangs. Scope it: `cargo test -p covenant canon`, `cargo test -p agent context_miner`, `cargo test -p canon`.
- Run `npm test` from the **repo root**, not `ui/`.
- No `unwrap()` outside `#[cfg(test)]` and `main()`.
- The model may never propose kind `subagent`. The `propose_unit` enum is `["skill","memory","command"]` and `parse_unit` rejects anything else. Subagent is reachable only by manual re-route in curation.
- UI copy is English. The surface is named **"Context Crawler"** in all user-visible strings. Rust modules, Tauri command names and TS file paths keep `miner` — do not rename them.
- New UI chrome uses `border-radius: 0` and the shared `.rail-row` classes; never `element.title` for tooltips, use `attachTooltip`.
- Unit identity is `(kind, canon::compile::slugify(name))` everywhere — Rust and TS must agree.

---

### Task 1: Canon compiler writes md entries in place

Today `write_md_entries` funnels every finding through `unique_slug`, which appends `-2`, `-3`, … forever. Re-crawling the same repo three times leaves three copies of the same memory. This task adds an `overwrite` path and extracts the entry rendering so later tasks can compare a candidate body against what is on disk.

**Files:**
- Modify: `crates/canon/src/compile.rs:118-144`
- Test: `crates/canon/src/compile.rs` (existing `#[cfg(test)] mod tests` at the bottom of the file)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `pub fn render_md_entry(f: &CompiledFinding) -> String`
  - `pub fn write_memory_entry(repo_root: &Path, findings: &[CompiledFinding], overwrite: bool) -> Result<Vec<PathBuf>, CanonError>`
  - `pub fn write_command_entry(repo_root: &Path, findings: &[CompiledFinding], overwrite: bool) -> Result<Vec<PathBuf>, CanonError>`
  - `pub fn write_subagent_entry(repo_root: &Path, findings: &[CompiledFinding], overwrite: bool) -> Result<Vec<PathBuf>, CanonError>`

- [ ] **Step 1: Write the failing tests**

Add to the bottom of the existing `mod tests` in `crates/canon/src/compile.rs`:

```rust
    #[test]
    fn overwrite_rewrites_the_same_file() {
        let tmp = std::env::temp_dir().join(format!("canon-ow-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let f = finding("convention", "Use tabs");
        for _ in 0..3 {
            write_memory_entry(&tmp, &[f.clone()], true).unwrap();
        }
        let dir = tmp.join(".covenant/canon/memory");
        let n = std::fs::read_dir(&dir).unwrap().count();
        assert_eq!(n, 1, "overwrite must not accumulate -2/-3");
        assert!(dir.join("use-tabs.md").exists());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn no_overwrite_still_suffixes() {
        let tmp = std::env::temp_dir().join(format!("canon-nw-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let f = finding("convention", "Use tabs");
        write_memory_entry(&tmp, &[f.clone()], false).unwrap();
        write_memory_entry(&tmp, &[f.clone()], false).unwrap();
        let dir = tmp.join(".covenant/canon/memory");
        assert!(dir.join("use-tabs.md").exists());
        assert!(dir.join("use-tabs-2.md").exists());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn render_md_entry_is_what_gets_written() {
        let tmp = std::env::temp_dir().join(format!("canon-rd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let f = finding("convention", "Use tabs");
        let paths = write_memory_entry(&tmp, &[f.clone()], true).unwrap();
        let on_disk = std::fs::read_to_string(&paths[0]).unwrap();
        assert_eq!(on_disk, render_md_entry(&f));
        let _ = std::fs::remove_dir_all(&tmp);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p canon compile:: -- --nocapture`
Expected: FAIL — `cannot find function 'render_md_entry'` and `this function takes 2 arguments but 3 arguments were supplied`.

- [ ] **Step 3: Implement**

Replace `crates/canon/src/compile.rs:118-144` (from `fn write_md_entries` through `write_subagent_entry`) with:

```rust
/// The exact bytes an md-backed entry (memory / command / subagent) is
/// written as. Public so state resolution can compare a candidate against
/// what is already on disk without rewriting it.
pub fn render_md_entry(f: &CompiledFinding) -> String {
    let mut md = format!(
        "---\ndescription: {}\n---\n\n# {}\n\n{}\n",
        f.title,
        f.title,
        f.body_md.trim()
    );
    if !f.evidence.is_empty() {
        let refs: Vec<String> = f.evidence.iter().map(|e| format!("`{e}`")).collect();
        md.push_str(&format!("\nEvidence: {}\n", refs.join(", ")));
    }
    md
}

fn write_md_entries(
    dir: &Path,
    findings: &[CompiledFinding],
    overwrite: bool,
) -> Result<Vec<PathBuf>, CanonError> {
    std::fs::create_dir_all(dir)?;
    let mut taken = std::collections::HashSet::new();
    let mut out = Vec::new();
    for f in findings {
        let base = slugify(&f.title);
        // ponytail: overwrite keys on the slug alone — that IS the unit
        // identity the inventory resolved against. unique_slug only guards
        // the `new` path, where a collision means Canon does not know the file.
        let slug = if overwrite {
            if base.is_empty() { "entry".to_string() } else { base }
        } else {
            unique_slug(dir, &base, &mut taken)
        };
        let path = dir.join(format!("{slug}.md"));
        std::fs::write(&path, render_md_entry(f))?;
        out.push(path);
    }
    Ok(out)
}

pub fn write_memory_entry(
    repo_root: &Path,
    findings: &[CompiledFinding],
    overwrite: bool,
) -> Result<Vec<PathBuf>, CanonError> {
    write_md_entries(&canon_dir(repo_root).join("memory"), findings, overwrite)
}
pub fn write_command_entry(
    repo_root: &Path,
    findings: &[CompiledFinding],
    overwrite: bool,
) -> Result<Vec<PathBuf>, CanonError> {
    write_md_entries(&canon_dir(repo_root).join("commands"), findings, overwrite)
}
pub fn write_subagent_entry(
    repo_root: &Path,
    findings: &[CompiledFinding],
    overwrite: bool,
) -> Result<Vec<PathBuf>, CanonError> {
    write_md_entries(&canon_dir(repo_root).join("agents"), findings, overwrite)
}
```

- [ ] **Step 4: Fix the one existing caller so the workspace compiles**

In `crates/app/src/canon_miner.rs:186-196`, pass the flag through — the command already has an `overwrite: bool` parameter in scope:

```rust
        if !g.memory.is_empty() {
            report.memory =
                strvec(write_memory_entry(&root, &g.memory, overwrite).map_err(|e| e.to_string())?);
        }
        if !g.commands.is_empty() {
            report.commands =
                strvec(write_command_entry(&root, &g.commands, overwrite).map_err(|e| e.to_string())?);
        }
        if !g.agents.is_empty() {
            report.agents =
                strvec(write_subagent_entry(&root, &g.agents, overwrite).map_err(|e| e.to_string())?);
        }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p canon compile::`
Expected: PASS, all tests in the module including the pre-existing ones.

Run: `cargo test -p covenant canon`
Expected: PASS (compiles with the new 3-arg calls).

- [ ] **Step 6: Commit**

```bash
git add crates/canon/src/compile.rs crates/app/src/canon_miner.rs
git commit -m "fix(canon): overwrite md entries in place instead of accumulating -2/-3"
```

---

### Task 2: Canon resolves a candidate unit's state

The inventory needs to know, per row, whether Canon already holds this unit and whether the crawler found something different. This is a pure function over the repo plus the rendered candidate body.

**Files:**
- Create: `crates/canon/src/inventory.rs`
- Modify: `crates/canon/src/lib.rs:3-22`
- Test: `crates/canon/src/inventory.rs` (inline `#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: `canon::compile::{render_md_entry, render_skill_md, slugify}`, `canon::kind::list_context`, `canon::detect::scan_detected` (all already public).
- Produces:
  - `pub enum UnitState { New, Exists, Changed, Detected }` (serde `rename_all = "lowercase"`)
  - `pub fn resolve_state(repo_root: &Path, kind: &str, slug: &str, body: &str) -> UnitState`
  - `pub fn detected_rows(repo_root: &Path) -> Result<Vec<ContextUnit>, CanonError>`

- [ ] **Step 1: Write the failing test**

Create `crates/canon/src/inventory.rs` containing only the test module for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::compile::{write_memory_entry, CompiledFinding};

    fn finding(title: &str, body: &str) -> CompiledFinding {
        CompiledFinding {
            category: "convention".into(),
            title: title.into(),
            body_md: body.into(),
            evidence: vec![],
            confidence: "high".into(),
            kind: "memory".into(),
        }
    }

    #[test]
    fn resolves_new_exists_and_changed() {
        let tmp = std::env::temp_dir().join(format!("canon-inv-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        // Nothing on disk yet.
        assert_eq!(
            resolve_state(&tmp, "memory", "use-tabs", "whatever"),
            UnitState::New
        );

        let f = finding("Use tabs", "Always use tabs.");
        write_memory_entry(&tmp, &[f.clone()], true).unwrap();
        let same = crate::compile::render_md_entry(&f);

        assert_eq!(
            resolve_state(&tmp, "memory", "use-tabs", &same),
            UnitState::Exists
        );
        assert_eq!(
            resolve_state(&tmp, "memory", "use-tabs", "different bytes"),
            UnitState::Changed
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn unknown_kind_is_new() {
        let tmp = std::env::temp_dir().join(format!("canon-inv2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        assert_eq!(resolve_state(&tmp, "mcp", "x", "y"), UnitState::New);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p canon inventory::`
Expected: FAIL — `file not found for module 'inventory'` (the module is not declared yet), then after declaring it, `cannot find function 'resolve_state'`.

- [ ] **Step 3: Implement**

Prepend to `crates/canon/src/inventory.rs`, above the test module:

```rust
//! Resolve a crawler-proposed unit against what Canon already holds, so every
//! inventory row can say whether it is new, unchanged, drifted, or a foreign
//! item waiting to be adopted.

use crate::kind::ContextUnit;
use crate::manifest::canon_dir;
use crate::CanonError;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UnitState {
    /// No Canon source with this (kind, slug).
    New,
    /// Canon holds this unit and the rendered bytes match.
    Exists,
    /// Canon holds this unit but the crawler rendered different bytes.
    Changed,
    /// A foreign item on disk with no Canon source — adoptable, not writable.
    Detected,
}

/// Where a `(kind, slug)` unit lands on disk, relative to the repo root.
/// `None` for kinds the crawler never emits (mcp, spec, context).
fn unit_path(repo_root: &Path, kind: &str, slug: &str) -> Option<std::path::PathBuf> {
    let base = canon_dir(repo_root);
    Some(match kind {
        "skill" => base.join("skills").join(slug).join("SKILL.md"),
        "memory" => base.join("memory").join(format!("{slug}.md")),
        "command" => base.join("commands").join(format!("{slug}.md")),
        "subagent" => base.join("agents").join(format!("{slug}.md")),
        _ => return None,
    })
}

/// `body` is the fully rendered artifact — `render_md_entry` output for
/// memory/command/subagent, `render_skill_md` output for skill.
///
/// ponytail: byte comparison, not a semantic diff. Cosmetic drift reports
/// `Changed`, which is the conservative direction — it offers Update rather
/// than hiding a real change. Upgrade to a normalized compare only if users
/// complain about false Changed rows.
pub fn resolve_state(repo_root: &Path, kind: &str, slug: &str, body: &str) -> UnitState {
    let Some(path) = unit_path(repo_root, kind, slug) else {
        return UnitState::New;
    };
    match std::fs::read_to_string(&path) {
        Ok(on_disk) if on_disk == body => UnitState::Exists,
        Ok(_) => UnitState::Changed,
        Err(_) => UnitState::New,
    }
}

/// Foreign items already on disk with no Canon source. These are not crawl
/// output — they answer the same question from the other direction and are
/// merged into the same inventory list, with Adopt instead of Materialize.
pub fn detected_rows(repo_root: &Path) -> Result<Vec<ContextUnit>, CanonError> {
    crate::detect::scan_detected(repo_root)
}
```

Then declare and re-export it. In `crates/canon/src/lib.rs`, add `pub mod inventory;` after line 4 (`pub mod detect;`), and add this line after the existing `pub use detect::scan_detected;`:

```rust
pub use inventory::{detected_rows, resolve_state, UnitState};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p canon inventory::`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add crates/canon/src/inventory.rs crates/canon/src/lib.rs
git commit -m "feat(canon): resolve a candidate unit against Canon state"
```

---

### Task 3: The miner's `propose_unit` tool and unit types

The model must declare a unit before filling it. This task adds the type, the tool spec, the parser, and the stream event — no loop wiring yet.

**Files:**
- Modify: `crates/agent/src/context_miner.rs:12-155` (types, `parse_finding`, `miner_tool_specs`)
- Test: `crates/agent/src/context_miner.rs` (existing `#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `pub struct MinerUnit { pub kind: String, pub name: String, pub summary: String }`
  - `pub(crate) fn parse_unit(v: &Value) -> Option<MinerUnit>`
  - `MinerFinding` gains `pub unit: String` (serde default empty)
  - `MinerEvent::UnitProposed { id: String, unit: MinerUnit }`

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `crates/agent/src/context_miner.rs`:

```rust
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p agent context_miner`
Expected: FAIL — `cannot find function 'parse_unit' in this scope`.

- [ ] **Step 3: Implement**

Add `unit` to `MinerFinding` in `crates/agent/src/context_miner.rs` (inside the struct, after the `kind` field):

```rust
    /// Name of the `propose_unit` this finding belongs to. Findings naming an
    /// unproposed unit are dropped by the run loop.
    #[serde(default)]
    pub unit: String,
}
```

Add the unit type after `default_kind`:

```rust
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
```

Add the event variant to `MinerEvent`, before `Finding`:

```rust
    UnitProposed {
        id: String,
        unit: MinerUnit,
    },
```

In `miner_tool_specs`, add `unit` to the `emit_finding` schema and push the new tool. Replace the body of `miner_tool_specs` with:

```rust
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
```

Note `suggested_kind` is gone from `emit_finding` — the unit now carries the kind. Update `parse_finding` accordingly: replace its kind-repair block

```rust
    if !matches!(f.kind.as_str(), "skill" | "memory" | "command") {
        f.kind = default_kind(&f.category).to_string();
    }
```

with

```rust
    if f.unit.trim().is_empty() {
        return None;
    }
    // Kind is inherited from the unit by the run loop; category default is
    // only a fallback for a finding whose unit lookup somehow left it blank.
    if !matches!(f.kind.as_str(), "skill" | "memory" | "command" | "subagent") {
        f.kind = default_kind(&f.category).to_string();
    }
```

Existing tests build `emit_finding` payloads without `unit` and will now fail. Update `finding_call` in `mod tests` to include it:

```rust
    fn finding_call(id: &str, title: &str) -> ToolCall {
        ToolCall {
            id: id.into(),
            name: "emit_finding".into(),
            input: serde_json::json!({
                "unit": "test-unit",
                "category": "convention",
                "title": title,
                "body_md": "Do the thing.",
                "evidence": ["src/lib.rs:1"],
                "confidence": "high"
            }),
        }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p agent context_miner`
Expected: PASS — all tests, new and pre-existing. This task does not touch the run loop, so `collects_findings_and_finishes_on_plain_turn` still passes once `finding_call` carries `"unit"`. **If any test fails, the task is not done** — do not commit a red suite and defer it to Task 4.

- [ ] **Step 5: Commit**

```bash
git add crates/agent/src/context_miner.rs
git commit -m "feat(agent): propose_unit tool + unit-scoped findings"
```

---

### Task 4: The crawl loop collects units, not one skill

Drop `skill_name` from the options, reframe the system prompt as a survey, register proposed units, drop orphan findings, and enforce the one-finding-per-entry rule for non-skill kinds.

**Files:**
- Modify: `crates/agent/src/context_miner.rs` — `MinerOpts` (~line 82), `system_prompt` (~line 156), `run_miner` (~line 205)
- Test: `crates/agent/src/context_miner.rs` (existing `mod tests`)

**Interfaces:**
- Consumes: `MinerUnit`, `parse_unit`, `MinerEvent::UnitProposed` from Task 3.
- Produces:
  - `MinerOpts { focus, depth, max_units, max_findings, max_tool_calls }` — **`skill_name` removed**
  - `MinerOpts::default_for(focus: &str) -> Self` (one arg now)
  - `pub struct CrawlUnit { pub unit: MinerUnit, pub findings: Vec<MinerFinding> }`
  - `run_miner(...) -> Result<Vec<CrawlUnit>, String>` (was `Vec<MinerFinding>`)

- [ ] **Step 1: Write the failing tests**

Add to `mod tests`:

```rust
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
```

`Collect` must be cloneable for `run` to snapshot events — add `#[derive(Clone)]` to `MinerEvent` if it is not already derived (it is: `#[derive(Debug, Clone, Serialize, PartialEq)]`), and `MinerUnit` already derives `Clone`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p agent context_miner`
Expected: FAIL — `cannot find type 'CrawlUnit'`, and `default_for` argument-count mismatch.

- [ ] **Step 3: Implement**

Replace `MinerOpts` and its impl:

```rust
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
```

Replace `system_prompt`:

```rust
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
```

In `run_miner`, change the signature's return type to `Result<Vec<CrawlUnit>, String>` and rework the state. Replace the opening of the function body (from `let system = ...` through `let mut turns = 0usize;`) with:

```rust
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

    let max_turns = opts.max_tool_calls + opts.max_findings + opts.max_units + 8;
    let mut turns = 0usize;
```

Add a slug helper above `run_miner` (the agent crate must not depend on `canon`, so this is a local copy of the same rule — lowercase, non-alphanumerics to `-`, trimmed):

```rust
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
```

Replace every `findings.len()` in the `RunDone` emissions and the returns with `findings_total` / `units`. The three early-exit sites become:

```rust
            sink.emit(MinerEvent::RunDone { findings_total, stopped: true });
            return Ok(units);
```

and the plain-turn exit:

```rust
        if turn.tool_calls.is_empty() {
            sink.emit(MinerEvent::RunDone { findings_total, stopped: false });
            return Ok(units);
        }
```

Replace the `emit_finding` arm of the tool loop with both arms:

```rust
            if call.name == "propose_unit" {
                match parse_unit(&call.input) {
                    Some(u) if units.len() < opts.max_units => {
                        let slug = unit_slug(&u.name);
                        if index.contains_key(&slug) {
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
                            feedback
                                .push_str(&format!("[tool propose_unit → {}] recorded\n", call.id));
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
                                // A memory/command/subagent unit IS one entry.
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
```

Delete the now-unused old test `collects_findings_and_finishes_on_plain_turn` and `finding_call` helper — `finding_lands_in_its_proposed_unit` replaces them. Keep `invalid_finding_is_dropped_not_fatal`, adding `"unit": "u"` is not needed since the payload is invalid either way; verify it still compiles and passes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p agent context_miner`
Expected: PASS — all tests including the 4 new loop tests and Task 3's 4 parser tests.

- [ ] **Step 5: Commit**

```bash
git add crates/agent/src/context_miner.rs
git commit -m "feat(agent): crawl the whole repo into an inventory of units"
```

---

### Task 5: Tauri commands — crawl without a name, compile units, resolve states

**Files:**
- Modify: `crates/app/src/canon_miner.rs` (whole file — `canon_mine_start`, `split_by_kind`, `CompileReport`, `canon_compile_findings`)
- Modify: `crates/app/src/lib.rs` (the `generate_handler!` list)
- Test: `crates/app/src/canon_miner.rs` (existing `#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: `agent::context_miner::{run_miner, unit_slug, CrawlUnit, MinerOpts}` (Task 4), `canon::compile::{render_md_entry, render_skill_md, slugify, write_*_entry}` (Task 1), `canon::{resolve_state, detected_rows, UnitState}` (Task 2).
- Produces:
  - `canon_mine_start(app, state, runs, repo_root, focus, thorough) -> Result<String, String>` — **`skill_name` parameter removed**
  - `pub struct CompiledUnit { kind: String, name: String, findings: Vec<CompiledFinding> }`
  - `canon_compile_units(repo_root: String, units: Vec<CompiledUnit>) -> Result<CompileReport, String>` — replaces `canon_compile_findings`
  - `CompileReport { skills: Vec<String>, memory: Vec<String>, commands: Vec<String>, agents: Vec<String> }` — `skills` is now a `Vec`
  - `canon_inventory_states(repo_root: String, units: Vec<CompiledUnit>) -> Result<InventoryReport, String>`
  - `pub struct InventoryReport { states: Vec<UnitStateRow>, detected: Vec<ContextUnit> }`
  - `pub struct UnitStateRow { kind: String, slug: String, state: UnitState }`

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `crates/app/src/canon_miner.rs`:

```rust
    #[test]
    fn slug_rules_agree_across_crates() {
        for name in ["PTY Conventions", "retry budget", "Foo/Bar baz", "  edge  "] {
            assert_eq!(
                agent::context_miner::unit_slug(name),
                canon::compile::slugify(name),
                "slug mismatch for {name}"
            );
        }
    }

    #[test]
    fn render_for_state_matches_what_gets_written() {
        let f = CompiledFinding {
            category: "convention".into(),
            title: "Use tabs".into(),
            body_md: "Always use tabs.".into(),
            evidence: vec![],
            confidence: "high".into(),
            kind: "memory".into(),
        };
        let u = CompiledUnit {
            kind: "memory".into(),
            name: "Use tabs".into(),
            findings: vec![f.clone()],
        };
        assert_eq!(render_unit(&u), canon::compile::render_md_entry(&f));

        let su = CompiledUnit {
            kind: "skill".into(),
            name: "PTY conventions".into(),
            findings: vec![f],
        };
        assert_eq!(
            render_unit(&su),
            canon::compile::render_skill_md("pty-conventions", &su.findings)
        );
    }

    #[test]
    fn empty_unit_renders_empty_not_panics() {
        let u = CompiledUnit { kind: "memory".into(), name: "x".into(), findings: vec![] };
        assert_eq!(render_unit(&u), String::new());
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p covenant canon_miner`
Expected: FAIL — `cannot find function 'render_unit'`, `cannot find struct 'CompiledUnit'`.

- [ ] **Step 3: Implement**

In `crates/app/src/canon_miner.rs`, change `canon_mine_start`'s signature — delete the `skill_name: String,` parameter (line 93) and change line 106 to:

```rust
    let mut opts = MinerOpts::default_for(&focus);
```

Replace `KindGroups`, `split_by_kind`, `CompileReport` and `canon_compile_findings` (lines 134 to the end of that command) with:

```rust
/// A curated unit as the UI sends it back: the destination and its findings.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledUnit {
    pub kind: String,
    pub name: String,
    pub findings: Vec<CompiledFinding>,
}

/// The exact bytes this unit will be written as — the input to state
/// resolution and to the preview. Empty findings render empty.
pub(crate) fn render_unit(u: &CompiledUnit) -> String {
    if u.findings.is_empty() {
        return String::new();
    }
    if u.kind == "skill" {
        canon::compile::render_skill_md(&canon::compile::slugify(&u.name), &u.findings)
    } else {
        canon::compile::render_md_entry(&u.findings[0])
    }
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompileReport {
    pub skills: Vec<String>,
    pub memory: Vec<String>,
    pub commands: Vec<String>,
    pub agents: Vec<String>,
}

#[tauri::command]
pub async fn canon_compile_units(
    repo_root: String,
    units: Vec<CompiledUnit>,
) -> Result<CompileReport, String> {
    let root = PathBuf::from(&repo_root);
    tokio::task::spawn_blocking(move || {
        let mut report = CompileReport::default();
        let strvec = |v: Vec<std::path::PathBuf>| -> Vec<String> {
            v.into_iter().map(|p| p.to_string_lossy().into_owned()).collect()
        };
        for u in &units {
            if u.findings.is_empty() {
                continue;
            }
            let slug = canon::compile::slugify(&u.name);
            // The unit was resolved against Canon before the user pressed
            // Write, so every write is an intentional create-or-update.
            match u.kind.as_str() {
                "skill" => {
                    let dir = write_skill_package(&root, &slug, None, &u.findings, true)
                        .map_err(|e| e.to_string())?;
                    report.skills.push(dir.to_string_lossy().into_owned());
                }
                "command" => report
                    .commands
                    .extend(strvec(write_command_entry(&root, &u.findings[..1], true).map_err(|e| e.to_string())?)),
                "subagent" => report
                    .agents
                    .extend(strvec(write_subagent_entry(&root, &u.findings[..1], true).map_err(|e| e.to_string())?)),
                _ => report
                    .memory
                    .extend(strvec(write_memory_entry(&root, &u.findings[..1], true).map_err(|e| e.to_string())?)),
            }
        }
        Ok::<_, String>(report)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitStateRow {
    pub kind: String,
    pub slug: String,
    pub state: canon::UnitState,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryReport {
    pub states: Vec<UnitStateRow>,
    pub detected: Vec<canon::ContextUnit>,
}

#[tauri::command]
pub async fn canon_inventory_states(
    repo_root: String,
    units: Vec<CompiledUnit>,
) -> Result<InventoryReport, String> {
    let root = PathBuf::from(&repo_root);
    tokio::task::spawn_blocking(move || {
        let states = units
            .iter()
            .map(|u| {
                let slug = canon::compile::slugify(&u.name);
                let state = canon::resolve_state(&root, &u.kind, &slug, &render_unit(u));
                UnitStateRow { kind: u.kind.clone(), slug, state }
            })
            .collect();
        let detected = canon::detected_rows(&root).map_err(|e| e.to_string())?;
        Ok::<_, String>(InventoryReport { states, detected })
    })
    .await
    .map_err(|e| e.to_string())?
}
```

Fix the imports at the top of the file: the `use` for `write_skill_package, write_memory_entry, write_command_entry, write_subagent_entry, CompiledFinding` stays; add `use serde::Deserialize;` if not present; delete any now-unused import surfaced by the compiler.

Delete the old `split_by_kind_groups_findings` test — `split_by_kind` no longer exists.

In `crates/app/src/lib.rs`, in the `tauri::generate_handler![...]` list, replace `canon_miner::canon_compile_findings` with:

```rust
            canon_miner::canon_compile_units,
            canon_miner::canon_inventory_states,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p covenant canon_miner`
Expected: PASS — 3 new tests plus the surviving `MinerRuns` test.

Run: `cargo clippy -p covenant -p canon -p agent --all-targets`
Expected: no warnings introduced by these files.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/canon_miner.rs crates/app/src/lib.rs
git commit -m "feat(app): compile crawled units and resolve their Canon state"
```

---

### Task 6: UI state — an inventory of units

**Files:**
- Modify: `ui/src/canon/miner/state.ts` (whole file)
- Modify: `ui/src/api.ts` (the miner wrappers and types)
- Test: `ui/src/canon/miner/state.test.ts`

**Interfaces:**
- Consumes: `canon_mine_start` (no `skillName`), `canon_compile_units`, `canon_inventory_states` from Task 5; `MinerEvent` gains the `unit_proposed` variant from Task 3.
- Produces:
  - `interface UnitRow { slug, kind, name, summary, findings: FindingCard[], state: UnitState, selected: boolean }`
  - `type UnitState = "new" | "exists" | "changed" | "detected"`
  - `createMinerState()`, `reduceMinerEvent(state, ev)`, `setUnitSelected`, `setUnitKind`, `setFindingStatus`, `setFindingKind`, `editFindingBody`
  - `selectedUnits(state): CompiledUnit[]`
  - `applyStates(state, report)`
  - `compilePreview(state): string`
  - `slugify(name: string): string`

- [ ] **Step 1: Write the failing tests**

Replace `ui/src/canon/miner/state.test.ts` with:

```ts
import { describe, it, expect } from "vitest";
import {
  createMinerState, reduceMinerEvent, setUnitSelected, setFindingStatus,
  selectedUnits, applyStates, compilePreview, slugify,
} from "./state";

const unitEv = (id: string, kind: string, name: string) =>
  ({ kind: "unit_proposed", id, unit: { kind, name, summary: "A summary." } }) as never;
const findingEv = (id: string, unit: string, title: string) =>
  ({
    kind: "finding", id,
    finding: { unit, category: "convention", title, bodyMd: "Do it.", evidence: ["a.ts:1"], confidence: "high", kind: unitKindOf(unit) },
  }) as never;
const unitKindOf = (unit: string) => (unit === "Retry budget" ? "memory" : "skill");

describe("crawler inventory state", () => {
  it("slugify matches the Rust rule", () => {
    expect(slugify("PTY Conventions")).toBe("pty-conventions");
    expect(slugify("Foo/Bar baz")).toBe("foo-bar-baz");
    expect(slugify("  edge  ")).toBe("edge");
  });

  it("groups findings under their proposed unit", () => {
    const s = createMinerState();
    reduceMinerEvent(s, unitEv("u1", "skill", "PTY Conventions"));
    reduceMinerEvent(s, findingEv("f1", "PTY Conventions", "one"));
    reduceMinerEvent(s, findingEv("f2", "PTY Conventions", "two"));
    expect(s.units).toHaveLength(1);
    expect(s.units[0].slug).toBe("pty-conventions");
    expect(s.units[0].findings).toHaveLength(2);
  });

  it("drops a finding whose unit was never proposed", () => {
    const s = createMinerState();
    reduceMinerEvent(s, findingEv("f1", "Ghost", "one"));
    expect(s.units).toHaveLength(0);
  });

  it("new units are selected, exists/detected are not", () => {
    const s = createMinerState();
    reduceMinerEvent(s, unitEv("u1", "skill", "A"));
    reduceMinerEvent(s, unitEv("u2", "skill", "B"));
    reduceMinerEvent(s, findingEv("f1", "A", "one"));
    reduceMinerEvent(s, findingEv("f2", "B", "two"));
    applyStates(s, {
      states: [
        { kind: "skill", slug: "a", state: "new" },
        { kind: "skill", slug: "b", state: "exists" },
      ],
      detected: [],
    });
    expect(s.units.find((u) => u.slug === "a")!.selected).toBe(true);
    expect(s.units.find((u) => u.slug === "b")!.selected).toBe(false);
  });

  it("selectedUnits only returns selected units with accepted findings", () => {
    const s = createMinerState();
    reduceMinerEvent(s, unitEv("u1", "skill", "A"));
    reduceMinerEvent(s, findingEv("f1", "A", "one"));
    reduceMinerEvent(s, findingEv("f2", "A", "two"));
    setUnitSelected(s, "skill:a", true);
    setFindingStatus(s, "f1", "accepted");
    setFindingStatus(s, "f2", "discarded");
    const out = selectedUnits(s);
    expect(out).toHaveLength(1);
    expect(out[0].findings).toHaveLength(1);
    expect(out[0].findings[0].title).toBe("one");
  });

  it("an unselected unit contributes nothing", () => {
    const s = createMinerState();
    reduceMinerEvent(s, unitEv("u1", "skill", "A"));
    reduceMinerEvent(s, findingEv("f1", "A", "one"));
    setFindingStatus(s, "f1", "accepted");
    setUnitSelected(s, "skill:a", false);
    expect(selectedUnits(s)).toHaveLength(0);
  });

  it("preview groups by destination path", () => {
    const s = createMinerState();
    reduceMinerEvent(s, unitEv("u1", "skill", "A"));
    reduceMinerEvent(s, findingEv("f1", "A", "one"));
    setUnitSelected(s, "skill:a", true);
    setFindingStatus(s, "f1", "accepted");
    expect(compilePreview(s)).toContain(".covenant/canon/skills/a/");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- state.test`
Expected: FAIL — `does not provide an export named 'setUnitSelected'`.

- [ ] **Step 3: Implement**

Replace `ui/src/canon/miner/state.ts` with:

```ts
import type { MinerEvent, MinerFinding, MinerUnit, InventoryReport } from "../../api";

export type UnitState = "new" | "exists" | "changed" | "detected";

export interface FindingCard {
  id: string;
  finding: MinerFinding;
  status: "pending" | "accepted" | "discarded";
  editedBody?: string;
}

export interface UnitRow {
  /** `${kind}:${slug}` — stable across kind re-routes only by re-keying. */
  id: string;
  slug: string;
  kind: string;
  name: string;
  summary: string;
  findings: FindingCard[];
  state: UnitState;
  selected: boolean;
  /** Set for detected rows: the executor dir the foreign item lives in. */
  detectedIn?: string;
}

export interface MinerState {
  activity: { id: string; tool: string; arg: string; summary?: string; ok?: boolean }[];
  units: UnitRow[];
  narration: string;
  done: boolean;
  stopped: boolean;
  error: string | null;
}

export interface CompiledUnit {
  kind: string;
  name: string;
  findings: MinerFinding[];
}

/** Mirrors `canon::compile::slugify` and `agent::context_miner::unit_slug`. */
export function slugify(name: string): string {
  let out = "";
  for (const ch of name) {
    if (/[a-zA-Z0-9]/.test(ch)) out += ch.toLowerCase();
    else if (!out.endsWith("-")) out += "-";
  }
  return out.replace(/^-+|-+$/g, "");
}

const unitId = (kind: string, slug: string) => `${kind}:${slug}`;

export function createMinerState(): MinerState {
  return { activity: [], units: [], narration: "", done: false, stopped: false, error: null };
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
    case "unit_proposed": {
      const u: MinerUnit = ev.unit;
      const slug = slugify(u.name);
      if (state.units.some((r) => r.slug === slug && r.kind === u.kind)) break;
      state.units.push({
        id: unitId(u.kind, slug), slug, kind: u.kind, name: u.name, summary: u.summary,
        findings: [], state: "new", selected: true,
      });
      break;
    }
    case "finding": {
      // The backend already dropped orphans; this guard keeps the UI honest
      // if the stream is replayed out of order.
      const row = state.units.find((r) => r.slug === slugify(ev.finding.unit));
      if (!row) break;
      row.findings.push({ id: ev.id, finding: ev.finding, status: "pending" });
      break;
    }
    case "run_done":
      state.done = true;
      state.stopped = ev.stopped;
      break;
    case "error":
      state.error = ev.message;
      break;
  }
}

/** Fold backend state resolution + detected rows into the inventory. */
export function applyStates(state: MinerState, report: InventoryReport): void {
  for (const s of report.states) {
    const row = state.units.find((r) => r.kind === s.kind && r.slug === s.slug);
    if (!row) continue;
    row.state = s.state;
    // Only `new` is pre-checked. `changed` offers Update but the user opts in.
    row.selected = s.state === "new";
  }
  for (const d of report.detected) {
    const kind = d.kind === "agent" ? "subagent" : d.kind;
    const slug = slugify(d.name);
    if (state.units.some((r) => r.kind === kind && r.slug === slug)) continue;
    state.units.push({
      id: unitId(kind, slug), slug, kind, name: d.name, summary: d.summary ?? "",
      findings: [], state: "detected", selected: false, detectedIn: d.detectedIn ?? undefined,
    });
  }
}

export function setUnitSelected(state: MinerState, id: string, selected: boolean): void {
  const u = state.units.find((r) => r.id === id);
  if (u) u.selected = selected;
}

export function setUnitKind(state: MinerState, id: string, kind: string): void {
  const u = state.units.find((r) => r.id === id);
  if (!u) return;
  u.kind = kind;
  u.id = unitId(kind, u.slug);
  for (const f of u.findings) f.finding = { ...f.finding, kind };
}

function findCard(state: MinerState, id: string): FindingCard | undefined {
  for (const u of state.units) {
    const c = u.findings.find((f) => f.id === id);
    if (c) return c;
  }
  return undefined;
}

export function setFindingStatus(state: MinerState, id: string, status: "accepted" | "discarded"): void {
  const c = findCard(state, id);
  if (c) c.status = status;
}

export function setFindingKind(state: MinerState, id: string, kind: string): void {
  const c = findCard(state, id);
  if (c) c.finding = { ...c.finding, kind };
}

export function editFindingBody(state: MinerState, id: string, body: string): void {
  const c = findCard(state, id);
  if (c) c.editedBody = body;
}

/** A unit's findings as they would be written: accepted ones, edits applied. */
function unitFindings(u: UnitRow): MinerFinding[] {
  const kept = u.findings
    .filter((c) => c.status === "accepted")
    .map((c) => ({ ...c.finding, kind: u.kind, bodyMd: c.editedBody ?? c.finding.bodyMd }));
  // Non-skill kinds are a single entry; the backend slices to [..1] too.
  return u.kind === "skill" ? kept : kept.slice(0, 1);
}

export function selectedUnits(state: MinerState): CompiledUnit[] {
  return state.units
    .filter((u) => u.selected && u.state !== "detected")
    .map((u) => ({ kind: u.kind, name: u.name, findings: unitFindings(u) }))
    .filter((u) => u.findings.length > 0);
}

/** Units awaiting all findings' state resolution, for the pre-write check. */
export function pendingUnits(state: MinerState): CompiledUnit[] {
  return state.units
    .filter((u) => u.state !== "detected")
    .map((u) => ({
      kind: u.kind, name: u.name,
      findings: u.findings.map((c) => ({ ...c.finding, kind: u.kind, bodyMd: c.editedBody ?? c.finding.bodyMd })),
    }))
    .filter((u) => u.findings.length > 0);
}

export const KIND_ORDER = ["skill", "memory", "command", "subagent"] as const;
export const KIND_LABELS: Record<string, string> = {
  skill: "Skill", memory: "Memory", command: "Command", subagent: "Subagent",
};
export const STATE_LABELS: Record<UnitState, string> = {
  new: "new", exists: "in canon", changed: "changed", detected: "detected",
};

export function unitTarget(kind: string, slug: string): string {
  if (kind === "skill") return `.covenant/canon/skills/${slug}/`;
  const dir = kind === "subagent" ? "agents" : kind === "command" ? "commands" : "memory";
  return `.covenant/canon/${dir}/${slug}.md`;
}

export function compilePreview(state: MinerState): string {
  const units = state.units.filter((u) => u.selected && u.state !== "detected");
  let md = "";
  for (const kind of KIND_ORDER) {
    for (const u of units.filter((x) => x.kind === kind)) {
      const fs = unitFindings(u);
      if (fs.length === 0) continue;
      md += `# ${KIND_LABELS[kind]} → ${unitTarget(kind, u.slug)}\n\n${u.summary}\n`;
      for (const f of fs) {
        md += `\n## ${f.title}\n\n${f.bodyMd.trim()}\n`;
        if (f.evidence.length > 0) md += `\nEvidence: ${f.evidence.map((e) => `\`${e}\``).join(", ")}\n`;
      }
      md += "\n";
    }
  }
  return md || "Nothing selected yet.";
}
```

In `ui/src/api.ts`, update the miner section:

```ts
export interface MinerUnit { kind: string; name: string; summary: string }

export interface MinerFinding {
  unit: string;
  category: string;
  title: string;
  bodyMd: string;
  evidence: string[];
  confidence: string;
  kind: string;
}

export interface UnitStateRow { kind: string; slug: string; state: "new" | "exists" | "changed" | "detected" }
export interface DetectedRow { kind: string; name: string; summary: string | null; detectedIn: string | null }
export interface InventoryReport { states: UnitStateRow[]; detected: DetectedRow[] }
export interface CompileReport { skills: string[]; memory: string[]; commands: string[]; agents: string[] }
```

Add `{ kind: "unit_proposed"; id: string; unit: MinerUnit }` to the `MinerEvent` union, and replace the command wrappers:

```ts
export const canonMineStart = (repoRoot: string, focus: string, thorough: boolean) =>
  invoke<string>("canon_mine_start", { repoRoot, focus, thorough });

export const canonCompileUnits = (repoRoot: string, units: CompiledUnit[]) =>
  invoke<CompileReport>("canon_compile_units", { repoRoot, units });

export const canonInventoryStates = (repoRoot: string, units: CompiledUnit[]) =>
  invoke<InventoryReport>("canon_inventory_states", { repoRoot, units });
```

Import `CompiledUnit` in `api.ts` from `./canon/miner/state`, or duplicate the three-field interface there — pick whichever matches the file's existing import direction.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- state.test`
Expected: PASS — 7 tests.

Run: `npm run build`
Expected: type-check clean, **including `view.ts`**. `view.ts` calls the old
`compilePreview(this.skillName, state)` and the old `state.findings`, which no
longer exist. Do the minimum to keep it compiling — this task does not redesign
the view (that is Task 7), it only stops the build from breaking:

- `compilePreview(this.skillName, this.state)` → `compilePreview(this.state)`
- any `this.state.findings` read → `this.state.units.flatMap((u) => u.findings)`
- `canonCompileFindings(...)` call → `canonCompileUnits(this.repoRoot, selectedUnits(this.state))`
- `canonMineStart(repoRoot, skillName, focus, thorough)` → drop the `skillName` argument

The gate still renders a package-name field after this task; Task 7 removes it.
**Do not commit with a failing `npm run build`.**

- [ ] **Step 5: Commit**

```bash
git add ui/src/canon/miner/state.ts ui/src/canon/miner/state.test.ts ui/src/api.ts
git commit -m "feat(ui): crawler inventory state — units, states, selection"
```

---

### Task 7: UI view — the inventory surface

**Files:**
- Modify: `ui/src/canon/miner/view.ts`
- Modify: `ui/src/canon/miner/miner.css`
- Modify: wherever `onNewContext` is wired (search `grep -rn "canonMineStart\|onNewContext" ui/src`)

**Interfaces:**
- Consumes: everything Task 6 produces, plus `canonAdopt(cwd, kind, name)` (already in `api.ts`).
- Produces: no new exports — this is the last task.

- [ ] **Step 1: Gate — remove the package-name field**

In `view.ts` around line 239-300, the form currently builds two fields via `this.field(...)`. Delete the `"Package name"` field and its `errorEl.textContent = "Enter a package name."` validation branch. Keep the Focus field, relabel it:

```ts
    title.textContent = "Crawl this repository";
    sub.textContent = this.opts.groupName
      ? `Survey ${this.opts.groupName} for context Canon can hold.`
      : "Survey the repository for context Canon can hold.";
    note.textContent = "Everything found lands in an inventory you curate before anything is written.";
    const focus = this.field(
      "Focus (optional)",
      "Leave empty to survey everything, or narrow it: 'the PTY layer'",
      "",
    );
```

Start becomes:

```ts
    startBtn.addEventListener("click", async () => {
      errorEl.textContent = "";
      try {
        this.runId = await canonMineStart(this.repoRoot, focus.input.value.trim(), this.thorough);
        this.renderRunning();
      } catch (e) {
        errorEl.textContent = String(e);
      }
    });
```

Delete the `skillName` field on the class and every read of it (`name.textContent = this.skillName`, the `compilePreview(this.skillName, ...)` call). The header's second line becomes the focus, or nothing when empty.

- [ ] **Step 2: Resolve states when the run finishes**

In the event handler that reduces `run_done`, after `reduceMinerEvent`, add:

```ts
      if (ev.kind === "run_done") {
        try {
          const report = await canonInventoryStates(this.repoRoot, pendingUnits(this.state));
          applyStates(this.state, report);
        } catch (e) {
          this.state.error = String(e);
        }
        this.renderInventory();
      }
```

- [ ] **Step 3: Render inventory rows instead of finding cards**

Replace the center-zone renderer (`renderCards` / the `CATEGORY_LABELS` grouping around lines 470-620) with a unit-row renderer. One row per unit, expandable to its findings:

```ts
  private renderInventory(): void {
    this.cardsEl.innerHTML = "";
    for (const kind of KIND_ORDER) {
      const rows = this.state.units.filter((u) => u.kind === kind);
      if (rows.length === 0) continue;
      const head = document.createElement("div");
      head.className = "rail-group";
      head.textContent = KIND_LABELS[kind];
      this.cardsEl.appendChild(head);
      for (const u of rows) this.cardsEl.appendChild(this.unitRow(u));
    }
    if (this.state.units.length === 0) {
      const empty = document.createElement("div");
      empty.className = "rail-empty";
      empty.textContent = "Units will appear here as the crawler works…";
      this.cardsEl.appendChild(empty);
    }
    this.renderPreview();
    this.renderFooter();
  }

  private unitRow(u: UnitRow): HTMLElement {
    const row = document.createElement("div");
    row.className = "rail-row miner-unit";
    row.dataset.state = u.state;

    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = u.selected;
    check.disabled = u.state === "detected";
    check.addEventListener("change", () => {
      setUnitSelected(this.state, u.id, check.checked);
      this.renderPreview();
      this.renderFooter();
    });
    row.appendChild(check);

    const main = document.createElement("div");
    main.className = "miner-unit-main";
    const name = document.createElement("div");
    name.className = "miner-unit-name";
    name.textContent = u.name;
    const badge = document.createElement("span");
    badge.className = `miner-state-badge miner-state-${u.state}`;
    badge.textContent = u.state === "detected" && u.detectedIn
      ? `detected · ${u.detectedIn}`
      : STATE_LABELS[u.state];
    name.appendChild(badge);
    const sum = document.createElement("div");
    sum.className = "miner-unit-summary";
    sum.textContent = u.summary;
    main.append(name, sum);
    row.appendChild(main);

    const count = document.createElement("span");
    count.className = "miner-unit-count";
    count.textContent = u.state === "detected" ? "" : `${u.findings.length}`;
    attachTooltip(count, `${u.findings.length} findings`);
    row.appendChild(count);

    const actions = document.createElement("div");
    actions.className = "rail-row-actions";
    if (u.state === "detected") {
      const adopt = iconButton(Icons.download({ size: 12 }), "Adopt", async () => {
        await canonAdopt(this.repoRoot, u.kind === "subagent" ? "agent" : u.kind, u.name);
        u.state = "exists";
        this.renderInventory();
      });
      actions.appendChild(adopt);
    }
    row.appendChild(actions);

    row.addEventListener("click", (e) => {
      if (e.target === check || actions.contains(e.target as Node)) return;
      this.expanded.has(u.id) ? this.expanded.delete(u.id) : this.expanded.add(u.id);
      this.renderInventory();
    });

    if (this.expanded.has(u.id)) {
      const wrap = document.createElement("div");
      wrap.className = "miner-unit-findings";
      for (const c of u.findings) wrap.appendChild(this.findingCard(c, u));
      row.appendChild(wrap);
    }
    return row;
  }
```

Add `private expanded = new Set<string>();` as a class field. Keep `findingCard` as the existing per-finding renderer (accept / discard / edit / kind chips) — change its signature to take the owning `UnitRow` so the kind chips call `setUnitKind(this.state, u.id, k)` when the whole unit is re-routed, and `setFindingKind` only for a single finding moved out.

- [ ] **Step 4: Preview and footer**

```ts
  private renderPreview(): void {
    this.previewPre.textContent = compilePreview(this.state);
  }

  private renderFooter(): void {
    const sel = selectedUnits(this.state);
    const findings = sel.reduce((n, u) => n + u.findings.length, 0);
    this.countEl.textContent = `${this.state.units.length} units · ${findings} findings · ${sel.length} to write`;
    this.writeBtn.disabled = sel.length === 0;
  }
```

And the Write handler:

```ts
    this.writeBtn.addEventListener("click", async () => {
      const report = await canonCompileUnits(this.repoRoot, selectedUnits(this.state));
      const n = report.skills.length + report.memory.length + report.commands.length + report.agents.length;
      this.opts.onWritten?.(n);
      this.destroy();
    });
```

- [ ] **Step 5: CSS**

Append to `ui/src/canon/miner/miner.css`, following the sharp-corner rule:

```css
.miner-unit { display: flex; align-items: flex-start; gap: 8px; border-radius: 0; flex-wrap: wrap; }
.miner-unit-main { flex: 1 1 auto; min-width: 0; }
.miner-unit-name { display: flex; align-items: center; gap: 6px; font-weight: 500; }
.miner-unit-summary { color: var(--text-muted); font-size: 11px; margin-top: 2px; }
.miner-unit-count { font-variant-numeric: tabular-nums; color: var(--text-muted); font-size: 11px; }
.miner-unit-findings { flex: 1 0 100%; margin-top: 8px; padding-left: 22px; }
.miner-state-badge {
  font-size: 10px; text-transform: uppercase; letter-spacing: .04em;
  padding: 1px 5px; border-radius: 0; border: 1px solid var(--border);
  color: var(--text-muted);
}
.miner-state-new { border-color: var(--accent); color: var(--accent); }
.miner-state-changed { border-color: var(--warning); color: var(--warning); }
.miner-state-exists,
.miner-state-detected { opacity: .7; }
```

Use the token names this file already references — if `--warning` or `--accent` are not defined in the app's token set, substitute the ones `miner.css` already uses.

- [ ] **Step 6: Type-check and test**

Run: `npm run build`
Expected: PASS, no type errors.

Run: `npm test`
Expected: PASS, full Vitest suite.

Run: `cargo test -p canon && cargo test -p agent context_miner && cargo test -p covenant canon`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add ui/src/canon/miner/view.ts ui/src/canon/miner/miner.css ui/src/api.ts
git commit -m "feat(ui): Context Crawler inventory surface"
```

- [ ] **Step 8: Live verification**

Use the `verify` skill against the dev build (`npm run tauri:dev`). Remember the dev build has its own `com.karluiz.covenant.dev` config — seed an API key first if it is unconfigured.

Verify, on a real repo:
1. The gate has no package-name field and Start works with Focus empty.
2. Units stream in as rows while the crawl runs; findings fill them.
3. Foreign items in `.claude/*` appear as `detected` rows with an Adopt button.
4. Write to repo produces the expected files under `.covenant/canon/`.
5. **Crawl the same repo a second time.** Rows must come back `in canon` / `changed`, unselected — not a duplicate set, and `.covenant/canon/memory/` must not gain `-2` files.

Step 5 is the regression this whole plan exists to prevent; do not report the feature verified without it.

---

## Notes for the implementer

- `crates/agent` deliberately does not depend on `crates/canon`. `unit_slug` and `slugify` are two implementations of one rule, pinned together by `slug_rules_agree_across_crates` in Task 5. If you change one, that test fails — change both.
- `canon_mine_start`'s `thorough` flag still bumps `max_tool_calls` to 240; a whole-repo survey without a focus is exactly when that matters.
- Kind naming crosses a boundary: Canon's `ContextKind` calls it `Agent`, the crawler and UI call it `subagent`. The mapping lives in `applyStates` (TS) and the `canon_adopt` call site. There is no third place — keep it that way.
