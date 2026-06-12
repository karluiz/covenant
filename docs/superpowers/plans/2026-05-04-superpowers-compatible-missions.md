---
spec: ../specs/2026-05-04-superpowers-compatible-missions-design.md
---

# Superpowers-compatible Missions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend per-tab mission attach to bind a Superpowers spec+plan pair, expose plan state to the operator's system prompt, and let the operator mark tasks / append notes as it works — while keeping today's Covenant single-file mission flow intact.

**Architecture:** New `MissionRef { kind, spec_path, plan_path? }` replaces the bare `PathBuf` argument to `set_mission`. A new `mission_pair` module owns plan resolution (frontmatter `spec:` field, filename fallback) and the narrow mutation API (`mark_plan_task`, `append_plan_note`) with mtime conflict detection. The existing `build_system_prompt` is rewired to emit two structured blocks (`<mission-spec>` cached, `<mission-plan>` mutable). The picker grows a second section listing Superpowers pairs with a file watcher and a "+ New Superpowers mission" entry that spawns a Claude Code tab pre-prompted to run `brainstorming`.

**Tech Stack:** Rust (tokio, serde, existing `notify`-based mission watcher), TypeScript (Tauri 2 invoke wrappers, vanilla DOM picker), no new third-party deps.

---

## File Structure

**Create**
- `crates/app/src/mission_pair.rs` — `MissionKind`, `MissionRef`, plan resolution (frontmatter + filename), `mark_plan_task`, `append_plan_note`. Pure logic + thin async file IO. ~280 lines.
- `ui/src/operator/superpowers-picker.ts` — Superpowers section of the picker: discovery, pair badges, "+ New" modal, file-watcher subscription. ~200 lines.

**Modify**
- `crates/app/src/operator.rs` — extend `MissionDoc` with optional plan, rewire `set_mission` / `clear_mission` / `get_mission` / system-prompt builder, hook plan watcher.
- `crates/app/src/lib.rs` — register new Tauri commands.
- `ui/src/api.ts` — typed wrappers.
- `ui/src/operator/picker.ts` — host the two sections + keyboard nav.
- `ui/src/operator/panel.ts` — kind-aware chip + plan-progress strip in the overlay.

**Test**
- Unit tests live next to the code in Rust (`#[cfg(test)] mod tests` in `mission_pair.rs` and inside `operator.rs` for the prompt-builder change).
- UI changes have explicit manual verification steps (no Vitest harness exists in this repo today).

---

## Task 1: Domain types — `MissionKind`, `MissionRef`, `PlanDoc`

**Files:**
- Create: `crates/app/src/mission_pair.rs`
- Modify: `crates/app/src/lib.rs:1-30` (add `mod mission_pair;`)

- [ ] **Step 1.1: Create `mission_pair.rs` with the core types**

```rust
//! Pairing layer for missions: a mission may attach a single Covenant
//! spec OR a Superpowers (spec, plan?) pair. This module owns the type
//! definitions, plan resolution, and the narrow mutation API used by
//! the operator at runtime.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MissionKind {
    Covenant,
    Superpowers,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MissionRef {
    pub kind: MissionKind,
    pub spec_path: PathBuf,
    pub plan_path: Option<PathBuf>,
}

/// In-memory representation of an attached plan file. Mirrors `MissionDoc`
/// in `operator.rs` but is only present when `MissionRef.plan_path` is
/// `Some`. The operator's prompt builder reads `content`; mtime drives
/// conflict detection on mutation ops.
#[derive(Debug, Clone)]
pub struct PlanDoc {
    pub path: PathBuf,
    pub content: String,
    pub mtime_unix_ms: u64,
}

impl MissionRef {
    pub fn covenant(spec_path: PathBuf) -> Self {
        Self { kind: MissionKind::Covenant, spec_path, plan_path: None }
    }
    pub fn superpowers(spec_path: PathBuf, plan_path: Option<PathBuf>) -> Self {
        Self { kind: MissionKind::Superpowers, spec_path, plan_path }
    }
}
```

- [ ] **Step 1.2: Register the module**

In `crates/app/src/lib.rs`, find the block of `mod` declarations near the top and add:

```rust
mod mission_pair;
```

- [ ] **Step 1.3: Verify it compiles**

Run: `cargo check -p covenant`
Expected: clean (no warnings about unused module — types are public).

- [ ] **Step 1.4: Commit**

```bash
git add crates/app/src/mission_pair.rs crates/app/src/lib.rs
git commit -m "feat(mission): add MissionRef + MissionKind + PlanDoc scaffolding"
```

---

## Task 2: Plan resolution — frontmatter parser

**Files:**
- Modify: `crates/app/src/mission_pair.rs`

The plan file may carry YAML frontmatter with a `spec:` field. Path values may be relative to the plan file or absolute.

- [ ] **Step 2.1: Write the failing test**

Append to `mission_pair.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_extracts_spec_relative_path() {
        let body = "---\nspec: ../specs/2026-05-04-foo-design.md\n---\n\n# Plan\n";
        let got = parse_plan_frontmatter_spec(body);
        assert_eq!(got, Some("../specs/2026-05-04-foo-design.md".to_string()));
    }

    #[test]
    fn frontmatter_missing_returns_none() {
        let body = "# Plan without frontmatter\n\nstuff\n";
        assert_eq!(parse_plan_frontmatter_spec(body), None);
    }

    #[test]
    fn frontmatter_without_spec_field_returns_none() {
        let body = "---\nauthor: x\n---\n\n# Plan\n";
        assert_eq!(parse_plan_frontmatter_spec(body), None);
    }

    #[test]
    fn frontmatter_with_quoted_value_extracts_unquoted() {
        let body = "---\nspec: \"../specs/foo-design.md\"\n---\n";
        assert_eq!(
            parse_plan_frontmatter_spec(body),
            Some("../specs/foo-design.md".to_string()),
        );
    }
}
```

- [ ] **Step 2.2: Run the test to verify it fails**

Run: `cargo test -p covenant mission_pair::tests::frontmatter -- --nocapture`
Expected: FAIL with "cannot find function `parse_plan_frontmatter_spec`".

- [ ] **Step 2.3: Implement the parser**

Add above the `#[cfg(test)]` block:

```rust
/// Extract the `spec:` field from a leading YAML frontmatter block, if
/// present. We don't pull in serde_yaml for this — the surface area is
/// one optional string, and a tiny manual parser keeps build deps flat.
pub fn parse_plan_frontmatter_spec(body: &str) -> Option<String> {
    let rest = body.strip_prefix("---\n")?;
    let end = rest.find("\n---")?;
    let block = &rest[..end];
    for line in block.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("spec:") else { continue };
        let val = rest.trim();
        let unquoted = val.trim_matches('"').trim_matches('\'').trim();
        if unquoted.is_empty() {
            return None;
        }
        return Some(unquoted.to_string());
    }
    None
}
```

- [ ] **Step 2.4: Re-run the test**

Run: `cargo test -p covenant mission_pair::tests::frontmatter`
Expected: 4 passed.

- [ ] **Step 2.5: Commit**

```bash
git add crates/app/src/mission_pair.rs
git commit -m "feat(mission): parse plan frontmatter spec field"
```

---

## Task 3: Plan resolution — full resolver (frontmatter → filename fallback)

**Files:**
- Modify: `crates/app/src/mission_pair.rs`

Given a spec path, find the matching plan in `docs/superpowers/plans/`, preferring frontmatter declarations, falling back to filename convention (strip trailing `-design`).

- [ ] **Step 3.1: Write the failing tests**

Append to the `tests` module:

```rust
use std::fs;
use tempfile::tempdir;

fn write(path: &Path, body: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, body).unwrap();
}

#[test]
fn resolve_plan_prefers_frontmatter_match() {
    let dir = tempdir().unwrap();
    let specs = dir.path().join("docs/superpowers/specs");
    let plans = dir.path().join("docs/superpowers/plans");
    let spec = specs.join("2026-05-04-foo-design.md");
    let frontmatter_plan = plans.join("unrelated-name.md");
    let convention_plan = plans.join("2026-05-04-foo.md");
    write(&spec, "# spec\n");
    write(
        &frontmatter_plan,
        "---\nspec: ../specs/2026-05-04-foo-design.md\n---\n# plan\n",
    );
    write(&convention_plan, "# also a plan\n");
    let got = resolve_plan_for_spec(&spec, &plans).unwrap();
    assert_eq!(got, Some(frontmatter_plan));
}

#[test]
fn resolve_plan_falls_back_to_filename_convention() {
    let dir = tempdir().unwrap();
    let specs = dir.path().join("docs/superpowers/specs");
    let plans = dir.path().join("docs/superpowers/plans");
    let spec = specs.join("2026-05-04-foo-design.md");
    let plan = plans.join("2026-05-04-foo.md");
    write(&spec, "# spec\n");
    write(&plan, "# plan no frontmatter\n");
    let got = resolve_plan_for_spec(&spec, &plans).unwrap();
    assert_eq!(got, Some(plan));
}

#[test]
fn resolve_plan_returns_none_when_no_match() {
    let dir = tempdir().unwrap();
    let specs = dir.path().join("docs/superpowers/specs");
    let plans = dir.path().join("docs/superpowers/plans");
    let spec = specs.join("2026-05-04-foo-design.md");
    write(&spec, "# spec\n");
    fs::create_dir_all(&plans).unwrap();
    assert_eq!(resolve_plan_for_spec(&spec, &plans).unwrap(), None);
}
```

- [ ] **Step 3.2: Add the `tempfile` dev-dep**

In `crates/app/Cargo.toml`, under `[dev-dependencies]` (create the section if absent):

```toml
[dev-dependencies]
tempfile = "3"
```

Run: `cargo build -p covenant --tests` to confirm it picks up.

- [ ] **Step 3.3: Run tests to confirm failure**

Run: `cargo test -p covenant mission_pair::tests::resolve_plan`
Expected: FAIL — `resolve_plan_for_spec` not defined.

- [ ] **Step 3.4: Implement the resolver**

```rust
/// Resolve the plan path for a given Superpowers spec.
///
/// 1. Scan `*.md` under `plans_dir`. For any file with a frontmatter
///    `spec:` value that resolves (via `plan_dir.join(value).canonicalize`)
///    to `spec_path.canonicalize()`, return it.
/// 2. Otherwise look for `<plans_dir>/<basename-stripped-of-`-design`>.md`.
/// 3. Otherwise `Ok(None)`.
pub fn resolve_plan_for_spec(
    spec_path: &Path,
    plans_dir: &Path,
) -> std::io::Result<Option<PathBuf>> {
    if !plans_dir.exists() {
        return Ok(None);
    }
    let target = std::fs::canonicalize(spec_path)?;
    for entry in std::fs::read_dir(plans_dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let body = match std::fs::read_to_string(&path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let Some(rel) = parse_plan_frontmatter_spec(&body) else { continue };
        let resolved = plans_dir.join(&rel);
        if let Ok(can) = std::fs::canonicalize(&resolved) {
            if can == target {
                return Ok(Some(path));
            }
        }
    }
    let stem = spec_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let stripped = stem.strip_suffix("-design").unwrap_or(stem);
    let candidate = plans_dir.join(format!("{stripped}.md"));
    if candidate.exists() {
        return Ok(Some(candidate));
    }
    Ok(None)
}
```

- [ ] **Step 3.5: Re-run**

Run: `cargo test -p covenant mission_pair::tests::resolve_plan`
Expected: 3 passed.

- [ ] **Step 3.6: Commit**

```bash
git add crates/app/src/mission_pair.rs crates/app/Cargo.toml Cargo.lock
git commit -m "feat(mission): resolve plan for spec via frontmatter + filename fallback"
```

---

## Task 4: Plan mutation — `mark_plan_task` (pure logic)

**Files:**
- Modify: `crates/app/src/mission_pair.rs`

Operates on plan content string; flips the Nth top-level `- [ ]` ↔ `- [x]`. "Top-level" means the line starts with `- [ ]` or `- [x]` (any leading indentation disqualifies — those are sub-tasks the operator cannot touch).

- [ ] **Step 4.1: Write failing tests**

```rust
#[test]
fn mark_plan_task_flips_unchecked_to_checked() {
    let body = "# Plan\n\n- [ ] Task A\n- [ ] Task B\n- [ ] Task C\n";
    let out = mark_plan_task_in_body(body, 1, true).unwrap();
    assert_eq!(
        out,
        "# Plan\n\n- [ ] Task A\n- [x] Task B\n- [ ] Task C\n",
    );
}

#[test]
fn mark_plan_task_flips_checked_to_unchecked() {
    let body = "- [x] A\n- [x] B\n";
    let out = mark_plan_task_in_body(body, 0, false).unwrap();
    assert_eq!(out, "- [ ] A\n- [x] B\n");
}

#[test]
fn mark_plan_task_skips_indented_subtasks() {
    let body = "- [ ] A\n  - [ ] sub\n- [ ] B\n";
    let out = mark_plan_task_in_body(body, 1, true).unwrap();
    assert_eq!(out, "- [ ] A\n  - [ ] sub\n- [x] B\n");
}

#[test]
fn mark_plan_task_index_out_of_range_errors() {
    let body = "- [ ] A\n";
    assert!(mark_plan_task_in_body(body, 5, true).is_err());
}
```

- [ ] **Step 4.2: Run, confirm fail**

Run: `cargo test -p covenant mission_pair::tests::mark_plan_task`
Expected: FAIL.

- [ ] **Step 4.3: Implement**

```rust
/// Pure-string version of `mark_plan_task` for unit testing.
pub fn mark_plan_task_in_body(
    body: &str,
    task_index: usize,
    done: bool,
) -> Result<String, String> {
    let mut count = 0usize;
    let mut out = String::with_capacity(body.len());
    let mut hit = false;
    for line in body.split_inclusive('\n') {
        let trimmed = line.trim_end_matches('\n');
        let is_top = trimmed.starts_with("- [ ] ") || trimmed.starts_with("- [x] ");
        if is_top {
            if count == task_index {
                let replacement = if done { "- [x] " } else { "- [ ] " };
                let rest = &trimmed[6..];
                out.push_str(replacement);
                out.push_str(rest);
                if line.ends_with('\n') {
                    out.push('\n');
                }
                hit = true;
                count += 1;
                continue;
            }
            count += 1;
        }
        out.push_str(line);
    }
    if !hit {
        return Err(format!(
            "task index {task_index} out of range (found {count} top-level tasks)",
        ));
    }
    Ok(out)
}
```

- [ ] **Step 4.4: Re-run**

Run: `cargo test -p covenant mission_pair::tests::mark_plan_task`
Expected: 4 passed.

- [ ] **Step 4.5: Commit**

```bash
git add crates/app/src/mission_pair.rs
git commit -m "feat(mission): mark_plan_task body transform"
```

---

## Task 5: Plan mutation — `append_plan_note` (pure logic)

**Files:**
- Modify: `crates/app/src/mission_pair.rs`

Inserts a `> note: <text>` line directly under the indicated task, before the next top-level task or end of file.

- [ ] **Step 5.1: Failing tests**

```rust
#[test]
fn append_plan_note_inserts_under_task() {
    let body = "- [ ] A\n- [ ] B\n";
    let out = append_plan_note_in_body(body, 0, "tried approach X").unwrap();
    assert_eq!(out, "- [ ] A\n> note: tried approach X\n- [ ] B\n");
}

#[test]
fn append_plan_note_appends_after_existing_notes() {
    let body = "- [ ] A\n> note: first\n- [ ] B\n";
    let out = append_plan_note_in_body(body, 0, "second").unwrap();
    assert_eq!(
        out,
        "- [ ] A\n> note: first\n> note: second\n- [ ] B\n",
    );
}

#[test]
fn append_plan_note_at_eof_when_last_task() {
    let body = "- [ ] A\n";
    let out = append_plan_note_in_body(body, 0, "done").unwrap();
    assert_eq!(out, "- [ ] A\n> note: done\n");
}

#[test]
fn append_plan_note_rejects_newlines_in_text() {
    let body = "- [ ] A\n";
    assert!(append_plan_note_in_body(body, 0, "line1\nline2").is_err());
}
```

- [ ] **Step 5.2: Run, confirm fail**

Run: `cargo test -p covenant mission_pair::tests::append_plan_note`
Expected: FAIL.

- [ ] **Step 5.3: Implement**

```rust
/// Pure-string version of `append_plan_note`. Inserts the note line at
/// the position immediately before the next top-level task (or EOF).
/// Rejects multi-line notes — the operator must escalate instead.
pub fn append_plan_note_in_body(
    body: &str,
    task_index: usize,
    note: &str,
) -> Result<String, String> {
    if note.contains('\n') {
        return Err("note must be a single line".into());
    }
    let lines: Vec<&str> = body.split_inclusive('\n').collect();
    let mut top_indices: Vec<usize> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let t = line.trim_end_matches('\n');
        if t.starts_with("- [ ] ") || t.starts_with("- [x] ") {
            top_indices.push(i);
        }
    }
    let Some(&start_idx) = top_indices.get(task_index) else {
        return Err(format!(
            "task index {task_index} out of range (found {} top-level tasks)",
            top_indices.len(),
        ));
    };
    let next_top = top_indices.get(task_index + 1).copied().unwrap_or(lines.len());
    let mut insert_at = start_idx + 1;
    while insert_at < next_top {
        let t = lines[insert_at].trim_end_matches('\n');
        if t.starts_with("> note:") {
            insert_at += 1;
        } else {
            break;
        }
    }
    let mut out = String::with_capacity(body.len() + note.len() + 16);
    for (i, line) in lines.iter().enumerate() {
        if i == insert_at {
            out.push_str(&format!("> note: {note}\n"));
        }
        out.push_str(line);
    }
    if insert_at == lines.len() {
        out.push_str(&format!("> note: {note}\n"));
    }
    Ok(out)
}
```

- [ ] **Step 5.4: Re-run**

Run: `cargo test -p covenant mission_pair::tests::append_plan_note`
Expected: 4 passed.

- [ ] **Step 5.5: Commit**

```bash
git add crates/app/src/mission_pair.rs
git commit -m "feat(mission): append_plan_note body transform"
```

---

## Task 6: Extend `MissionDoc` to carry a paired plan

**Files:**
- Modify: `crates/app/src/operator.rs:403-432` (`MissionDoc`, `MissionInfo`)

Augment `MissionDoc` with `kind` and `plan: Option<PlanDoc>`. Augment `MissionInfo` (the IPC payload) with `kind` and `plan` summary fields. Existing call sites that pass `Path` keep working: we add a constructor that defaults to Covenant + no plan.

- [ ] **Step 6.1: Edit `MissionDoc`**

In `operator.rs` near line 408, replace the struct with:

```rust
#[derive(Debug, Clone)]
pub struct MissionDoc {
    pub kind: crate::mission_pair::MissionKind,
    pub path: PathBuf,
    pub content: String,
    pub loaded_at_unix_ms: u64,
    pub mtime_unix_ms: u64,
    /// Present only when `kind == Superpowers` AND a plan was found.
    pub plan: Option<crate::mission_pair::PlanDoc>,
}
```

- [ ] **Step 6.2: Edit `MissionInfo`**

```rust
#[derive(Debug, Clone, serde::Serialize)]
pub struct MissionInfo {
    pub kind: crate::mission_pair::MissionKind,
    pub path: String,
    pub content_preview: String,
    pub loaded_at_unix_ms: u64,
    pub mtime_unix_ms: u64,
    pub plan: Option<MissionPlanInfo>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct MissionPlanInfo {
    pub path: String,
    pub mtime_unix_ms: u64,
    pub tasks_total: usize,
    pub tasks_done: usize,
}
```

- [ ] **Step 6.3: Add a counter helper in `mission_pair.rs`**

```rust
pub fn count_top_level_tasks(body: &str) -> (usize, usize) {
    let mut total = 0;
    let mut done = 0;
    for line in body.lines() {
        if line.starts_with("- [ ] ") {
            total += 1;
        } else if line.starts_with("- [x] ") {
            total += 1;
            done += 1;
        }
    }
    (total, done)
}

#[cfg(test)]
#[test]
fn count_top_level_tasks_counts_only_top_level() {
    let body = "- [ ] A\n  - [ ] sub\n- [x] B\n- [ ] C\n";
    assert_eq!(count_top_level_tasks(body), (3, 1));
}
```

- [ ] **Step 6.4: Update `load_mission_doc` (around `operator.rs:780-820`)**

Locate `load_mission_doc` (search `fn load_mission_doc`) and update its signature to take a `MissionRef` instead of a `&Path`. Pseudocode (adapt to the existing impl's exact shape):

```rust
async fn load_mission_doc(
    mref: &crate::mission_pair::MissionRef,
) -> Result<MissionDoc, String> {
    let (content, mtime_unix_ms, loaded_at_unix_ms) = read_with_mtime(&mref.spec_path).await?;
    let plan = if let Some(plan_path) = mref.plan_path.as_ref() {
        let (pcontent, pmtime, _) = read_with_mtime(plan_path).await?;
        Some(crate::mission_pair::PlanDoc {
            path: plan_path.clone(),
            content: pcontent,
            mtime_unix_ms: pmtime,
        })
    } else {
        None
    };
    Ok(MissionDoc {
        kind: mref.kind,
        path: mref.spec_path.clone(),
        content,
        loaded_at_unix_ms,
        mtime_unix_ms,
        plan,
    })
}
```

If the existing `load_mission_doc` does its own `tokio::fs::read_to_string` + `metadata().modified()` dance, factor that into a small `read_with_mtime` helper as shown — keep the impl identical, just call it twice.

- [ ] **Step 6.5: Compile-check**

Run: `cargo check -p covenant`
Expected: errors at `set_mission` / `MissionInfo` construction sites — those get fixed in Task 7. Note them and proceed.

- [ ] **Step 6.6: Commit (WIP)**

```bash
git add crates/app/src/operator.rs crates/app/src/mission_pair.rs
git commit -m "feat(mission): extend MissionDoc with kind + paired plan (WIP)"
```

---

## Task 7: Rewire `set_mission` / `get_mission` / persistence

**Files:**
- Modify: `crates/app/src/operator.rs:641-692` (`set_mission`, `clear_mission`)
- Modify: `crates/app/src/operator.rs:718-732` (`get_mission`)
- Modify: `crates/app/src/mission_persistence.rs`

`set_mission` now takes `MissionRef`. `MissionInfo` includes the plan summary. Persistence stores the full `MissionRef` (so app restart can re-attach the same pair).

- [ ] **Step 7.1: Update `set_mission` signature + body**

Replace the function around line 641 with:

```rust
pub async fn set_mission(
    &self,
    session_id: SessionId,
    mref: crate::mission_pair::MissionRef,
) -> Result<MissionInfo, String> {
    let doc = load_mission_doc(&mref).await?;
    let info = mission_info_from_doc(&doc);
    let cwd = {
        let mut inner = self.inner.lock().await;
        let Some(att) = inner.sessions.get_mut(&session_id) else {
            return Ok(info);
        };
        let cwd = {
            let w = att.world.lock().await;
            w.cwd.display().to_string()
        };
        att.mission = Some(doc.clone());
        cwd
    };
    mission_persistence::record(&self.mission_store, cwd, &mref);
    Ok(info)
}

fn mission_info_from_doc(doc: &MissionDoc) -> MissionInfo {
    let plan = doc.plan.as_ref().map(|p| {
        let (total, done) = crate::mission_pair::count_top_level_tasks(&p.content);
        MissionPlanInfo {
            path: p.path.display().to_string(),
            mtime_unix_ms: p.mtime_unix_ms,
            tasks_total: total,
            tasks_done: done,
        }
    });
    MissionInfo {
        kind: doc.kind,
        path: doc.path.display().to_string(),
        content_preview: take_preview(&doc.content, 240),
        loaded_at_unix_ms: doc.loaded_at_unix_ms,
        mtime_unix_ms: doc.mtime_unix_ms,
        plan,
    }
}
```

- [ ] **Step 7.2: Update `get_mission`**

Around line 718 replace the body with:

```rust
pub async fn get_mission(&self, session_id: SessionId) -> Option<MissionInfo> {
    self.inner
        .lock()
        .await
        .sessions
        .get(&session_id)
        .and_then(|a| a.mission.as_ref().map(mission_info_from_doc))
}
```

- [ ] **Step 7.3: Update `mission_persistence` to store `MissionRef`**

Inspect `mission_persistence.rs`. Change the on-disk shape from a single `String` (path) to a serde-serialized `MissionRef`. Adjust `record` and the read-side helper:

```rust
pub fn record(store: &Path, cwd: String, mref: &crate::mission_pair::MissionRef) {
    // existing logic, but serialize mref via serde_json
}
```

If existing entries are bare strings, treat them as `MissionRef::covenant(PathBuf::from(s))` on read — backward compat for users with persisted state. Add a unit test for this fallback.

- [ ] **Step 7.4: Fix all remaining call sites**

Run: `cargo check -p covenant`
Address each error. The likely sites:
- `notify_cwd_changed` and the manifest-restore path (search `set_mission(`) — wrap their `PathBuf` in `MissionRef::covenant(...)`.
- `set_mission_content` should keep working unchanged (it operates on `att.mission.path`).

Expected after: `cargo check -p covenant` clean.

- [ ] **Step 7.5: Commit**

```bash
git add crates/app/src/operator.rs crates/app/src/mission_persistence.rs
git commit -m "feat(mission): set_mission takes MissionRef; persistence stores it"
```

---

## Task 8: Rewire `build_system_prompt` to emit structured blocks

**Files:**
- Modify: `crates/app/src/operator.rs:2033-2076` (`build_system_prompt`)

The mission block becomes one or two structured XML-like sections. Existing tests `build_system_prompt_empty_learned_matches_baseline` and `build_system_prompt_with_learned_renders_block` must continue to pass for the no-mission case.

- [ ] **Step 8.1: Write the new tests**

In the existing `#[cfg(test)] mod tests` of `operator.rs`, add:

```rust
#[test]
fn build_system_prompt_emits_covenant_mission_block() {
    let mref = crate::mission_pair::MissionRef::covenant("/tmp/spec.md".into());
    let doc = MissionDoc {
        kind: mref.kind,
        path: mref.spec_path.clone(),
        content: "Goal: do X".into(),
        loaded_at_unix_ms: 0,
        mtime_unix_ms: 0,
        plan: None,
    };
    let out = build_system_prompt("persona", false, Some(&doc), &[]);
    assert!(out.contains("<mission-spec kind=\"covenant\""));
    assert!(out.contains("Goal: do X"));
    assert!(!out.contains("<mission-plan"));
}

#[test]
fn build_system_prompt_emits_superpowers_with_plan_block() {
    let plan = crate::mission_pair::PlanDoc {
        path: "/tmp/plan.md".into(),
        content: "- [x] one\n- [ ] two\n".into(),
        mtime_unix_ms: 0,
    };
    let doc = MissionDoc {
        kind: crate::mission_pair::MissionKind::Superpowers,
        path: "/tmp/spec.md".into(),
        content: "spec body".into(),
        loaded_at_unix_ms: 0,
        mtime_unix_ms: 0,
        plan: Some(plan),
    };
    let out = build_system_prompt("persona", false, Some(&doc), &[]);
    assert!(out.contains("<mission-spec kind=\"superpowers\""));
    assert!(out.contains("spec body"));
    assert!(out.contains("<mission-plan status=\"1/2\""));
    assert!(out.contains("- [x] one"));
}

#[test]
fn build_system_prompt_emits_no_plan_hint_when_superpowers_without_plan() {
    let doc = MissionDoc {
        kind: crate::mission_pair::MissionKind::Superpowers,
        path: "/tmp/spec.md".into(),
        content: "spec body".into(),
        loaded_at_unix_ms: 0,
        mtime_unix_ms: 0,
        plan: None,
    };
    let out = build_system_prompt("persona", false, Some(&doc), &[]);
    assert!(out.contains("no plan attached; ESCALATE"));
}
```

- [ ] **Step 8.2: Run, confirm fail**

Run: `cargo test -p covenant operator::tests::build_system_prompt`
Expected: the three new tests fail; the two pre-existing `..._empty_learned_matches_baseline` / `..._with_learned_renders_block` tests still pass.

- [ ] **Step 8.3: Implement the new `mission_block`**

Replace the `let mission_block = …` block (around line 2044) with:

```rust
let mission_block = mission
    .map(|m| {
        let kind = match m.kind {
            crate::mission_pair::MissionKind::Covenant => "covenant",
            crate::mission_pair::MissionKind::Superpowers => "superpowers",
        };
        let spec = format!(
            "<mission-spec kind=\"{kind}\" path=\"{path}\">\n{content}\n</mission-spec>\n\n",
            path = m.path.display(),
            content = m.content.trim(),
        );
        let plan = match (&m.plan, m.kind) {
            (Some(p), _) => {
                let (total, done) = crate::mission_pair::count_top_level_tasks(&p.content);
                format!(
                    "<mission-plan status=\"{done}/{total}\" path=\"{path}\">\n{content}\n</mission-plan>\n\n",
                    path = p.path.display(),
                    content = p.content.trim(),
                )
            }
            (None, crate::mission_pair::MissionKind::Superpowers) => {
                "<!-- no plan attached; ESCALATE before executing TDD steps -->\n\n".to_string()
            }
            (None, crate::mission_pair::MissionKind::Covenant) => String::new(),
        };
        format!("{spec}{plan}")
    })
    .unwrap_or_default();
```

Remove the now-unused `MISSION_DIRECTIVE`-prefixed legacy block. (Keep the constant if other call sites reference it; otherwise delete.)

- [ ] **Step 8.4: Re-run all `build_system_prompt` tests**

Run: `cargo test -p covenant operator::tests::build_system_prompt`
Expected: 5 passed (3 new + 2 baseline).

⚠️ **Cache impact:** the prefix bytes for sessions WITHOUT a mission are unchanged (test `..._empty_learned_matches_baseline` guards this). Sessions WITH a mission lose their existing prefix-cache hit one time on upgrade — acceptable.

- [ ] **Step 8.5: Commit**

```bash
git add crates/app/src/operator.rs
git commit -m "feat(operator): emit structured mission-spec/mission-plan prompt blocks"
```

---

## Task 9: Plan mutation Tauri commands + watcher hook

**Files:**
- Modify: `crates/app/src/operator.rs` (add `mark_plan_task` / `append_plan_note` methods on `OperatorWatcher`)
- Modify: `crates/app/src/lib.rs` (register commands)

The runtime mutation API: write to disk via the pure transforms from Tasks 4–5, with mtime conflict detection.

- [ ] **Step 9.1: Add `mark_plan_task` method on `OperatorWatcher`**

In `operator.rs` (near `set_mission_content`), add:

```rust
pub async fn mark_plan_task(
    &self,
    session_id: SessionId,
    task_index: usize,
    done: bool,
    expected_mtime_unix_ms: u64,
) -> Result<MissionPlanInfo, String> {
    let plan_path = {
        let inner = self.inner.lock().await;
        let att = inner.sessions.get(&session_id).ok_or("no session")?;
        let mission = att.mission.as_ref().ok_or("no mission attached")?;
        let plan = mission.plan.as_ref().ok_or("mission has no plan")?;
        plan.path.clone()
    };
    let body = tokio::fs::read_to_string(&plan_path).await.map_err(|e| e.to_string())?;
    let actual_mtime = mtime_unix_ms(&plan_path).await?;
    if expected_mtime_unix_ms != 0 && actual_mtime != expected_mtime_unix_ms {
        return Err(format!("plan changed on disk (mtime {actual_mtime} != {expected_mtime_unix_ms})"));
    }
    let new_body = crate::mission_pair::mark_plan_task_in_body(&body, task_index, done)?;
    tokio::fs::write(&plan_path, &new_body).await.map_err(|e| e.to_string())?;
    let new_mtime = mtime_unix_ms(&plan_path).await?;
    let (total, done_count) = crate::mission_pair::count_top_level_tasks(&new_body);
    // Refresh in-memory copy so the next prompt build sees it.
    {
        let mut inner = self.inner.lock().await;
        if let Some(att) = inner.sessions.get_mut(&session_id) {
            if let Some(m) = att.mission.as_mut() {
                if let Some(p) = m.plan.as_mut() {
                    p.content = new_body;
                    p.mtime_unix_ms = new_mtime;
                }
            }
        }
    }
    Ok(MissionPlanInfo {
        path: plan_path.display().to_string(),
        mtime_unix_ms: new_mtime,
        tasks_total: total,
        tasks_done: done_count,
    })
}
```

(Where `mtime_unix_ms` is whatever helper the existing `set_mission_content` uses — copy that pattern, do not invent a new one.)

- [ ] **Step 9.2: Add `append_plan_note` analogously**

Same skeleton, but call `append_plan_note_in_body(body, task_index, &note)` instead.

- [ ] **Step 9.3: Register Tauri commands in `lib.rs`**

In `crates/app/src/lib.rs`, find the `tauri::generate_handler!` macro and add:

```rust
operator_mark_plan_task,
operator_append_plan_note,
```

Define the wrappers near the existing operator commands (search `operator_set_mission`):

```rust
#[tauri::command]
async fn operator_mark_plan_task(
    state: tauri::State<'_, AppState>,
    session_id: String,
    task_index: usize,
    done: bool,
    expected_mtime_unix_ms: u64,
) -> Result<crate::operator::MissionPlanInfo, String> {
    let sid = parse_session_id(&session_id)?;
    state.operator.mark_plan_task(sid, task_index, done, expected_mtime_unix_ms).await
}

#[tauri::command]
async fn operator_append_plan_note(
    state: tauri::State<'_, AppState>,
    session_id: String,
    task_index: usize,
    note: String,
    expected_mtime_unix_ms: u64,
) -> Result<crate::operator::MissionPlanInfo, String> {
    let sid = parse_session_id(&session_id)?;
    state.operator.append_plan_note(sid, task_index, note, expected_mtime_unix_ms).await
}
```

(Match the surrounding command signatures' exact shape — `AppState`, `parse_session_id`, etc. are already used by `operator_set_mission`.)

- [ ] **Step 9.4: Update the existing `operator_set_mission` to take `MissionRef`**

Find `operator_set_mission` in `lib.rs`. Change the parameter to `mref: crate::mission_pair::MissionRef` and pass through to `state.operator.set_mission(sid, mref).await`.

- [ ] **Step 9.5: Compile + cargo test**

Run: `cargo check -p covenant && cargo test -p covenant`
Expected: clean; all tests pass.

- [ ] **Step 9.6: Commit**

```bash
git add crates/app/src/operator.rs crates/app/src/lib.rs
git commit -m "feat(operator): mark_plan_task + append_plan_note Tauri commands"
```

---

## Task 10: Mission watcher reloads the plan too

**Files:**
- Modify: `crates/app/src/operator.rs` (search `MISSION_REFRESH_EVERY_TICKS`)

The existing watcher polls the spec mtime every ~2.5s. Extend it to also poll the plan mtime when present, and re-load the plan body on change.

- [ ] **Step 10.1: Locate the watcher tick code**

Run: `grep -n "MISSION_REFRESH_EVERY_TICKS\|mission.*mtime" crates/app/src/operator.rs`
Read the function that handles the spec re-check (likely inside `tick_loop` or a helper called by it).

- [ ] **Step 10.2: Add a parallel plan re-check**

Inside the same block that re-stats the spec, after handling the spec, add (adapted to the existing variable names):

```rust
if let Some(plan) = mission.plan.as_ref() {
    if let Ok(new_mtime) = mtime_unix_ms(&plan.path).await {
        if new_mtime != plan.mtime_unix_ms {
            if let Ok(new_body) = tokio::fs::read_to_string(&plan.path).await {
                if let Some(p) = mission.plan.as_mut() {
                    p.content = new_body;
                    p.mtime_unix_ms = new_mtime;
                }
            }
        }
    }
}
```

- [ ] **Step 10.3: Manual verification**

```bash
cargo build -p covenant
# Run the app, attach a Superpowers mission to a tab.
# Edit the plan file in another editor, save, then trigger the operator.
# Check that the operator's reasoning references the updated plan content.
```

- [ ] **Step 10.4: Commit**

```bash
git add crates/app/src/operator.rs
git commit -m "feat(operator): mission watcher hot-reloads paired plan"
```

---

## Task 11: TypeScript API wrappers

**Files:**
- Modify: `ui/src/api.ts`

Match the new backend signatures.

- [ ] **Step 11.1: Add the types**

Near other operator types in `api.ts`, add:

```ts
export type MissionKind = "covenant" | "superpowers";

export interface MissionRef {
  kind: MissionKind;
  spec_path: string;
  plan_path: string | null;
}

export interface MissionPlanInfo {
  path: string;
  mtime_unix_ms: number;
  tasks_total: number;
  tasks_done: number;
}

export interface MissionInfo {
  kind: MissionKind;
  path: string;
  content_preview: string;
  loaded_at_unix_ms: number;
  mtime_unix_ms: number;
  plan: MissionPlanInfo | null;
}
```

(If `MissionInfo` already exists, edit it to match.)

- [ ] **Step 11.2: Update `setMission` wrapper**

Replace whatever today calls `operator_set_mission(session_id, path)` with:

```ts
export async function setMission(
  sessionId: string,
  mref: MissionRef,
): Promise<MissionInfo> {
  return invoke<MissionInfo>("operator_set_mission", { sessionId, mref });
}
```

- [ ] **Step 11.3: Add the new wrappers**

```ts
export async function markPlanTask(
  sessionId: string,
  taskIndex: number,
  done: boolean,
  expectedMtimeUnixMs: number,
): Promise<MissionPlanInfo> {
  return invoke<MissionPlanInfo>("operator_mark_plan_task", {
    sessionId,
    taskIndex,
    done,
    expectedMtimeUnixMs,
  });
}

export async function appendPlanNote(
  sessionId: string,
  taskIndex: number,
  note: string,
  expectedMtimeUnixMs: number,
): Promise<MissionPlanInfo> {
  return invoke<MissionPlanInfo>("operator_append_plan_note", {
    sessionId,
    taskIndex,
    note,
    expectedMtimeUnixMs,
  });
}
```

- [ ] **Step 11.4: Add a Superpowers discovery wrapper**

Add a new Tauri command in `lib.rs` named `list_superpowers_missions` that lists `docs/superpowers/specs/*.md` and returns each paired with its resolved plan (call `mission_pair::resolve_plan_for_spec` per spec). Then wrap:

```ts
export interface SuperpowersMissionEntry {
  spec_path: string;
  spec_filename: string;
  plan_path: string | null;
  goal_preview: string;  // first non-blank line after the first heading
}

export async function listSuperpowersMissions(): Promise<SuperpowersMissionEntry[]> {
  return invoke<SuperpowersMissionEntry[]>("list_superpowers_missions");
}
```

Implement the Rust side in `lib.rs`:

```rust
#[tauri::command]
async fn list_superpowers_missions(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<SuperpowersMissionEntry>, String> {
    let root = state.project_root.clone();  // existing field on AppState
    let specs_dir = root.join("docs/superpowers/specs");
    let plans_dir = root.join("docs/superpowers/plans");
    let mut out = Vec::new();
    if !specs_dir.exists() {
        return Ok(out);
    }
    for entry in std::fs::read_dir(&specs_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") { continue; }
        let body = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let plan = crate::mission_pair::resolve_plan_for_spec(&path, &plans_dir)
            .map_err(|e| e.to_string())?;
        let goal = body.lines().find(|l| !l.starts_with('#') && !l.trim().is_empty())
            .unwrap_or("").chars().take(120).collect::<String>();
        out.push(SuperpowersMissionEntry {
            spec_filename: path.file_name().unwrap().to_string_lossy().into(),
            spec_path: path.display().to_string(),
            plan_path: plan.map(|p| p.display().to_string()),
            goal_preview: goal,
        });
    }
    Ok(out)
}

#[derive(serde::Serialize)]
struct SuperpowersMissionEntry {
    spec_path: String,
    spec_filename: String,
    plan_path: Option<String>,
    goal_preview: String,
}
```

Register in `tauri::generate_handler!`.

- [ ] **Step 11.5: Verify**

Run: `npx tsc --noEmit` (in `ui/`) and `cargo check -p covenant`.
Expected: clean.

- [ ] **Step 11.6: Commit**

```bash
git add ui/src/api.ts crates/app/src/lib.rs
git commit -m "feat(ipc): mission ref + plan task ops + superpowers discovery"
```

---

## Task 12: Picker — Superpowers section

**Files:**
- Create: `ui/src/operator/superpowers-picker.ts`
- Modify: `ui/src/operator/picker.ts`

The picker today is a single list (Covenant). Add a second section that calls `listSuperpowersMissions` and renders pair rows.

- [ ] **Step 12.1: Scaffold `superpowers-picker.ts`**

```ts
import {
  listSuperpowersMissions,
  type SuperpowersMissionEntry,
  type MissionRef,
} from "../api";

export interface SuperpowersSectionCallbacks {
  onSelect: (mref: MissionRef) => void;
  onCreateNew: () => void;
  onGeneratePlan: (specPath: string) => void;
}

export class SuperpowersSection {
  private root: HTMLElement;
  private listEl: HTMLElement;
  private entries: SuperpowersMissionEntry[] = [];

  constructor(parent: HTMLElement, private cb: SuperpowersSectionCallbacks) {
    this.root = document.createElement("section");
    this.root.className = "mission-picker__section mission-picker__section--sp";
    const header = document.createElement("header");
    header.innerHTML = `<h3>Superpowers</h3>`;
    const newBtn = document.createElement("button");
    newBtn.textContent = "+ New Superpowers mission";
    newBtn.className = "mission-picker__new-sp";
    newBtn.addEventListener("click", () => cb.onCreateNew());
    header.appendChild(newBtn);
    this.root.appendChild(header);
    this.listEl = document.createElement("ul");
    this.listEl.className = "mission-picker__list";
    this.root.appendChild(this.listEl);
    parent.appendChild(this.root);
  }

  async refresh(): Promise<void> {
    this.entries = await listSuperpowersMissions();
    this.render();
  }

  private render(): void {
    this.listEl.innerHTML = "";
    if (this.entries.length === 0) {
      const empty = document.createElement("li");
      empty.className = "mission-picker__empty";
      empty.textContent = "No Superpowers specs yet.";
      this.listEl.appendChild(empty);
      return;
    }
    for (const e of this.entries) {
      const li = document.createElement("li");
      li.className = "mission-picker__row";
      li.innerHTML = `
        <span class="mission-picker__name">${escapeHtml(e.spec_filename)}</span>
        <span class="mission-picker__goal">${escapeHtml(e.goal_preview)}</span>
        <span class="mission-picker__badge mission-picker__badge--ok">spec ✓</span>
      `;
      const planBadge = document.createElement("span");
      planBadge.className = "mission-picker__badge";
      if (e.plan_path) {
        planBadge.classList.add("mission-picker__badge--ok");
        planBadge.textContent = "plan ✓";
      } else {
        planBadge.classList.add("mission-picker__badge--missing");
        planBadge.textContent = "plan ✗";
        planBadge.title = "No plan yet — click to generate via writing-plans";
        planBadge.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.cb.onGeneratePlan(e.spec_path);
        });
      }
      li.appendChild(planBadge);
      li.addEventListener("click", () => {
        this.cb.onSelect({
          kind: "superpowers",
          spec_path: e.spec_path,
          plan_path: e.plan_path,
        });
      });
      this.listEl.appendChild(li);
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!),
  );
}
```

- [ ] **Step 12.2: Wire into `picker.ts`**

Open `ui/src/operator/picker.ts`. Find where the existing list is built. Wrap that into a "Covenant specs" section wrapper, then mount `SuperpowersSection` after it. Pass:

```ts
new SuperpowersSection(modalRoot, {
  onSelect: (mref) => this.attachMission(mref),
  onCreateNew: () => this.openNewSuperpowersModal(),
  onGeneratePlan: (specPath) => this.spawnWritingPlansTab(specPath),
});
```

`attachMission` wraps the call to `setMission(sessionId, mref)` (Covenant rows pass `{ kind: "covenant", spec_path, plan_path: null }`).

- [ ] **Step 12.3: Add a file watcher for refresh**

In `lib.rs` add a Tauri event emitter `superpowers-missions-changed` that fires when any file under `docs/superpowers/specs/` or `docs/superpowers/plans/` changes (use the existing `notify` infra if already present; otherwise a 2s polling loop comparing mtimes is acceptable for v1). In `superpowers-picker.ts` `constructor`:

```ts
import { listen } from "@tauri-apps/api/event";
listen("superpowers-missions-changed", () => this.refresh());
```

- [ ] **Step 12.4: Add CSS**

Append to `ui/src/styles.css` (under the existing mission-picker section):

```css
.mission-picker__section--sp { border-top: 1px solid var(--border); padding-top: 12px; }
.mission-picker__new-sp { float: right; font-size: 11px; padding: 2px 8px; }
.mission-picker__row { display: grid; grid-template-columns: 1fr 1fr auto auto; gap: 8px; align-items: center; padding: 6px 8px; cursor: pointer; }
.mission-picker__row:hover { background: var(--bg-panel); }
.mission-picker__badge { font-size: 10px; padding: 2px 6px; border-radius: 4px; }
.mission-picker__badge--ok { color: var(--accent); border: 1px solid var(--accent); }
.mission-picker__badge--missing { color: var(--muted); border: 1px dashed var(--muted); cursor: pointer; }
.mission-picker__empty { padding: 8px; color: var(--muted); font-style: italic; }
```

- [ ] **Step 12.5: Manual verification**

```bash
cargo build -p covenant && (cd ui && npx tsc --noEmit)
# Run the app. ⌘M opens picker. Confirm two sections render.
# Click a Superpowers row — operator panel should show kind=superpowers chip.
# Touch a spec file via `touch docs/superpowers/specs/foo.md` — picker refreshes.
```

- [ ] **Step 12.6: Commit**

```bash
git add ui/src/operator/superpowers-picker.ts ui/src/operator/picker.ts ui/src/styles.css crates/app/src/lib.rs
git commit -m "feat(ui): superpowers section in mission picker"
```

---

## Task 13: "+ New Superpowers mission" flow

**Files:**
- Modify: `ui/src/operator/picker.ts` (or a new small `ui/src/operator/new-mission-modal.ts` if it grows)

The button spawns a new Covenant tab with a pre-populated initial command that invokes the `brainstorming` skill.

- [ ] **Step 13.1: Add the modal**

In `picker.ts`, implement `openNewSuperpowersModal`:

```ts
private openNewSuperpowersModal(): void {
  const modal = document.createElement("div");
  modal.className = "mission-picker__newmodal";
  modal.innerHTML = `
    <h4>New Superpowers mission</h4>
    <label>Topic <input type="text" id="sp-topic" placeholder="what do you want to brainstorm?" /></label>
    <div class="mission-picker__newmodal-actions">
      <button id="sp-cancel">Cancel</button>
      <button id="sp-create">Create tab</button>
    </div>
  `;
  document.body.appendChild(modal);
  const input = modal.querySelector<HTMLInputElement>("#sp-topic")!;
  input.focus();
  modal.querySelector("#sp-cancel")!.addEventListener("click", () => modal.remove());
  modal.querySelector("#sp-create")!.addEventListener("click", async () => {
    const topic = input.value.trim();
    if (!topic) return;
    await this.spawnBrainstormingTab(topic);
    modal.remove();
  });
}

private async spawnBrainstormingTab(topic: string): Promise<void> {
  const initial = `Use the brainstorming skill to design: ${topic}`;
  // existing tab API — match whatever recall/picker uses today
  await spawnTabWithInitialCommand(initial);
}

private async spawnWritingPlansTab(specPath: string): Promise<void> {
  const initial = `Use the writing-plans skill to create the plan for ${specPath}`;
  await spawnTabWithInitialCommand(initial);
}
```

- [ ] **Step 13.2: Implement `spawnTabWithInitialCommand`**

Search the codebase for an existing "open tab with command" call (e.g. used by Recall to launch a command):

```bash
grep -rn "spawn_session\|open_tab_with\|initial_command" ui/src crates/app/src
```

If a function exists, reuse it. If not, add a new Tauri command `spawn_tab_with_initial(command: String) -> SessionId` that creates a session and writes `command + "\n"` into the PTY after the prompt is ready (use the existing prompt-ready signal — search `prompt_ready` or OSC 133 A handler).

- [ ] **Step 13.3: Add CSS**

```css
.mission-picker__newmodal {
  position: fixed; inset: 50% auto auto 50%; transform: translate(-50%, -50%);
  background: var(--bg-overlay); border: 1px solid var(--border);
  padding: 16px; border-radius: 6px; z-index: 100;
}
.mission-picker__newmodal input { width: 360px; }
.mission-picker__newmodal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
```

- [ ] **Step 13.4: Manual verification**

```bash
cargo build -p covenant && (cd ui && npx tsc --noEmit)
# Click "+ New Superpowers mission". Type a topic. Click Create.
# A new tab opens; its first command should be the brainstorming invocation.
# Click a `plan ✗` badge on an existing spec row. A new tab opens with the
# writing-plans invocation prefilled.
```

- [ ] **Step 13.5: Commit**

```bash
git add ui/src/operator/picker.ts ui/src/styles.css
git commit -m "feat(ui): new superpowers mission flow + plan generation shortcut"
```

---

## Task 14: Mission chip + overlay — kind-aware rendering

**Files:**
- Modify: `ui/src/operator/panel.ts`
- Modify: `ui/src/tabs/manager.ts`

Chip color depends on `kind`. Overlay shows a plan progress strip (read-only checklist).

- [ ] **Step 14.1: Update chip render**

In `panel.ts`, find the function that renders the mission chip in the operator panel and tab strip. Replace the static color with kind-conditional:

```ts
function renderMissionChip(info: MissionInfo): HTMLElement {
  const chip = document.createElement("span");
  chip.className = `mission-chip mission-chip--${info.kind}`;
  const icon = info.kind === "superpowers" ? "🧭" : "📋";
  const slug = filenameToSlug(info.path);
  chip.textContent = `${icon} ${slug}`;
  const planSummary = info.plan
    ? `${info.plan.tasks_done}/${info.plan.tasks_total} done`
    : info.kind === "superpowers" ? "no plan" : "";
  chip.title = `${info.path}\n${planSummary}`;
  return chip;
}
```

- [ ] **Step 14.2: Add CSS for chip variants**

```css
.mission-chip { display: inline-flex; padding: 2px 8px; border-radius: 4px; font-size: 11px; }
.mission-chip--covenant { background: color-mix(in srgb, var(--accent) 20%, transparent); border: 1px solid var(--accent); }
.mission-chip--superpowers { background: color-mix(in srgb, var(--accent-alt, #b06aff) 22%, transparent); border: 1px solid var(--accent-alt, #b06aff); }
```

If `--accent-alt` doesn't exist, define it once at `:root`:

```css
:root { --accent-alt: #b06aff; }
```

- [ ] **Step 14.3: Plan progress strip in mission overlay**

In `panel.ts`, find where the mission overlay renders the spec content. Below the spec content, conditionally render:

```ts
if (info.plan) {
  const planSection = document.createElement("section");
  planSection.className = "mission-overlay__plan";
  planSection.innerHTML = `<h4>Plan progress (${info.plan.tasks_done}/${info.plan.tasks_total})</h4>`;
  // Fetch plan body via a new `get_plan_content` command for display.
  const body = await getPlanContent(sessionId);
  const list = document.createElement("ul");
  for (const line of (body ?? "").split("\n")) {
    if (line.startsWith("- [ ] ") || line.startsWith("- [x] ")) {
      const li = document.createElement("li");
      li.textContent = line;
      li.className = line.startsWith("- [x] ") ? "done" : "pending";
      list.appendChild(li);
    }
  }
  planSection.appendChild(list);
  overlayRoot.appendChild(planSection);
}
```

Add `get_plan_content` Tauri command (analogous to `get_mission_content`) and a TS wrapper.

- [ ] **Step 14.4: Update tab strip chip in `manager.ts`**

Search for where tab title is rendered with mission badge. Use the same `renderMissionChip` helper to keep behavior consistent.

- [ ] **Step 14.5: Manual verification**

```bash
cargo build -p covenant && (cd ui && npx tsc --noEmit)
# Attach a Covenant mission → chip is accent-colored, no plan progress strip.
# Attach a Superpowers mission with a plan → chip is purple, overlay shows
#   N/M done with checkbox list.
# Mark a task via the operator (or by editing the file in another editor) →
#   reopen overlay, count and checkboxes reflect the change.
```

- [ ] **Step 14.6: Commit**

```bash
git add ui/src/operator/panel.ts ui/src/tabs/manager.ts ui/src/styles.css ui/src/api.ts crates/app/src/lib.rs crates/app/src/operator.rs
git commit -m "feat(ui): kind-aware mission chip + plan progress strip in overlay"
```

---

## Task 15: End-to-end smoke + final checks

- [ ] **Step 15.1: Full build and test**

```bash
cargo test -p covenant
(cd ui && npx tsc --noEmit)
cargo build -p covenant --release
```

Expected: all green.

- [ ] **Step 15.2: Manual smoke (golden path)**

1. Launch the app.
2. Open a tab in this repo's working dir.
3. ⌘M → "+ New Superpowers mission" → topic "tab grouping by mission". A new tab opens running `Use the brainstorming skill to design: tab grouping by mission`.
4. Cancel out of brainstorming by closing that tab (we just wanted to see the spawn worked).
5. ⌘M → click an existing Superpowers row (this very plan, for instance) → mission attaches; chip is purple `🧭 2026-05-04-superpowers...`.
6. Open the operator overlay; confirm the plan progress strip shows N/M done with this plan's checkboxes.
7. From an executor agent in the same tab, simulate `mark_plan_task` via `invoke('operator_mark_plan_task', ...)` from devtools or by triggering the operator's normal flow on a non-zero exit.
8. Verify the plan file on disk has the updated checkbox.
9. Switch the same tab's mission to a Covenant spec — chip color flips to accent, plan strip disappears.

- [ ] **Step 15.3: Commit any final fixups, update CHANGELOG**

If a CHANGELOG exists, add an entry. Otherwise skip.

```bash
git add -p
git commit -m "feat: superpowers-compatible missions (end-to-end)"
```

- [ ] **Step 15.4: Open PR or merge to main per branch policy**

Per `feedback_commit_granularity.md` (one commit per feature) you may want to squash before merge — coordinate with the user on whether to squash these 14 commits into a single `feat(mission): superpowers-compatible missions` commit.

---

## Self-review notes

- All spec sections (`MissionRef`, plan resolution, runtime injection, picker UX, chip, "+ New" flow, plan mutations, file boundaries) map to a task.
- Open questions from the spec (`plan ✗` blocking, auto-commit on mark, spec-rename behavior) are NOT implemented in code — they remain open and should ESCALATE if encountered at run time. Do not silently decide them.
- Cache invariant: `build_system_prompt` for the no-mission case stays byte-identical (Task 8 step 8.4 guards via the existing baseline test).
- Persistence backward-compat: bare-string entries in `mission_persistence` deserialize as Covenant (Task 7 step 7.3).
