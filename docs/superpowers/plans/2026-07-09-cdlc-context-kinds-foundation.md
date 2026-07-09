# CDLC Context Kinds — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Agent, Context, and Skill equal, first-class, visible context units — enumerated through one backend contract (`ContextKind` / `list_context`) and surfaced in both the Canon rail and cockpit.

**Architecture:** Add a `ContextKind` enum + `ContextUnit` + `list_context()` to `crates/canon` that enumerates the three existing source dirs uniformly. Enrich `CanonStatus` so the frontend can list agents and context (not just skills). Refactor the rail's `renderStatus` into three kind sections and add an `agents` cockpit section. Projection (`project.rs`) is untouched.

**Tech Stack:** Rust (`crates/canon`, `crates/app` Tauri commands, serde), TypeScript (`ui/src/canon/*`, Vitest).

## Global Constraints

- Rust: `thiserror` in libs, no `unwrap()` outside `#[cfg(test)]`/`main()`. Public types derive `Debug + Clone`; serialized types derive `Serialize` with `#[serde(rename_all = "camelCase")]`. (`CLAUDE.md` Coding Conventions)
- TypeScript: `strict: true`, no `as any` without a justifying comment. All Tauri commands wrapped in `ui/src/api.ts` with typed returns. (`CLAUDE.md`)
- Tests run from repo ROOT: `npm test` (Vitest), `cargo test --workspace`. Never run vitest from `ui/`. (memory: Covenant test gotchas)
- No native `element.title` — use `attachTooltip` from `ui/src/tooltip/tooltip.ts`. (memory: No native tooltips)
- UI chrome copy is English. (memory: English-first copy)
- Conventional Commits, one feature-shaped change per commit.
- Work happens in worktree `.claude/worktrees/cdlc-context-kinds` (branch `feat/cdlc-context-kinds-foundation`). Never `git add -A`; stage explicit paths. (memory: worktree node_modules symlink)

---

### Task 1: Backend — `ContextKind` + `list_context`

**Files:**
- Create: `crates/canon/src/kind.rs`
- Modify: `crates/canon/src/lib.rs` (add `pub mod kind;` + re-exports)
- Modify: `crates/canon/src/project.rs` (make `read_dir_md` and `parse_summary` `pub(crate)`)
- Test: inline `#[cfg(test)]` in `crates/canon/src/kind.rs`

**Interfaces:**
- Consumes: `canon_dir` (from `manifest`), `read_manifest` (from `manifest`), `read_dir_md` + `parse_summary` (from `project`), `CanonError`.
- Produces:
  - `pub enum ContextKind { Agent, Context, Skill }` with `fn dir(&self) -> &'static str` and `fn label(&self) -> &'static str`.
  - `pub struct ContextUnit { kind: ContextKind, name: String, summary: Option<String>, projectable: bool, packageable: bool }`.
  - `pub fn list_context(repo_root: &Path) -> Result<Vec<ContextUnit>, CanonError>`.

- [ ] **Step 1: Make the two helpers crate-visible**

In `crates/canon/src/project.rs`, change the two signatures (keep bodies unchanged):

```rust
pub(crate) fn read_dir_md(dir: &Path) -> Result<Vec<(String, String)>, CanonError> {
```

```rust
pub(crate) fn parse_summary(md: &str) -> Option<String> {
```

- [ ] **Step 2: Write the failing test (new file with the enumerator)**

Create `crates/canon/src/kind.rs` with ONLY the test module first (so it fails to compile → then compile):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::install::install_local;

    #[test]
    fn list_context_enumerates_all_three_kinds() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let canon = root.join(".covenant/canon");

        // One agent, one context doc (with a summary), one installed skill.
        std::fs::create_dir_all(canon.join("agents")).unwrap();
        std::fs::write(canon.join("agents/reviewer.md"), "# Reviewer persona\n").unwrap();
        std::fs::create_dir_all(canon.join("context")).unwrap();
        std::fs::write(
            canon.join("context/kyc.md"),
            "---\nsummary: KYC rules for Peru\n---\nbody\n",
        )
        .unwrap();

        let pkg = tmp.path().join("pkg");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("skill.toml"), "name = \"testing\"\nversion = \"1.0.0\"\n").unwrap();
        std::fs::write(pkg.join("SKILL.md"), "---\nname: testing\n---\nx\n").unwrap();
        install_local(root, &pkg).unwrap();

        let mut units = list_context(root).unwrap();
        units.sort_by(|a, b| (a.kind as u8, &a.name).cmp(&(b.kind as u8, &b.name)));

        assert_eq!(units.len(), 3);
        let agent = units.iter().find(|u| u.kind == ContextKind::Agent).unwrap();
        assert_eq!(agent.name, "reviewer");
        assert!(!agent.packageable);
        let ctx = units.iter().find(|u| u.kind == ContextKind::Context).unwrap();
        assert_eq!(ctx.name, "kyc");
        assert_eq!(ctx.summary.as_deref(), Some("KYC rules for Peru"));
        let skill = units.iter().find(|u| u.kind == ContextKind::Skill).unwrap();
        assert_eq!(skill.name, "testing");
        assert!(skill.packageable);
    }
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cargo test -p karl-canon list_context_enumerates_all_three_kinds`
Expected: FAIL — `cannot find function list_context` / `ContextKind` not found.

- [ ] **Step 4: Write the implementation (prepend to `kind.rs`, above the test module)**

```rust
//! The context-kind contract: the enumerable classes Canon carries into an
//! executor's context. Skill is the only packageable kind today; Command / Mcp
//! / Spec / Memory join in later sub-projects.

use crate::manifest::{canon_dir, read_manifest};
use crate::project::{parse_summary, read_dir_md};
use crate::CanonError;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ContextKind {
    Agent,
    Context,
    Skill,
}

impl ContextKind {
    /// Source subdirectory under `.covenant/canon/`.
    pub fn dir(&self) -> &'static str {
        match self {
            Self::Agent => "agents",
            Self::Context => "context",
            Self::Skill => "skills",
        }
    }

    /// Human label for UI section headers.
    pub fn label(&self) -> &'static str {
        match self {
            Self::Agent => "Agent",
            Self::Context => "Context",
            Self::Skill => "Skill",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextUnit {
    pub kind: ContextKind,
    pub name: String,
    pub summary: Option<String>,
    pub projectable: bool,
    pub packageable: bool,
}

/// Enumerate every authored/installed context unit across the three kinds,
/// reading the same source dirs `project_with_active` projects from.
pub fn list_context(repo_root: &Path) -> Result<Vec<ContextUnit>, CanonError> {
    let base = canon_dir(repo_root);
    let mut out: Vec<ContextUnit> = Vec::new();

    for (name, _raw) in read_dir_md(&base.join("agents"))? {
        out.push(ContextUnit {
            kind: ContextKind::Agent,
            name,
            summary: None,
            projectable: true,
            packageable: false,
        });
    }
    for (name, raw) in read_dir_md(&base.join("context"))? {
        out.push(ContextUnit {
            kind: ContextKind::Context,
            summary: parse_summary(&raw),
            name,
            projectable: true,
            packageable: false,
        });
    }
    for i in read_manifest(repo_root)?.installed {
        out.push(ContextUnit {
            kind: ContextKind::Skill,
            name: i.name,
            summary: None,
            projectable: true,
            packageable: true,
        });
    }
    Ok(out)
}
```

- [ ] **Step 5: Wire the module in `crates/canon/src/lib.rs`**

Add after `pub mod eval;` (line ~8):

```rust
pub mod kind;
```

Add after the existing `pub use` block (line ~16):

```rust
pub use kind::{list_context, ContextKind, ContextUnit};
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cargo test -p karl-canon list_context_enumerates_all_three_kinds`
Expected: PASS.

(If `tempfile` is not already a dev-dependency of `karl_canon`, the existing tests in `install.rs` already use temp dirs — reuse whatever they use. Check `crates/canon/Cargo.toml` `[dev-dependencies]`; `install.rs` tests confirm the pattern.)

- [ ] **Step 7: Commit**

```bash
git add crates/canon/src/kind.rs crates/canon/src/lib.rs crates/canon/src/project.rs
git commit -m "feat(canon): ContextKind enum + list_context enumerator"
```

---

### Task 2: Backend — enrich `CanonStatus` with agents + context summaries

**Files:**
- Modify: `crates/canon/src/install.rs` (struct `CanonStatus`, fn `status`)
- Test: extend `#[cfg(test)]` in `crates/canon/src/install.rs`

**Interfaces:**
- Consumes: `list_context`, `ContextKind` (Task 1).
- Produces: enriched `CanonStatus`:
  - `pub installed: Vec<InstalledRef>` (unchanged)
  - `pub agents: Vec<AgentRef>` where `pub struct AgentRef { pub name: String }`
  - `pub contexts: Vec<ContextRef>` where `pub struct ContextRef { pub name: String, pub summary: Option<String> }`
  - (the old `context_files: Vec<String>` field is REMOVED)

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` in `crates/canon/src/install.rs`:

```rust
#[test]
fn status_lists_agents_and_contexts_with_summary() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let canon = root.join(".covenant/canon");
    std::fs::create_dir_all(canon.join("agents")).unwrap();
    std::fs::write(canon.join("agents/reviewer.md"), "persona\n").unwrap();
    std::fs::create_dir_all(canon.join("context")).unwrap();
    std::fs::write(
        canon.join("context/kyc.md"),
        "---\nsummary: KYC rules\n---\nbody\n",
    )
    .unwrap();

    let s = status(root).unwrap();
    assert_eq!(s.agents.len(), 1);
    assert_eq!(s.agents[0].name, "reviewer");
    assert_eq!(s.contexts.len(), 1);
    assert_eq!(s.contexts[0].name, "kyc");
    assert_eq!(s.contexts[0].summary.as_deref(), Some("KYC rules"));
    assert!(s.installed.is_empty());
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p karl-canon status_lists_agents_and_contexts_with_summary`
Expected: FAIL — no field `agents` on `CanonStatus`.

- [ ] **Step 3: Replace the struct and `status()` body**

In `crates/canon/src/install.rs`, replace the `CanonStatus` struct (lines ~18-23):

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRef {
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextRef {
    pub name: String,
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonStatus {
    pub installed: Vec<InstalledRef>,
    pub agents: Vec<AgentRef>,
    pub contexts: Vec<ContextRef>,
}
```

Replace the `status()` fn (lines ~127-146) so it reads through `list_context` (single source of truth):

```rust
pub fn status(repo_root: &Path) -> Result<CanonStatus, CanonError> {
    let installed = read_manifest(repo_root)?.installed;
    let units = crate::list_context(repo_root)?;
    let agents = units
        .iter()
        .filter(|u| u.kind == crate::ContextKind::Agent)
        .map(|u| AgentRef { name: u.name.clone() })
        .collect();
    let contexts = units
        .iter()
        .filter(|u| u.kind == crate::ContextKind::Context)
        .map(|u| ContextRef { name: u.name.clone(), summary: u.summary.clone() })
        .collect();
    Ok(CanonStatus { installed, agents, contexts })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p karl-canon status_lists_agents_and_contexts_with_summary`
Expected: PASS.

- [ ] **Step 5: Verify the whole canon crate still compiles + tests green**

Run: `cargo test -p karl-canon`
Expected: PASS (all existing tests). If any existing test referenced `context_files`, update it to `contexts` with the `ContextRef` shape.

- [ ] **Step 6: Commit**

```bash
git add crates/canon/src/install.rs
git commit -m "feat(canon): CanonStatus lists agents + context summaries"
```

---

### Task 3: Backend — kind-aware source read command

**Files:**
- Modify: `crates/canon/src/install.rs` (add `read_source`)
- Modify: `crates/app/src/lib.rs` (add `canon_read_source` command + register it)
- Test: extend `#[cfg(test)]` in `crates/canon/src/install.rs`

**Interfaces:**
- Consumes: `ContextKind` (Task 1), `valid_pkg_name` (already in `install.rs`), `canon_dir`.
- Produces:
  - `pub fn read_source(repo_root: &Path, kind: ContextKind, name: &str) -> Result<String, CanonError>` — returns the raw source markdown for a unit (`agents/<name>.md`, `context/<name>.md`, or `skills/<name>/SKILL.md`).
  - Tauri command `canon_read_source(cwd: String, kind: String, name: String) -> Result<String, String>`.

- [ ] **Step 1: Write the failing test**

Add to `#[cfg(test)] mod tests` in `install.rs`:

```rust
#[test]
fn read_source_returns_agent_and_context_bodies() {
    use crate::ContextKind;
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let canon = root.join(".covenant/canon");
    std::fs::create_dir_all(canon.join("agents")).unwrap();
    std::fs::write(canon.join("agents/reviewer.md"), "PERSONA BODY").unwrap();
    std::fs::create_dir_all(canon.join("context")).unwrap();
    std::fs::write(canon.join("context/kyc.md"), "CTX BODY").unwrap();

    assert_eq!(read_source(root, ContextKind::Agent, "reviewer").unwrap(), "PERSONA BODY");
    assert_eq!(read_source(root, ContextKind::Context, "kyc").unwrap(), "CTX BODY");
    assert!(read_source(root, ContextKind::Agent, "../etc/passwd").is_err());
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p karl-canon read_source_returns_agent_and_context_bodies`
Expected: FAIL — `cannot find function read_source`.

- [ ] **Step 3: Implement `read_source` in `install.rs`**

```rust
use crate::ContextKind;

/// Raw source markdown for a single context unit. Path-traversal safe.
pub fn read_source(repo_root: &Path, kind: ContextKind, name: &str) -> Result<String, CanonError> {
    if !valid_pkg_name(name) {
        return Err(CanonError::InvalidPackage(format!("invalid name: {name:?}")));
    }
    let base = canon_dir(repo_root).join(kind.dir());
    let path = match kind {
        ContextKind::Skill => base.join(name).join("SKILL.md"),
        _ => base.join(format!("{name}.md")),
    };
    Ok(std::fs::read_to_string(path)?)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p karl-canon read_source_returns_agent_and_context_bodies`
Expected: PASS.

- [ ] **Step 5: Add the Tauri command in `crates/app/src/lib.rs`**

After `canon_read_local` (line ~2424), add:

```rust
/// Raw source markdown for a context unit of a given kind (agent/context/skill).
#[tauri::command]
async fn canon_read_source(cwd: String, kind: String, name: String) -> Result<String, String> {
    let repo = std::path::PathBuf::from(cwd);
    let k = match kind.as_str() {
        "agent" => karl_canon::ContextKind::Agent,
        "context" => karl_canon::ContextKind::Context,
        "skill" => karl_canon::ContextKind::Skill,
        other => return Err(format!("unknown context kind: {other}")),
    };
    tokio::task::spawn_blocking(move || karl_canon::read_source(&repo, k, &name))
        .await
        .map_err(|e| format!("canon_read_source join: {e}"))?
        .map_err(|e| e.to_string())
}
```

Register it in the `tauri::generate_handler!` list (near `canon_read_local` at line ~4733):

```rust
            canon_read_local,
            canon_read_source,
```

Export `read_source` from the canon crate — in `crates/canon/src/lib.rs` extend the install re-export line:

```rust
pub use install::{install_from_dir, install_local, read_skill_package, read_source, status, CanonStatus};
```

- [ ] **Step 6: Verify workspace builds**

Run: `cargo build -p covenant`
Expected: builds clean.

- [ ] **Step 7: Commit**

```bash
git add crates/canon/src/install.rs crates/canon/src/lib.rs crates/app/src/lib.rs
git commit -m "feat(canon): kind-aware read_source + canon_read_source command"
```

---

### Task 4: Frontend — migrate `CanonStatus` TS type + all consumers

**Files:**
- Modify: `ui/src/api.ts` (`CanonStatus` interface, add `AgentRef`/`ContextRef` types, `canonReadSource` wrapper)
- Modify: `ui/src/canon/cockpit/view.ts` (3 references to `contextFiles`)
- Modify: `ui/src/canon/panel.test.ts` (mocks that use `contextFiles`)
- Test: `ui/src/canon/panel.test.ts` (existing suite must stay green)

**Interfaces:**
- Consumes: nothing new (mirrors Task 2/3 wire types).
- Produces:
  - `export interface AgentRef { name: string }`
  - `export interface ContextRef { name: string; summary: string | null }`
  - `CanonStatus { installed: InstalledRef[]; agents: AgentRef[]; contexts: ContextRef[] }`
  - `export async function canonReadSource(cwd: string, kind: "agent"|"context"|"skill", name: string): Promise<string>`

- [ ] **Step 1: Update the types + wrapper in `ui/src/api.ts`**

Replace the `CanonStatus` interface (lines ~1449-1452):

```typescript
export interface AgentRef {
  name: string;
}

export interface ContextRef {
  name: string;
  summary: string | null;
}

export interface CanonStatus {
  installed: InstalledRef[];
  agents: AgentRef[];
  contexts: ContextRef[];
}
```

Add after `canonReadLocal` (line ~1516):

```typescript
export async function canonReadSource(
  cwd: string,
  kind: "agent" | "context" | "skill",
  name: string,
): Promise<string> {
  return invoke<string>("canon_read_source", { cwd, kind, name });
}
```

- [ ] **Step 2: Fix the cockpit consumers in `ui/src/canon/cockpit/view.ts`**

Line ~616: `if (status.contextFiles.length === 0) {` → `if (status.contexts.length === 0) {`

Line ~620: `for (const f of status.contextFiles) {` → `for (const c of status.contexts) {` and update the loop body to use `c.name` where it used `f` (the value was a filename string; now it's `{ name, summary }`). If the body wrote `f` as text, use `c.name`.

Line ~651: `canonLocalStatus(cwd).catch(() => ({ installed: [], contextFiles: [] }) as CanonStatus),` → `canonLocalStatus(cwd).catch(() => ({ installed: [], agents: [], contexts: [] }) as CanonStatus),`

- [ ] **Step 3: Fix the test mocks in `ui/src/canon/panel.test.ts`**

Replace every `contextFiles: [...]` occurrence with `agents: [], contexts: []` (and drop the old `contextFiles` key). Example — the mock at line ~8:

```typescript
  canonLocalStatus: vi.fn().mockResolvedValue({ installed: [], agents: [], contexts: [] }),
```

And each inline status object in the suite (lines ~35, ~53, ~95, ~105, ~118): remove `contextFiles: [...]`, add `agents: [], contexts: []`.

- [ ] **Step 4: Run type-check + existing tests**

Run (from repo ROOT): `npm run build && npm test -- panel.test`
Expected: TS compiles; existing panel tests PASS (they still assert skills-only behavior, which Task 5 will extend).

- [ ] **Step 5: Commit**

```bash
git add ui/src/api.ts ui/src/canon/cockpit/view.ts ui/src/canon/panel.test.ts
git commit -m "refactor(canon): migrate CanonStatus TS type to agents+contexts"
```

---

### Task 5: Frontend — rail renders Agents · Context · Skills

**Files:**
- Modify: `ui/src/canon/panel.ts` (`renderStatus`)
- Test: `ui/src/canon/panel.test.ts`

**Interfaces:**
- Consumes: `CanonStatus.agents`, `CanonStatus.contexts`, `CanonStatus.installed` (Task 4); `skillCard`, `iconButton` (existing in panel.ts); `canonReadSource` (Task 4).
- Produces: a three-section rail. No new exported symbols.

- [ ] **Step 1: Write the failing test**

Add to `ui/src/canon/panel.test.ts`:

```typescript
it("renders Agents, Context and Skills sections", () => {
  const { panel, host } = mountPanel(); // reuse the suite's existing mount helper
  panel.renderStatus({
    installed: [
      { name: "kyc-peru", version: "1.0.0", source: "local:/x", sha: "a", signer: null, installedAt: "t" },
    ],
    agents: [{ name: "reviewer" }],
    contexts: [{ name: "kyc", summary: "KYC rules" }],
  });
  expect(host.textContent).toContain("Agents");
  expect(host.textContent).toContain("reviewer");
  expect(host.textContent).toContain("Context");
  expect(host.textContent).toContain("kyc");
  expect(host.textContent).toContain("Skills");
  expect(host.textContent).toContain("kyc-peru");
});

it("shows empty hints when a kind is absent", () => {
  const { panel, host } = mountPanel();
  panel.renderStatus({ installed: [], agents: [], contexts: [] });
  expect(host.textContent).toContain("No agents authored.");
  expect(host.textContent).toContain("No context authored.");
  expect(host.textContent).toContain("No skills installed.");
});
```

(If the suite has no `mountPanel` helper, follow the existing tests' construction pattern — they instantiate the panel and read `host.textContent`; mirror that exactly.)

- [ ] **Step 2: Run the test to verify it fails**

Run (repo ROOT): `npm test -- panel.test`
Expected: FAIL — "Agents" / "No agents authored." not found.

- [ ] **Step 3: Rewrite `renderStatus` into three sections**

Replace the body of `renderStatus(s: CanonStatus)` (panel.ts ~467-504). Keep the existing skills-row logic; wrap it and add two kind sections above it:

```typescript
  renderStatus(s: CanonStatus): void {
    this.body.replaceChildren();
    const cwd = this.opts.groupRootDir ?? null;

    // ── Agents ──
    const agents = this.kindSection(
      "Agents",
      s.agents.length,
      "No agents authored.",
      s.agents.map((a) =>
        skillCard({
          name: a.name,
          meta: "agent",
          className: "canon-skill-row",
          fetchPreview: () =>
            cwd ? canonReadSource(cwd, "agent", a.name) : Promise.resolve("(no project folder)"),
          actions: [],
        }),
      ),
    );

    // ── Context ──
    const contexts = this.kindSection(
      "Context",
      s.contexts.length,
      "No context authored.",
      s.contexts.map((c) =>
        skillCard({
          name: c.name,
          meta: c.summary ?? "context",
          className: "canon-skill-row",
          fetchPreview: () =>
            cwd ? canonReadSource(cwd, "context", c.name) : Promise.resolve("(no project folder)"),
          actions: [],
        }),
      ),
    );

    // ── Skills (unchanged rows) ──
    const rows: HTMLElement[] = [];
    for (const i of s.installed) {
      const actions: HTMLButtonElement[] = [];
      if (this.orgs.length > 0 && !i.source.startsWith("registry:")) {
        actions.push(iconButton(Icons.upload({ size: 15 }), "Publish to registry", () => void this.publish(i.name)));
      }
      const runBtn = iconButton(Icons.play({ size: 15 }), "Run evals", () => void this.runEvals(i.name, runBtn));
      actions.push(runBtn);
      rows.push(
        skillCard({
          name: i.name,
          meta: `${i.version} · ${i.source}`,
          className: "canon-skill-row",
          fetchPreview: () => (cwd ? canonReadLocal(cwd, i.name) : Promise.resolve("(no project folder)")),
          actions,
          stats: [`v${i.version}`, i.source],
        }),
      );
    }
    const skills = this.kindSection("Skills", s.installed.length, "No skills installed.", rows);

    this.body.replaceChildren(agents, contexts, skills);
  }

  /** One rail section: uppercase head, count, rows-or-empty-hint. */
  private kindSection(title: string, count: number, emptyHint: string, rows: HTMLElement[]): HTMLElement {
    const sec = document.createElement("section");
    sec.className = "canon-skills";
    const h = document.createElement("h3");
    h.textContent = title;
    sec.appendChild(h);
    if (count === 0) {
      const p = document.createElement("p");
      p.textContent = emptyHint;
      sec.appendChild(p);
    } else {
      for (const r of rows) sec.appendChild(r);
    }
    return sec;
  }
```

Add `canonReadSource` to the `../api` import at the top of panel.ts (the file already imports `canonReadLocal` — add `canonReadSource` to the same import group).

- [ ] **Step 4: Run the tests to verify they pass**

Run (repo ROOT): `npm test -- panel.test`
Expected: PASS (new + existing "No skills installed." test still green).

- [ ] **Step 5: Type-check the whole UI**

Run (repo ROOT): `npm run build`
Expected: compiles clean.

- [ ] **Step 6: Commit**

```bash
git add ui/src/canon/panel.ts ui/src/canon/panel.test.ts
git commit -m "feat(canon): rail shows Agents, Context and Skills sections"
```

---

### Task 6: Frontend — cockpit `Agents` nav section

**Files:**
- Modify: `ui/src/canon/cockpit/view.ts`

**Interfaces:**
- Consumes: `CanonStatus.agents`, `canonReadSource` (Task 4), existing `renderContextSection` pattern.
- Produces: a new `agents` section reachable from the cockpit nav.

- [ ] **Step 1: Add `agents` to `SectionKey` and the nav**

Line ~32:

```typescript
export type SectionKey = "org" | "members" | "agents" | "skills" | "registry" | "context" | "loop";
```

In `SECTIONS` (line ~60), insert after `members`:

```typescript
  { key: "agents", label: "Agents" },
```

In `SECTION_HEAD` (line ~70), add:

```typescript
  agents: ["Agents", "Operator personas projected to your executors."],
```

- [ ] **Step 2: Route the section**

In the render switch (line ~154), add a branch alongside the others:

```typescript
      : key === "agents" ? this.renderAgentsSection()
```

- [ ] **Step 3: Implement `renderAgentsSection`**

Mirror `renderContextSection` (line ~591) but read agents. Minimal version (list names, open source on click via `canonReadSource`):

```typescript
  private renderAgentsSection(): HTMLElement {
    const el = document.createElement("div");
    el.className = "canon-cockpit-section is-agents";
    const cwd = this.opts.groupRootDir;
    void canonLocalStatus(cwd ?? "")
      .then((status) => {
        if (status.agents.length === 0) {
          const empty = document.createElement("p");
          empty.className = "canon-cockpit-empty";
          empty.textContent = "No agents authored yet.";
          el.appendChild(empty);
          return;
        }
        for (const a of status.agents) {
          const row = skillCard({
            name: a.name,
            meta: "agent",
            className: "canon-skill-row",
            fetchPreview: () =>
              cwd ? canonReadSource(cwd, "agent", a.name) : Promise.resolve("(no project folder)"),
            actions: [],
          });
          el.appendChild(row);
        }
      })
      .catch(() => {});
    return el;
  }
```

Add `canonReadSource` to the existing `../../api` import block in view.ts (which already imports `canonLocalStatus`), and confirm `skillCard` is imported (it is re-exported from `panel.ts` — line ~13 of panel.ts notes cockpit imports it; mirror the existing skills-section import).

- [ ] **Step 4: Type-check**

Run (repo ROOT): `npm run build`
Expected: compiles clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/canon/cockpit/view.ts
git commit -m "feat(canon): cockpit Agents nav section"
```

---

### Task 7: Frontend — miner copy honesty

**Files:**
- Modify: `ui/src/canon/miner/view.ts`

**Interfaces:** none — copy only.

- [ ] **Step 1: Add a one-line note under the Mine context title**

Near line ~236 (`title.textContent = "Mine context";`), after the title/subtitle is appended, add a note element clarifying the output is a skill:

```typescript
    const note = document.createElement("p");
    note.className = "canon-miner-note";
    note.textContent = "Mined context is packaged as a skill.";
    // append it in the same container the title/subtitle use (mirror their append)
```

Wire the append next to wherever the existing title/subtitle are appended (follow the surrounding code — append `note` right after the subtitle so it reads as a caption).

- [ ] **Step 2: Type-check**

Run (repo ROOT): `npm run build`
Expected: compiles clean.

- [ ] **Step 3: Commit**

```bash
git add ui/src/canon/miner/view.ts
git commit -m "feat(canon): clarify mined context packages as a skill"
```

---

## Final verification

- [ ] `cargo test -p karl-canon` — all green.
- [ ] `cargo build -p covenant` — clean.
- [ ] `npm run build` (repo ROOT) — clean.
- [ ] `npm test -- panel.test` (repo ROOT) — green.
- [ ] In-app smoke (respawn dev): open Canon rail → three sections visible; open cockpit → Agents nav present; open miner → note shown. (Manual — the running dev app is a worktree; verify per memory `reference_inapp_verify_dom_dump` if keystroke automation is needed.)
