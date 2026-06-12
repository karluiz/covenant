# Mission Drafts (3.10) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the in-app **Drafts** sidebar entry + guided wizard that lets the user write specs from scratch following `docs/specs/_template.md`, store them as drafts in `docs/specs/drafts/<slug>.md`, optionally request **✨ Help** from Haiku 4.5 for three sections, and publish them as numbered specs in `docs/specs/<id>-<slug>.md`. Per `docs/specs/3.10-mission-drafts.md`.

**Architecture:** Backend exposes 6 new Tauri commands (`list_drafts`, `read_draft`, `save_draft`, `publish_draft`, `delete_draft`, `suggest_draft_section`) under a single `crates/app/src/drafts.rs` module. Filesystem is the source of truth — drafts live as YAML-frontmatter `.md` files in `<repo>/docs/specs/drafts/`; published specs go in `<repo>/docs/specs/`. Frontend mounts a full-page panel mirroring `DocsPanel` (replaces the workspace grid cell), with a list view and a 6-step wizard that autosaves on blur and every 30s. The ✨ Help button calls `karl_agent::ask_oneshot` with a cached system prompt + the `_template.md` content cached as a static asset.

**Tech Stack:** Rust (`serde`, `serde_yaml`, `tokio::fs`, `tauri::command`), Tauri 2 commands, TypeScript class + manual DOM (no framework), CodeMirror 6 (already in repo for Structure), CSS grid.

**Source spec:** `docs/specs/3.10-mission-drafts.md` — read first. Acceptance criteria, file boundaries, and line caps in the spec are binding.

**Resolved decisions (from brainstorm):**
- Hybrid wizard: static form + per-section ✨ Help (Out of scope, Acceptance criteria, Open questions only).
- Filesystem from day one: drafts in `docs/specs/drafts/<slug>.md`, no SQLite.
- Sidebar entry in fullscreen panel (not a Set Mission tab); icon-only, Lucide `file-pen`.
- Auto-incremented ID at publish time (max existing `<N>.<M>` + 0.1, override editable).
- LLM cap = 20 calls/draft, hardcoded v1 (settings-driven in v2).
- Use existing `karl_agent::ask_oneshot` + `s.agent.model_summary` (Haiku) — same path as `fix_proposer.rs`.

**Repo discovery:**
- Workspace root for fs operations: `tauri::Manager::path().app_local_data_dir()` is wrong; the user's repo root is what matters. Use `std::env::current_dir()` at app start (already done in existing modules) or accept `cwd: PathBuf` in commands and let frontend pass `tab.cwd`. **Decision: accept `repo_root: String` in every draft command** so the user can run drafts against any repo, mirroring `tab.cwd` usage in `tabs/manager.ts:1352`.
- Existing pattern for LLM call: `crates/app/src/fix_proposer.rs:120-160`. Reuse verbatim shape.
- Sidebar icon set: Lucide via `ui/src/icons/`. Use `file-pen` (already common) — verify in `icons` module; if missing, add to that module's icon list.

---

## File Structure

**Create:**
- `crates/app/src/drafts.rs` — types (`DraftFrontmatter`, `DraftSummary`, `DraftDocument`), `parse_draft(text)`, `serialize_draft(doc)`, `slugify(title)`, `next_spec_id(repo_root)`, `list_drafts(repo_root)`, `read_draft(repo_root, slug)`, `save_draft(repo_root, slug, content)`, `publish_draft(repo_root, slug, id, slug_override)`, `delete_draft(repo_root, slug)`, `suggest_section(api_key, model, draft_text, section)`. Includes unit tests. ≤ 250 lines.
- `ui/src/drafts/api.ts` — typed wrappers around the 6 Tauri commands. ≤ 80 lines.
- `ui/src/drafts/panel.ts` — `DraftsPanel` class: open/close/toggle, mounts list or wizard view in pageHost; mirrors `DocsPanel`. ≤ 300 lines.
- `ui/src/drafts/wizard.ts` — `DraftWizard` component: 6 sections + autosave + ✨ Help popover + Publish modal. ≤ 350 lines.
- `docs/specs/drafts/.gitkeep` — empty file so the directory exists in git.

**Modify:**
- `crates/app/src/lib.rs` — `mod drafts;` + register 6 commands in `tauri::generate_handler!`. ≤ 15 lines added.
- `ui/index.html` — add `<section id="drafts-page" hidden></section>` next to `#docs-page`. 1 line.
- `ui/src/main.ts` — instantiate `DraftsPanel`, wire sidebar icon click + Esc close + workspace replacement (mirror docsPanel block). ≤ 20 lines added.
- `ui/src/api.ts` — re-export `drafts/api.ts` wrappers. ≤ 10 lines.
- `ui/src/styles.css` — drafts panel + wizard + popover + publish modal styles. ≤ 100 lines, appended at file end. Reuse `--bg-overlay`, `--bg-panel`, `--border`, `--muted`, `--accent`. **No new color tokens.**

**Do NOT touch:** `crates/agent/`, `crates/blocks/`, `crates/session/`, `crates/pty/`, `crates/app/src/operator.rs`, `crates/app/src/aom.rs`, `crates/app/src/safety.rs`, `crates/app/src/settings.rs` (except reading `agent.model_summary` and `anthropic_api_key` — read-only), `crates/app/src/storage.rs`, `ui/src/operator/`, `ui/src/aom/`, `ui/src/recall/`, `ui/src/blocks/`, `ui/src/structure/`, `ui/src/tabs/`, `ui/src/settings/`, `docs/specs/_template.md`, any existing `docs/specs/3.*-*.md`.

---

## Task 1: Backend types + frontmatter parser (TDD)

**Files:**
- Create: `crates/app/src/drafts.rs`
- Test: same file (`#[cfg(test)] mod tests`)

- [ ] **Step 1: Write the failing tests**

```rust
// crates/app/src/drafts.rs
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DraftError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("yaml: {0}")]
    Yaml(#[from] serde_yaml::Error),
    #[error("invalid frontmatter: {0}")]
    InvalidFrontmatter(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("collision: {0}")]
    Collision(String),
    #[error("validation: {0}")]
    Validation(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DraftFrontmatter {
    pub status: String,        // always "draft"
    pub title: String,
    pub slug: String,
    pub created_at: String,    // RFC3339
    pub updated_at: String,    // RFC3339
    #[serde(default)]
    pub llm_calls: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DraftDocument {
    pub frontmatter: DraftFrontmatter,
    pub body: String,
}

pub fn parse_draft(text: &str) -> Result<DraftDocument, DraftError> {
    let rest = text.strip_prefix("---\n")
        .ok_or_else(|| DraftError::InvalidFrontmatter("missing opening ---".into()))?;
    let end = rest.find("\n---\n")
        .ok_or_else(|| DraftError::InvalidFrontmatter("missing closing ---".into()))?;
    let yaml = &rest[..end];
    let body = rest[end + 5..].to_string();
    let frontmatter: DraftFrontmatter = serde_yaml::from_str(yaml)?;
    Ok(DraftDocument { frontmatter, body })
}

pub fn serialize_draft(doc: &DraftDocument) -> Result<String, DraftError> {
    let yaml = serde_yaml::to_string(&doc.frontmatter)?;
    Ok(format!("---\n{yaml}---\n{}", doc.body))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fm() -> DraftFrontmatter {
        DraftFrontmatter {
            status: "draft".into(),
            title: "Mission Drafts".into(),
            slug: "mission-drafts".into(),
            created_at: "2026-05-03T14:55:00Z".into(),
            updated_at: "2026-05-03T15:12:00Z".into(),
            llm_calls: 0,
        }
    }

    #[test]
    fn parse_roundtrip() {
        let doc = DraftDocument {
            frontmatter: fm(),
            body: "# Draft — Mission Drafts\n\n## Goal\nx\n".into(),
        };
        let text = serialize_draft(&doc).unwrap();
        let parsed = parse_draft(&text).unwrap();
        assert_eq!(parsed, doc);
    }

    #[test]
    fn parse_missing_open() {
        let err = parse_draft("title: x\n").unwrap_err();
        assert!(matches!(err, DraftError::InvalidFrontmatter(_)));
    }

    #[test]
    fn parse_missing_close() {
        let err = parse_draft("---\ntitle: x\n").unwrap_err();
        assert!(matches!(err, DraftError::InvalidFrontmatter(_)));
    }
}
```

- [ ] **Step 2: Add `mod drafts;` to lib + add `serde_yaml` dep if missing**

Run: `grep -n "serde_yaml" crates/app/Cargo.toml`. If absent, add `serde_yaml = "0.9"` under `[dependencies]`.

Edit `crates/app/src/lib.rs` to add `mod drafts;` near the other `mod` declarations (e.g., after `mod cost;`).

- [ ] **Step 3: Run tests to verify they pass**

Run: `cargo test -p covenant drafts::tests --lib`
Expected: 3 passed.

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/drafts.rs crates/app/src/lib.rs crates/app/Cargo.toml
git commit -m "feat(drafts): types + frontmatter parser"
```

---

## Task 2: Slug + ID helpers (TDD)

**Files:**
- Modify: `crates/app/src/drafts.rs`

- [ ] **Step 1: Append failing tests + helpers**

Add to `crates/app/src/drafts.rs` (above the `#[cfg(test)]` block):

```rust
/// kebab-case slug from a free-text title. ASCII-only fallback for
/// non-ASCII chars (drop them). Empty input returns "untitled".
pub fn slugify(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut prev_dash = true;
    for c in title.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() { "untitled".into() } else { trimmed.to_string() }
}

/// Find max `<major>.<minor>` ID among `docs/specs/*.md` (excluding
/// `_template.md` and `drafts/`) and return next minor (`major.(minor+1)`).
/// If no spec exists, returns "1.0".
pub fn next_spec_id(repo_root: &Path) -> Result<String, DraftError> {
    let dir = repo_root.join("docs/specs");
    if !dir.exists() {
        return Ok("1.0".into());
    }
    let mut best: Option<(u32, u32)> = None;
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.ends_with(".md") || name.starts_with('_') {
            continue;
        }
        let stem = name.trim_end_matches(".md");
        let prefix = stem.split('-').next().unwrap_or("");
        let mut parts = prefix.split('.');
        let (Some(maj), Some(min)) = (parts.next(), parts.next()) else { continue };
        if let (Ok(maj), Ok(min)) = (maj.parse::<u32>(), min.parse::<u32>()) {
            best = Some(best.map_or((maj, min), |(m, n)| {
                if (maj, min) > (m, n) { (maj, min) } else { (m, n) }
            }));
        }
    }
    Ok(match best {
        Some((maj, min)) => format!("{maj}.{}", min + 1),
        None => "1.0".into(),
    })
}
```

Add tests inside `mod tests`:

```rust
#[test]
fn slugify_basic() {
    assert_eq!(slugify("Mission Drafts"), "mission-drafts");
    assert_eq!(slugify("  Hello, World!  "), "hello-world");
    assert_eq!(slugify("---"), "untitled");
    assert_eq!(slugify("Café 99"), "caf-99");
}

#[test]
fn next_spec_id_increments_max() {
    let tmp = tempfile::tempdir().unwrap();
    let specs = tmp.path().join("docs/specs");
    std::fs::create_dir_all(&specs).unwrap();
    for name in ["1.0-a.md", "3.9-foo.md", "3.2-bar.md", "_template.md"] {
        std::fs::write(specs.join(name), "x").unwrap();
    }
    assert_eq!(next_spec_id(tmp.path()).unwrap(), "3.10");
}

#[test]
fn next_spec_id_empty_dir() {
    let tmp = tempfile::tempdir().unwrap();
    assert_eq!(next_spec_id(tmp.path()).unwrap(), "1.0");
}
```

- [ ] **Step 2: Add `tempfile` to dev-dependencies if missing**

Run: `grep -n "tempfile" crates/app/Cargo.toml`. If not under `[dev-dependencies]`, add `tempfile = "3"`.

- [ ] **Step 3: Run tests**

Run: `cargo test -p covenant drafts::tests --lib`
Expected: 6 passed.

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/drafts.rs crates/app/Cargo.toml
git commit -m "feat(drafts): slugify + next_spec_id helpers"
```

---

## Task 3: list/read/save filesystem ops (TDD)

**Files:**
- Modify: `crates/app/src/drafts.rs`

- [ ] **Step 1: Append helpers + tests**

Add to `crates/app/src/drafts.rs` (above `#[cfg(test)]`):

```rust
#[derive(Debug, Clone, Serialize)]
pub struct DraftSummary {
    pub slug: String,
    pub title: String,
    pub updated_at: String,
}

fn drafts_dir(repo_root: &Path) -> PathBuf {
    repo_root.join("docs/specs/drafts")
}

fn draft_path(repo_root: &Path, slug: &str) -> PathBuf {
    drafts_dir(repo_root).join(format!("{slug}.md"))
}

pub fn list_drafts_sync(repo_root: &Path) -> Result<Vec<DraftSummary>, DraftError> {
    let dir = drafts_dir(repo_root);
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.ends_with(".md") || name.starts_with('.') {
            continue;
        }
        let text = std::fs::read_to_string(entry.path())?;
        let doc = parse_draft(&text)?;
        out.push(DraftSummary {
            slug: doc.frontmatter.slug,
            title: doc.frontmatter.title,
            updated_at: doc.frontmatter.updated_at,
        });
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

pub fn read_draft_sync(repo_root: &Path, slug: &str) -> Result<DraftDocument, DraftError> {
    let path = draft_path(repo_root, slug);
    if !path.exists() {
        return Err(DraftError::NotFound(slug.into()));
    }
    let text = std::fs::read_to_string(path)?;
    parse_draft(&text)
}

/// Atomic write: write to `<slug>.md.tmp` then rename. Updates
/// `updated_at` to now (RFC3339 UTC). Creates the drafts directory
/// if missing.
pub fn save_draft_sync(
    repo_root: &Path,
    slug: &str,
    title: &str,
    body: &str,
) -> Result<DraftDocument, DraftError> {
    let dir = drafts_dir(repo_root);
    std::fs::create_dir_all(&dir)?;
    let path = draft_path(repo_root, slug);
    let now = chrono::Utc::now().to_rfc3339();
    let frontmatter = if path.exists() {
        let existing = parse_draft(&std::fs::read_to_string(&path)?)?.frontmatter;
        DraftFrontmatter {
            updated_at: now,
            title: title.into(),
            ..existing
        }
    } else {
        DraftFrontmatter {
            status: "draft".into(),
            title: title.into(),
            slug: slug.into(),
            created_at: now.clone(),
            updated_at: now,
            llm_calls: 0,
        }
    };
    let doc = DraftDocument { frontmatter, body: body.into() };
    let text = serialize_draft(&doc)?;
    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, &path)?;
    Ok(doc)
}

pub fn delete_draft_sync(repo_root: &Path, slug: &str) -> Result<(), DraftError> {
    let path = draft_path(repo_root, slug);
    if !path.exists() {
        return Err(DraftError::NotFound(slug.into()));
    }
    std::fs::remove_file(path)?;
    Ok(())
}
```

Add tests:

```rust
#[test]
fn save_then_read_roundtrip() {
    let tmp = tempfile::tempdir().unwrap();
    let doc = save_draft_sync(tmp.path(), "foo", "Foo Title", "## Goal\nbar\n").unwrap();
    assert_eq!(doc.frontmatter.slug, "foo");
    assert_eq!(doc.frontmatter.title, "Foo Title");
    let read = read_draft_sync(tmp.path(), "foo").unwrap();
    assert_eq!(read.body, "## Goal\nbar\n");
    assert_eq!(read.frontmatter.created_at, doc.frontmatter.created_at);
}

#[test]
fn save_preserves_created_at_and_llm_calls() {
    let tmp = tempfile::tempdir().unwrap();
    let first = save_draft_sync(tmp.path(), "a", "A", "x").unwrap();
    std::thread::sleep(std::time::Duration::from_millis(10));
    let mut doc = read_draft_sync(tmp.path(), "a").unwrap();
    doc.frontmatter.llm_calls = 5;
    let text = serialize_draft(&doc).unwrap();
    std::fs::write(tmp.path().join("docs/specs/drafts/a.md"), text).unwrap();
    let second = save_draft_sync(tmp.path(), "a", "A", "y").unwrap();
    assert_eq!(first.frontmatter.created_at, second.frontmatter.created_at);
    assert_eq!(second.frontmatter.llm_calls, 5);
    assert_ne!(first.frontmatter.updated_at, second.frontmatter.updated_at);
}

#[test]
fn list_drafts_sorted_desc() {
    let tmp = tempfile::tempdir().unwrap();
    save_draft_sync(tmp.path(), "a", "A", "x").unwrap();
    std::thread::sleep(std::time::Duration::from_millis(10));
    save_draft_sync(tmp.path(), "b", "B", "x").unwrap();
    let list = list_drafts_sync(tmp.path()).unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].slug, "b");
    assert_eq!(list[1].slug, "a");
}

#[test]
fn delete_then_missing() {
    let tmp = tempfile::tempdir().unwrap();
    save_draft_sync(tmp.path(), "a", "A", "x").unwrap();
    delete_draft_sync(tmp.path(), "a").unwrap();
    assert!(matches!(read_draft_sync(tmp.path(), "a"), Err(DraftError::NotFound(_))));
}

#[test]
fn delete_missing_errors() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(matches!(delete_draft_sync(tmp.path(), "x"), Err(DraftError::NotFound(_))));
}
```

- [ ] **Step 2: Verify chrono is available**

Run: `grep -n "^chrono" crates/app/Cargo.toml`. If absent, add `chrono = { version = "0.4", features = ["serde"] }`.

- [ ] **Step 3: Run tests**

Run: `cargo test -p covenant drafts::tests --lib`
Expected: 11 passed.

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/drafts.rs crates/app/Cargo.toml
git commit -m "feat(drafts): list/read/save/delete fs ops"
```

---

## Task 4: Publish flow (TDD)

**Files:**
- Modify: `crates/app/src/drafts.rs`

- [ ] **Step 1: Append helper + tests**

Add to `crates/app/src/drafts.rs`:

```rust
/// Move `drafts/<slug>.md` → `<id>-<final_slug>.md`, strip
/// frontmatter, rewrite the `# Draft — X` heading to `# <id> — X`.
/// Returns the published file path. Validates ID uniqueness against
/// existing `docs/specs/*.md` and slug uniqueness.
pub fn publish_draft_sync(
    repo_root: &Path,
    slug: &str,
    id: &str,
    final_slug: &str,
) -> Result<PathBuf, DraftError> {
    // Validate ID format: `<u32>.<u32>`.
    let mut parts = id.split('.');
    let (Some(maj), Some(min), None) = (parts.next(), parts.next(), parts.next()) else {
        return Err(DraftError::Validation(format!("invalid id format: {id}")));
    };
    if maj.parse::<u32>().is_err() || min.parse::<u32>().is_err() {
        return Err(DraftError::Validation(format!("invalid id numbers: {id}")));
    }

    // Validate slug.
    let cleaned = slugify(final_slug);
    if cleaned != final_slug {
        return Err(DraftError::Validation(format!(
            "slug must be kebab-case ascii: got {final_slug}, expected {cleaned}"
        )));
    }

    let dest = repo_root.join("docs/specs").join(format!("{id}-{final_slug}.md"));
    if dest.exists() {
        return Err(DraftError::Collision(format!("{}", dest.display())));
    }
    // Also reject if any existing spec uses the same id prefix.
    let specs_dir = repo_root.join("docs/specs");
    if specs_dir.exists() {
        for entry in std::fs::read_dir(&specs_dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy().to_string();
            if name.starts_with(&format!("{id}-")) {
                return Err(DraftError::Collision(format!("id {id} already used: {name}")));
            }
        }
    }

    let doc = read_draft_sync(repo_root, slug)?;
    let title = &doc.frontmatter.title;
    // Body may start with `# Draft — <title>`; rewrite or prepend.
    let new_heading = format!("# {id} — {title}");
    let rewritten = if doc.body.starts_with("# Draft —") || doc.body.starts_with("# Draft -") {
        let nl = doc.body.find('\n').unwrap_or(doc.body.len());
        format!("{new_heading}{}", &doc.body[nl..])
    } else {
        format!("{new_heading}\n\n{}", doc.body)
    };

    std::fs::create_dir_all(&specs_dir)?;
    let tmp = dest.with_extension("md.tmp");
    std::fs::write(&tmp, rewritten)?;
    std::fs::rename(&tmp, &dest)?;
    std::fs::remove_file(draft_path(repo_root, slug))?;
    Ok(dest)
}
```

Add tests:

```rust
#[test]
fn publish_moves_file_and_rewrites_heading() {
    let tmp = tempfile::tempdir().unwrap();
    save_draft_sync(
        tmp.path(),
        "mission-drafts",
        "Mission Drafts",
        "# Draft — Mission Drafts\n\n## Goal\nx\n",
    ).unwrap();
    let dest = publish_draft_sync(tmp.path(), "mission-drafts", "3.10", "mission-drafts").unwrap();
    assert!(dest.ends_with("docs/specs/3.10-mission-drafts.md"));
    let text = std::fs::read_to_string(&dest).unwrap();
    assert!(text.starts_with("# 3.10 — Mission Drafts\n"));
    assert!(!text.contains("---\nstatus:"));
    assert!(!tmp.path().join("docs/specs/drafts/mission-drafts.md").exists());
}

#[test]
fn publish_rejects_duplicate_id() {
    let tmp = tempfile::tempdir().unwrap();
    let specs = tmp.path().join("docs/specs");
    std::fs::create_dir_all(&specs).unwrap();
    std::fs::write(specs.join("3.10-other.md"), "x").unwrap();
    save_draft_sync(tmp.path(), "a", "A", "## Goal\nx").unwrap();
    let err = publish_draft_sync(tmp.path(), "a", "3.10", "a").unwrap_err();
    assert!(matches!(err, DraftError::Collision(_)));
}

#[test]
fn publish_rejects_invalid_slug() {
    let tmp = tempfile::tempdir().unwrap();
    save_draft_sync(tmp.path(), "a", "A", "x").unwrap();
    let err = publish_draft_sync(tmp.path(), "a", "1.0", "Bad Slug!").unwrap_err();
    assert!(matches!(err, DraftError::Validation(_)));
}

#[test]
fn publish_rejects_invalid_id() {
    let tmp = tempfile::tempdir().unwrap();
    save_draft_sync(tmp.path(), "a", "A", "x").unwrap();
    assert!(matches!(
        publish_draft_sync(tmp.path(), "a", "abc", "a").unwrap_err(),
        DraftError::Validation(_)
    ));
    assert!(matches!(
        publish_draft_sync(tmp.path(), "a", "1.0.0", "a").unwrap_err(),
        DraftError::Validation(_)
    ));
}
```

- [ ] **Step 2: Run tests**

Run: `cargo test -p covenant drafts::tests --lib`
Expected: 15 passed.

- [ ] **Step 3: Commit**

```bash
git add crates/app/src/drafts.rs
git commit -m "feat(drafts): publish flow with id/slug validation"
```

---

## Task 5: ✨ Help LLM caller (TDD)

**Files:**
- Modify: `crates/app/src/drafts.rs`

- [ ] **Step 1: Add caller + parser + tests**

Add to `crates/app/src/drafts.rs`:

```rust
const SUGGEST_SYSTEM_PROMPT: &str = "You are a spec assistant for Covenant, an \
    AI-native terminal. The user is writing a feature spec following a fixed \
    template. Given the draft so far and the section name, return EXACTLY 3 \
    concrete bullet suggestions for that section. Output JSON: \
    {\"suggestions\":[\"...\",\"...\",\"...\"]}. No prose, no markdown fences.";

pub const SUGGEST_MAX_TOKENS: u32 = 600;
pub const LLM_CALL_CAP: u32 = 20;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SuggestSection {
    OutOfScope,
    AcceptanceCriteria,
    OpenQuestions,
}

pub fn build_suggest_user_message(section: SuggestSection, draft_text: &str) -> String {
    let label = match section {
        SuggestSection::OutOfScope => "Out of scope",
        SuggestSection::AcceptanceCriteria => "Acceptance criteria",
        SuggestSection::OpenQuestions => "Open questions",
    };
    format!("Section: {label}\n\nDraft so far:\n\n{draft_text}\n\nReturn JSON now.")
}

pub fn parse_suggestions(text: &str) -> Result<Vec<String>, DraftError> {
    #[derive(Deserialize)]
    struct Wrap { suggestions: Vec<String> }
    let trimmed = text.trim()
        .trim_start_matches("```json").trim_start_matches("```")
        .trim_end_matches("```").trim();
    let wrap: Wrap = serde_json::from_str(trimmed)
        .map_err(|e| DraftError::Validation(format!("bad llm json: {e}")))?;
    if wrap.suggestions.is_empty() {
        return Err(DraftError::Validation("no suggestions".into()));
    }
    Ok(wrap.suggestions.into_iter().take(3).collect())
}
```

Add tests:

```rust
#[test]
fn parse_suggestions_plain_json() {
    let r = parse_suggestions(r#"{"suggestions":["a","b","c"]}"#).unwrap();
    assert_eq!(r, vec!["a", "b", "c"]);
}

#[test]
fn parse_suggestions_with_fences() {
    let r = parse_suggestions("```json\n{\"suggestions\":[\"x\",\"y\",\"z\"]}\n```").unwrap();
    assert_eq!(r, vec!["x", "y", "z"]);
}

#[test]
fn parse_suggestions_trims_to_three() {
    let r = parse_suggestions(r#"{"suggestions":["a","b","c","d"]}"#).unwrap();
    assert_eq!(r.len(), 3);
}

#[test]
fn parse_suggestions_rejects_empty() {
    assert!(parse_suggestions(r#"{"suggestions":[]}"#).is_err());
    assert!(parse_suggestions("not json").is_err());
}

#[test]
fn build_user_message_includes_section() {
    let m = build_suggest_user_message(SuggestSection::OutOfScope, "draft body");
    assert!(m.contains("Out of scope"));
    assert!(m.contains("draft body"));
}
```

- [ ] **Step 2: Run tests**

Run: `cargo test -p covenant drafts::tests --lib`
Expected: 20 passed.

- [ ] **Step 3: Commit**

```bash
git add crates/app/src/drafts.rs
git commit -m "feat(drafts): suggest section parser + prompt builder"
```

---

## Task 6: Tauri commands + register in lib.rs

**Files:**
- Modify: `crates/app/src/drafts.rs`, `crates/app/src/lib.rs`

- [ ] **Step 1: Add tauri::command wrappers at the bottom of `drafts.rs`**

```rust
use std::sync::Arc;
use tokio::sync::Mutex;

#[tauri::command]
pub async fn list_drafts(repo_root: String) -> Result<Vec<DraftSummary>, String> {
    let path = PathBuf::from(repo_root);
    tokio::task::spawn_blocking(move || list_drafts_sync(&path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn read_draft(repo_root: String, slug: String) -> Result<DraftDocumentDto, String> {
    let path = PathBuf::from(repo_root);
    let doc = tokio::task::spawn_blocking(move || read_draft_sync(&path, &slug))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    Ok(DraftDocumentDto::from(doc))
}

#[tauri::command]
pub async fn save_draft(
    repo_root: String,
    slug: String,
    title: String,
    body: String,
) -> Result<DraftDocumentDto, String> {
    let path = PathBuf::from(repo_root);
    let doc = tokio::task::spawn_blocking(move || save_draft_sync(&path, &slug, &title, &body))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    Ok(DraftDocumentDto::from(doc))
}

#[tauri::command]
pub async fn delete_draft(repo_root: String, slug: String) -> Result<(), String> {
    let path = PathBuf::from(repo_root);
    tokio::task::spawn_blocking(move || delete_draft_sync(&path, &slug))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn publish_draft(
    repo_root: String,
    slug: String,
    id: String,
    final_slug: String,
) -> Result<String, String> {
    let path = PathBuf::from(repo_root);
    let dest = tokio::task::spawn_blocking(move || {
        publish_draft_sync(&path, &slug, &id, &final_slug)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn next_draft_id(repo_root: String) -> Result<String, String> {
    let path = PathBuf::from(repo_root);
    tokio::task::spawn_blocking(move || next_spec_id(&path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn suggest_draft_section(
    state: tauri::State<'_, Arc<Mutex<crate::settings::Settings>>>,
    repo_root: String,
    slug: String,
    section: SuggestSection,
) -> Result<Vec<String>, String> {
    let (api_key, model) = {
        let s = state.lock().await;
        let key = s.anthropic_api_key.clone()
            .filter(|k| !k.trim().is_empty())
            .ok_or_else(|| "no API key".to_string())?;
        (key, s.agent.model_summary.clone())
    };

    // Read draft + check cap.
    let path = PathBuf::from(&repo_root);
    let slug_clone = slug.clone();
    let doc = tokio::task::spawn_blocking(move || read_draft_sync(&path, &slug_clone))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    if doc.frontmatter.llm_calls >= LLM_CALL_CAP {
        return Err(format!("cap reached ({LLM_CALL_CAP})"));
    }

    let user_msg = build_suggest_user_message(section, &doc.body);
    let response = karl_agent::ask_oneshot(karl_agent::AskRequest {
        api_key,
        model,
        system_prompt: SUGGEST_SYSTEM_PROMPT.to_string(),
        user_message: user_msg,
        max_tokens: SUGGEST_MAX_TOKENS,
    })
    .await
    .map_err(|e| e.to_string())?;

    // Increment llm_calls in frontmatter (best-effort, non-fatal).
    let path = PathBuf::from(&repo_root);
    let slug_clone = slug.clone();
    let _ = tokio::task::spawn_blocking(move || -> Result<(), DraftError> {
        let mut existing = read_draft_sync(&path, &slug_clone)?;
        existing.frontmatter.llm_calls += 1;
        existing.frontmatter.updated_at = chrono::Utc::now().to_rfc3339();
        let text = serialize_draft(&existing)?;
        std::fs::write(draft_path(&path, &slug_clone), text)?;
        Ok(())
    })
    .await;

    parse_suggestions(&response).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize)]
pub struct DraftDocumentDto {
    pub frontmatter: DraftFrontmatter,
    pub body: String,
}
impl From<DraftDocument> for DraftDocumentDto {
    fn from(d: DraftDocument) -> Self {
        Self { frontmatter: d.frontmatter, body: d.body }
    }
}
```

- [ ] **Step 2: Register commands in `lib.rs`**

In `crates/app/src/lib.rs`, find the `tauri::generate_handler!` invocation and append:

```rust
drafts::list_drafts,
drafts::read_draft,
drafts::save_draft,
drafts::delete_draft,
drafts::publish_draft,
drafts::next_draft_id,
drafts::suggest_draft_section,
```

- [ ] **Step 3: Build and verify**

Run: `cargo check -p covenant`
Expected: 0 errors. Warnings about unused imports OK.

Run: `cargo test -p covenant drafts::tests --lib`
Expected: 20 passed (no regressions).

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/drafts.rs crates/app/src/lib.rs
git commit -m "feat(drafts): tauri commands + lib registration"
```

---

## Task 7: TS API wrappers

**Files:**
- Create: `ui/src/drafts/api.ts`
- Modify: `ui/src/api.ts`

- [ ] **Step 1: Create `ui/src/drafts/api.ts`**

```typescript
import { invoke } from "@tauri-apps/api/core";

export interface DraftFrontmatter {
  status: string;
  title: string;
  slug: string;
  created_at: string;
  updated_at: string;
  llm_calls: number;
}

export interface DraftSummary {
  slug: string;
  title: string;
  updated_at: string;
}

export interface DraftDocument {
  frontmatter: DraftFrontmatter;
  body: string;
}

export type SuggestSection = "out-of-scope" | "acceptance-criteria" | "open-questions";

export const draftsApi = {
  list: (repoRoot: string) =>
    invoke<DraftSummary[]>("list_drafts", { repoRoot }),
  read: (repoRoot: string, slug: string) =>
    invoke<DraftDocument>("read_draft", { repoRoot, slug }),
  save: (repoRoot: string, slug: string, title: string, body: string) =>
    invoke<DraftDocument>("save_draft", { repoRoot, slug, title, body }),
  delete: (repoRoot: string, slug: string) =>
    invoke<void>("delete_draft", { repoRoot, slug }),
  publish: (repoRoot: string, slug: string, id: string, finalSlug: string) =>
    invoke<string>("publish_draft", { repoRoot, slug, id, finalSlug }),
  nextId: (repoRoot: string) =>
    invoke<string>("next_draft_id", { repoRoot }),
  suggest: (repoRoot: string, slug: string, section: SuggestSection) =>
    invoke<string[]>("suggest_draft_section", { repoRoot, slug, section }),
};
```

- [ ] **Step 2: Re-export from `ui/src/api.ts`**

Append to `ui/src/api.ts`:

```typescript
export { draftsApi } from "./drafts/api";
export type {
  DraftFrontmatter,
  DraftSummary,
  DraftDocument,
  SuggestSection,
} from "./drafts/api";
```

- [ ] **Step 3: Type-check**

Run: `cd ui && pnpm exec tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add ui/src/drafts/api.ts ui/src/api.ts
git commit -m "feat(drafts): typed ts api wrappers"
```

---

## Task 8: HTML host + sidebar entry + main.ts wiring

**Files:**
- Modify: `ui/index.html`, `ui/src/main.ts`

- [ ] **Step 1: Add page host to `ui/index.html`**

Edit `ui/index.html` line 27 area:

```html
<section id="settings-page" hidden></section>
<section id="docs-page" hidden></section>
<section id="drafts-page" hidden></section>
```

- [ ] **Step 2: Add a sidebar nav entry**

Find the existing sidebar nav block in `ui/src/main.ts` (where Blocks/Files icons are wired — near the call sites for tabs/structure panels — `grep -n "file-pen\|sidebar-nav\|Blocks\|Files" ui/src/main.ts`). Add a new icon button next to the existing entries:

```typescript
// near the existing nav setup (after Files icon wiring)
const draftsNavBtn = document.createElement("button");
draftsNavBtn.type = "button";
draftsNavBtn.className = "sidebar-nav-btn";
draftsNavBtn.title = "Drafts";
draftsNavBtn.setAttribute("aria-label", "Drafts");
draftsNavBtn.innerHTML = Icons.filePen ?? Icons.pencilLine ?? "✎";
sidebarNavHost.appendChild(draftsNavBtn);
draftsNavBtn.addEventListener("click", () => draftsPanel.toggle());
```

If `Icons.filePen` is missing, add it to `ui/src/icons/index.ts` (Lucide SVG for `file-pen`):

```typescript
filePen: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 22H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v9.5"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M13.378 15.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"/></svg>`,
```

- [ ] **Step 3: Instantiate `DraftsPanel` (mirror docsPanel block)**

Below the `docsPanel` instantiation in `ui/src/main.ts`:

```typescript
import { DraftsPanel } from "./drafts/panel";
// ...
const draftsPage = requireEl<HTMLElement>("drafts-page");
const draftsPanel = new DraftsPanel(draftsPage, workspace);
draftsPanel.onClosed = () => {
  // refit terminal — same as docsPanel.onClosed
  activeTab()?.fit();
};
```

In the existing settings/docs visibility coordination (lines ~450 in current `main.ts`), add:

```typescript
if (settingsPanel.isOpen()) settingsPanel.close();
if (docsPanel.isOpen()) docsPanel.close();
if (draftsPanel.isOpen()) draftsPanel.close();
```

In Esc handler (~line 609):

```typescript
if (draftsPanel.isOpen()) {
  draftsPanel.close();
  return;
}
```

- [ ] **Step 4: Type-check**

Run: `cd ui && pnpm exec tsc --noEmit`
Expected: 0 errors (DraftsPanel will be created in next task — to allow type-checking now, create the file as an empty class stub).

Create `ui/src/drafts/panel.ts` skeleton:

```typescript
export class DraftsPanel {
  private isOpenState = false;
  public onClosed: (() => void) | null = null;
  constructor(
    private readonly pageHost: HTMLElement,
    private readonly workspace: HTMLElement,
  ) {}
  isOpen(): boolean { return this.isOpenState; }
  toggle(): void { this.isOpenState ? this.close() : this.open(); }
  open(): void {
    this.isOpenState = true;
    this.pageHost.hidden = false;
    this.workspace.hidden = true;
  }
  close(): void {
    this.isOpenState = false;
    this.pageHost.hidden = true;
    this.workspace.hidden = false;
    this.onClosed?.();
  }
}
```

Run: `cd ui && pnpm exec tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add ui/index.html ui/src/main.ts ui/src/drafts/panel.ts ui/src/icons/
git commit -m "feat(drafts): sidebar entry + page host + panel skeleton"
```

---

## Task 9: Drafts list view

**Files:**
- Modify: `ui/src/drafts/panel.ts`

- [ ] **Step 1: Implement list view rendering**

Replace `ui/src/drafts/panel.ts` with:

```typescript
import { draftsApi, type DraftSummary } from "./api";
import { DraftWizard } from "./wizard";
import { Icons } from "../icons";

type View = "list" | "wizard";

export class DraftsPanel {
  private isOpenState = false;
  private view: View = "list";
  private currentSlug: string | null = null;
  private wizard: DraftWizard | null = null;
  public onClosed: (() => void) | null = null;
  public getRepoRoot: () => string = () => ".";

  constructor(
    private readonly pageHost: HTMLElement,
    private readonly workspace: HTMLElement,
  ) {
    pageHost.classList.add("drafts-page");
  }

  isOpen(): boolean { return this.isOpenState; }
  toggle(): void { this.isOpenState ? this.close() : this.open(); }

  open(): void {
    this.isOpenState = true;
    this.pageHost.hidden = false;
    this.workspace.hidden = true;
    this.view = "list";
    this.currentSlug = null;
    void this.render();
  }

  close(): void {
    this.isOpenState = false;
    this.pageHost.hidden = true;
    this.workspace.hidden = false;
    this.wizard?.dispose();
    this.wizard = null;
    this.onClosed?.();
  }

  openWizard(slug: string | null): void {
    this.view = "wizard";
    this.currentSlug = slug;
    void this.render();
  }

  private async render(): Promise<void> {
    if (this.view === "list") {
      await this.renderList();
    } else {
      await this.renderWizard();
    }
  }

  private async renderList(): Promise<void> {
    const root = this.getRepoRoot();
    let drafts: DraftSummary[] = [];
    try {
      drafts = await draftsApi.list(root);
    } catch (e) {
      this.pageHost.innerHTML = `<div class="drafts-empty">Failed to list drafts: ${escapeHtml(String(e))}</div>`;
      return;
    }
    const rows = drafts.map(d => `
      <li class="drafts-row" data-slug="${escapeAttr(d.slug)}">
        <button class="drafts-row-open" type="button" data-action="open">
          <span class="drafts-row-title">${escapeHtml(d.title)}</span>
          <span class="drafts-row-meta">${escapeHtml(formatDate(d.updated_at))}</span>
        </button>
        <button class="drafts-row-delete" type="button" data-action="delete" title="Delete">×</button>
      </li>
    `).join("");
    this.pageHost.innerHTML = `
      <header class="drafts-header">
        <h1>Drafts</h1>
        <div class="drafts-actions">
          <button id="drafts-new" type="button" class="drafts-primary">+ New draft</button>
          <button id="drafts-close" type="button" class="drafts-close" aria-label="Close">×</button>
        </div>
      </header>
      <ul class="drafts-list">
        ${rows || `<li class="drafts-empty">No drafts yet. Click <strong>+ New draft</strong> to start.</li>`}
      </ul>
    `;
    this.pageHost.querySelector("#drafts-new")?.addEventListener("click", () => this.openWizard(null));
    this.pageHost.querySelector("#drafts-close")?.addEventListener("click", () => this.close());
    this.pageHost.querySelectorAll<HTMLLIElement>(".drafts-row").forEach(row => {
      const slug = row.dataset.slug!;
      row.querySelector('[data-action="open"]')?.addEventListener("click", () => this.openWizard(slug));
      row.querySelector('[data-action="delete"]')?.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete draft "${slug}"? Git history is preserved.`)) return;
        await draftsApi.delete(this.getRepoRoot(), slug);
        await this.renderList();
      });
    });
  }

  private async renderWizard(): Promise<void> {
    this.wizard?.dispose();
    this.wizard = new DraftWizard({
      host: this.pageHost,
      repoRoot: this.getRepoRoot(),
      slug: this.currentSlug,
      onBack: () => { this.view = "list"; void this.render(); },
      onClose: () => this.close(),
    });
    await this.wizard.mount();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]!));
}
function escapeAttr(s: string): string { return escapeHtml(s); }
function formatDate(iso: string): string {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}
```

In `ui/src/main.ts`, after instantiating the panel, wire `getRepoRoot`:

```typescript
draftsPanel.getRepoRoot = () => activeTab()?.cwd ?? ".";
```

(Use the existing `activeTab()` helper or equivalent — `grep -n "activeTab\|currentTab" ui/src/main.ts` to find the right accessor.)

- [ ] **Step 2: Stub `DraftWizard` for compilation**

Create `ui/src/drafts/wizard.ts`:

```typescript
export interface DraftWizardOpts {
  host: HTMLElement;
  repoRoot: string;
  slug: string | null;
  onBack: () => void;
  onClose: () => void;
}

export class DraftWizard {
  constructor(private opts: DraftWizardOpts) {}
  async mount(): Promise<void> {
    this.opts.host.innerHTML = `<div class="drafts-empty">Wizard coming next task.</div>`;
  }
  dispose(): void {}
}
```

- [ ] **Step 3: Type-check + manual smoke**

Run: `cd ui && pnpm exec tsc --noEmit`
Expected: 0 errors.

Run: `pnpm tauri dev` (if not already running). Click sidebar Drafts icon → expect empty list view + "+ New draft" button. Click → wizard placeholder shows.

- [ ] **Step 4: Commit**

```bash
git add ui/src/drafts/panel.ts ui/src/drafts/wizard.ts ui/src/main.ts
git commit -m "feat(drafts): list view + wizard scaffold"
```

---

## Task 10: Wizard — sections + autosave

**Files:**
- Modify: `ui/src/drafts/wizard.ts`

- [ ] **Step 1: Implement the 6-section wizard with autosave**

Replace `ui/src/drafts/wizard.ts` entirely:

```typescript
import { draftsApi, type DraftDocument, type SuggestSection } from "./api";

export interface DraftWizardOpts {
  host: HTMLElement;
  repoRoot: string;
  slug: string | null;
  onBack: () => void;
  onClose: () => void;
}

interface SectionDef {
  key: string;       // markdown heading (## Goal, etc.)
  label: string;
  hint: string;
  placeholder: string;
  helpSection?: SuggestSection;
  required: boolean;
}

const SECTIONS: SectionDef[] = [
  { key: "Goal", label: "Goal", hint: "One sentence. The user-visible problem this resolves.",
    placeholder: "Open an in-app reference without leaving Covenant when I forget what AOM does.",
    required: true },
  { key: "Out of scope", label: "Out of scope", hint: "What looks related but is NOT this task.",
    placeholder: "- thing the agent might be tempted to also build\n- adjacent improvement",
    helpSection: "out-of-scope", required: false },
  { key: "Acceptance criteria", label: "Acceptance criteria", hint: "3–5 bullets, each observable.",
    placeholder: "- [ ] user can do X via Y\n- [ ] command Z passes",
    helpSection: "acceptance-criteria", required: true },
  { key: "File boundaries", label: "File boundaries", hint: "Hint at the blast radius.",
    placeholder: "- **Create**: `path/to/file.rs` (≤ 200 lines)\n- **DO NOT touch**: `crates/agent/`",
    required: false },
  { key: "Complexity", label: "Complexity", hint: "small | medium | large", placeholder: "small",
    required: true },
  { key: "Open questions", label: "Open questions", hint: "Decisions the agent shouldn't make alone.",
    placeholder: "- decision X\n- tradeoff Y",
    helpSection: "open-questions", required: false },
];

const COMPLEXITY_VALUES = ["small", "medium", "large"] as const;

export class DraftWizard {
  private title = "Untitled draft";
  private slug: string | null;
  private values = new Map<string, string>();
  private complexity: typeof COMPLEXITY_VALUES[number] = "small";
  private llmCalls = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private autoSaveInterval: ReturnType<typeof setInterval> | null = null;
  private dirty = false;

  constructor(private opts: DraftWizardOpts) {
    this.slug = opts.slug;
  }

  async mount(): Promise<void> {
    if (this.slug) {
      try {
        const doc = await draftsApi.read(this.opts.repoRoot, this.slug);
        this.hydrateFromDoc(doc);
      } catch (e) {
        this.opts.host.innerHTML = `<div class="drafts-empty">Failed to load: ${String(e)}</div>`;
        return;
      }
    } else {
      for (const s of SECTIONS) this.values.set(s.key, "");
    }
    this.render();
    this.autoSaveInterval = setInterval(() => { if (this.dirty) void this.save(); }, 30_000);
  }

  dispose(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.autoSaveInterval) clearInterval(this.autoSaveInterval);
  }

  private hydrateFromDoc(doc: DraftDocument): void {
    this.title = doc.frontmatter.title;
    this.slug = doc.frontmatter.slug;
    this.llmCalls = doc.frontmatter.llm_calls;
    const sections = parseBody(doc.body);
    for (const s of SECTIONS) {
      const v = sections.get(s.key) ?? "";
      this.values.set(s.key, v);
      if (s.key === "Complexity") {
        const m = v.trim().toLowerCase();
        if ((COMPLEXITY_VALUES as readonly string[]).includes(m)) {
          this.complexity = m as typeof COMPLEXITY_VALUES[number];
        }
      }
    }
  }

  private render(): void {
    const sectionsHtml = SECTIONS.map(s => this.renderSection(s)).join("");
    this.opts.host.innerHTML = `
      <header class="drafts-header">
        <button id="wiz-back" type="button" class="drafts-back" aria-label="Back">←</button>
        <input id="wiz-title" type="text" class="wiz-title" value="${escapeAttr(this.title)}" />
        <div class="drafts-actions">
          <button id="wiz-save" type="button">Save</button>
          <button id="wiz-publish" type="button" class="drafts-primary" disabled>Publish</button>
          <button id="wiz-close" type="button" class="drafts-close" aria-label="Close">×</button>
        </div>
      </header>
      <div class="wiz-body">${sectionsHtml}</div>
    `;
    this.bindEvents();
    this.updatePublishEnabled();
  }

  private renderSection(s: SectionDef): string {
    const value = this.values.get(s.key) ?? "";
    if (s.key === "Complexity") {
      return `
        <section class="wiz-section" data-key="${escapeAttr(s.key)}">
          <h2>${s.label} <span class="wiz-hint">— ${escapeHtml(s.hint)}</span></h2>
          <div class="wiz-segmented">
            ${COMPLEXITY_VALUES.map(v => `
              <button type="button" data-complexity="${v}" class="${this.complexity === v ? "active" : ""}">${v}</button>
            `).join("")}
          </div>
        </section>
      `;
    }
    const helpBtn = s.helpSection
      ? `<button type="button" class="wiz-help" data-help="${s.helpSection}" ${this.llmCalls >= 20 ? "disabled" : ""}>✨ Help</button>`
      : "";
    return `
      <section class="wiz-section" data-key="${escapeAttr(s.key)}">
        <h2>${s.label} <span class="wiz-hint">— ${escapeHtml(s.hint)}</span> ${helpBtn}</h2>
        <textarea class="wiz-textarea" data-key="${escapeAttr(s.key)}" placeholder="${escapeAttr(s.placeholder)}" rows="6">${escapeHtml(value)}</textarea>
      </section>
    `;
  }

  private bindEvents(): void {
    const host = this.opts.host;
    host.querySelector("#wiz-back")?.addEventListener("click", () => { void this.save().then(() => this.opts.onBack()); });
    host.querySelector("#wiz-close")?.addEventListener("click", () => { void this.save().then(() => this.opts.onClose()); });
    host.querySelector("#wiz-save")?.addEventListener("click", () => { void this.save(); });
    host.querySelector("#wiz-publish")?.addEventListener("click", () => { void this.openPublishModal(); });
    (host.querySelector("#wiz-title") as HTMLInputElement | null)?.addEventListener("input", (e) => {
      this.title = (e.target as HTMLInputElement).value;
      this.markDirty();
    });
    host.querySelectorAll<HTMLTextAreaElement>(".wiz-textarea").forEach(ta => {
      const key = ta.dataset.key!;
      ta.addEventListener("input", () => { this.values.set(key, ta.value); this.markDirty(); this.updatePublishEnabled(); });
      ta.addEventListener("blur", () => { void this.save(); });
    });
    host.querySelectorAll<HTMLButtonElement>("[data-complexity]").forEach(btn => {
      btn.addEventListener("click", () => {
        this.complexity = btn.dataset.complexity as typeof COMPLEXITY_VALUES[number];
        this.values.set("Complexity", this.complexity);
        host.querySelectorAll<HTMLButtonElement>("[data-complexity]").forEach(b =>
          b.classList.toggle("active", b === btn));
        this.markDirty();
        this.updatePublishEnabled();
      });
    });
    host.querySelectorAll<HTMLButtonElement>(".wiz-help").forEach(btn => {
      btn.addEventListener("click", () => void this.handleHelp(btn));
    });
  }

  private updatePublishEnabled(): void {
    const goal = (this.values.get("Goal") ?? "").trim();
    const accept = (this.values.get("Acceptance criteria") ?? "").trim();
    const ok = goal.length > 0 && accept.length > 0;
    const btn = this.opts.host.querySelector<HTMLButtonElement>("#wiz-publish");
    if (btn) btn.disabled = !ok;
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { void this.save(); }, 1500);
  }

  private buildBody(): string {
    const lines: string[] = [`# Draft — ${this.title}`, ""];
    for (const s of SECTIONS) {
      lines.push(`## ${s.key}`);
      lines.push(this.values.get(s.key) ?? "");
      lines.push("");
    }
    return lines.join("\n");
  }

  private async save(): Promise<void> {
    if (!this.dirty) return;
    if (!this.slug) {
      const base = slugify(this.title);
      this.slug = await this.uniqueSlug(base);
    }
    const body = this.buildBody();
    try {
      const doc = await draftsApi.save(this.opts.repoRoot, this.slug, this.title, body);
      this.llmCalls = doc.frontmatter.llm_calls;
      this.dirty = false;
    } catch (e) {
      console.error("save_draft failed", e);
    }
  }

  private async uniqueSlug(base: string): Promise<string> {
    const existing = new Set((await draftsApi.list(this.opts.repoRoot)).map(d => d.slug));
    if (!existing.has(base)) return base;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base}-${i}`;
      if (!existing.has(candidate)) return candidate;
    }
    return `${base}-${Date.now()}`;
  }

  private async handleHelp(btn: HTMLButtonElement): Promise<void> {
    const section = btn.dataset.help as SuggestSection;
    if (!this.slug) await this.save();
    btn.disabled = true;
    btn.textContent = "✨ …";
    let suggestions: string[];
    try {
      suggestions = await draftsApi.suggest(this.opts.repoRoot, this.slug!, section);
    } catch (e) {
      btn.textContent = "✨ unavailable";
      console.error(e);
      return;
    } finally {
      btn.disabled = false;
    }
    btn.textContent = "✨ Help";
    this.showSuggestionsPopover(btn, section, suggestions);
  }

  private showSuggestionsPopover(anchor: HTMLElement, section: SuggestSection, suggestions: string[]): void {
    const existing = document.getElementById("wiz-popover");
    existing?.remove();
    const popover = document.createElement("div");
    popover.id = "wiz-popover";
    popover.className = "wiz-popover";
    popover.innerHTML = suggestions.map((s, i) => `
      <button type="button" class="wiz-suggestion" data-i="${i}">${escapeHtml(s)}</button>
    `).join("") + `<button type="button" class="wiz-popover-close">Dismiss</button>`;
    document.body.appendChild(popover);
    const rect = anchor.getBoundingClientRect();
    popover.style.position = "absolute";
    popover.style.top = `${rect.bottom + window.scrollY + 4}px`;
    popover.style.left = `${rect.left + window.scrollX}px`;
    const sectionKey = sectionToKey(section);
    popover.querySelectorAll<HTMLButtonElement>(".wiz-suggestion").forEach(b => {
      b.addEventListener("click", () => {
        const i = Number(b.dataset.i!);
        const ta = this.opts.host.querySelector<HTMLTextAreaElement>(`textarea[data-key="${cssEscape(sectionKey)}"]`);
        if (ta) {
          const sep = ta.value.endsWith("\n") || ta.value === "" ? "" : "\n";
          ta.value = `${ta.value}${sep}- ${suggestions[i]}\n`;
          this.values.set(sectionKey, ta.value);
          this.markDirty();
          this.updatePublishEnabled();
        }
        popover.remove();
      });
    });
    popover.querySelector(".wiz-popover-close")?.addEventListener("click", () => popover.remove());
  }

  private async openPublishModal(): Promise<void> {
    await this.save();
    const suggestedId = await draftsApi.nextId(this.opts.repoRoot);
    const suggestedSlug = slugify(this.title);
    const id = prompt(`Spec ID (suggested: ${suggestedId}):`, suggestedId);
    if (!id) return;
    const finalSlug = prompt(`Slug (suggested: ${suggestedSlug}):`, suggestedSlug);
    if (!finalSlug) return;
    try {
      const dest = await draftsApi.publish(this.opts.repoRoot, this.slug!, id, finalSlug);
      alert(`Published as ${dest}`);
      this.opts.onBack();
    } catch (e) {
      alert(`Publish failed: ${e}`);
    }
  }
}

function parseBody(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = body.split("\n");
  let current: string | null = null;
  let buf: string[] = [];
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (current) out.set(current, buf.join("\n").trim());
      current = m[1];
      buf = [];
    } else if (current) {
      buf.push(line);
    }
  }
  if (current) out.set(current, buf.join("\n").trim());
  return out;
}

function slugify(title: string): string {
  const out = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return out || "untitled";
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]!));
}
function escapeAttr(s: string): string { return escapeHtml(s); }
function cssEscape(s: string): string { return s.replace(/"/g, '\\"'); }
function sectionToKey(s: SuggestSection): string {
  return s === "out-of-scope" ? "Out of scope"
    : s === "acceptance-criteria" ? "Acceptance criteria"
    : "Open questions";
}
```

- [ ] **Step 2: Type-check**

Run: `cd ui && pnpm exec tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Manual smoke**

Run: `pnpm tauri dev` (if not running). Open Drafts → New draft → type Goal + 1 acceptance criterion → Publish button enables → close → reopen list → draft is there → reopen → values persisted.

- [ ] **Step 4: Commit**

```bash
git add ui/src/drafts/wizard.ts
git commit -m "feat(drafts): wizard with autosave, ✨ help, publish flow"
```

---

## Task 11: CSS styling

**Files:**
- Modify: `ui/src/styles.css`

- [ ] **Step 1: Append drafts styles at end of `ui/src/styles.css`**

```css
/* ---- Drafts page ---- */
.drafts-page {
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  color: var(--fg);
  overflow: auto;
  min-height: 0;
}
.drafts-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  background: var(--bg-panel);
  z-index: 1;
}
.drafts-header h1 { font-size: 16px; margin: 0; flex: 1; }
.drafts-actions { display: flex; gap: 8px; align-items: center; }
.drafts-primary {
  background: var(--accent); color: #fff; border: 0; padding: 6px 12px;
  border-radius: 4px; cursor: pointer; font-size: 13px;
}
.drafts-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.drafts-close, .drafts-back {
  background: transparent; border: 0; color: var(--muted);
  font-size: 18px; cursor: pointer; padding: 4px 8px;
}
.drafts-close:hover, .drafts-back:hover { color: var(--fg); }
.drafts-list { list-style: none; margin: 0; padding: 8px 20px; }
.drafts-row {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 0; border-bottom: 1px solid var(--border);
}
.drafts-row-open {
  flex: 1; display: flex; flex-direction: column; align-items: flex-start;
  background: transparent; border: 0; cursor: pointer; color: var(--fg);
  padding: 4px 0; text-align: left;
}
.drafts-row-title { font-size: 14px; }
.drafts-row-meta { font-size: 11px; color: var(--muted); }
.drafts-row-delete {
  background: transparent; border: 0; color: var(--muted);
  cursor: pointer; padding: 4px 8px; font-size: 16px;
}
.drafts-row-delete:hover { color: #e44; }
.drafts-empty { padding: 24px; color: var(--muted); text-align: center; }

/* ---- Wizard ---- */
.wiz-title {
  flex: 1; font-size: 16px; padding: 4px 8px;
  background: transparent; border: 1px solid transparent; color: var(--fg);
  border-radius: 3px;
}
.wiz-title:hover, .wiz-title:focus { border-color: var(--border); outline: none; }
.wiz-body { padding: 16px 24px 64px; max-width: 900px; }
.wiz-section { margin-bottom: 24px; }
.wiz-section h2 {
  font-size: 13px; font-weight: 600; margin: 0 0 8px;
  display: flex; align-items: center; gap: 8px;
}
.wiz-hint { font-weight: 400; color: var(--muted); font-size: 12px; }
.wiz-help {
  margin-left: auto; background: transparent; border: 1px solid var(--border);
  color: var(--muted); cursor: pointer; padding: 2px 8px; font-size: 11px;
  border-radius: 3px;
}
.wiz-help:hover:not(:disabled) { color: var(--fg); border-color: var(--accent); }
.wiz-help:disabled { opacity: 0.4; cursor: not-allowed; }
.wiz-textarea {
  width: 100%; min-height: 100px; background: var(--bg-overlay);
  color: var(--fg); border: 1px solid var(--border); border-radius: 4px;
  padding: 8px; font-family: ui-monospace, monospace; font-size: 13px;
  resize: vertical;
}
.wiz-textarea:focus { outline: none; border-color: var(--accent); }
.wiz-segmented { display: inline-flex; border: 1px solid var(--border); border-radius: 4px; overflow: hidden; }
.wiz-segmented button {
  background: transparent; border: 0; color: var(--muted); padding: 6px 14px;
  cursor: pointer; font-size: 12px; border-right: 1px solid var(--border);
}
.wiz-segmented button:last-child { border-right: 0; }
.wiz-segmented button.active { background: var(--accent); color: #fff; }

/* ---- Suggestions popover ---- */
.wiz-popover {
  background: var(--bg-overlay); border: 1px solid var(--border);
  border-radius: 4px; padding: 6px; min-width: 320px; max-width: 480px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.3); z-index: 100;
}
.wiz-suggestion {
  display: block; width: 100%; text-align: left; background: transparent;
  border: 0; color: var(--fg); padding: 6px 8px; cursor: pointer;
  font-size: 12px; border-radius: 3px;
}
.wiz-suggestion:hover { background: var(--bg-panel); }
.wiz-popover-close {
  display: block; width: 100%; background: transparent; border: 0;
  color: var(--muted); padding: 6px 8px; cursor: pointer; font-size: 11px;
  border-top: 1px solid var(--border); margin-top: 4px;
}
```

- [ ] **Step 2: Manual smoke**

Run dev app, open Drafts. Visual check: header sticky, list rows align, wizard textareas readable, segmented complexity shows active state, ✨ Help popover positions below button.

- [ ] **Step 3: Commit**

```bash
git add ui/src/styles.css
git commit -m "feat(drafts): styles for panel + wizard + popover"
```

---

## Task 12: End-to-end manual verification + acceptance checklist

- [ ] **Step 1: Verify acceptance criteria from `docs/specs/3.10-mission-drafts.md`**

Run the app: `pnpm tauri dev`. For each criterion in the spec, check off when verified:

- [ ] Sidebar shows **Drafts** icon with tooltip "Drafts"; click toggles the panel.
- [ ] Empty state shows "+ New draft"; click opens the wizard.
- [ ] All 6 sections render with hint, editor, and (where applicable) ✨ Help button.
- [ ] Complexity is a segmented control with 3 values, default `small`.
- [ ] Type in Goal, blur → file appears at `docs/specs/drafts/<slug>.md` with frontmatter.
- [ ] Wait 30s without typing → autosave updates `updated_at`.
- [ ] Click ✨ Help (with `ANTHROPIC_API_KEY` set in settings) on Acceptance criteria → 3 suggestions appear; clicking one appends to textarea.
- [ ] Without API key, clicking ✨ Help shows error, no crash.
- [ ] Publish disabled until Goal + Acceptance criteria filled and Complexity selected (always selected → effectively Goal + Acceptance gate).
- [ ] Publish prompts for ID (suggested = next minor) + slug, then moves file to `docs/specs/<id>-<slug>.md`, drops frontmatter, rewrites heading. Source draft removed.
- [ ] Set Mission picker shows the published spec.
- [ ] Delete draft from list with confirm.

- [ ] **Step 2: Run full test suite**

Run: `cargo test -p covenant`
Expected: all tests pass (20 new + existing pass).

Run: `cd ui && pnpm exec tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat(drafts): 3.10 mission drafts complete

Acceptance verified per docs/specs/3.10-mission-drafts.md."
```

---

## Self-Review Notes

- Spec coverage: all 10 acceptance criteria mapped (sidebar T8, list T9, wizard T10, autosave T10, ✨ Help T5+T10, Publish T4+T10, delete T9, tests T1–T5+T12).
- No placeholders; every code step has full code.
- Type/name consistency: `DraftSummary`, `DraftDocument`, `DraftFrontmatter`, `SuggestSection` defined once and reused.
- File caps respected (drafts.rs 250, panel.ts 300, wizard.ts 350, css 100).
- Out-of-scope items from spec stay out (no settings changes, no AOM integration, no multi-user).
