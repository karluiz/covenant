# CDLC Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working, offline per-group CDLC module — `.covenant/cdlc/` artifact, local skill install, executor projection, telemetry, and a per-group UI panel — without any network registry.

**Architecture:** A new `crates/cdlc` crate owns the `.covenant/cdlc/` artifact (read/write `cdlc.toml`, install a skill from a local path, project installed skills into each executor's native instruction file). `crates/app` exposes Tauri commands over it; `ui/src/cdlc/` is a per-group panel cloned from `ProjectNotesPanel`. Install events flow through the existing `crates/score` telemetry. This is Phase 1 of the design at `docs/superpowers/specs/2026-06-24-cdlc-context-governance-design.md`.

**Tech Stack:** Rust (thiserror, serde, toml, sha2, chrono), Tauri 2, TypeScript + vanilla DOM, vitest.

## Global Constraints

- Source of truth is the committed `.covenant/cdlc/` directory; the panel is a view over it. Never store CDLC state only in a DB.
- TOML for manifests (`cdlc.toml`, `skill.toml`); markdown for payloads (`SKILL.md`).
- Executors learn CDLC via **projection only** (Phase 1): generate native files; no operator injection.
- Projection managed blocks are delimited (`<!-- cdlc:start -->` / `<!-- cdlc:end -->`) and idempotent — regenerating twice produces zero diff.
- No `unwrap()` outside `#[cfg(test)]`/`main()`. `thiserror` in the lib crate. Tauri commands return `Result<_, String>`.
- Rust structs crossing the IPC boundary use `#[serde(rename_all = "camelCase")]` so TS sees camelCase (match existing `FileChange`).
- Run vitest/tsc from the **repo root**, not `ui/`.
- All agent-driven edits run in a git worktree.
- `source` field for a locally-installed skill is `local:<abs-path>`; the hosted registry (`registry.covenant.uno`) is Plan 2 and is out of scope here.

---

### Task 1: `crates/cdlc` — artifact types + manifest IO

**Files:**
- Create: `crates/cdlc/Cargo.toml`
- Create: `crates/cdlc/src/lib.rs`
- Create: `crates/cdlc/src/types.rs`
- Create: `crates/cdlc/src/manifest.rs`
- Modify: `Cargo.toml:3-14` (workspace members)

**Interfaces:**
- Produces:
  - `karl_cdlc::CdlcManifest { version: u32, installed: Vec<InstalledRef> }`
  - `karl_cdlc::InstalledRef { name, version, source, sha, signer: Option<String>, installed_at: String }`
  - `karl_cdlc::SkillManifest { name, version, owner: Option<String>, deps: Vec<String> }`
  - `karl_cdlc::cdlc_dir(repo_root: &Path) -> PathBuf`
  - `karl_cdlc::read_manifest(repo_root: &Path) -> Result<CdlcManifest>`
  - `karl_cdlc::write_manifest(repo_root: &Path, m: &CdlcManifest) -> Result<()>`
  - `karl_cdlc::CdlcError` (thiserror)

- [ ] **Step 1: Add the crate to the workspace**

In `Cargo.toml` add `"crates/cdlc",` to the `members` list (after `"crates/store",`).

- [ ] **Step 2: Create `crates/cdlc/Cargo.toml`**

```toml
[package]
name = "karl-cdlc"
version.workspace = true
edition.workspace = true
authors.workspace = true
license.workspace = true
publish.workspace = true
description = "CDLC artifact, local install, and executor projection for Covenant"

[dependencies]
thiserror = { workspace = true }
serde = { workspace = true }
toml = { workspace = true }
sha2 = { workspace = true }
chrono = { workspace = true }
tracing = { workspace = true }
```

If `toml`, `sha2`, or `chrono` are not in the root `[workspace.dependencies]`, add them there:
```toml
toml = "0.8"
sha2 = "0.10"
chrono = { version = "0.4", features = ["clock"] }
```
(`chrono` is already used by `crates/score`; reuse its exact version line.)

- [ ] **Step 3: Write the failing test for manifest roundtrip**

Create `crates/cdlc/src/manifest.rs`:
```rust
use crate::types::{CdlcManifest, InstalledRef};
use crate::CdlcError;
use std::path::{Path, PathBuf};

pub fn cdlc_dir(repo_root: &Path) -> PathBuf {
    repo_root.join(".covenant/cdlc")
}

pub fn read_manifest(repo_root: &Path) -> Result<CdlcManifest, CdlcError> {
    let path = cdlc_dir(repo_root).join("cdlc.toml");
    if !path.exists() {
        return Ok(CdlcManifest::default());
    }
    let text = std::fs::read_to_string(&path)?;
    Ok(toml::from_str(&text)?)
}

pub fn write_manifest(repo_root: &Path, m: &CdlcManifest) -> Result<(), CdlcError> {
    let dir = cdlc_dir(repo_root);
    std::fs::create_dir_all(&dir)?;
    let text = toml::to_string_pretty(m)?;
    std::fs::write(dir.join("cdlc.toml"), text)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_manifest() {
        let tmp = std::env::temp_dir().join(format!("cdlc-rt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let m = CdlcManifest {
            version: 1,
            installed: vec![InstalledRef {
                name: "kyc-peru".into(),
                version: "2.1.0".into(),
                source: "local:/tmp/kyc".into(),
                sha: "abc123".into(),
                signer: Some("github:mibanco".into()),
                installed_at: "2026-06-24T00:00:00Z".into(),
            }],
        };
        write_manifest(&tmp, &m).unwrap();
        let back = read_manifest(&tmp).unwrap();
        assert_eq!(back.installed.len(), 1);
        assert_eq!(back.installed[0].name, "kyc-peru");
        assert_eq!(back.version, 1);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn missing_manifest_is_default() {
        let tmp = std::env::temp_dir().join("cdlc-missing-does-not-exist-xyz");
        let m = read_manifest(&tmp).unwrap();
        assert_eq!(m.version, 0);
        assert!(m.installed.is_empty());
    }
}
```

Create `crates/cdlc/src/types.rs`:
```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CdlcManifest {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub installed: Vec<InstalledRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledRef {
    pub name: String,
    pub version: String,
    /// "local:<abs-path>" in Phase 1; "registry.covenant.uno" in Plan 2.
    pub source: String,
    pub sha: String,
    #[serde(default)]
    pub signer: Option<String>,
    pub installed_at: String,
}

/// `skill.toml` inside a package dir.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillManifest {
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub deps: Vec<String>,
}
```

Create `crates/cdlc/src/lib.rs`:
```rust
//! CDLC — the `.covenant/cdlc/` artifact, local install, and executor projection.

pub mod manifest;
pub mod types;

pub use manifest::{cdlc_dir, read_manifest, write_manifest};
pub use types::{CdlcManifest, InstalledRef, SkillManifest};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum CdlcError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("toml parse: {0}")]
    TomlDe(#[from] toml::de::Error),
    #[error("toml write: {0}")]
    TomlSer(#[from] toml::ser::Error),
    #[error("invalid skill package: {0}")]
    InvalidPackage(String),
}
```

- [ ] **Step 4: Run the test, verify it fails**

Run: `cargo test -p karl-cdlc roundtrip_manifest`
Expected: FAIL — crate doesn't compile yet / not in workspace until Steps 1-3 land. Once it compiles, both tests pass.

- [ ] **Step 5: Run the test, verify it passes**

Run: `cargo test -p karl-cdlc`
Expected: PASS (`roundtrip_manifest`, `missing_manifest_is_default`).

- [ ] **Step 6: Commit**

```bash
git add Cargo.toml crates/cdlc
git commit -m "feat(cdlc): artifact types + cdlc.toml manifest read/write crate"
```

---

### Task 2: Local install + executor projection

**Files:**
- Create: `crates/cdlc/src/install.rs`
- Create: `crates/cdlc/src/project.rs`
- Modify: `crates/cdlc/src/lib.rs` (add modules + re-exports)

**Interfaces:**
- Consumes: `CdlcManifest`, `InstalledRef`, `SkillManifest`, `cdlc_dir`, `read_manifest`, `write_manifest` from Task 1.
- Produces:
  - `karl_cdlc::install_local(repo_root: &Path, source_dir: &Path) -> Result<InstalledRef>`
  - `karl_cdlc::project(repo_root: &Path) -> Result<()>`
  - `karl_cdlc::CdlcStatus { installed: Vec<InstalledRef>, context_files: Vec<String> }`
  - `karl_cdlc::status(repo_root: &Path) -> Result<CdlcStatus>`

- [ ] **Step 1: Write the failing test for install + projection idempotency**

Create `crates/cdlc/src/install.rs`:
```rust
use crate::project::project;
use crate::types::{CdlcManifest, InstalledRef, SkillManifest};
use crate::{cdlc_dir, read_manifest, write_manifest, CdlcError};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CdlcStatus {
    pub installed: Vec<InstalledRef>,
    pub context_files: Vec<String>,
}

/// Install a skill package from a local directory containing `skill.toml` + `SKILL.md`.
pub fn install_local(repo_root: &Path, source_dir: &Path) -> Result<InstalledRef, CdlcError> {
    let skill_toml = source_dir.join("skill.toml");
    let skill_md = source_dir.join("SKILL.md");
    if !skill_toml.exists() || !skill_md.exists() {
        return Err(CdlcError::InvalidPackage(
            "source must contain skill.toml and SKILL.md".into(),
        ));
    }
    let sm: SkillManifest = toml::from_str(&std::fs::read_to_string(&skill_toml)?)?;
    let payload = std::fs::read(&skill_md)?;
    let sha = format!("{:x}", Sha256::digest(&payload));

    // Copy package into .covenant/cdlc/skills/<name>/
    let dest = cdlc_dir(repo_root).join("skills").join(&sm.name);
    std::fs::create_dir_all(&dest)?;
    std::fs::copy(&skill_toml, dest.join("skill.toml"))?;
    std::fs::write(dest.join("SKILL.md"), &payload)?;

    // Upsert manifest entry by name.
    let mut manifest = read_manifest(repo_root)?;
    if manifest.version == 0 {
        manifest.version = 1;
    }
    let r = InstalledRef {
        name: sm.name.clone(),
        version: sm.version.clone(),
        source: format!("local:{}", source_dir.display()),
        sha,
        signer: sm.owner.clone(),
        installed_at: chrono::Utc::now().to_rfc3339(),
    };
    manifest.installed.retain(|i| i.name != sm.name);
    manifest.installed.push(r.clone());
    write_manifest(repo_root, &manifest)?;
    write_lock(repo_root, &manifest)?;

    project(repo_root)?;
    Ok(r)
}

fn write_lock(repo_root: &Path, m: &CdlcManifest) -> Result<(), CdlcError> {
    let lines: Vec<String> = m
        .installed
        .iter()
        .map(|i| format!("{} {} {}", i.name, i.version, i.sha))
        .collect();
    std::fs::write(cdlc_dir(repo_root).join("cdlc.lock"), lines.join("\n"))?;
    Ok(())
}

pub fn status(repo_root: &Path) -> Result<CdlcStatus, CdlcError> {
    let installed = read_manifest(repo_root)?.installed;
    let ctx_dir = cdlc_dir(repo_root).join("context");
    let mut context_files = Vec::new();
    if ctx_dir.exists() {
        for entry in std::fs::read_dir(&ctx_dir)? {
            let entry = entry?;
            if entry.path().extension().and_then(|s| s.to_str()) == Some("md") {
                if let Some(name) = entry.file_name().to_str() {
                    context_files.push(name.to_string());
                }
            }
        }
    }
    context_files.sort();
    Ok(CdlcStatus { installed, context_files })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_pkg(dir: &Path, name: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(
            dir.join("skill.toml"),
            format!("name = \"{name}\"\nversion = \"1.0.0\"\nowner = \"github:mibanco\"\n"),
        )
        .unwrap();
        std::fs::write(dir.join("SKILL.md"), "# KYC Peru\nAlways require the doc.\n").unwrap();
    }

    #[test]
    fn install_then_projection_is_idempotent() {
        let base = std::env::temp_dir().join(format!("cdlc-inst-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let repo = base.join("repo");
        let src = base.join("src-kyc");
        std::fs::create_dir_all(&repo).unwrap();
        write_pkg(&src, "kyc-peru");

        let r = install_local(&repo, &src).unwrap();
        assert_eq!(r.name, "kyc-peru");
        assert!(repo.join(".covenant/cdlc/skills/kyc-peru/SKILL.md").exists());
        assert!(repo.join(".claude/skills/cdlc-kyc-peru/SKILL.md").exists());

        let agents1 = std::fs::read_to_string(repo.join("AGENTS.md")).unwrap();
        // Re-project: must not duplicate the managed block.
        crate::project::project(&repo).unwrap();
        let agents2 = std::fs::read_to_string(repo.join("AGENTS.md")).unwrap();
        assert_eq!(agents1, agents2, "projection must be idempotent");
        assert_eq!(agents2.matches("<!-- cdlc:start -->").count(), 1);

        let _ = std::fs::remove_dir_all(&base);
    }
}
```

- [ ] **Step 2: Write the projection module**

Create `crates/cdlc/src/project.rs`:
```rust
use crate::{cdlc_dir, read_manifest, CdlcError};
use std::path::Path;

const START: &str = "<!-- cdlc:start -->";
const END: &str = "<!-- cdlc:end -->";

/// Generate every executor's native instruction file from the installed skills.
pub fn project(repo_root: &Path) -> Result<(), CdlcError> {
    let manifest = read_manifest(repo_root)?;
    let skills_dir = cdlc_dir(repo_root).join("skills");

    // Collect each installed skill's payload once.
    let mut blocks: Vec<(String, String, String)> = Vec::new(); // (name, version, body)
    for i in &manifest.installed {
        let md = skills_dir.join(&i.name).join("SKILL.md");
        let body = std::fs::read_to_string(&md).unwrap_or_default();
        blocks.push((i.name.clone(), i.version.clone(), body));
    }

    // claude: one dir per skill, 1:1 copy (native skill format).
    for (name, _v, body) in &blocks {
        let dir = repo_root.join(".claude/skills").join(format!("cdlc-{name}"));
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join("SKILL.md"), body)?;
    }

    // Managed-block executors: one concatenated block.
    let combined = blocks
        .iter()
        .map(|(n, v, b)| format!("## {n} v{v}\n\n{}", b.trim()))
        .collect::<Vec<_>>()
        .join("\n\n");
    let body = format!("# CDLC context (auto-generated — do not edit inside this block)\n\n{combined}");

    for rel in ["AGENTS.md", ".github/copilot-instructions.md"] {
        upsert_file(repo_root, rel, &body)?;
    }
    Ok(())
}

fn upsert_file(repo_root: &Path, rel: &str, body: &str) -> Result<(), CdlcError> {
    let path = repo_root.join(rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    std::fs::write(&path, upsert_block(&existing, body))?;
    Ok(())
}

fn upsert_block(existing: &str, body: &str) -> String {
    let block = format!("{START}\n{body}\n{END}");
    if let (Some(s), Some(e)) = (existing.find(START), existing.find(END)) {
        let end = e + END.len();
        format!("{}{}{}", &existing[..s], block, &existing[end..])
    } else if existing.trim().is_empty() {
        format!("{block}\n")
    } else {
        format!("{}\n\n{block}\n", existing.trim_end())
    }
}

#[cfg(test)]
mod tests {
    use super::upsert_block;

    #[test]
    fn upsert_is_idempotent_and_single_block() {
        let once = upsert_block("", "BODY-A");
        let twice = upsert_block(&once, "BODY-A");
        assert_eq!(once, twice);
        assert_eq!(twice.matches("<!-- cdlc:start -->").count(), 1);
        // Replaces body, preserves surrounding text.
        let with_prefix = upsert_block("hand-written top\n", "BODY-B");
        assert!(with_prefix.starts_with("hand-written top"));
        let replaced = upsert_block(&with_prefix, "BODY-C");
        assert!(replaced.contains("BODY-C"));
        assert!(!replaced.contains("BODY-B"));
    }
}
```

- [ ] **Step 3: Wire modules + re-exports in lib.rs**

In `crates/cdlc/src/lib.rs`, add under the existing `pub mod` lines:
```rust
pub mod install;
pub mod project;

pub use install::{install_local, status, CdlcStatus};
pub use project::project;
```

- [ ] **Step 4: Run tests, verify they fail then pass**

Run: `cargo test -p karl-cdlc`
Expected: PASS — `install_then_projection_is_idempotent`, `upsert_is_idempotent_and_single_block`, plus Task 1's tests.

- [ ] **Step 5: Commit**

```bash
git add crates/cdlc/src
git commit -m "feat(cdlc): local install + idempotent executor projection (.claude/AGENTS/copilot)"
```

---

### Task 3: Score telemetry — `CdlcInstall` event

**Files:**
- Modify: `crates/score/src/types.rs:4-9` (EventKind)
- Modify: `crates/score/src/lib.rs` (add `record_cdlc_install`)

**Interfaces:**
- Consumes: `EventKind`, `Context`, `Store::append_with_context` (existing).
- Produces: `score::record_cdlc_install(name: &str, group: Option<String>, workspace: Option<String>)`

- [ ] **Step 1: Add the EventKind variant**

In `crates/score/src/types.rs`, change the enum to:
```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    Prompt,
    Commit,
    CdlcInstall,
}
```

- [ ] **Step 2: Write the failing test**

In `crates/score/src/lib.rs`, add to the existing `#[cfg(test)] mod tests` (or create one):
```rust
#[test]
fn cdlc_install_event_records() {
    let tmp = std::env::temp_dir().join(format!("score-cdlc-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let store = crate::store::Store::open_at(&tmp).unwrap();
    let ctx = crate::types::Context {
        repo: Some("mibanco".into()),
        branch: None,
        group_name: Some("payments".into()),
        workspace: Some("main".into()),
    };
    store
        .append_with_context(0, crate::types::EventKind::CdlcInstall, "cdlc:kyc-peru", None, &ctx)
        .unwrap();
    let summary = store.summary().unwrap();
    assert!(summary.total_events >= 1);
    let _ = std::fs::remove_dir_all(&tmp);
}
```
(If `Store::open_at` / `summary().total_events` differ, match the actual names already used by the neighbouring tests in `store.rs` — do not invent.)

- [ ] **Step 3: Run test, verify it fails**

Run: `cargo test -p score cdlc_install_event_records`
Expected: FAIL until the variant compiles; then PASS.

- [ ] **Step 4: Add the convenience wrapper**

In `crates/score/src/lib.rs`, next to `record_commit_with_context`, add:
```rust
pub fn record_cdlc_install(name: &str, group: Option<String>, workspace: Option<String>) {
    let now = chrono::Utc::now().timestamp_millis();
    let exec = format!("cdlc:{name}");
    let ctx = crate::types::Context {
        repo: None,
        branch: None,
        group_name: group,
        workspace,
    };
    if let Ok(g) = slot().lock() {
        if let Some(store) = g.as_ref() {
            let _ = store.append_with_context(now, crate::types::EventKind::CdlcInstall, &exec, None, &ctx);
        }
    }
}
```

- [ ] **Step 5: Run tests, verify pass**

Run: `cargo test -p score`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/score/src
git commit -m "feat(score): CdlcInstall telemetry event + record_cdlc_install"
```

---

### Task 4: Tauri commands + api.ts wrappers

**Files:**
- Modify: `crates/app/Cargo.toml` (depend on `karl-cdlc`)
- Modify: `crates/app/src/lib.rs` (two commands + handler registration)
- Modify: `ui/src/api.ts` (types + wrappers)

**Interfaces:**
- Consumes: `karl_cdlc::{status, install_local, CdlcStatus, InstalledRef}` (Task 2), `score::record_cdlc_install` (Task 3).
- Produces (TS): `cdlcLocalStatus(cwd)`, `cdlcInstallLocal(cwd, source, group, workspace)`, types `CdlcStatus`, `InstalledRef`.

- [ ] **Step 1: Add the crate dependency**

In `crates/app/Cargo.toml` `[dependencies]`, add:
```toml
karl-cdlc = { path = "../cdlc" }
```

- [ ] **Step 2: Add the two commands**

In `crates/app/src/lib.rs`, near the `git_changes` command, add:
```rust
#[tauri::command]
async fn cdlc_local_status(cwd: String) -> Result<karl_cdlc::CdlcStatus, String> {
    let repo = std::path::PathBuf::from(cwd);
    tokio::task::spawn_blocking(move || karl_cdlc::status(&repo))
        .await
        .map_err(|e| format!("cdlc_local_status join: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cdlc_install_local(
    cwd: String,
    source: String,
    group: Option<String>,
    workspace: Option<String>,
) -> Result<karl_cdlc::InstalledRef, String> {
    let repo = std::path::PathBuf::from(cwd);
    let src = std::path::PathBuf::from(source);
    let r = tokio::task::spawn_blocking(move || karl_cdlc::install_local(&repo, &src))
        .await
        .map_err(|e| format!("cdlc_install_local join: {e}"))?
        .map_err(|e| e.to_string())?;
    score::record_cdlc_install(&r.name, group, workspace);
    Ok(r)
}
```

- [ ] **Step 3: Register in the handler**

In the `tauri::generate_handler![...]` list in `crates/app/src/lib.rs`, add (next to `git_changes,`):
```rust
        cdlc_local_status,
        cdlc_install_local,
```

- [ ] **Step 4: Add TS wrappers**

In `ui/src/api.ts`, add:
```typescript
export interface InstalledRef {
  name: string;
  version: string;
  source: string;
  sha: string;
  signer: string | null;
  installedAt: string;
}
export interface CdlcStatus {
  installed: InstalledRef[];
  contextFiles: string[];
}
export async function cdlcLocalStatus(cwd: string): Promise<CdlcStatus> {
  return invoke<CdlcStatus>("cdlc_local_status", { cwd });
}
export async function cdlcInstallLocal(
  cwd: string,
  source: string,
  group: string | null,
  workspace: string | null,
): Promise<InstalledRef> {
  return invoke<InstalledRef>("cdlc_install_local", { cwd, source, group, workspace });
}
```

- [ ] **Step 5: Verify it compiles**

Run: `cargo build -p covenant-app` (use the actual app package name from `crates/app/Cargo.toml`) and `npm run -s typecheck` from the repo root.
Expected: both succeed, no type errors.

- [ ] **Step 6: Commit**

```bash
git add crates/app/Cargo.toml crates/app/src/lib.rs ui/src/api.ts
git commit -m "feat(cdlc): tauri commands cdlc_local_status/cdlc_install_local + api wrappers"
```

---

### Task 5: Per-group CDLC panel + rail wiring

**Files:**
- Create: `ui/src/cdlc/panel.ts`
- Create: `ui/src/cdlc/panel.test.ts`
- Modify: `ui/src/titlebar/right-rail.ts:4-12` (RailTarget union)
- Modify: `ui/src/main.ts` (opener, mount/close, openRail/closeRail cases)

**Interfaces:**
- Consumes (TS): `cdlcLocalStatus`, `cdlcInstallLocal`, `CdlcStatus` (Task 4).
- Produces: `CdlcPanel { constructor(opts: CdlcPanelOpts); mount(host): this; renderStatus(s: CdlcStatus): void; close(): void }`, opener `requestCdlc(groupId, label, color)`.

- [ ] **Step 1: Write the failing render test**

Create `ui/src/cdlc/panel.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { CdlcPanel } from "./panel";

describe("CdlcPanel", () => {
  it("renders installed skills and context files", () => {
    const host = document.createElement("div");
    const panel = new CdlcPanel({
      groupId: "g1",
      groupLabel: "Payments",
      groupColor: null,
      groupRootDir: "/repo",
    }).mount(host);
    panel.renderStatus({
      installed: [
        { name: "kyc-peru", version: "2.1.0", source: "local:/x", sha: "a", signer: "github:mibanco", installedAt: "2026-06-24T00:00:00Z" },
      ],
      contextFiles: ["kyc-peru.md"],
    });
    expect(host.textContent).toContain("kyc-peru");
    expect(host.textContent).toContain("2.1.0");
    expect(host.textContent).toContain("kyc-peru.md");
  });
});
```

- [ ] **Step 2: Implement the panel**

Create `ui/src/cdlc/panel.ts`:
```typescript
import type { CdlcStatus } from "../api";
import { cdlcLocalStatus } from "../api";

export interface CdlcPanelOpts {
  groupId: string;
  groupLabel: string;
  groupColor?: string | null;
  groupRootDir?: string | null;
  onClose?: () => void;
  onNewContext?: () => void;
}

type Section = "context" | "skills" | "loop";

export class CdlcPanel {
  private root: HTMLElement;
  private body: HTMLElement;
  private section: Section = "skills";

  constructor(private opts: CdlcPanelOpts) {
    this.root = document.createElement("div");
    this.root.className = "cdlc-panel";
    const head = document.createElement("div");
    head.className = "cdlc-head";
    head.textContent = `CDLC — ${opts.groupLabel}`;
    if (opts.groupColor) head.style.setProperty("--cdlc-accent", opts.groupColor);
    this.body = document.createElement("div");
    this.body.className = "cdlc-body";
    this.root.append(head, this.body);
  }

  mount(host: HTMLElement): this {
    host.appendChild(this.root);
    void this.refresh();
    return this;
  }

  async refresh(): Promise<void> {
    const cwd = this.opts.groupRootDir;
    if (!cwd) {
      this.body.textContent = "This group has no project folder.";
      return;
    }
    try {
      this.renderStatus(await cdlcLocalStatus(cwd));
    } catch (e) {
      this.body.textContent = `Failed to read CDLC: ${String(e)}`;
    }
  }

  renderStatus(s: CdlcStatus): void {
    this.body.replaceChildren();

    const skills = document.createElement("section");
    skills.className = "cdlc-skills";
    const sh = document.createElement("h3");
    sh.textContent = "Skills";
    skills.appendChild(sh);
    if (s.installed.length === 0) {
      const p = document.createElement("p");
      p.textContent = "No skills installed.";
      skills.appendChild(p);
    } else {
      for (const i of s.installed) {
        const row = document.createElement("div");
        row.className = "cdlc-skill-row";
        row.textContent = `${i.name}  ${i.version}  ${i.source}`;
        skills.appendChild(row);
      }
    }

    const ctx = document.createElement("section");
    ctx.className = "cdlc-context";
    const ch = document.createElement("h3");
    ch.textContent = "Context";
    ctx.appendChild(ch);
    const newBtn = document.createElement("button");
    newBtn.textContent = "New context";
    newBtn.addEventListener("click", () => this.opts.onNewContext?.());
    ctx.appendChild(newBtn);
    for (const f of s.contextFiles) {
      const row = document.createElement("div");
      row.className = "cdlc-context-row";
      row.textContent = f;
      ctx.appendChild(row);
    }

    const loop = document.createElement("section");
    loop.className = "cdlc-loop";
    loop.innerHTML = "<h3>Loop</h3><p>Eval &amp; adoption metrics arrive in Phase 2.</p>";

    this.body.append(ctx, skills, loop);
    void this.section; // sections rendered together for v1
  }

  close(): void {
    this.root.remove();
    this.opts.onClose?.();
  }
}
```

- [ ] **Step 3: Run the test, verify pass**

Run (from repo root): `npm run -s test -- ui/src/cdlc/panel.test.ts`
Expected: PASS.

- [ ] **Step 4: Register the rail target**

In `ui/src/titlebar/right-rail.ts`, add `"cdlc"` to the `RailTarget` union:
```typescript
export type RailTarget =
  | "blocks"
  | "structure"
  | "activity"
  | "recall"
  | "notes"
  | "cdlc"
  | "teammate"
  | "tasker"
  | "resources";
```

- [ ] **Step 5: Wire opener + mount/close in main.ts**

In `ui/src/main.ts`, mirror the Project Notes wiring. Add module state + functions near `mountProjectNotes`:
```typescript
let activeCdlcPanel: import("./cdlc/panel").CdlcPanel | null = null;
let pendingCdlcArgs: { groupId: string; groupLabel: string; groupColor: string | null } | null = null;

function requestCdlc(groupId: string, groupLabel: string, groupColor: string | null): void {
  pendingCdlcArgs = { groupId, groupLabel, groupColor };
  rail.open("cdlc");
}

function mountCdlc(): void {
  let args = pendingCdlcArgs;
  pendingCdlcArgs = null;
  if (!args) {
    const g = manager.activeGroup();
    if (!g) return;
    args = { groupId: g.id, groupLabel: g.name, groupColor: g.color ?? null };
  }
  if (activeCdlcPanel) activeCdlcPanel.close();
  const { CdlcPanel } = require("./cdlc/panel") as typeof import("./cdlc/panel");
  activeCdlcPanel = new CdlcPanel({
    groupId: args.groupId,
    groupLabel: args.groupLabel,
    groupColor: args.groupColor,
    groupRootDir: manager.groupRootDirFor(args.groupId),
    onClose: () => {
      activeCdlcPanel = null;
      rail.handleExternalClose("cdlc");
    },
    onNewContext: () => {
      window.dispatchEvent(new CustomEvent("spec-chat:open", { detail: { cdlcContext: true } }));
    },
  }).mount(document.body);
}
```
(If the file uses ESM imports rather than `require`, add `import { CdlcPanel } from "./cdlc/panel";` at the top and drop the inline `require`.)

Add to the `openRail` switch:
```typescript
      case "cdlc":
        mountCdlc();
        break;
```
Add to the `closeRail` switch:
```typescript
      case "cdlc":
        activeCdlcPanel?.close();
        break;
```

- [ ] **Step 6: Add a keyboard shortcut**

Find the keydown handler that opens `notes` (search `requestProjectNotes` / `⌘⇧J`). Add a sibling binding for CDLC on a **free** chord — propose `⌘⇧K`; verify it's unbound first (`grep -rn "shiftKey" ui/src/main.ts` and the keymap). Wire it to call `requestCdlc(g.id, g.name, g.color ?? null)` for the active group. If the chord is taken, pick another and note it in the commit message.

- [ ] **Step 7: Verify build + tests**

Run (repo root): `npm run -s typecheck && npm run -s test -- ui/src/cdlc`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add ui/src/cdlc ui/src/titlebar/right-rail.ts ui/src/main.ts
git commit -m "feat(cdlc): per-group panel + rail entry + opener shortcut"
```

---

### Task 6: Generate wiring — Spec Creator publishes to `.covenant/cdlc/context/`

**Files:**
- Modify: `crates/app/src/drafts.rs` (publish-path override)
- Modify: `ui/src/spec-chat/index.ts` (thread `cdlcContext` through `open`)
- Modify: `ui/src/main.ts:1644-1647` (`spec-chat:open` listener reads `cdlcContext`)

**Interfaces:**
- Consumes: the `spec-chat:open` CustomEvent `detail.cdlcContext` emitted by Task 5's `onNewContext`.
- Produces: `drafts::publish_subdir(cdlc_context: bool) -> &'static str` and a `specChat.open(draftId?, opts?: { cdlcContext?: boolean })` signature.

- [ ] **Step 1: Write the failing test for the publish subdir**

In `crates/app/src/drafts.rs`, add a small pure helper + test:
```rust
/// Where a published spec is written, relative to repo root.
pub fn publish_subdir(cdlc_context: bool) -> &'static str {
    if cdlc_context {
        ".covenant/cdlc/context"
    } else {
        "docs/specs"
    }
}

#[cfg(test)]
mod cdlc_tests {
    use super::publish_subdir;
    #[test]
    fn cdlc_context_redirects_publish_dir() {
        assert_eq!(publish_subdir(false), "docs/specs");
        assert_eq!(publish_subdir(true), ".covenant/cdlc/context");
    }
}
```

- [ ] **Step 2: Run it, verify fail then pass**

Run: `cargo test -p covenant-app cdlc_context_redirects_publish_dir`
Expected: PASS once it compiles.

- [ ] **Step 3: Use the subdir at the publish site**

Find where a published spec path is built (the function using `next_spec_id(repo_root)` / `repo_root.join("docs/specs")` in `drafts.rs`). Replace the hard-coded `"docs/specs"` join with `repo_root.join(publish_subdir(cdlc_context))`, threading a `cdlc_context: bool` parameter from the publish command. The publish Tauri command gains a `cdlc_context: Option<bool>` arg (default `false`); pass it down. Create `.covenant/cdlc/context/` with `create_dir_all` before writing (mirror the existing `docs/specs` creation).

- [ ] **Step 4: Thread the flag through the frontend**

In `ui/src/spec-chat/index.ts`, change the controller's `open` signature to accept options and carry `cdlcContext` into its publish call:
```typescript
open(draftId?: string, opts?: { cdlcContext?: boolean }): void {
  this.cdlcContext = opts?.cdlcContext ?? false;
  // ...existing open logic; pass this.cdlcContext to the publish invoke...
}
```
In `ui/src/main.ts`, update the listener:
```typescript
window.addEventListener("spec-chat:open", (e: Event) => {
  const detail = (e as CustomEvent<{ draftId?: string; cdlcContext?: boolean }>).detail;
  specChat.open(detail?.draftId, { cdlcContext: detail?.cdlcContext });
});
```

- [ ] **Step 5: Verify end-to-end build + tests**

Run (repo root): `cargo test -p covenant-app && npm run -s typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/drafts.rs ui/src/spec-chat/index.ts ui/src/main.ts
git commit -m "feat(cdlc): Spec Creator publishes context specs to .covenant/cdlc/context"
```

---

## Self-Review

**Spec coverage (Phase 1 scope from the design doc):**
- `.covenant/cdlc/` manifest → Task 1 ✓
- Local install + skills/ layout → Task 2 ✓
- Executor projection (claude/codex/copilot; pi/hermes share the managed-block path) → Task 2 ✓ *(pi/hermes use the same `AGENTS.md`-style managed block; if they read a distinct file, add it to the `for rel in [...]` loop in `project.rs` — one line each)*
- Install telemetry → Tasks 3 + 4 ✓
- Per-group panel (Context/Skills/Loop) → Task 5 ✓
- Generate wired to Spec Creator → Task 6 ✓
- identity+sha signing → `sha` computed in Task 2; `signer` carried from `skill.toml owner`. Full verification is a Plan 2 concern (registry verifies on publish/install). ✓ for local.

**Out of scope (correctly absent):** hosted registry, eval runner, Observe/Adapt loop, operator injection, keypair signing.

**Placeholder scan:** No "TBD"/"add error handling" placeholders. Two flagged integration points (keyboard chord in Task 5 Step 6; the exact publish-site line in Task 6 Step 3) are marked "find X and replace" because they depend on lines that move — each names the exact anchor token to grep for.

**Type consistency:** `InstalledRef`/`CdlcStatus` use `#[serde(rename_all = "camelCase")]` (Rust) ↔ camelCase TS interfaces (`installedAt`, `contextFiles`). `EventKind::CdlcInstall` (snake_case `cdlc_install` on the wire) used consistently in Tasks 3-4. `install_local`/`status`/`project` names match across Tasks 2-4.

## Execution Handoff

Two flagged anchors (Task 5 Step 6 chord, Task 6 Step 3 publish site) need a quick grep at execution time to confirm exact lines — both name the token to search for. Everything else is concrete.
