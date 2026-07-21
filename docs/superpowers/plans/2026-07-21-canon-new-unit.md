# Canon "New unit" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An organization owner can create a new Subagent, Command, MCP server, Memory or Skill from its Canon cockpit section — the scaffold lands in `.covenant/canon/`, gets projected, and opens in the editor; Specs routes to the existing Spec Creator scoped to the group's repo.

**Architecture:** One new Rust function `new_unit` writes a per-kind scaffold and reuses the existing `install_unit` / `install_from_dir` (which already write source + project). One Tauri command exposes it. The cockpit gains a shared inline "create" bar per section, gated on org role, whose success callback hands the returned path to `manager.openFileAtLine` via a new `onOpenFile` option.

**Tech Stack:** Rust (`karl-canon` crate, Tauri commands in `crates/app/src/lib.rs`), TypeScript (vanilla DOM, no framework), vitest, cargo test.

## Global Constraints

- Worktree: `/Users/carlosgallardoarenas/Sources/karlTerminal-canon-new`, branch `feat/canon-new-unit`. All work happens here, never in the main checkout.
- **Never `git add -A`** — this worktree has a `node_modules` symlink that must not be committed. Stage explicit paths only.
- All UI chrome copy is English. No emoji in chrome — glyphs come from `Icons.*` (inline SVG).
- Never set `element.title` for tooltips; use `attachTooltip` if a tooltip is needed.
- New panels/controls: `border-radius: 0` (sharp corners), per DESIGN.md.
- Rust crate name is `karl-canon` → `cargo test -p karl-canon`. The app crate is `covenant`, not `app`.
- Commit granularity: one commit per task, not per TDD step.

---

### Task 1: Backend — `new_unit` + Tauri command + api binding

**Files:**
- Create: `crates/canon/src/new_unit.rs`
- Modify: `crates/canon/src/lib.rs` (add `mod new_unit;` and re-export)
- Modify: `crates/app/src/lib.rs` (new `canon_new_unit` command next to `canon_adopt` around line 2870, and register it in the `invoke_handler!` list around line 5654)
- Modify: `ui/src/api.ts` (binding next to `canonAdopt`, line ~1802)
- Test: inline `#[cfg(test)] mod tests` in `crates/canon/src/new_unit.rs`

**Interfaces:**
- Consumes: `karl_canon::{ContextKind, CanonError}`, `crate::compile::slugify`, `crate::install::install_unit`, `crate::install::install_from_dir`, `crate::manifest::canon_dir`, `crate::types::SkillManifest`, `crate::project`.
- Produces:
  - Rust: `pub fn new_unit(repo_root: &Path, kind: ContextKind, name: &str) -> Result<PathBuf, CanonError>`
  - Tauri: `canon_new_unit(cwd: String, kind: String, name: String) -> Result<String, String>` (returns the absolute path of the file to open)
  - TS: `export type CanonNewKind = "agent" | "command" | "mcp" | "memory" | "skill"` and `export async function canonNewUnit(cwd: string, kind: CanonNewKind, name: string): Promise<string>`

- [ ] **Step 1: Write the failing tests**

Create `crates/canon/src/new_unit.rs` with ONLY the test module for now (the impl comes in step 3):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_a_scaffold_for_every_authorable_kind() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let cases = [
            (ContextKind::Agent, ".covenant/canon/agents/reviewer.md"),
            (ContextKind::Command, ".covenant/canon/commands/reviewer.md"),
            (ContextKind::Memory, ".covenant/canon/memory/reviewer.md"),
            (ContextKind::Mcp, ".covenant/canon/mcp/reviewer.json"),
            (ContextKind::Skill, ".covenant/canon/skills/reviewer/SKILL.md"),
        ];
        for (kind, rel) in cases {
            let path = new_unit(root, kind, "reviewer").unwrap();
            assert_eq!(path, root.join(rel), "{kind:?} landed at the wrong path");
            assert!(path.exists(), "{kind:?} scaffold was not written");
            assert!(
                !std::fs::read_to_string(&path).unwrap().is_empty(),
                "{kind:?} scaffold is empty"
            );
            std::fs::remove_file(&path).unwrap();
        }
    }

    #[test]
    fn mcp_scaffold_is_valid_server_json() {
        let tmp = tempfile::tempdir().unwrap();
        let path = new_unit(tmp.path(), ContextKind::Mcp, "ctx7").unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        let srv: crate::mcp::McpServer = serde_json::from_str(&raw).unwrap();
        assert_eq!(srv.transport_kind(), "stdio");
    }

    #[test]
    fn slugifies_the_given_name() {
        let tmp = tempfile::tempdir().unwrap();
        let path = new_unit(tmp.path(), ContextKind::Agent, "My Reviewer").unwrap();
        assert_eq!(path.file_name().unwrap(), "my-reviewer.md");
    }

    #[test]
    fn rejects_an_empty_slug() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(new_unit(tmp.path(), ContextKind::Agent, "  ///  ").is_err());
    }

    #[test]
    fn refuses_to_clobber_an_existing_unit() {
        let tmp = tempfile::tempdir().unwrap();
        new_unit(tmp.path(), ContextKind::Command, "deploy").unwrap();
        let err = new_unit(tmp.path(), ContextKind::Command, "deploy").unwrap_err();
        assert!(format!("{err}").contains("already exists"), "got: {err}");
    }

    #[test]
    fn rejects_kinds_that_are_not_authored_here() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(new_unit(tmp.path(), ContextKind::Spec, "3.1-thing").is_err());
        assert!(new_unit(tmp.path(), ContextKind::Context, "thing").is_err());
    }
}
```

Add to `crates/canon/src/lib.rs`, next to the other `mod` declarations:

```rust
mod new_unit;
```

and extend the existing re-export line (currently `pub use install::{…}`) with a new line:

```rust
pub use new_unit::new_unit;
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p karl-canon new_unit`
Expected: compile error — `cannot find function 'new_unit' in this scope` / `unresolved import`.

- [ ] **Step 3: Write the implementation**

Prepend to `crates/canon/src/new_unit.rs` (above the test module):

```rust
//! Author a fresh Canon unit from the cockpit: write a scaffold in the shape
//! that kind expects, install/project it, and hand back the path so the caller
//! can open it in the editor. The inverse of `detect`/`adopt` — those import
//! what already exists, this one starts from nothing.

use crate::compile::slugify;
use crate::install::{install_from_dir, install_unit};
use crate::manifest::canon_dir;
use crate::types::SkillManifest;
use crate::{project, CanonError, ContextKind};
use std::path::{Path, PathBuf};

/// Where a unit of `kind` named `slug` lives. `Spec` and `Context` are not
/// authored here (Specs go through the Spec Creator; Context through the miner).
fn unit_path(repo_root: &Path, kind: ContextKind, slug: &str) -> Result<PathBuf, CanonError> {
    let dir = canon_dir(repo_root).join(kind.dir());
    Ok(match kind {
        ContextKind::Agent | ContextKind::Command | ContextKind::Memory => {
            dir.join(format!("{slug}.md"))
        }
        ContextKind::Mcp => dir.join(format!("{slug}.json")),
        ContextKind::Skill => dir.join(slug).join("SKILL.md"),
        ContextKind::Spec | ContextKind::Context => {
            return Err(CanonError::InvalidPackage(format!(
                "kind {kind:?} is not authored from the cockpit"
            )))
        }
    })
}

/// The starting contents for a new unit — enough frontmatter that the executor
/// accepts it, and one line of prose telling the author what to replace.
fn scaffold(kind: ContextKind, slug: &str) -> String {
    match kind {
        ContextKind::Agent => format!(
            "---\nname: {slug}\ndescription: One line on when to use this subagent.\n---\n\n# {slug}\n\nDescribe the job, the tools it may use, and where it must stop.\n"
        ),
        ContextKind::Command => format!(
            "---\ndescription: One line on what this command does.\n---\n\n# {slug}\n\nThe prompt this slash command runs.\n"
        ),
        ContextKind::Memory => format!(
            "---\ndescription: One line on the fact this memory carries.\n---\n\n# {slug}\n\nThe durable fact, and why it matters.\n"
        ),
        ContextKind::Skill => format!(
            "---\nname: {slug}\ndescription: One line on when to use this skill.\nversion: 1.0.0\n---\n\n# {slug}\n\nWhat this skill does, and when to reach for it.\n"
        ),
        ContextKind::Mcp => {
            let srv = crate::mcp::McpServer {
                transport: Some("stdio".into()),
                command: Some(String::new()),
                description: Some("One line on what this server provides.".into()),
                ..Default::default()
            };
            serde_json::to_string_pretty(&srv).unwrap_or_else(|_| "{}".into())
        }
        ContextKind::Spec | ContextKind::Context => String::new(),
    }
}

/// Create a new Canon unit and return the path to edit. Errors when the name
/// slugifies to nothing, when the unit already exists, or for a kind that is
/// not authored from the cockpit.
pub fn new_unit(repo_root: &Path, kind: ContextKind, name: &str) -> Result<PathBuf, CanonError> {
    let slug = slugify(name);
    if slug.is_empty() {
        return Err(CanonError::InvalidPackage(format!(
            "cannot derive a valid name from {name:?}"
        )));
    }
    let path = unit_path(repo_root, kind, &slug)?;
    if path.exists() {
        return Err(CanonError::InvalidPackage(format!(
            "{} already exists",
            path.display()
        )));
    }
    let body = scaffold(kind, &slug);
    match kind {
        // install_unit writes the source file AND projects — the same call
        // `adopt` uses for these three kinds.
        ContextKind::Agent | ContextKind::Command | ContextKind::Mcp => {
            install_unit(repo_root, kind, &slug, &body)?;
        }
        ContextKind::Memory => {
            std::fs::create_dir_all(path.parent().expect("unit path has a parent"))?;
            std::fs::write(&path, body)?;
            project(repo_root)?;
        }
        ContextKind::Skill => {
            // install_from_dir COPIES source → `.covenant/canon/skills/<name>`
            // and registers the manifest entry the Skills list reads, so stage
            // the package in a temp dir rather than writing the destination
            // directly (a copy onto itself would truncate the file).
            let staging = std::env::temp_dir().join(format!("canon-new-{}-{slug}", std::process::id()));
            std::fs::create_dir_all(&staging)?;
            std::fs::write(staging.join("SKILL.md"), body)?;
            let manifest = SkillManifest {
                name: slug.clone(),
                version: "1.0.0".to_string(),
                owner: None,
                deps: Vec::new(),
            };
            std::fs::write(staging.join("skill.toml"), toml::to_string_pretty(&manifest)?)?;
            let installed = install_from_dir(repo_root, &staging, "new");
            let _ = std::fs::remove_dir_all(&staging);
            installed?;
        }
        ContextKind::Spec | ContextKind::Context => unreachable!("rejected by unit_path"),
    }
    Ok(path)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p karl-canon new_unit`
Expected: PASS — 6 tests.

Then the full crate suite: `cargo test -p karl-canon`
Expected: PASS, no regressions.

- [ ] **Step 5: Add the Tauri command**

In `crates/app/src/lib.rs`, directly after the `canon_adopt` command (around line 2878):

```rust
/// Author a brand-new context unit (subagent/command/mcp/memory/skill) and
/// return the path of the file to open in the editor.
#[tauri::command]
async fn canon_new_unit(cwd: String, kind: String, name: String) -> Result<String, String> {
    let repo = std::path::PathBuf::from(cwd);
    let k = parse_unit_kind(&kind)?;
    let path = tokio::task::spawn_blocking(move || karl_canon::new_unit(&repo, k, &name))
        .await
        .map_err(|e| format!("canon_new_unit join: {e}"))?
        .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}
```

Register it in the `invoke_handler` list, immediately after the `canon_adopt,` entry (around line 5654):

```rust
            canon_new_unit,
```

- [ ] **Step 6: Add the TS binding**

In `ui/src/api.ts`, right after `canonAdopt` (line ~1804):

```ts
/** Kinds that can be authored from the Canon cockpit. Specs go through the
 *  Spec Creator and Context through the miner, so neither is listed here. */
export type CanonNewKind = "agent" | "command" | "mcp" | "memory" | "skill";

/** Create a new Canon unit; resolves to the absolute path to open in the editor. */
export async function canonNewUnit(cwd: string, kind: CanonNewKind, name: string): Promise<string> {
  return invoke<string>("canon_new_unit", { cwd, kind, name });
}
```

- [ ] **Step 7: Verify it compiles**

Run: `cargo check -p covenant`
Expected: no errors.

Run: `cd ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add crates/canon/src/new_unit.rs crates/canon/src/lib.rs crates/app/src/lib.rs ui/src/api.ts
git commit -m "feat(canon): author a new unit of any kind from source"
```

---

### Task 2: Cockpit — inline create bar for Subagents, Commands, MCP, Memory

**Files:**
- Modify: `ui/src/canon/cockpit/view.ts` (opts interface ~line 53, `renderSection` ~line 203, the four `render*Section` methods at ~801/854/907/1014)
- Modify: `ui/src/canon/cockpit/cockpit.css` (reuse `.canon-import-bar`; add nothing unless the bar needs it)
- Modify: `ui/src/main.ts` (both `CanonCockpitView` construction sites, lines ~1788 and ~1819)
- Test: `ui/src/canon/cockpit/view.test.ts`

**Interfaces:**
- Consumes: `canonNewUnit`, `CanonNewKind` from Task 1; existing `Icons.plus`, `pushInfoToast`, `this.emptyState`, `this.activeOrg`.
- Produces (used by Task 3 and Task 4):
  - `CanonCockpitOpts.onOpenFile?: (path: string) => void`
  - `private canCreate(): boolean`
  - `private newUnitBar(cwd: string, kind: CanonNewKind, headBtn: HTMLElement | undefined, onCreated: () => void): { element: HTMLElement; reveal: () => void }`

- [ ] **Step 1: Write the failing tests**

Add to the `vi.mock("../../api", …)` block in `ui/src/canon/cockpit/view.test.ts`:

```ts
  canonNewUnit: vi.fn(async () => "/x/.covenant/canon/agents/reviewer.md"),
  canonImportSkill: vi.fn(async () => [] as string[]),
  canonAdopt: vi.fn(async () => undefined),
  canonReadSource: vi.fn(async () => ""),
```

Extend the import list from `"../../api"` at the top of the file with `canonNewUnit`.

Add this describe block at the end of the file:

```ts
describe("CanonCockpitView authoring", () => {
  const memberOpts = {
    ...opts,
    orgs: [{ id: 1, slug: "acme", name: "Acme", role: "member", personal: false }],
    getActiveOrg: () => "acme",
  };
  const noOrgOpts = { ...opts, orgs: [], getActiveOrg: () => null };

  it("shows the New action to an org owner", () => {
    const v = new CanonCockpitView(opts);
    v.open();
    v.showSection("agents");
    expect(v.element.querySelector(".canon-sec-head-action")).toBeTruthy();
    v.close();
  });

  it("hides the New action from a non-owner member", () => {
    const v = new CanonCockpitView(memberOpts);
    v.open();
    v.showSection("agents");
    expect(v.element.querySelector(".canon-sec-head-action")).toBeNull();
    v.close();
  });

  it("shows the New action when there is no organization at all", () => {
    const v = new CanonCockpitView(noOrgOpts);
    v.open();
    v.showSection("commands");
    expect(v.element.querySelector(".canon-sec-head-action")).toBeTruthy();
    v.close();
  });

  it("creates the unit and hands the path to onOpenFile", async () => {
    const onOpenFile = vi.fn();
    const v = new CanonCockpitView({ ...opts, onOpenFile });
    v.open();
    v.showSection("agents");
    const input = v.element.querySelector<HTMLInputElement>(".canon-import-input");
    expect(input).toBeTruthy();
    input!.value = "reviewer";
    v.element.querySelector<HTMLFormElement>(".canon-import-bar")!
      .dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(canonNewUnit).toHaveBeenCalledWith("/x", "agent", "reviewer"));
    await vi.waitFor(() =>
      expect(onOpenFile).toHaveBeenCalledWith("/x/.covenant/canon/agents/reviewer.md"));
    v.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ui && npx vitest run src/canon/cockpit/view.test.ts`
Expected: FAIL — no `.canon-sec-head-action` in the agents section, `canonNewUnit` never called.

- [ ] **Step 3: Implement the option, the gate and the shared bar**

In `ui/src/canon/cockpit/view.ts`, add to the imports from `"../../api"`: `canonNewUnit`, and `type CanonNewKind`.

Add to `CanonCockpitOpts` (after `onNewContext`, line ~68):

```ts
  /** Open a file in the workspace editor (the cockpit closes first). Used by
   *  the per-kind "New …" actions to drop the author straight into the
   *  scaffold they just created. */
  onOpenFile?: (path: string) => void;
```

Add these two methods next to `unitAdoptAction` (~line 416):

```ts
  /** Authoring gate. Inside an organization only owners inscribe new units;
   *  with no active org (or an org list we never managed to fetch) this is
   *  just your own repo, so authoring stays open. A surface gate, not a
   *  security boundary — the file is writable outside the app regardless. */
  private canCreate(): boolean {
    const active = this.activeOrg();
    return !active || active.role === "owner";
  }

  /** The inline "name it and go" bar behind a section's New action: writes the
   *  scaffold, closes the cockpit, and opens the file in the editor. Shares the
   *  `.canon-import-bar` chrome with the skills.sh import row. */
  private newUnitBar(
    cwd: string,
    kind: CanonNewKind,
    headBtn: HTMLElement | undefined,
    onCreated: () => void,
  ): { element: HTMLElement; reveal: () => void } {
    const bar = document.createElement("form");
    bar.className = "canon-import-bar";
    bar.hidden = true;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "canon-import-input";
    input.placeholder = `New ${kind} name`;
    input.setAttribute("aria-label", `New ${kind} name`);
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "canon-import-btn";
    submit.textContent = "Create";
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "canon-import-close canon-icon-btn";
    dismiss.innerHTML = Icons.x({ size: 15 });
    dismiss.setAttribute("aria-label", "Dismiss");
    dismiss.addEventListener("click", () => { bar.hidden = true; });
    bar.append(input, submit, dismiss);

    const reveal = (): void => { bar.hidden = false; input.focus(); };
    headBtn?.addEventListener("click", () => {
      bar.hidden = !bar.hidden;
      if (!bar.hidden) input.focus();
    });

    bar.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      submit.disabled = true;
      input.disabled = true;
      void canonNewUnit(cwd, kind, name)
        .then((path) => {
          const org = this.activeOrg();
          pushInfoToast({
            message: org
              ? `Created ${name} — publish it to ${org.slug} when it's ready`
              : `Created ${name}`,
          });
          input.value = "";
          bar.hidden = true;
          onCreated();
          if (this.opts.onOpenFile) {
            this.close();
            this.opts.onOpenFile(path);
          }
        })
        .catch((err) => pushInfoToast({ message: `Create failed: ${this.friendlyError(err)}` }))
        .finally(() => { submit.disabled = false; input.disabled = false; });
    });

    return { element: bar, reveal };
  }
```

In `renderSection`, replace the `else if (key === "skills" …)` chain's head so the four kinds get a New button too. The branch becomes (keep the existing `context` and `skills` branches exactly as they are, and insert this one before them):

```ts
    const NEW_KINDS: Partial<Record<SectionKey, CanonNewKind>> = {
      agents: "agent", commands: "command", mcp: "mcp", memory: "memory",
    };
    const newKind = NEW_KINDS[key];
    if (newKind && this.opts.groupRootDir && this.canCreate()) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "canon-sec-head-action";
      btn.innerHTML = Icons.plus({ size: 14 }) + `<span>New</span>`;
      headAction = btn;
    } else if (key === "context" && …) {   // unchanged
```

and pass `headAction` into the four renderers, changing their dispatch lines:

```ts
      : key === "agents" ? this.renderAgentsSection(headAction)
      : key === "commands" ? this.renderCommandsSection(headAction)
      : key === "mcp" ? this.renderMcpSection(headAction)
      : key === "memory" ? this.renderMemorySection(headAction)
```

- [ ] **Step 4: Wire the bar into the four sections**

Each of `renderAgentsSection`, `renderCommandsSection`, `renderMcpSection`, `renderMemorySection` takes `(headBtn?: HTMLElement)` and changes in three places. Using Subagents as the worked example — apply the identical shape to the other three, substituting the kind string, the empty-state label, and the section's own list class:

```ts
  private renderAgentsSection(headBtn?: HTMLElement): HTMLElement {
    const el = document.createElement("div");
    el.className = "canon-cockpit-section is-agents";
    const cwd = this.opts.groupRootDir;

    if (!cwd) {
      el.appendChild(this.emptyNoRepo("Point this group at a repo from the rail to manage subagents."));
      return el;
    }

    const list = document.createElement("div");
    list.className = "canon-cockpit-agents-list";
    list.appendChild(this.note("Loading…"));
    const toolbar = this.filterToolbar(list, "Filter subagents…");
    const create = this.newUnitBar(cwd, "agent", headBtn, () => this.showSection("agents"));
    el.append(create.element, toolbar, list);

    void canonLocalStatus(cwd)
      .then((status) => {
        list.replaceChildren();
        if (status.agents.length === 0) {
          list.appendChild(this.emptyState({
            icon: Icons.bot({ size: 28 }),
            title: "No subagents yet",
            hint: "Install a subagent, or crawl the repo for context — Canon detects and adopts what's already in the repo.",
            action: this.canCreate() ? { label: "New subagent", onClick: create.reveal } : undefined,
          }));
          return;
        }
        // …rest of the method unchanged…
```

The per-section substitutions:

| method | kind | `showSection` key | empty-state action label |
|---|---|---|---|
| `renderCommandsSection` | `"command"` | `"commands"` | `New command` |
| `renderMcpSection` | `"mcp"` | `"mcp"` | `New MCP server` |
| `renderMemorySection` | `"memory"` | `"memory"` | `New memory` |

Also update the Memory empty-state hint, which currently tells the user to author by hand — replace it with:

```ts
            hint: "Durable facts that ride into every executor's managed block.",
```

- [ ] **Step 5: Wire `onOpenFile` in main.ts**

In `ui/src/main.ts`, add to BOTH `CanonCockpitView` construction sites (after the `onNewContext:` line, ~1797 and ~1827):

```ts
            onOpenFile: (path) => manager.openFileAtLine(path),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd ui && npx vitest run src/canon/cockpit/view.test.ts`
Expected: PASS, including the four new authoring tests.

Run: `cd ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add ui/src/canon/cockpit/view.ts ui/src/canon/cockpit/view.test.ts ui/src/main.ts
git commit -m "feat(canon): create subagents, commands, MCP servers and memories from the cockpit"
```

---

### Task 3: Skills — one input creates or imports

**Files:**
- Modify: `ui/src/canon/cockpit/view.ts` (`renderSkillsSection`, ~line 1063–1200)
- Test: `ui/src/canon/cockpit/view.test.ts`

**Interfaces:**
- Consumes: `canonNewUnit` (Task 1), `this.canCreate()` (Task 2), existing `canonImportSkill`.
- Produces: nothing new.

The Skills header action already toggles the skills.sh import bar. Rather than a second bar, the one input serves both: a value containing `/` is an `owner/repo --skill name` import; anything else is a new skill name.

- [ ] **Step 1: Write the failing tests**

Add to `ui/src/canon/cockpit/view.test.ts` (inside the `CanonCockpitView authoring` describe from Task 2):

```ts
  it("routes a slash-bearing value to the skills.sh import", async () => {
    const v = new CanonCockpitView(opts);
    v.open();
    v.showSection("skills");
    const input = v.element.querySelector<HTMLInputElement>(".canon-import-input")!;
    input.value = "obra/skills --skill deploy";
    v.element.querySelector<HTMLFormElement>(".canon-import-bar")!
      .dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() =>
      expect(canonImportSkill).toHaveBeenCalledWith("/x", "obra/skills --skill deploy"));
    expect(canonNewUnit).not.toHaveBeenCalledWith("/x", "skill", "obra/skills --skill deploy");
    v.close();
  });

  it("routes a bare name to a new skill", async () => {
    const v = new CanonCockpitView(opts);
    v.open();
    v.showSection("skills");
    const input = v.element.querySelector<HTMLInputElement>(".canon-import-input")!;
    input.value = "deploy-notes";
    v.element.querySelector<HTMLFormElement>(".canon-import-bar")!
      .dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(canonNewUnit).toHaveBeenCalledWith("/x", "skill", "deploy-notes"));
    v.close();
  });
```

Extend the top-of-file import from `"../../api"` with `canonImportSkill`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ui && npx vitest run src/canon/cockpit/view.test.ts -t "routes"`
Expected: FAIL — the bare name is still sent to `canonImportSkill`.

- [ ] **Step 3: Implement the routing**

In `renderSkillsSection`, change the input's placeholder and the submit handler:

```ts
    importInput.placeholder = "new-skill-name   ·   or   owner/repo --skill name";
    importInput.setAttribute("aria-label", "New skill name, or a skills.sh reference");
```

Replace the body of the `importBar` submit listener with:

```ts
    importBar.addEventListener("submit", (e) => {
      e.preventDefault();
      const ref = importInput.value.trim();
      if (!ref) return;
      importBtn.disabled = true;
      importInput.disabled = true;
      // ponytail: one input, two intents. A "/" means it's an owner/repo
      // reference for skills.sh; anything else is the name of a new skill.
      const run = ref.includes("/")
        ? canonImportSkill(cwd, ref).then((names) => {
            pushInfoToast({ message: names.length ? `Imported: ${names.join(", ")}` : "Nothing new to import" });
            importInput.value = "";
            load();
          })
        : canonNewUnit(cwd, "skill", ref).then((path) => {
            const org = this.activeOrg();
            pushInfoToast({
              message: org ? `Created ${ref} — publish it to ${org.slug} when it's ready` : `Created ${ref}`,
            });
            importInput.value = "";
            load();
            if (this.opts.onOpenFile) {
              this.close();
              this.opts.onOpenFile(path);
            }
          });
      void run
        .catch((err) => pushInfoToast({ message: `Failed: ${this.friendlyError(err)}` }))
        .finally(() => { importBtn.disabled = false; importInput.disabled = false; });
    });
```

Gate the header action so a non-owner member never sees it — in `renderSection`, change the skills branch condition:

```ts
    } else if (key === "skills" && this.opts.groupRootDir && this.canCreate()) {
```

and give the empty state a create path, in the `load()` callback:

```ts
              action: { label: "Browse registry", onClick: () => this.showSection("registry") },
```

becomes

```ts
              action: this.canCreate()
                ? { label: "New skill", onClick: () => { importBar.hidden = false; importInput.focus(); } }
                : { label: "Browse registry", onClick: () => this.showSection("registry") },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ui && npx vitest run src/canon/cockpit/view.test.ts`
Expected: PASS.

Run: `cd ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add ui/src/canon/cockpit/view.ts ui/src/canon/cockpit/view.test.ts
git commit -m "feat(canon): the Skills add bar creates a new skill or imports one"
```

---

### Task 4: Specs — open the Spec Creator scoped to the group's repo

**Files:**
- Modify: `ui/src/canon/cockpit/view.ts` (`CanonCockpitOpts`, `renderSection`, `renderSpecSection` ~line 960)
- Modify: `ui/src/main.ts` (spec-chat mount ~line 2258, the `spec-chat:open` listener ~line 2282, line ~2620, both cockpit construction sites)
- Test: `ui/src/canon/cockpit/view.test.ts`

**Interfaces:**
- Consumes: `this.canCreate()` (Task 2).
- Produces: `CanonCockpitOpts.onNewSpec?: (repoRoot: string) => void`.

The Spec Creator already grounds its agent in a `cwd` (it renders an "Agent grounded in \<cwd\>" chip). Today that cwd is the active terminal's, which may not be the repo the cockpit is scoped to — so the caller passes an explicit override that rides in the existing `spec-chat:open` event detail.

- [ ] **Step 1: Write the failing test**

Add to the `CanonCockpitView authoring` describe in `ui/src/canon/cockpit/view.test.ts`:

```ts
  it("opens the spec creator scoped to the group's repo", () => {
    const onNewSpec = vi.fn();
    const v = new CanonCockpitView({ ...opts, onNewSpec });
    v.open();
    v.showSection("spec");
    v.element.querySelector<HTMLButtonElement>(".canon-sec-head-action")!.click();
    expect(onNewSpec).toHaveBeenCalledWith("/x");
    v.close();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ui && npx vitest run src/canon/cockpit/view.test.ts -t "spec creator"`
Expected: FAIL — no `.canon-sec-head-action` in the Specs section.

- [ ] **Step 3: Implement the cockpit side**

Add to `CanonCockpitOpts`, after `onOpenFile`:

```ts
  /** Open the immersive Spec Creator grounded in this group's repo. Specs are
   *  authored there, not scaffolded — the creator is a better surface than an
   *  empty file, as long as it is scoped to the repo being worked on. */
  onNewSpec?: (repoRoot: string) => void;
```

In `renderSection`, add a branch before the `context` one:

```ts
    if (key === "spec" && this.opts.groupRootDir && this.opts.onNewSpec && this.canCreate()) {
      const root = this.opts.groupRootDir;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "canon-sec-head-action";
      btn.innerHTML = Icons.plus({ size: 14 }) + `<span>New spec</span>`;
      btn.addEventListener("click", () => { this.close(); this.opts.onNewSpec?.(root); });
      headAction = btn;
    } else if (…)
```

Give the Specs empty state the same door, in `renderSpecSection`:

```ts
            action: this.opts.onNewSpec && this.canCreate()
              ? { label: "New spec", onClick: () => { this.close(); this.opts.onNewSpec?.(cwd); } }
              : undefined,
```

- [ ] **Step 4: Implement the main.ts side**

Above the `mountSpecChat` call (~line 2257) add the override holder:

```ts
  // ponytail: a single override slot instead of threading a cwd through the
  // spec-chat factory. Set by whoever opens the creator for a specific repo
  // (the Canon cockpit), cleared by every other opener.
  let specChatCwd: string | null = null;
```

Change the `getCwd` dep in `mountSpecChat` (line ~2266):

```ts
    getCwd: () => specChatCwd ?? manager.activeCwd() ?? null,
```

Change the `spec-chat:open` listener (~line 2281) to accept and apply the override:

```ts
  window.addEventListener("spec-chat:open", (e: Event) => {
    const detail = (e as CustomEvent<{ draftId?: string; canonContext?: boolean; cwd?: string }>).detail;
    specChatCwd = detail?.cwd ?? null;
    specChat.open(detail?.draftId, { canonContext: detail?.canonContext });
  });
```

At line ~2620, the other opener must clear the override:

```ts
      specChatCwd = null;
      specChat.open();
```

Add to BOTH `CanonCockpitView` construction sites, after `onOpenFile`:

```ts
            onNewSpec: (repoRoot) => window.dispatchEvent(new CustomEvent("spec-chat:open", {
              detail: { canonContext: true, cwd: repoRoot },
            })),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ui && npx vitest run src/canon/cockpit/view.test.ts`
Expected: PASS.

Run: `cd ui && npx tsc --noEmit`
Expected: no errors.

Run the full front-end suite for regressions: `cd ui && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/canon/cockpit/view.ts ui/src/canon/cockpit/view.test.ts ui/src/main.ts
git commit -m "feat(canon): New spec opens the Spec Creator scoped to the group's repo"
```

---

### Task 5: Live verification

**Files:** none modified (verification only; fix-ups land as follow-up commits).

- [ ] **Step 1: Build and launch**

Run: `npm run tauri:dev` (from the worktree root, in the background)
Expected: the app boots.

- [ ] **Step 2: Exercise every kind**

Open the Canon cockpit (⌘⌥C) on a repo with an owned org and confirm, for each of Subagents / Commands / MCP / Memory / Skills:
- the `+ New` action is present in the section header,
- naming a unit creates it, the toast names the org, the cockpit closes and the scaffold opens in the editor,
- reopening the cockpit shows the new row with its Publish action.

Then confirm Specs' `New spec` opens the Spec Creator showing the "grounded in \<groupRootDir\>" chip.

- [ ] **Step 3: Verify the file system**

Run: `ls -R .covenant/canon` in the test repo
Expected: `agents/<slug>.md`, `commands/<slug>.md`, `memory/<slug>.md`, `mcp/<slug>.json`, `skills/<slug>/{SKILL.md,skill.toml}`.

Run: `cat .mcp.json`
Expected: a `canon-<slug>` key with the stdio scaffold, and no un-prefixed duplicate.

- [ ] **Step 4: Verify the gate**

Switch the cockpit to an org where the account's role is `member` and confirm none of the six sections show a New action.

- [ ] **Step 5: Commit any fix-ups**

```bash
git add <touched files>
git commit -m "fix(canon): <what live verification turned up>"
```

---

## Self-Review

- **Spec coverage:** §1 backend → Task 1. §2 head action + inline bar + empty-state actions → Tasks 2 and 3. §3 owner gate → `canCreate()` in Task 2, applied in Tasks 2, 3 and 4. §4 publishing (no new code, toast copy) → Task 2's toast, unchanged Publish actions. §5 Specs → Task 4. Verification → each task's test steps plus Task 5.
- **Type consistency:** `CanonNewKind` is defined once in Task 1 and used verbatim in Tasks 2 and 3. `new_unit` / `canon_new_unit` / `canonNewUnit` names match across the three layers. `onOpenFile` and `onNewSpec` are declared in Tasks 2 and 4 respectively and consumed only after declaration.
- **Known ceiling:** the gate reads the *active* org's role only. An owner of org A viewing org B as a member cannot author into that repo — correct by the rule as specified.
