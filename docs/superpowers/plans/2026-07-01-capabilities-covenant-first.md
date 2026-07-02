# Capabilities Covenant-First Reframe — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reframe the Capabilities panel so Covenant is the elevated source of truth (default landing) and each executor shows a synced / stale / not-projected badge, without removing per-executor editing.

**Architecture:** A new read-only `karl_cdlc::projection_status(repo)` recomputes what each executor's projected files *should* contain — reusing the exact content helpers `project()` already uses (`strip_covenant_block`, `ensure_frontmatter`, a newly-extracted `managed_body`) — and compares to disk, returning per-tool state. A thin Tauri command exposes it; the panel calls it in `refresh()`, splits the nav into SOURCE (Covenant) / PROJECTIONS (executors + badges), and turns the existing banner into a status header. No projection *write* semantics change.

**Tech Stack:** Rust (`karl-cdlc` crate, Tauri command in `covenant` crate), TypeScript (`ui/src/capabilities/panel.ts`, `ui/src/api.ts`), CSS.

## Global Constraints

- No new dependencies (ponytail: reuse stdlib + existing helpers only).
- All user-facing copy in English.
- No `unwrap()` outside `#[cfg(test)]`.
- Theme-aware CSS tokens only: `--ok` (synced), `--running` (stale/amber), `--muted` (not-projected). No hard-coded hex.
- The group-scoped `ui/src/cdlc/panel.ts` (`CdlcPanel`) is OUT OF SCOPE — do not touch it.
- Projection targets by tool (for status): `claude` → `.claude/agents/*.md` + `.claude/skills/cdlc-*/SKILL.md`; `opencode` → `.opencode/agent/*.md` + shared `AGENTS.md` block; `pi` → `.pi/skills/cdlc-*/SKILL.md`; `codex` → `AGENTS.md` block; `copilot` → `.github/copilot-instructions.md` block. `codex` and `opencode` share `AGENTS.md`'s block state (documented caveat, not a bug).

---

### Task 1: `projection_status` in the CDLC crate

**Files:**
- Modify: `crates/cdlc/src/project.rs` (extract `managed_body`; add types + `projection_status` + helpers + tests)
- Modify: `crates/cdlc/src/lib.rs:11` (export new symbols)

**Interfaces:**
- Consumes: existing module-private `strip_covenant_block`, `ensure_frontmatter`, `body_after_frontmatter`, `parse_summary`, `upsert_block`, `read_dir_md`, `START`, and `crate::{cdlc_dir, read_manifest}`.
- Produces:
  - `pub fn projection_status(repo_root: &Path) -> Result<ProjectionStatus, CdlcError>`
  - `pub struct ProjectionStatus { pub executors: Vec<ExecutorStatus>, pub source_edited_unix: Option<u64> }`
  - `pub struct ExecutorStatus { pub tool: String, pub state: ProjState }`
  - `pub enum ProjState { Synced, Stale, NotProjected }` (serde `snake_case` → `"synced" | "stale" | "not_projected"`)

- [ ] **Step 1: Extract `managed_body` helper (pure refactor, no behavior change)**

In `crates/cdlc/src/project.rs`, add this function just above `pub fn project`:

```rust
/// Build the concatenated managed-block body shared by codex/copilot/hermes.
/// Returns `None` when there is nothing to project (block should be absent).
/// Extracted from `project_with_active` so `projection_status` reuses the exact
/// same generator (ponytail: one source of truth for the block string).
fn managed_body(
    active_agent: Option<&str>,
    agents: &[(String, String)],
    skills: &[(String, String, String)],
    contexts: &[(String, String)],
) -> Option<String> {
    let mut sections: Vec<String> = Vec::new();
    if let Some(name) = active_agent {
        if let Some((stem, raw)) = agents.iter().find(|(s, _)| s == name) {
            sections.push(format!(
                "## {stem} (operator)\n\n{}",
                body_after_frontmatter(raw).trim()
            ));
        }
    }
    for (name, v, body) in skills {
        sections.push(format!("## {name} v{v}\n\n{}", body.trim()));
    }
    for (stem, raw) in contexts {
        if let Some(sum) = parse_summary(raw) {
            sections.push(format!("## {stem} (context)\n\n{sum}"));
        }
    }
    if sections.is_empty() {
        return None;
    }
    Some(format!(
        "# CDLC context (auto-generated — do not edit inside this block)\n\n{}",
        sections.join("\n\n")
    ))
}
```

- [ ] **Step 2: Rewrite the managed-block section of `project_with_active` to call `managed_body`**

In `project_with_active`, replace everything from `// Managed-block executors (codex, copilot): one concatenated block.` down to the final `Ok(())` (the block that builds `sections`, checks `sections.is_empty()`, strips, and upserts) with:

```rust
    // Managed-block executors (codex, copilot): one concatenated block.
    match managed_body(active_agent, &agents, &skills, &contexts) {
        None => {
            // `.hermes.md` is stripped only if present (the loop guards on exists).
            for rel in ["AGENTS.md", ".github/copilot-instructions.md", ".hermes.md"] {
                let path = repo_root.join(rel);
                if path.exists() {
                    let existing = std::fs::read_to_string(&path)?;
                    std::fs::write(&path, strip_block(&existing))?;
                }
            }
        }
        Some(body) => {
            // codex + opencode read AGENTS.md; copilot reads its own file.
            for rel in ["AGENTS.md", ".github/copilot-instructions.md"] {
                upsert_file(repo_root, rel, &body)?;
            }
            // Hermes reads AGENTS.md, but a project-local `.hermes.md` shadows it.
            // Mirror the block into `.hermes.md` only when it already exists.
            if repo_root.join(".hermes.md").exists() {
                upsert_file(repo_root, ".hermes.md", &body)?;
            }
        }
    }
    Ok(())
}
```

- [ ] **Step 3: Run the existing crate tests to confirm the refactor is behavior-preserving**

Run: `cargo test -p karl-cdlc`
Expected: PASS (all existing `project::tests` still green — `managed_block_includes_active_agent_and_context_summary`, `project_strips_block_when_everything_empty`, `project_mirrors_block_into_existing_hermes_md_only`, etc.).

- [ ] **Step 4: Write the failing `projection_status` tests**

Add to the `mod tests` block at the bottom of `crates/cdlc/src/project.rs`:

```rust
    #[test]
    fn projection_status_reports_synced_stale_and_not_projected() {
        let base = std::env::temp_dir().join(format!("cdlc-status-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let repo = base.clone();

        // One agent source + one context source, empty skills manifest.
        let adir = crate::cdlc_dir(&repo).join("agents");
        std::fs::create_dir_all(&adir).unwrap();
        std::fs::write(
            adir.join("kyc-reviewer.md"),
            "---\nname: kyc-reviewer\ncovenant:\n  voice: formal\n---\nReview KYC.\n",
        )
        .unwrap();
        let cdir = crate::cdlc_dir(&repo).join("context");
        std::fs::create_dir_all(&cdir).unwrap();
        std::fs::write(cdir.join("sbs.md"), "---\nsummary: Cite SBS.\n---\n# SBS\nfull\n").unwrap();
        write_manifest(&repo, &CdlcManifest { version: 1, installed: vec![] }).unwrap();

        // Before projecting: everything is not_projected.
        let st = projection_status(&repo).unwrap();
        let state = |tool: &str| st.executors.iter().find(|e| e.tool == tool).unwrap().state.clone();
        assert_eq!(state("claude"), ProjState::NotProjected);
        assert_eq!(state("codex"), ProjState::NotProjected);
        assert!(st.source_edited_unix.is_some(), "sources exist → mtime present");

        // After projecting: everything the sources touch is synced.
        project(&repo).unwrap();
        let st = projection_status(&repo).unwrap();
        let state = |tool: &str| st.executors.iter().find(|e| e.tool == tool).unwrap().state.clone();
        assert_eq!(state("claude"), ProjState::Synced);
        assert_eq!(state("opencode"), ProjState::Synced);
        assert_eq!(state("codex"), ProjState::Synced);
        assert_eq!(state("copilot"), ProjState::Synced);
        // pi has no skills (empty manifest) and gets nothing → not_projected.
        assert_eq!(state("pi"), ProjState::NotProjected);

        // Hand-edit Claude's projected agent file → claude goes stale, others stay synced.
        std::fs::write(repo.join(".claude/agents/kyc-reviewer.md"), "tampered\n").unwrap();
        let st = projection_status(&repo).unwrap();
        let state = |tool: &str| st.executors.iter().find(|e| e.tool == tool).unwrap().state.clone();
        assert_eq!(state("claude"), ProjState::Stale);
        assert_eq!(state("codex"), ProjState::Synced);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn projection_status_empty_repo_all_not_projected() {
        let base = std::env::temp_dir().join(format!("cdlc-status-empty-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let repo = base.clone();
        write_manifest(&repo, &CdlcManifest { version: 1, installed: vec![] }).unwrap();

        let st = projection_status(&repo).unwrap();
        assert!(st.executors.iter().all(|e| e.state == ProjState::NotProjected));
        assert_eq!(st.source_edited_unix, None);

        let _ = std::fs::remove_dir_all(&base);
    }
```

- [ ] **Step 5: Run the new tests to verify they fail**

Run: `cargo test -p karl-cdlc projection_status`
Expected: FAIL — `cannot find function projection_status` / `cannot find type ProjState`.

- [ ] **Step 6: Implement the types + `projection_status` + helpers**

Add near the top of `crates/cdlc/src/project.rs` (after the `use` line), the public types:

```rust
/// Sync state of one executor's projected files versus the current CDLC sources.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjState {
    Synced,
    Stale,
    NotProjected,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ExecutorStatus {
    pub tool: String,
    pub state: ProjState,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ProjectionStatus {
    pub executors: Vec<ExecutorStatus>,
    /// Newest mtime (unix secs) under `.covenant/cdlc/`, or `None` if no sources.
    pub source_edited_unix: Option<u64>,
}
```

Then add, just below `managed_body`:

```rust
#[derive(Clone, Copy, PartialEq)]
enum Check {
    Missing,
    Match,
    Differ,
}

fn check_file(path: &Path, expected: &str) -> Check {
    match std::fs::read_to_string(path) {
        Ok(actual) if actual == expected => Check::Match,
        Ok(_) => Check::Differ,
        Err(_) => Check::Missing,
    }
}

/// A managed-block file is synced iff re-upserting the current body is a no-op.
/// `body == None` means the block should be absent.
fn check_managed(path: &Path, body: Option<&str>) -> Check {
    let existing = std::fs::read_to_string(path);
    match (body, existing) {
        (Some(b), Ok(cur)) => {
            if !cur.contains(START) {
                Check::Missing
            } else if upsert_block(&cur, b) == cur {
                Check::Match
            } else {
                Check::Differ
            }
        }
        (Some(_), Err(_)) => Check::Missing,
        (None, Ok(cur)) => {
            if cur.contains(START) {
                Check::Differ
            } else {
                Check::Match
            }
        }
        (None, Err(_)) => Check::Match,
    }
}

fn aggregate(checks: &[Check]) -> ProjState {
    if checks.is_empty() || checks.iter().all(|c| *c == Check::Missing) {
        return ProjState::NotProjected;
    }
    if checks.iter().all(|c| *c == Check::Match) {
        return ProjState::Synced;
    }
    ProjState::Stale
}

/// Newest mtime (unix secs) of any file under `.covenant/cdlc/`.
fn newest_source_mtime(repo_root: &Path) -> Option<u64> {
    fn walk(dir: &Path, newest: &mut u64) {
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, newest);
                } else if let Ok(m) = e.metadata() {
                    if let Ok(mt) = m.modified() {
                        if let Ok(d) = mt.duration_since(std::time::UNIX_EPOCH) {
                            *newest = (*newest).max(d.as_secs());
                        }
                    }
                }
            }
        }
    }
    let dir = cdlc_dir(repo_root);
    if !dir.exists() {
        return None;
    }
    let mut newest = 0u64;
    walk(&dir, &mut newest);
    (newest > 0).then_some(newest)
}

/// Read-only: compare each executor's projected files against what `project()`
/// would currently write, without touching disk. Reuses the same content
/// helpers as projection, so "synced" means byte-identical to a fresh project.
pub fn projection_status(repo_root: &Path) -> Result<ProjectionStatus, CdlcError> {
    const TOOLS: [&str; 5] = ["claude", "opencode", "pi", "codex", "copilot"];

    let manifest = read_manifest(repo_root)?;
    let skills_dir = cdlc_dir(repo_root).join("skills");
    let agents = read_dir_md(&cdlc_dir(repo_root).join("agents"))?;
    let contexts = read_dir_md(&cdlc_dir(repo_root).join("context"))?;
    let mut skills: Vec<(String, String, String)> = Vec::new();
    for i in &manifest.installed {
        let md = skills_dir.join(&i.name).join("SKILL.md");
        skills.push((i.name.clone(), i.version.clone(), std::fs::read_to_string(&md)?));
    }

    // No sources at all → nothing is projected anywhere.
    if agents.is_empty() && skills.is_empty() && contexts.is_empty() {
        return Ok(ProjectionStatus {
            executors: TOOLS
                .iter()
                .map(|t| ExecutorStatus { tool: t.to_string(), state: ProjState::NotProjected })
                .collect(),
            source_edited_unix: None,
        });
    }

    // Expected file-per-item content: (tool, absolute path, expected bytes).
    let mut files: Vec<(&str, std::path::PathBuf, String)> = Vec::new();
    for (stem, raw) in &agents {
        let content = strip_covenant_block(raw);
        files.push(("claude", repo_root.join(".claude/agents").join(format!("{stem}.md")), content.clone()));
        files.push(("opencode", repo_root.join(".opencode/agent").join(format!("{stem}.md")), content));
    }
    for (name, _v, body) in &skills {
        let content = ensure_frontmatter(name, body);
        files.push(("claude", repo_root.join(".claude/skills").join(format!("cdlc-{name}")).join("SKILL.md"), content.clone()));
        files.push(("pi", repo_root.join(".pi/skills").join(format!("cdlc-{name}")).join("SKILL.md"), content));
    }
    for (stem, raw) in &contexts {
        let content = ensure_frontmatter(stem, body_after_frontmatter(raw));
        files.push(("claude", repo_root.join(".claude/skills").join(format!("cdlc-{stem}")).join("SKILL.md"), content.clone()));
        files.push(("pi", repo_root.join(".pi/skills").join(format!("cdlc-{stem}")).join("SKILL.md"), content));
    }

    let body = managed_body(None, &agents, &skills, &contexts);

    let mut checks: std::collections::BTreeMap<&str, Vec<Check>> = std::collections::BTreeMap::new();
    for (tool, path, expected) in &files {
        checks.entry(tool).or_default().push(check_file(path, expected));
    }
    // Managed-block executors. codex + opencode both read AGENTS.md.
    let agents_md = repo_root.join("AGENTS.md");
    checks.entry("codex").or_default().push(check_managed(&agents_md, body.as_deref()));
    checks.entry("opencode").or_default().push(check_managed(&agents_md, body.as_deref()));
    checks
        .entry("copilot")
        .or_default()
        .push(check_managed(&repo_root.join(".github/copilot-instructions.md"), body.as_deref()));

    let executors = TOOLS
        .iter()
        .map(|t| ExecutorStatus {
            tool: t.to_string(),
            state: aggregate(checks.get(t).map(|v| v.as_slice()).unwrap_or(&[])),
        })
        .collect();

    Ok(ProjectionStatus { executors, source_edited_unix: newest_source_mtime(repo_root) })
}
```

- [ ] **Step 7: Export the new symbols**

In `crates/cdlc/src/lib.rs:11`, change:

```rust
pub use project::{project, project_with_active};
```
to:
```rust
pub use project::{
    project, project_with_active, projection_status, ExecutorStatus, ProjState, ProjectionStatus,
};
```

- [ ] **Step 8: Run all crate tests to verify pass**

Run: `cargo test -p karl-cdlc`
Expected: PASS (existing tests + the two new `projection_status_*` tests).

- [ ] **Step 9: Commit**

```bash
git add crates/cdlc/src/project.rs crates/cdlc/src/lib.rs
git commit -m "feat(cdlc): add read-only projection_status (synced/stale/not_projected)"
```

---

### Task 2: Tauri command `cdlc_projection_status`

**Files:**
- Modify: `crates/app/src/lib.rs` (add command next to `cdlc_export` ~line 2399; register in handler ~line 4428)

**Interfaces:**
- Consumes: `karl_cdlc::projection_status`, `karl_cdlc::ProjectionStatus` (Task 1).
- Produces: Tauri command `cdlc_projection_status(cwd: String) -> Result<ProjectionStatus, String>`.

- [ ] **Step 1: Add the command**

In `crates/app/src/lib.rs`, immediately after the `cdlc_export` function (ends ~line 2399), add:

```rust
/// Read-only projection status per executor (synced / stale / not_projected)
/// plus the newest CDLC source mtime. Used by the Capabilities panel badges.
#[tauri::command]
async fn cdlc_projection_status(cwd: String) -> Result<karl_cdlc::ProjectionStatus, String> {
    let repo = std::path::PathBuf::from(cwd);
    tokio::task::spawn_blocking(move || karl_cdlc::projection_status(&repo))
        .await
        .map_err(|e| format!("cdlc_projection_status join: {e}"))?
        .map_err(|e| e.to_string())
}
```

- [ ] **Step 2: Register in the invoke handler**

In `crates/app/src/lib.rs`, in the `invoke_handler` list, change the line `cdlc_export,` to:

```rust
            cdlc_export,
            cdlc_projection_status,
```

- [ ] **Step 3: Build to verify the command compiles and registers**

Run: `cargo build -p covenant`
Expected: PASS (no errors; command type resolves).

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/lib.rs
git commit -m "feat(app): expose cdlc_projection_status command"
```

---

### Task 3: API wrapper + type fix

**Files:**
- Modify: `ui/src/api.ts` (add types + wrapper near `cdlcExport` ~line 1373; fix `CapabilityListItem.tool` union ~line 2003)

**Interfaces:**
- Consumes: Tauri command `cdlc_projection_status` (Task 2).
- Produces:
  - `export type ProjState = "synced" | "stale" | "not_projected";`
  - `export interface ExecutorStatus { tool: string; state: ProjState; }`
  - `export interface ProjectionStatus { executors: ExecutorStatus[]; source_edited_unix: number | null; }`
  - `export async function cdlcProjectionStatus(cwd: string): Promise<ProjectionStatus>`

- [ ] **Step 1: Add types + wrapper**

In `ui/src/api.ts`, directly after the `cdlcExport` function (~line 1375), add:

```ts
export type ProjState = "synced" | "stale" | "not_projected";
export interface ExecutorStatus {
  tool: string;
  state: ProjState;
}
export interface ProjectionStatus {
  executors: ExecutorStatus[];
  source_edited_unix: number | null;
}
export async function cdlcProjectionStatus(cwd: string): Promise<ProjectionStatus> {
  return invoke<ProjectionStatus>("cdlc_projection_status", { cwd });
}
```

- [ ] **Step 2: Fix the `CapabilityListItem.tool` union to include covenant**

In `ui/src/api.ts` (~line 2003), change:

```ts
  tool: "claude" | "copilot" | "opencode" | "codex" | "pi" | "shared";
```
to:
```ts
  tool: "claude" | "copilot" | "opencode" | "codex" | "pi" | "shared" | "covenant";
```

- [ ] **Step 3: Type-check**

Run: `npm run --prefix ui tsc --noEmit` (or from repo root: `npx tsc -p ui/tsconfig.json --noEmit`)
Expected: PASS (no type errors).

- [ ] **Step 4: Commit**

```bash
git add ui/src/api.ts
git commit -m "feat(api): cdlcProjectionStatus wrapper + covenant in CapabilityListItem.tool"
```

---

### Task 4: Panel — default to Covenant, fetch status, SOURCE/PROJECTIONS nav with badges

**Files:**
- Modify: `ui/src/capabilities/panel.ts` (imports; default state; `refresh()`; `renderNav()`; add `renderProjBadge`/`relTime` helpers)

**Interfaces:**
- Consumes: `cdlcProjectionStatus`, `ProjectionStatus`, `ProjState` (Task 3).
- Produces: nav with a SOURCE group (Covenant + `edited Xm ago`) and a PROJECTIONS group (executors + status badge).

- [ ] **Step 1: Import the new API + default to Covenant**

In `ui/src/capabilities/panel.ts`, add these three lines to the `from "../api"` import block, directly after the existing `cdlcExport,` line (do NOT re-add `cdlcExport`):

```ts
  cdlcProjectionStatus,
  type ProjectionStatus,
  type ProjState,
```

Change the two default fields (~line 82-83):

```ts
  private activeTool: ToolKey = "covenant";
  private activeSection: SectionKey = "config";
```

Add a status field next to them:

```ts
  private projStatus: ProjectionStatus | null = null;
```

- [ ] **Step 2: Fetch status in `refresh()`**

In `refresh()` (~line 155), after `this.items = await capabilitiesList(this.projectRoot);`, add:

```ts
      this.projStatus = this.projectRoot ? await cdlcProjectionStatus(this.projectRoot) : null;
```

And in the `catch` block, after `this.items = [];`, add:

```ts
      this.projStatus = null;
```

- [ ] **Step 3: Add the badge + relative-time helpers**

Add near the bottom of the file, next to `navGroupTitle` (~line 699):

```ts
function projBadge(state: ProjState): HTMLElement {
  const b = document.createElement("span");
  b.className = `cap-proj-badge cap-proj-${state}`;
  b.textContent = state === "synced" ? "✓ synced" : state === "stale" ? "⚠ stale" : "— not projected";
  return b;
}

function relTime(unixSecs: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - unixSecs));
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
```

- [ ] **Step 4: Rewrite `renderNav()`'s tool section into SOURCE / PROJECTIONS**

In `renderNav()`, replace the block that starts at `nav.appendChild(navGroupTitle("Tool"));` and ends just before `nav.appendChild(navGroupTitle("Section"));` with:

```ts
    // Reusable tool-link builder (preserves existing click behaviour).
    const toolLink = (key: ToolKey, label: string, badge?: HTMLElement, meta?: string): HTMLElement => {
      const installed = this.detect ? this.detect[key] : true;
      const a = document.createElement("a");
      a.className = "cap-nav-item";
      if (this.activeTool === key) a.classList.add("active");
      if (!installed) a.classList.add("disabled");
      const name = document.createElement("span");
      name.className = "cap-nav-item-name";
      name.textContent = installed ? label : `${label} (not installed)`;
      a.appendChild(name);
      if (meta) {
        const m = document.createElement("span");
        m.className = "cap-nav-item-meta";
        m.textContent = meta;
        a.appendChild(m);
      }
      if (badge) a.appendChild(badge);
      a.onclick = () => {
        this.activeTool = key;
        this.activeSection = SECTIONS_BY_TOOL[key][0].key;
        this.selectedId = null;
        this.render();
      };
      return a;
    };

    // SOURCE — Covenant is the source of truth.
    nav.appendChild(navGroupTitle("Source"));
    const edited =
      this.projStatus?.source_edited_unix != null
        ? `edited ${relTime(this.projStatus.source_edited_unix)}`
        : "";
    nav.appendChild(toolLink("covenant", "Covenant", undefined, edited));

    // PROJECTIONS — executors receive projected files; badge shows sync state.
    nav.appendChild(navGroupTitle("Projections"));
    const projTools: { key: ToolKey; label: string }[] = [
      { key: "claude", label: "Claude" },
      { key: "codex", label: "Codex" },
      { key: "pi", label: "Pi" },
      { key: "copilot", label: "Copilot" },
      { key: "opencode", label: "opencode" },
      { key: "shared", label: "Shared" },
    ];
    for (const t of projTools) {
      const st = this.projStatus?.executors.find((e) => e.tool === t.key);
      // Shared is not a projection target → no badge.
      const badge = st && t.key !== "shared" ? projBadge(st.state) : undefined;
      nav.appendChild(toolLink(t.key, t.label, badge));
    }
```

- [ ] **Step 5: Type-check**

Run: `npx tsc -p ui/tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/capabilities/panel.ts
git commit -m "feat(capabilities): Covenant-first nav (SOURCE/PROJECTIONS + status badges)"
```

---

### Task 5: Covenant status header (summary + button emphasis)

**Files:**
- Modify: `ui/src/capabilities/panel.ts` (`renderCovenantBar()` ~line 347)

**Interfaces:**
- Consumes: `this.projStatus` (Task 4).
- Produces: header showing `N synced · N stale · N never` and an emphasised Project button when work is pending.

- [ ] **Step 1: Replace the covenant bar message with a live summary**

In `renderCovenantBar()`, replace the `bar.innerHTML = \`...\`` assignment with:

```ts
    const ex = this.projStatus?.executors ?? [];
    const synced = ex.filter((e) => e.state === "synced").length;
    const stale = ex.filter((e) => e.state === "stale").length;
    const never = ex.filter((e) => e.state === "not_projected").length;
    const pending = stale + never;
    const summary = ex.length
      ? `${synced} synced · ${stale} stale · ${never} never`
      : "";
    bar.innerHTML = `
      <span class="cap-covenant-msg">CDLC is the source of truth.${summary ? ` <span class="cap-proj-summary">${summary}</span>` : ""}</span>
      <button type="button" class="cap-btn ${pending > 0 ? "cap-btn-primary" : ""}" data-act="project" ${hasRoot ? "" : "disabled"}>Project →</button>
    `;
```

- [ ] **Step 2: Update the button label restore string**

In the same function, the `finally` block sets `btn.textContent = "Project to executors →";` — change it to:

```ts
        btn.textContent = "Project →";
```

(The click handler's `btn.textContent = "Projecting…";` line stays as-is.)

- [ ] **Step 3: Type-check**

Run: `npx tsc -p ui/tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add ui/src/capabilities/panel.ts
git commit -m "feat(capabilities): projection status header + pending-aware Project button"
```

---

### Task 6: Styles — nav groups, status badges, header summary

**Files:**
- Modify: `ui/src/styles.css` (append to the `cap-*` block, after `.cap-badge-ro` ~line 13455)

**Interfaces:**
- Consumes: class names emitted in Tasks 4–5 (`cap-nav-item-name`, `cap-nav-item-meta`, `cap-proj-badge`, `cap-proj-synced/stale/not_projected`, `cap-proj-summary`).
- Produces: theme-aware styling.

- [ ] **Step 1: Add the CSS**

Append after the `.cap-badge-ro { … }` rule (~line 13455) in `ui/src/styles.css`:

```css
/* Covenant-first nav: SOURCE row + PROJECTIONS badges */
.cap-nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
}
.cap-nav-item-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cap-nav-item-meta {
  font-size: 10px;
  color: var(--muted);
  flex: 0 0 auto;
}
.cap-proj-badge {
  font-size: 10px;
  font-weight: 600;
  flex: 0 0 auto;
  white-space: nowrap;
}
.cap-proj-synced {
  color: var(--ok);
}
.cap-proj-stale {
  color: var(--running);
}
.cap-proj-not_projected {
  color: var(--muted);
}
.cap-proj-summary {
  color: var(--muted);
  font-size: 12px;
  margin-left: 8px;
}
```

- [ ] **Step 2: Type-check (CSS has no test; confirm build is clean)**

Run: `npx tsc -p ui/tsconfig.json --noEmit`
Expected: PASS (unchanged; CSS is not type-checked but confirms nothing else broke).

- [ ] **Step 3: Commit**

```bash
git add ui/src/styles.css
git commit -m "style(capabilities): SOURCE/PROJECTIONS nav + status badge palette"
```

---

## Manual Verification (after all tasks)

Cannot be unit-tested — the panel needs a live app + a real repo with `.covenant/cdlc/`:

1. `npm run tauri:dev` (or `respawn`).
2. Open Capabilities (⌘⇧I). Confirm it lands on **Covenant** under a **SOURCE** heading with `edited …` meta.
3. Set a project root that has `.covenant/cdlc/` sources. Confirm executors under **PROJECTIONS** show badges; header shows `N synced · N stale · N never`.
4. Hit **Project →**; badges flip to synced, header shows all synced, button de-emphasises.
5. Hand-edit a projected file (e.g. `.claude/agents/*.md`), Refresh → that executor shows **⚠ stale**.

## Notes

- **TS test:** no DOM/unit test is added for `renderNav`. The Capabilities panel has no existing test harness, and the real logic (state computation) lives in Rust and is covered by Task 1. Adding a jsdom+mock harness would be more scaffolding than the render code warrants (ponytail). Manual verification covers the wiring.
- **Shared-block caveat (by design):** `codex` and `opencode` both key off `AGENTS.md`'s managed block, so they share that portion of state. Independent badges would require splitting the file — out of scope.
