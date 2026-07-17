# Canon Detection & Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Canon show every ability already present in a repo's executor dirs (skills/agents/commands/mcp installed outside Canon), badged "detected", with a one-click "Adopt" that brings each into Canon's source so it's tracked and projectable.

**Architecture:** Detection is projection run backwards. Projection writes `.covenant/canon/*` → executor dirs (`.claude/*`, `.pi/*`, `.mcp.json`) using the dir constants in `crates/canon/src/project.rs`. A new `detect.rs` reads those same dirs and returns items with no Canon source (`detected_in: Some(path)`). `list_context()` merges them in; `status()` surfaces them per section; `adopt()` reuses the existing `install_unit` / `install_from_dir` pipelines to copy a detected item into the source and re-project.

**Tech Stack:** Rust (`crates/canon`, `crates/app` Tauri commands), TypeScript (`ui/src/canon/cockpit`, `ui/src/api.ts`), no new dependencies.

## Global Constraints

- Kinds in scope: **skill, agent, command, mcp** only. Memory / context / spec are Canon-native — no foreign location, unchanged.
- No new crates or npm deps.
- Rust: no `unwrap()` outside `#[cfg(test)]`; `thiserror` (`CanonError`) inside `crates/canon`.
- Test scope: run `cargo test -p covenant canon` — the full `cargo test` hangs on pre-existing `telegram::tests`.
- TS: `strict: true`, no `as any` without a justifying comment.
- UI copy: English, sentence case; no emoji, SVG icons via `Icons.*`; no native `title` tooltips (use existing card affordances).
- Detected skill version fallback when no `skill.toml`: `"0.0.0"`; adopted-skill manifest `source: "detected"`.

---

## File Structure

- `crates/canon/src/project.rs` — MODIFY: make `AGENT_DIRS`, `SKILL_DIRS`, `COMMAND_DIRS` `pub(crate)`.
- `crates/canon/src/kind.rs` — MODIFY: add `detected_in: Option<String>` to `ContextUnit`; `list_context` merges detected.
- `crates/canon/src/detect.rs` — CREATE: `scan_detected(repo_root) -> Vec<ContextUnit>`.
- `crates/canon/src/lib.rs` — MODIFY: `pub mod detect;` + re-export `scan_detected`, `adopt`.
- `crates/canon/src/install.rs` — MODIFY: add `detected_in` to `AgentRef`/`CommandRef`/`McpRef`, add `DetectedSkillRef` + `detected_skills` to `CanonStatus`, merge detected in `status()`; add `adopt()`.
- `crates/app/src/lib.rs` — MODIFY: `canon_adopt` command + register in `generate_handler!`.
- `ui/src/api.ts` — MODIFY: add `detectedIn` to refs, `detectedSkills` to `CanonStatus`, `DetectedSkillRef`, `canonAdopt()`.
- `ui/src/canon/cockpit/view.ts` — MODIFY: render detected badge + Adopt in the four sections; reword empty hints.

---

## Task 1: `detected_in` field + detect agents & commands

**Files:**
- Modify: `crates/canon/src/project.rs` (constants → `pub(crate)`)
- Modify: `crates/canon/src/kind.rs` (`ContextUnit.detected_in`; `list_context` merge)
- Create: `crates/canon/src/detect.rs`
- Modify: `crates/canon/src/lib.rs` (`pub mod detect;`)
- Test: `crates/canon/src/detect.rs` (`#[cfg(test)]`)

**Interfaces:**
- Produces: `pub fn scan_detected(repo_root: &Path) -> Result<Vec<ContextUnit>, CanonError>` — units for foreign items, each `detected_in: Some(<executor dir>)`. This task covers `Agent` + `Command`; Task 2 adds `Skill` + `Mcp`.
- Produces: `ContextUnit.detected_in: Option<String>` (serde `detectedIn`).

- [ ] **Step 1: Make projection dir constants crate-visible**

In `crates/canon/src/project.rs`, change the three `const` lines from private to `pub(crate)`:

```rust
pub(crate) const AGENT_DIRS: &[&str] = &[".claude/agents", ".opencode/agent"];
pub(crate) const SKILL_DIRS: &[&str] = &[".claude/skills", ".pi/skills"];
pub(crate) const COMMAND_DIRS: &[&str] = &[".claude/commands", ".opencode/commands", ".pi/prompts"];
```

- [ ] **Step 2: Add `detected_in` to `ContextUnit`**

In `crates/canon/src/kind.rs`, add the field to the struct:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextUnit {
    pub kind: ContextKind,
    pub name: String,
    pub summary: Option<String>,
    pub projectable: bool,
    pub packageable: bool,
    /// None = Canon-managed (has a `.covenant/canon` source).
    /// Some(dir) = detected/foreign, found in this executor dir.
    pub detected_in: Option<String>,
}
```

Then add `detected_in: None` to **every** `ContextUnit { .. }` literal already in `list_context` (Agent, Context, Memory, Command, Mcp, Spec, Skill — 7 sites). The file will not compile until all are updated.

- [ ] **Step 3: Write the failing test**

Create `crates/canon/src/detect.rs`:

```rust
//! Detection is projection run backwards: read the executor dirs that
//! `project()` writes to and surface items Canon did NOT put there (no source
//! under `.covenant/canon/`). Reuses project.rs's dir constants as the single
//! source of truth for "where executors read".

use crate::kind::{ContextKind, ContextUnit};
use crate::manifest::canon_dir;
use crate::project::{parse_frontmatter_str, read_dir_md, AGENT_DIRS, COMMAND_DIRS};
use crate::CanonError;
use std::collections::HashSet;
use std::path::Path;

/// A file-per-item `.md` executor dir (agents, commands): a `<stem>.md` is
/// foreign when no `<stem>.md` exists under the matching Canon source dir.
fn scan_file_per_item(
    repo_root: &Path,
    dirs: &[&str],
    kind: ContextKind,
    seen: &mut HashSet<String>,
    out: &mut Vec<ContextUnit>,
) -> Result<(), CanonError> {
    let source: HashSet<String> = read_dir_md(&canon_dir(repo_root).join(kind.dir()))?
        .into_iter()
        .map(|(stem, _)| stem)
        .collect();
    for base in dirs {
        for (stem, raw) in read_dir_md(&repo_root.join(base))? {
            if source.contains(&stem) || !seen.insert(stem.clone()) {
                continue;
            }
            out.push(ContextUnit {
                kind,
                summary: parse_frontmatter_str(&raw, "description"),
                name: stem,
                projectable: true,
                packageable: kind == ContextKind::Agent || kind == ContextKind::Command,
                detected_in: Some(base.to_string()),
            });
        }
    }
    Ok(())
}

/// Foreign items across executor dirs, deduped by name within each kind.
/// Task 1: Agent + Command. Task 2 extends with Skill + Mcp.
pub fn scan_detected(repo_root: &Path) -> Result<Vec<ContextUnit>, CanonError> {
    let mut out = Vec::new();
    let mut agent_seen = HashSet::new();
    scan_file_per_item(repo_root, AGENT_DIRS, ContextKind::Agent, &mut agent_seen, &mut out)?;
    let mut cmd_seen = HashSet::new();
    scan_file_per_item(repo_root, COMMAND_DIRS, ContextKind::Command, &mut cmd_seen, &mut out)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_foreign_agent_not_source_backed() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // Foreign agent installed straight into .claude/agents (no Canon source).
        std::fs::create_dir_all(root.join(".claude/agents")).unwrap();
        std::fs::write(
            root.join(".claude/agents/foo.md"),
            "---\nname: foo\ndescription: A foreign agent\n---\nbody\n",
        )
        .unwrap();
        // A source-backed agent must NOT be reported as detected.
        std::fs::create_dir_all(root.join(".covenant/canon/agents")).unwrap();
        std::fs::write(root.join(".covenant/canon/agents/managed.md"), "# managed\n").unwrap();
        std::fs::create_dir_all(root.join(".claude/agents")).unwrap();
        std::fs::write(root.join(".claude/agents/managed.md"), "# managed\n").unwrap();

        let det = scan_detected(root).unwrap();
        let foo = det.iter().find(|u| u.name == "foo").expect("foreign agent detected");
        assert_eq!(foo.kind, ContextKind::Agent);
        assert_eq!(foo.detected_in.as_deref(), Some(".claude/agents"));
        assert_eq!(foo.summary.as_deref(), Some("A foreign agent"));
        assert!(det.iter().all(|u| u.name != "managed"), "source-backed item is not detected");
    }
}
```

Add the module in `crates/canon/src/lib.rs` (near the other `pub mod` lines):

```rust
pub mod detect;
```

And extend the re-export line for kind:

```rust
pub use detect::scan_detected;
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cargo test -p covenant --lib detect::tests::detects_foreign_agent`
Expected: FAILS to compile first (the 7 `ContextUnit` literals in `kind.rs` lack `detected_in`) — fix them per Step 2 until it compiles, then the test PASSES. If it still fails, the discriminator is wrong.

- [ ] **Step 5: Merge detected into `list_context`**

At the end of `list_context` in `kind.rs`, before `Ok(out)`, append deduped detected units:

```rust
    // Fold in items that live in executor dirs but have no Canon source.
    let managed: std::collections::HashSet<(ContextKind, String)> =
        out.iter().map(|u| (u.kind, u.name.clone())).collect();
    for u in crate::detect::scan_detected(repo_root)? {
        if !managed.contains(&(u.kind, u.name.clone())) {
            out.push(u);
        }
    }
    Ok(out)
```

(`ContextKind` already derives `Copy, PartialEq, Eq`; add `Hash` to its derive list in `kind.rs` so it can key the set: `#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]`.)

- [ ] **Step 6: Run the canon test suite**

Run: `cargo test -p covenant --lib canon 2>/dev/null; cargo test -p covenant --lib detect kind project install`
Expected: PASS (existing `list_context` tests still green — managed items unaffected; new detect test green).

- [ ] **Step 7: Commit**

```bash
git add crates/canon/src/project.rs crates/canon/src/kind.rs crates/canon/src/detect.rs crates/canon/src/lib.rs
git commit -m "feat(canon): detect foreign agents & commands (detected_in)"
```

---

## Task 2: Detect skills & MCP servers

**Files:**
- Modify: `crates/canon/src/detect.rs`
- Test: `crates/canon/src/detect.rs`

**Interfaces:**
- Consumes: `scan_detected` (Task 1), `SKILL_DIRS` const, `crate::mcp::read_mcp_servers`.
- Produces: `scan_detected` now also emits `Skill` (dir without `canon-` prefix) and `Mcp` (server key without `canon-` prefix) units.

- [ ] **Step 1: Write the failing test**

Add to `detect.rs` `#[cfg(test)] mod tests`:

```rust
    #[test]
    fn detects_foreign_skill_and_mcp_but_not_canon_prefixed() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // Foreign skill hand-installed (no canon- prefix).
        std::fs::create_dir_all(root.join(".claude/skills/kyc")).unwrap();
        std::fs::write(
            root.join(".claude/skills/kyc/SKILL.md"),
            "---\nname: kyc\ndescription: KYC helper\n---\nbody\n",
        )
        .unwrap();
        // A Canon-projected skill (canon- prefix) must NOT be detected.
        std::fs::create_dir_all(root.join(".claude/skills/canon-managed")).unwrap();
        std::fs::write(root.join(".claude/skills/canon-managed/SKILL.md"), "x\n").unwrap();
        // Foreign MCP server (key without canon- prefix); a canon- one is ignored.
        std::fs::write(
            root.join(".mcp.json"),
            r#"{"mcpServers":{"ctx7":{"command":"npx","description":"C7"},"canon-x":{"command":"npx"}}}"#,
        )
        .unwrap();

        let det = scan_detected(root).unwrap();
        let skill = det.iter().find(|u| u.name == "kyc").expect("foreign skill detected");
        assert_eq!(skill.kind, ContextKind::Skill);
        assert_eq!(skill.detected_in.as_deref(), Some(".claude/skills"));
        assert!(det.iter().all(|u| u.name != "canon-managed"), "canon- skill not detected");
        let mcp = det.iter().find(|u| u.name == "ctx7").expect("foreign mcp detected");
        assert_eq!(mcp.kind, ContextKind::Mcp);
        assert_eq!(mcp.detected_in.as_deref(), Some(".mcp.json"));
        assert!(det.iter().all(|u| u.name != "canon-x"), "canon- mcp server not detected");
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p covenant --lib detect::tests::detects_foreign_skill_and_mcp`
Expected: FAIL — `kyc` / `ctx7` not found (scan doesn't cover skills/mcp yet).

- [ ] **Step 3: Implement skill + mcp scanning**

Add these helpers to `detect.rs` and call them from `scan_detected`:

```rust
use crate::project::SKILL_DIRS;

/// A `canon-`-prefixed dir is a Canon projection; any other skill dir is foreign.
fn scan_skills(repo_root: &Path, out: &mut Vec<ContextUnit>) -> Result<(), CanonError> {
    let mut seen = HashSet::new();
    for base in SKILL_DIRS {
        let dir = repo_root.join(base);
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries {
            let path = entry?.path();
            if !path.is_dir() {
                continue;
            }
            let name = match path.file_name().and_then(|s| s.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if name.starts_with("canon-") || !seen.insert(name.clone()) {
                continue;
            }
            let summary = std::fs::read_to_string(path.join("SKILL.md"))
                .ok()
                .and_then(|md| parse_frontmatter_str(&md, "description"));
            out.push(ContextUnit {
                kind: ContextKind::Skill,
                name,
                summary,
                projectable: true,
                packageable: true,
                detected_in: Some(base.to_string()),
            });
        }
    }
    Ok(())
}

/// An MCP server in the EXECUTOR config `.mcp.json` whose key is not
/// `canon-`-prefixed was added outside Canon. (Canon's own source lives in
/// `.covenant/canon/mcp/*.json` and is read by `read_mcp_servers` — that is the
/// managed side; detection reads the projected `.mcp.json` instead.)
fn scan_mcp(repo_root: &Path, out: &mut Vec<ContextUnit>) -> Result<(), CanonError> {
    let path = repo_root.join(".mcp.json");
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Ok(()), // no executor config → nothing foreign
    };
    let v: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return Ok(()), // malformed: never guess, just skip
    };
    let Some(servers) = v.get("mcpServers").and_then(|m| m.as_object()) else {
        return Ok(());
    };
    for (name, srv) in servers {
        if name.starts_with("canon-") {
            continue;
        }
        out.push(ContextUnit {
            kind: ContextKind::Mcp,
            summary: srv.get("description").and_then(|d| d.as_str()).map(String::from),
            name: name.clone(),
            projectable: true,
            packageable: true,
            detected_in: Some(".mcp.json".to_string()),
        });
    }
    Ok(())
}
```

Then extend `scan_detected`, after the command scan:

```rust
    scan_skills(repo_root, &mut out)?;
    scan_mcp(repo_root, &mut out)?;
    Ok(out)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p covenant --lib detect::tests`
Expected: PASS (both detect tests).

- [ ] **Step 5: Commit**

```bash
git add crates/canon/src/detect.rs
git commit -m "feat(canon): detect foreign skills & mcp servers"
```

---

## Task 3: `adopt()` — bring a detected item into Canon

**Files:**
- Modify: `crates/canon/src/install.rs` (add `adopt`)
- Modify: `crates/canon/src/lib.rs` (re-export `adopt`)
- Test: `crates/canon/src/install.rs`

**Interfaces:**
- Consumes: `scan_detected` (Tasks 1–2), `install_unit`, `install_from_dir`, `project`, `SKILL_DIRS`.
- Produces: `pub fn adopt(repo_root: &Path, kind: ContextKind, name: &str) -> Result<(), CanonError>`.

- [ ] **Step 1: Write the failing test**

Add to `install.rs` `#[cfg(test)] mod tests`:

```rust
    #[test]
    fn adopt_agent_moves_into_source_and_clears_detected() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join(".claude/agents")).unwrap();
        std::fs::write(root.join(".claude/agents/foo.md"), "---\nname: foo\n---\nbody\n").unwrap();

        // Before: foo is detected.
        assert!(crate::scan_detected(root).unwrap().iter().any(|u| u.name == "foo"));

        crate::adopt(root, crate::ContextKind::Agent, "foo").unwrap();

        // After: source exists, foo no longer detected (it has a source now).
        assert!(root.join(".covenant/canon/agents/foo.md").exists(), "copied into source");
        assert!(crate::scan_detected(root).unwrap().iter().all(|u| u.name != "foo"), "no longer foreign");
    }

    #[test]
    fn adopt_skill_installs_and_removes_foreign_dup() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join(".claude/skills/kyc")).unwrap();
        std::fs::write(
            root.join(".claude/skills/kyc/SKILL.md"),
            "---\nname: kyc\ndescription: KYC\n---\nbody\n",
        )
        .unwrap();

        crate::adopt(root, crate::ContextKind::Skill, "kyc").unwrap();

        assert!(root.join(".covenant/canon/skills/kyc/SKILL.md").exists(), "in canon source");
        assert!(read_manifest(root).unwrap().installed.iter().any(|i| i.name == "kyc" && i.source == "detected"));
        assert!(root.join(".claude/skills/canon-kyc/SKILL.md").exists(), "projected as canon-kyc");
        assert!(!root.join(".claude/skills/kyc").exists(), "foreign un-prefixed dup removed");
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p covenant --lib install::tests::adopt`
Expected: FAIL — `adopt` not defined.

- [ ] **Step 3: Implement `adopt`**

Add to `crates/canon/src/install.rs` (reuses `install_unit` / `install_from_dir` — DRY over re-implementing the copy+manifest+project pipeline):

```rust
use crate::project::{project, SKILL_DIRS};

/// Bring a DETECTED (foreign) item into Canon's source so it becomes managed.
/// Reuses the same install pipelines as registry/local installs, then removes
/// the foreign un-prefixed skill dir so `<name>` and `canon-<name>` don't both
/// shadow the executor. Agents/commands project back to the same path they were
/// found at, so nothing duplicates. Errors if the item isn't currently foreign.
pub fn adopt(repo_root: &Path, kind: ContextKind, name: &str) -> Result<(), CanonError> {
    if !valid_pkg_name(name) {
        return Err(CanonError::InvalidPackage(format!("invalid name: {name:?}")));
    }
    let unit = crate::scan_detected(repo_root)?
        .into_iter()
        .find(|u| u.kind == kind && u.name == name)
        .ok_or_else(|| CanonError::InvalidPackage(format!("not a detected {kind:?}: {name}")))?;
    let base = unit
        .detected_in
        .ok_or_else(|| CanonError::InvalidPackage("detected unit missing path".into()))?;

    match kind {
        ContextKind::Agent | ContextKind::Command => {
            let src = repo_root.join(&base).join(format!("{name}.md"));
            let content = std::fs::read_to_string(&src)?;
            install_unit(repo_root, kind, name, &content)?; // writes source + projects
        }
        ContextKind::Mcp => {
            let json = crate::mcp::read_executor_mcp(repo_root, name)?; // see note
            install_unit(repo_root, ContextKind::Mcp, name, &json)?;
        }
        ContextKind::Skill => {
            let foreign = repo_root.join(&base).join(name);
            // A hand-installed skill may lack skill.toml; synthesize a minimal one.
            let toml_path = foreign.join("skill.toml");
            if !toml_path.exists() {
                std::fs::write(&toml_path, format!("name = \"{name}\"\nversion = \"0.0.0\"\n"))?;
            }
            install_from_dir(repo_root, &foreign, "detected")?; // copies + manifest + project
            // Remove the foreign un-prefixed dup in every skill dir.
            for sdir in SKILL_DIRS {
                let dup = repo_root.join(sdir).join(name);
                if dup.exists() {
                    std::fs::remove_dir_all(&dup)?;
                }
            }
            project(repo_root)?;
        }
        ContextKind::Context | ContextKind::Spec | ContextKind::Memory => {
            return Err(CanonError::InvalidPackage(format!("{kind:?} is not adoptable")));
        }
    }
    Ok(())
}
```

For the MCP branch, add a small reader to `crates/canon/src/mcp.rs` that returns the raw server JSON string from the executor's `.mcp.json` (NOT the Canon source). If such a helper already exists, use it; otherwise:

```rust
/// Serialize one server from the executor `.mcp.json` `mcpServers` map as JSON.
pub fn read_executor_mcp(repo_root: &Path, name: &str) -> Result<String, CanonError> {
    let path = repo_root.join(".mcp.json");
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path)?)?;
    let srv = v.get("mcpServers").and_then(|m| m.get(name)).ok_or_else(|| {
        CanonError::InvalidPackage(format!("mcp server not in .mcp.json: {name}"))
    })?;
    Ok(serde_json::to_string(srv)?)
}
```

Re-export in `crates/canon/src/lib.rs`:

```rust
pub use install::{/* existing… */ adopt};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p covenant --lib install::tests::adopt`
Expected: PASS (both adopt tests).

- [ ] **Step 5: Commit**

```bash
git add crates/canon/src/install.rs crates/canon/src/mcp.rs crates/canon/src/lib.rs
git commit -m "feat(canon): adopt() moves a detected item into Canon source"
```

---

## Task 4: Surface detected items in `CanonStatus`

**Files:**
- Modify: `crates/canon/src/install.rs` (`AgentRef`/`CommandRef`/`McpRef` + `DetectedSkillRef` + `status()`)
- Test: `crates/canon/src/install.rs`

**Interfaces:**
- Consumes: `list_context` (now merges detected), `scan_detected`.
- Produces: `AgentRef`/`CommandRef`/`McpRef` gain `detected_in: Option<String>`; `CanonStatus` gains `detected_skills: Vec<DetectedSkillRef>` where `DetectedSkillRef { name: String, detected_in: String }`.

- [ ] **Step 1: Write the failing test**

Add to `install.rs` tests:

```rust
    #[test]
    fn status_reports_detected_agent_and_skill() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join(".claude/agents")).unwrap();
        std::fs::write(root.join(".claude/agents/foo.md"), "---\nname: foo\n---\nb\n").unwrap();
        std::fs::create_dir_all(root.join(".claude/skills/kyc")).unwrap();
        std::fs::write(root.join(".claude/skills/kyc/SKILL.md"), "---\nname: kyc\n---\nb\n").unwrap();

        let st = status(root).unwrap();
        let foo = st.agents.iter().find(|a| a.name == "foo").expect("detected agent listed");
        assert_eq!(foo.detected_in.as_deref(), Some(".claude/agents"));
        assert!(st.detected_skills.iter().any(|s| s.name == "kyc"), "detected skill listed");
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p covenant --lib install::tests::status_reports_detected`
Expected: FAIL to compile — `detected_in` / `detected_skills` don't exist yet.

- [ ] **Step 3: Add the fields**

In `install.rs`, add `detected_in` to the three refs:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRef {
    pub name: String,
    pub detected_in: Option<String>,
}
// same field added to CommandRef and McpRef
```

Add the new struct + `CanonStatus` field:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedSkillRef {
    pub name: String,
    pub detected_in: String,
}
// in CanonStatus:
pub detected_skills: Vec<DetectedSkillRef>,
```

- [ ] **Step 4: Populate them in `status()`**

`status()` already builds `agents`/`commands` from `list_context` (which now includes detected units) and `mcp` from `read_mcp_servers` (managed only). Update the three maps to carry `detected_in`, append detected MCP, and build `detected_skills`:

```rust
    let agents = units.iter().filter(|u| u.kind == crate::ContextKind::Agent)
        .map(|u| AgentRef { name: u.name.clone(), detected_in: u.detected_in.clone() })
        .collect();
    let commands = units.iter().filter(|u| u.kind == crate::ContextKind::Command)
        .map(|u| CommandRef { name: u.name.clone(), description: u.summary.clone(), detected_in: u.detected_in.clone() })
        .collect();
    // Managed MCP (from source) carry detected_in: None …
    let mut mcp: Vec<McpRef> = crate::mcp::read_mcp_servers(repo_root)?
        .into_iter()
        .map(|(name, s)| McpRef { description: s.description.clone(), transport: s.transport_kind(), name, detected_in: None })
        .collect();
    // … plus detected MCP from list_context.
    for u in units.iter().filter(|u| u.kind == crate::ContextKind::Mcp && u.detected_in.is_some()) {
        mcp.push(McpRef { name: u.name.clone(), description: u.summary.clone(), transport: "detected".into(), detected_in: u.detected_in.clone() });
    }
    let detected_skills = units.iter()
        .filter(|u| u.kind == crate::ContextKind::Skill && u.detected_in.is_some())
        .map(|u| DetectedSkillRef { name: u.name.clone(), detected_in: u.detected_in.clone().unwrap_or_default() })
        .collect();
```

Add `detected_skills` to the returned `CanonStatus { .. }` literal.

- [ ] **Step 5: Run the tests**

Run: `cargo test -p covenant --lib install::tests`
Expected: PASS (existing status tests still green; new one green).

- [ ] **Step 6: Commit**

```bash
git add crates/canon/src/install.rs
git commit -m "feat(canon): status() surfaces detected items per section"
```

---

## Task 5: `canon_adopt` Tauri command

**Files:**
- Modify: `crates/app/src/lib.rs`

**Interfaces:**
- Consumes: `karl_canon::adopt`, existing `parse_unit_kind`.
- Produces: Tauri command `canon_adopt(cwd, kind, name)`.

- [ ] **Step 1: Add the command** (mirror `canon_read_source` at `crates/app/src/lib.rs:2679`)

```rust
#[tauri::command]
async fn canon_adopt(cwd: String, kind: String, name: String) -> Result<(), String> {
    let repo = std::path::PathBuf::from(cwd);
    let k = parse_unit_kind(&kind)?;
    tokio::task::spawn_blocking(move || karl_canon::adopt(&repo, k, &name))
        .await
        .map_err(|e| format!("canon_adopt join: {e}"))?
        .map_err(|e| e.to_string())
}
```

- [ ] **Step 2: Register it** in `generate_handler!` (near `canon_read_source`, ~line 5201):

```rust
            canon_read_source,
            canon_adopt,
```

- [ ] **Step 3: Build to verify it compiles**

Run: `cargo build -p covenant 2>&1 | tail -20`
Expected: builds clean (no missing-import / signature errors).

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/lib.rs
git commit -m "feat(app): canon_adopt command"
```

---

## Task 6: UI — detected badge + Adopt across the four sections

**Files:**
- Modify: `ui/src/api.ts`
- Modify: `ui/src/canon/cockpit/view.ts`

**Interfaces:**
- Consumes: `canon_adopt`; `CanonStatus` now has `detectedIn` on refs + `detectedSkills`.
- Produces: `canonAdopt(cwd, kind, name)`; detected rows with an Adopt action in Subagents / Commands / MCP / Skills.

- [ ] **Step 1: TS types + wrapper** in `ui/src/api.ts`

Add `detectedIn?: string | null` to `AgentRef`, `CommandRef`, `McpRef`; add the new type and field:

```ts
export interface DetectedSkillRef {
  name: string;
  detectedIn: string;
}
// in CanonStatus:
  detectedSkills: DetectedSkillRef[];
```

Add the command wrapper (near `canonLocalStatus`, ~line 1667):

```ts
export async function canonAdopt(cwd: string, kind: CanonPkgKind, name: string): Promise<void> {
  return invoke<void>("canon_adopt", { cwd, kind, name });
}
```

- [ ] **Step 2: A shared "Adopt" action helper** in `ui/src/canon/cockpit/view.ts`

Add a private method next to `unitPublishAction` (~line 334), reusing `iconButton` (already imported):

```ts
  /** Adopt a detected item into Canon, then refresh the section. */
  private unitAdoptAction(cwd: string, kind: CanonPkgKind, name: string): HTMLButtonElement {
    const btn = iconButton(Icons.download({ size: 15 }), "Adopt into Canon", () => {
      btn.disabled = true;
      void canonAdopt(cwd, kind, name)
        .then(() => this.showSection(this.current))
        .catch((e) => {
          btn.disabled = false;
          alert(this.friendlyError(e));
        });
    });
    return btn;
  }
```

(If `Icons.download` doesn't exist, use `Icons.plus` — verify against `ui/src/ui/icons.ts` and pick an existing glyph. Import `canonAdopt` at the top of the file alongside the other `canon*` imports.)

- [ ] **Step 3: Render detected agents** — in `renderSubagentsSection` (~line 742), the loop over `status.agents`. Replace the empty-state guard and loop body so detected rows carry the badge + Adopt:

```ts
        if (status.agents.length === 0) {
          list.appendChild(this.emptyState({
            icon: Icons.bot({ size: 28 }),
            title: "No subagents yet",
            hint: "Install a subagent, or mine context — Canon detects and adopts what's already in the repo.",
          }));
          return;
        }
        for (const a of status.agents) {
          const detected = !!a.detectedIn;
          const actions = detected
            ? [this.unitAdoptAction(cwd, "agent", a.name)]
            : (() => { const p = this.unitPublishAction(cwd, "agent", a.name); return p ? [p] : []; })();
          list.appendChild(skillCard({
            name: a.name,
            meta: detected ? `detected · ${a.detectedIn}` : "agent",
            className: detected ? "canon-skill-row is-detected" : "canon-skill-row",
            fetchPreview: () => canonReadSource(cwd, "agent", a.name),
            actions,
          }));
        }
```

- [ ] **Step 4: Repeat for Commands and MCP** — same pattern in `renderCommandsSection` (~789) and `renderMcpSection` (~836): if `c.detectedIn` / `m.detectedIn` is set, use `unitAdoptAction(cwd, "command"|"mcp", name)` and set `meta` to `detected · <dir>`, class `is-detected`. Keep the managed branch (publish action) unchanged. Reword both empty hints to the "detect and adopt" phrasing.

- [ ] **Step 5: Render detected skills** — in `renderSkillsSection` (~972), after the `for (const i of status.installed)` loop, append detected skills:

```ts
          for (const d of status.detectedSkills) {
            list.appendChild(skillCard({
              name: d.name,
              meta: `detected · ${d.detectedIn}`,
              className: "canon-skill-row is-detected",
              fetchPreview: () => Promise.resolve(""),
              actions: [this.unitAdoptAction(cwd, "skill", d.name)],
            }));
          }
```

Change the empty guard so a section with only detected skills isn't shown as empty:

```ts
          if (status.installed.length === 0 && status.detectedSkills.length === 0) {
            // …existing emptyState…
            return;
          }
```

- [ ] **Step 6: Add the `.is-detected` styling** in `ui/src/canon/cockpit/*.css` (or the cockpit's stylesheet) — a tenuous mono badge look for the meta line:

```css
.canon-skill-row.is-detected .canon-skill-meta {
  font-family: var(--font-mono);
  opacity: 0.6;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 11px;
}
```

(Confirm the actual meta element class in `panel.ts:skillCard` and the mono var name in the design tokens; adjust selector to match.)

- [ ] **Step 7: Type-check + build the frontend**

Run: `npm run build 2>&1 | tail -20`
Expected: TS compiles clean (no missing `detectedIn` / `detectedSkills` / `canonAdopt`).

- [ ] **Step 8: Commit**

```bash
git add ui/src/api.ts ui/src/canon/cockpit/view.ts ui/src/canon/cockpit/*.css
git commit -m "feat(canon-ui): detected badge + Adopt across subagents/commands/mcp/skills"
```

---

## Manual verification (after Task 6)

Use the `verify` skill (DOM-dump recipe). Respawn the dev app, open Canon → Subagents in a repo that has a hand-installed `.claude/agents/*.md` with no `.covenant/canon/agents` source. Expect: the agent shows with a "detected" badge and an Adopt button; clicking Adopt makes it a managed row on refresh, and `.covenant/canon/agents/<name>.md` appears on disk. Repeat spot-check for a foreign `.claude/skills/<name>` dir.

## Self-review notes

- Spec coverage: discriminator table → Tasks 1–2; data layer (`detected_in`, `scan_detected`, `list_context` merge, `adopt`) → Tasks 1–4; command layer → Task 5; UI (badge, Adopt, empty-state rewording) → Task 6; test cases from the spec → Tasks 1–4 tests + manual verify.
- Resolved during planning: `read_mcp_servers` reads the Canon **source** (`.covenant/canon/mcp/*.json`), so detection reads the executor `.mcp.json` directly (Task 2 `scan_mcp`, Task 3 `read_executor_mcp`). No open ambiguity remains here.
- `Icons.download` / mono token / `skillCard` meta class are "verify-against-codebase, pick the existing name" — flagged inline, not invented.
