# CDLC Multi-Export Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize CDLC's executor projection from skills-only into a multi-export tool that writes agents, skills, and regulatory context into each executor's native format.

**Architecture:** Refactor `crates/cdlc/src/project.rs`. Today `project()` reads installed skills (manifest-driven) and writes Claude skill dirs + codex/copilot managed blocks. We add two dir-scanned artifact sources — `agents/*.md` and `context/*.md` — and route all three kinds through the two host strategies that already exist (file-per-item dir, managed-block file). Agents strip their Covenant-only `covenant:` frontmatter block on export. Context exports twice: a one-line `summary:` into the always-on managed block, the full body into an on-demand Claude skill dir.

**Tech Stack:** Rust, `crates/cdlc` (`karl_cdlc`), `std::fs`, existing helpers (`ensure_frontmatter`, `upsert_block`, `strip_block`). No new dependencies.

## Global Constraints

- No new crate dependencies — string helpers only (no `serde_yaml`). `// ponytail:` mark the hand-rolled frontmatter parsing with its upgrade path.
- No `unwrap()` outside `#[cfg(test)]`.
- Projection stays idempotent and re-runnable: re-export produces identical files; empty sources strip the managed block but preserve surrounding hand-written content.
- `covenant:` frontmatter block is stripped from every exported agent file — executors only ever see clean native files.
- All new public fns return `Result<_, CdlcError>`.
- Test command: `cargo test -p karl_cdlc <name>`.
- Spec: `docs/superpowers/specs/2026-06-24-cdlc-multi-export-design.md`.

## Source layout (per-repo, under `.covenant/cdlc/`)

```
agents/*.md          # operator personas; standard frontmatter + `covenant:` block (NEW, dir-scanned)
skills/*/SKILL.md    # capabilities (existing, manifest-driven)
context/*.md         # regulatory specs; `summary:` frontmatter (NEW, dir-scanned)
```

## Out of scope this session

- Agent **authoring** (the file format producer) — separate session.
- App-level trigger that re-projects with the *live* active operator. This plan ships `project_with_active(repo, Some(name))` fully tested; the existing `project(repo)` (= `None`) keeps being called by `install`. Wiring the operator-attach trigger to pass a live name is a follow-up.
- Deleting stale `.claude/skills/cdlc-*` / `.claude/agents/*` dirs when a source is removed — pre-existing parity gap, unchanged here.
- opencode / pi / hermes executors — add a row when their write-paths land.

---

### Task 1: Frontmatter helpers — strip `covenant:` block and split body

**Files:**
- Modify: `crates/cdlc/src/project.rs` (add two private fns + tests)

**Interfaces:**
- Produces: `fn strip_covenant_block(md: &str) -> String` — removes the top-level `covenant:` mapping (key line + its indented children) from the leading `---`…`---` frontmatter; everything else byte-identical.
- Produces: `fn body_after_frontmatter(md: &str) -> &str` — returns the markdown body after the closing `---`; returns input unchanged when there is no frontmatter.

- [ ] **Step 1: Write the failing tests**

Add to the `tests` module in `crates/cdlc/src/project.rs`:

```rust
#[test]
fn strip_covenant_removes_block_keeps_standard_keys() {
    let md = "---\nname: kyc-reviewer\nmodel: claude-sonnet-4-6\ncovenant:\n  escalate_threshold: 0.7\n  voice: formal\ntools: [Read]\n---\nbody text\n";
    let out = strip_covenant_block(md);
    assert!(out.contains("name: kyc-reviewer"));
    assert!(out.contains("model: claude-sonnet-4-6"));
    assert!(out.contains("tools: [Read]"), "key after covenant block must survive");
    assert!(!out.contains("covenant:"), "covenant key removed");
    assert!(!out.contains("escalate_threshold"), "covenant children removed");
    assert!(out.contains("body text"), "body untouched");
}

#[test]
fn strip_covenant_noop_without_block() {
    let md = "---\nname: x\n---\nbody\n";
    assert_eq!(strip_covenant_block(md), md);
}

#[test]
fn body_after_frontmatter_returns_body() {
    let md = "---\nsummary: short\n---\nfull body here\n";
    assert_eq!(body_after_frontmatter(md), "full body here\n");
}

#[test]
fn body_after_frontmatter_noop_when_no_frontmatter() {
    let md = "no frontmatter here\n";
    assert_eq!(body_after_frontmatter(md), md);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p karl_cdlc strip_covenant body_after_frontmatter`
Expected: FAIL — `cannot find function 'strip_covenant_block'` / `'body_after_frontmatter'`.

- [ ] **Step 3: Implement the helpers**

Add near the top of `crates/cdlc/src/project.rs` (after the `START`/`END` consts):

```rust
/// Remove the top-level `covenant:` mapping from a doc's leading `---`…`---`
/// frontmatter. The key line and every following indented (or blank) line up to
/// the next top-level key (or the closing fence) is dropped. Body is untouched.
/// ponytail: line-based, not a real YAML parse — handles single-level nesting,
/// which is all the `covenant:` block uses. Swap to serde_yaml if it grows.
fn strip_covenant_block(md: &str) -> String {
    let lines: Vec<&str> = md.lines().collect();
    let open = match lines.iter().position(|l| l.trim() == "---") {
        Some(i) => i,
        None => return md.to_string(),
    };
    let close = match lines.iter().skip(open + 1).position(|l| l.trim() == "---") {
        Some(i) => open + 1 + i,
        None => return md.to_string(),
    };
    let mut out: Vec<&str> = Vec::with_capacity(lines.len());
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let in_fm = i > open && i < close;
        // top-level key (no indent) named exactly `covenant:`
        if in_fm && line == line.trim_start() && line.trim_start().starts_with("covenant:") {
            i += 1;
            while i < close {
                let child = lines[i];
                if child.trim().is_empty() || child.starts_with(' ') || child.starts_with('\t') {
                    i += 1;
                } else {
                    break;
                }
            }
            continue;
        }
        out.push(line);
        i += 1;
    }
    let mut s = out.join("\n");
    if md.ends_with('\n') {
        s.push('\n');
    }
    s
}

/// Markdown body after the closing `---` of a leading frontmatter block.
/// Returns the input unchanged when there is no frontmatter.
fn body_after_frontmatter(md: &str) -> &str {
    let s = md.trim_start_matches('\n');
    if let Some(rest) = s.strip_prefix("---") {
        if let Some(idx) = rest.find("\n---") {
            // skip past the closing fence line
            let after = &rest[idx + 1..]; // at the "---" line
            if let Some(nl) = after.find('\n') {
                return after[nl + 1..].trim_start_matches('\n');
            }
        }
    }
    md
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p karl_cdlc strip_covenant body_after_frontmatter`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/cdlc/src/project.rs
git commit -m "feat(cdlc): frontmatter helpers — strip covenant block, split body"
```

---

### Task 2: `parse_summary` — read the `summary:` line from context frontmatter

**Files:**
- Modify: `crates/cdlc/src/project.rs` (add private fn + tests)

**Interfaces:**
- Produces: `fn parse_summary(md: &str) -> Option<String>` — returns the trimmed, unquoted value of the first top-level `summary:` line inside the leading frontmatter; `None` if absent or empty.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn parse_summary_reads_frontmatter_line() {
    let md = "---\nsummary: \"Mask all PII; cite SBS article.\"\n---\nfull text\n";
    assert_eq!(parse_summary(md).as_deref(), Some("Mask all PII; cite SBS article."));
}

#[test]
fn parse_summary_none_when_absent() {
    let md = "---\nname: x\n---\nbody\n";
    assert_eq!(parse_summary(md), None);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p karl_cdlc parse_summary`
Expected: FAIL — `cannot find function 'parse_summary'`.

- [ ] **Step 3: Implement**

```rust
/// First top-level `summary:` value inside the leading frontmatter, trimmed and
/// dequoted. `None` if there is no frontmatter or no non-empty summary.
/// ponytail: single-line summaries only; add block-scalar support if needed.
fn parse_summary(md: &str) -> Option<String> {
    let lines: Vec<&str> = md.lines().collect();
    let open = lines.iter().position(|l| l.trim() == "---")?;
    let close = open + 1 + lines.iter().skip(open + 1).position(|l| l.trim() == "---")?;
    for l in &lines[open + 1..close] {
        if let Some(rest) = l.strip_prefix("summary:") {
            let v = rest.trim().trim_matches('"').trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p karl_cdlc parse_summary`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/cdlc/src/project.rs
git commit -m "feat(cdlc): parse_summary helper for context frontmatter"
```

---

### Task 3: Dir scanner + agent projection to `.claude/agents/`

**Files:**
- Modify: `crates/cdlc/src/project.rs`

**Interfaces:**
- Produces: `fn read_dir_md(dir: &Path) -> Result<Vec<(String, String)>, CdlcError>` — `(file_stem, contents)` for every `*.md` in `dir`, sorted by stem; empty Vec if `dir` is absent.
- Produces: `fn project_agents(repo_root: &Path, agents: &[(String, String)]) -> Result<(), CdlcError>` — writes `.claude/agents/<stem>.md` with the `covenant:` block stripped.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn project_agents_writes_stripped_claude_files() {
    let base = std::env::temp_dir().join(format!("cdlc-agents-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let repo = base.clone();
    let src = crate::cdlc_dir(&repo).join("agents");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(
        src.join("kyc-reviewer.md"),
        "---\nname: kyc-reviewer\nmodel: claude-sonnet-4-6\ncovenant:\n  voice: formal\n---\nReview KYC.\n",
    )
    .unwrap();

    let agents = read_dir_md(&src).unwrap();
    assert_eq!(agents.len(), 1);
    project_agents(&repo, &agents).unwrap();

    let out = repo.join(".claude/agents/kyc-reviewer.md");
    assert!(out.exists());
    let content = std::fs::read_to_string(&out).unwrap();
    assert!(content.contains("name: kyc-reviewer"));
    assert!(!content.contains("covenant:"), "covenant block must be stripped");
    assert!(content.contains("Review KYC."));

    let _ = std::fs::remove_dir_all(&base);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p karl_cdlc project_agents_writes_stripped`
Expected: FAIL — `cannot find function 'read_dir_md'` / `'project_agents'`.

- [ ] **Step 3: Implement**

Add `use std::path::Path;` is already present. Add:

```rust
/// `(file_stem, contents)` for every `*.md` directly under `dir`, sorted by stem.
/// Returns an empty Vec when `dir` does not exist.
fn read_dir_md(dir: &Path) -> Result<Vec<(String, String)>, CdlcError> {
    let mut out: Vec<(String, String)> = Vec::new();
    if !dir.exists() {
        return Ok(out);
    }
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let stem = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        out.push((stem, std::fs::read_to_string(&path)?));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

/// Project operator personas into Claude's native multi-agent dir.
fn project_agents(repo_root: &Path, agents: &[(String, String)]) -> Result<(), CdlcError> {
    if agents.is_empty() {
        return Ok(());
    }
    let dir = repo_root.join(".claude/agents");
    std::fs::create_dir_all(&dir)?;
    for (stem, raw) in agents {
        std::fs::write(dir.join(format!("{stem}.md")), strip_covenant_block(raw))?;
    }
    Ok(())
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p karl_cdlc project_agents_writes_stripped`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/cdlc/src/project.rs
git commit -m "feat(cdlc): scan agents dir and project to .claude/agents"
```

---

### Task 4: Context projection — full body to a Claude skill dir

**Files:**
- Modify: `crates/cdlc/src/project.rs`

**Interfaces:**
- Consumes: `read_dir_md` (Task 3), `ensure_frontmatter` (existing), `body_after_frontmatter` (Task 1).
- Produces: `fn project_context_skills(repo_root: &Path, contexts: &[(String, String)]) -> Result<(), CdlcError>` — writes `.claude/skills/cdlc-<stem>/SKILL.md` from the context body (frontmatter dropped, Claude frontmatter re-added).

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn project_context_writes_claude_skill_from_body() {
    let base = std::env::temp_dir().join(format!("cdlc-ctx-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let repo = base.clone();
    let src = crate::cdlc_dir(&repo).join("context");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(
        src.join("sbs-kyc.md"),
        "---\nsummary: Mask PII; cite SBS article.\n---\n# SBS KYC\nFull regulatory text.\n",
    )
    .unwrap();

    let contexts = read_dir_md(&src).unwrap();
    project_context_skills(&repo, &contexts).unwrap();

    let out = repo.join(".claude/skills/cdlc-sbs-kyc/SKILL.md");
    assert!(out.exists());
    let content = std::fs::read_to_string(&out).unwrap();
    assert!(content.starts_with("---\nname: cdlc-"), "must have Claude frontmatter");
    assert!(content.contains("Full regulatory text."), "full body present");
    assert!(!content.contains("summary: Mask PII"), "context frontmatter dropped");

    let _ = std::fs::remove_dir_all(&base);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p karl_cdlc project_context_writes_claude_skill`
Expected: FAIL — `cannot find function 'project_context_skills'`.

- [ ] **Step 3: Implement**

```rust
/// Project the FULL body of each regulatory context doc into an on-demand Claude
/// skill dir. The `summary:` frontmatter is dropped here (it rides the managed
/// block instead — see project_managed_block) and Claude frontmatter is re-added.
fn project_context_skills(repo_root: &Path, contexts: &[(String, String)]) -> Result<(), CdlcError> {
    for (stem, raw) in contexts {
        let body = body_after_frontmatter(raw);
        let dir = repo_root.join(".claude/skills").join(format!("cdlc-{stem}"));
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join("SKILL.md"), ensure_frontmatter(stem, body))?;
    }
    Ok(())
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p karl_cdlc project_context_writes_claude_skill`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/cdlc/src/project.rs
git commit -m "feat(cdlc): project context full body to Claude skill dir"
```

---

### Task 5: Wire it together — `project_with_active` + extended managed block

**Files:**
- Modify: `crates/cdlc/src/project.rs` (rewrite `project()`)
- Modify: `crates/cdlc/src/lib.rs` (export `project_with_active`)

**Interfaces:**
- Consumes: `read_dir_md`, `project_agents`, `project_context_skills`, `parse_summary`, `body_after_frontmatter`, existing `upsert_file` / `strip_block` / skill-block logic.
- Produces: `pub fn project_with_active(repo_root: &Path, active_agent: Option<&str>) -> Result<(), CdlcError>`.
- Produces (unchanged signature): `pub fn project(repo_root: &Path) -> Result<(), CdlcError>` now delegates to `project_with_active(repo_root, None)`.
- Managed block now concatenates, in order: the active operator's body (if `active_agent` names an existing agent), each installed skill, each context `summary`. Block is stripped only when all three are empty.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn managed_block_includes_active_agent_and_context_summary() {
    let base = std::env::temp_dir().join(format!("cdlc-full-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let repo = base.clone();

    // an agent
    let adir = crate::cdlc_dir(&repo).join("agents");
    std::fs::create_dir_all(&adir).unwrap();
    std::fs::write(
        adir.join("kyc-reviewer.md"),
        "---\nname: kyc-reviewer\ncovenant:\n  voice: formal\n---\nReview KYC carefully.\n",
    )
    .unwrap();

    // a context doc with a summary
    let cdir = crate::cdlc_dir(&repo).join("context");
    std::fs::create_dir_all(&cdir).unwrap();
    std::fs::write(
        cdir.join("sbs-kyc.md"),
        "---\nsummary: Mask PII; cite SBS article.\n---\n# SBS KYC\nfull text\n",
    )
    .unwrap();

    // empty skills manifest
    crate::write_manifest(&repo, &CdlcManifest { version: 1, installed: vec![] }).unwrap();

    project_with_active(&repo, Some("kyc-reviewer")).unwrap();

    let agents_md = std::fs::read_to_string(repo.join("AGENTS.md")).unwrap();
    assert!(agents_md.contains("kyc-reviewer (operator)"), "active operator in block");
    assert!(agents_md.contains("Review KYC carefully."), "operator body in block");
    assert!(agents_md.contains("Mask PII; cite SBS article."), "context summary in block");
    assert!(!agents_md.contains("full text"), "context FULL body must NOT be in managed block");
    assert_eq!(agents_md.matches("<!-- cdlc:start -->").count(), 1);

    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn project_strips_block_when_everything_empty() {
    let base = std::env::temp_dir().join(format!("cdlc-empty-all-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let repo = base.clone();
    std::fs::create_dir_all(&repo).unwrap();
    std::fs::write(
        repo.join("AGENTS.md"),
        "hand-written\n\n<!-- cdlc:start -->\nold\n<!-- cdlc:end -->\n",
    )
    .unwrap();
    crate::write_manifest(&repo, &CdlcManifest { version: 1, installed: vec![] }).unwrap();

    project(&repo).unwrap();

    let content = std::fs::read_to_string(repo.join("AGENTS.md")).unwrap();
    assert!(!content.contains("<!-- cdlc:start -->"), "block stripped when all sources empty");
    assert!(content.contains("hand-written"), "surrounding content preserved");

    let _ = std::fs::remove_dir_all(&base);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p karl_cdlc managed_block_includes_active project_strips_block_when_everything`
Expected: FAIL — `cannot find function 'project_with_active'`.

- [ ] **Step 3: Rewrite `project()`**

Replace the existing `pub fn project(...)` body (lines ~49-94) with:

```rust
/// Generate every executor's native files from the repo's CDLC sources.
pub fn project(repo_root: &Path) -> Result<(), CdlcError> {
    project_with_active(repo_root, None)
}

/// Like `project`, but also folds the currently-attached operator's persona into
/// the managed-block executors (codex/copilot run one persona at a time).
pub fn project_with_active(repo_root: &Path, active_agent: Option<&str>) -> Result<(), CdlcError> {
    let manifest = read_manifest(repo_root)?;
    let skills_dir = cdlc_dir(repo_root).join("skills");

    // Sources.
    let agents = read_dir_md(&cdlc_dir(repo_root).join("agents"))?;
    let contexts = read_dir_md(&cdlc_dir(repo_root).join("context"))?;
    let mut skills: Vec<(String, String, String)> = Vec::new(); // (name, version, body)
    for i in &manifest.installed {
        let md = skills_dir.join(&i.name).join("SKILL.md");
        skills.push((i.name.clone(), i.version.clone(), std::fs::read_to_string(&md)?));
    }

    // File-per-item executor (Claude): one file per artifact.
    project_agents(repo_root, &agents)?;
    project_context_skills(repo_root, &contexts)?;
    for (name, _v, body) in &skills {
        let dir = repo_root.join(".claude/skills").join(format!("cdlc-{name}"));
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join("SKILL.md"), ensure_frontmatter(name, body))?;
    }

    // Managed-block executors (codex, copilot): one concatenated block.
    let mut sections: Vec<String> = Vec::new();
    if let Some(name) = active_agent {
        if let Some((stem, raw)) = agents.iter().find(|(s, _)| s == name) {
            sections.push(format!("## {stem} (operator)\n\n{}", body_after_frontmatter(raw).trim()));
        }
    }
    for (name, v, body) in &skills {
        sections.push(format!("## {name} v{v}\n\n{}", body.trim()));
    }
    for (stem, raw) in &contexts {
        if let Some(sum) = parse_summary(raw) {
            sections.push(format!("## {stem} (context)\n\n{sum}"));
        }
    }

    if sections.is_empty() {
        for rel in ["AGENTS.md", ".github/copilot-instructions.md"] {
            let path = repo_root.join(rel);
            if path.exists() {
                let existing = std::fs::read_to_string(&path)?;
                std::fs::write(&path, strip_block(&existing))?;
            }
        }
        return Ok(());
    }

    let body = format!(
        "# CDLC context (auto-generated — do not edit inside this block)\n\n{}",
        sections.join("\n\n")
    );
    for rel in ["AGENTS.md", ".github/copilot-instructions.md"] {
        upsert_file(repo_root, rel, &body)?;
    }
    Ok(())
}
```

- [ ] **Step 4: Export from lib.rs**

In `crates/cdlc/src/lib.rs`, change:

```rust
pub use project::project;
```

to:

```rust
pub use project::{project, project_with_active};
```

- [ ] **Step 5: Run the full crate test suite**

Run: `cargo test -p karl_cdlc`
Expected: PASS — all new tests plus the existing `upsert_is_idempotent_and_single_block`, `project_writes_claude_skill_with_frontmatter`, `project_strips_managed_block_when_empty_manifest`, `install_then_projection_is_idempotent`, etc. still green.

- [ ] **Step 6: Commit**

```bash
git add crates/cdlc/src/project.rs crates/cdlc/src/lib.rs
git commit -m "feat(cdlc): multi-export — agents, skills, context across executors"
```

---

## Self-Review

**Spec coverage:**
- Per-repo sources `agents/` + `context/` dir-scanned → Tasks 3, 4, 5.
- Agent canonical format + `covenant:` block stripped on export → Tasks 1, 3.
- Two host strategies (file-per-item, managed-block) → Task 5 (both paths) reusing existing `upsert`/`strip`.
- Agent → Claude file-per-item; agent → managed-block = active operator only → Tasks 3, 5.
- Skill → unchanged behavior → Task 5 (preserved).
- Context → summary always-on (managed block) + full body on-demand (Claude skill) → Tasks 2, 4, 5.
- Idempotent + strip-when-empty across all three sources → Task 5.
- XP/runtime state never in file → enforced by stripping `covenant:` and never reading SQLite here (N/A to crate).

**Placeholder scan:** none — every code step has full code.

**Type consistency:** `read_dir_md -> Vec<(String,String)>` consumed identically in Tasks 3/4/5; `(name,version,body)` skill tuple unchanged; `project_with_active(&Path, Option<&str>)` exported and called in tests. `ensure_frontmatter`, `upsert_file`, `strip_block`, `body_after_frontmatter`, `parse_summary`, `strip_covenant_block` all defined before use.

**Deferred (not gaps):** app trigger to pass live active operator; stale-file cleanup; opencode/pi/hermes rows — all listed under "Out of scope this session".
