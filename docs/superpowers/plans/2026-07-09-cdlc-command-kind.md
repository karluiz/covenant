# CDLC Command Kind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `Command` as a first-class context kind — authored under `.covenant/canon/commands/<name>.md`, enumerated, carried in `CanonStatus`, projected to claude/opencode/pi command dirs, and surfaced in the Canon rail and cockpit.

**Architecture:** Extends the Sub-project 1 `ContextKind` contract. Command projection is file-per-item (identical shape to agents), so agents+commands share a new `project_file_per_item` helper. Codex (no project commands) and Copilot (`.prompt.md`, IDE-only) are deferred.

**Tech Stack:** Rust (`crates/canon`, `crates/app`, serde), TypeScript (`ui/src/canon/*`, Vitest).

## Global Constraints

- Rust: no `unwrap()` outside `#[cfg(test)]`/`main()`. Serialized structs derive `Serialize` + `#[serde(rename_all = "camelCase")]`; public types derive `Debug + Clone`.
- Command projection targets ONLY `.claude/commands/`, `.opencode/commands/`, `.pi/prompts/` (verified paths). Do NOT project to codex or copilot.
- TypeScript strict; no `as any` without a justifying comment. All Tauri commands wrapped in `ui/src/api.ts`.
- Tests from repo ROOT: `npm test` (Vitest), `cargo test -p karl-canon`. Never vitest from `ui/`.
- No native `element.title` — use `attachTooltip`. UI copy English.
- Conventional Commits; stage explicit paths (never `git add -A`).
- Work in worktree `.claude/worktrees/cdlc-command` (branch `feat/cdlc-command-kind`).
- Known pre-existing unrelated failure: `ui/src/tasker/panel.test.ts` "calendar sets and clears dueDate" — ignore.

---

### Task 1: Backend — `ContextKind::Command` + list_context

**Files:**
- Modify: `crates/canon/src/kind.rs` (enum variant, `dir()`/`label()`, `list_context`)
- Modify: `crates/canon/src/project.rs` (generalize `parse_summary` → `parse_frontmatter_str`)
- Test: inline in `crates/canon/src/kind.rs`

**Interfaces:**
- Consumes: `read_dir_md`, `parse_frontmatter_str` (new, from `project`).
- Produces: `ContextKind::Command` (`dir()="commands"`, `label()="Command"`); `list_context` yields `Command` units with summary from `description:` frontmatter.

- [ ] **Step 1: Generalize the frontmatter reader in `project.rs`**

Replace the existing `parse_summary` (currently `pub(crate) fn parse_summary(md: &str) -> Option<String>`) with a generic reader plus a thin `parse_summary` wrapper. Find the current function body (it scans the leading `---`…`---` block for a `summary:` line) and rewrite as:

```rust
/// First top-level `<key>:` value inside the leading frontmatter, trimmed and
/// dequoted. `None` if there is no frontmatter or no non-empty value.
/// ponytail: single-line values only; add block-scalar support if needed.
pub(crate) fn parse_frontmatter_str(md: &str, key: &str) -> Option<String> {
    let lines: Vec<&str> = md.lines().collect();
    let open = lines.iter().position(|l| l.trim() == "---")?;
    let close = open
        + 1
        + lines
            .iter()
            .skip(open + 1)
            .position(|l| l.trim() == "---")?;
    let prefix = format!("{key}:");
    for l in &lines[open + 1..close] {
        if let Some(rest) = l.strip_prefix(&prefix) {
            let v = rest.trim().trim_matches('"').trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

pub(crate) fn parse_summary(md: &str) -> Option<String> {
    parse_frontmatter_str(md, "summary")
}
```

- [ ] **Step 2: Run existing summary tests to confirm no regression**

Run: `cargo test -p karl-canon parse_summary`
Expected: PASS (the existing `parse_summary_reads_frontmatter_line` / `parse_summary_none_when_absent` tests still pass through the wrapper).

- [ ] **Step 3: Write the failing test in `kind.rs`**

Add to the `#[cfg(test)] mod tests` in `crates/canon/src/kind.rs`:

```rust
#[test]
fn list_context_includes_commands_with_description_summary() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let canon = root.join(".covenant/canon");
    std::fs::create_dir_all(canon.join("commands")).unwrap();
    std::fs::write(
        canon.join("commands/deploy.md"),
        "---\ndescription: Ship the current branch\n---\nRun the deploy.\n",
    )
    .unwrap();

    let units = list_context(root).unwrap();
    let cmd = units.iter().find(|u| u.kind == ContextKind::Command).unwrap();
    assert_eq!(cmd.name, "deploy");
    assert_eq!(cmd.summary.as_deref(), Some("Ship the current branch"));
    assert!(!cmd.packageable);
    assert!(cmd.projectable);
}
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cargo test -p karl-canon list_context_includes_commands_with_description_summary`
Expected: FAIL — no variant `Command` on `ContextKind`.

- [ ] **Step 5: Add the `Command` variant + enumerate it**

In `crates/canon/src/kind.rs`, add `Command` to the enum:

```rust
pub enum ContextKind {
    Agent,
    Context,
    Command,
    Skill,
}
```

Add its `dir()` and `label()` arms:

```rust
    pub fn dir(&self) -> &'static str {
        match self {
            Self::Agent => "agents",
            Self::Context => "context",
            Self::Command => "commands",
            Self::Skill => "skills",
        }
    }
```

```rust
    pub fn label(&self) -> &'static str {
        match self {
            Self::Agent => "Agent",
            Self::Context => "Context",
            Self::Command => "Command",
            Self::Skill => "Skill",
        }
    }
```

Update the `use` line to import the new reader:

```rust
use crate::project::{parse_frontmatter_str, parse_summary, read_dir_md};
```

Add the command enumeration loop in `list_context`, after the `context` loop and before the `skills` loop:

```rust
    for (name, raw) in read_dir_md(&base.join("commands"))? {
        out.push(ContextUnit {
            kind: ContextKind::Command,
            summary: parse_frontmatter_str(&raw, "description").or_else(|| parse_summary(&raw)),
            name,
            projectable: true,
            packageable: false,
        });
    }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cargo test -p karl-canon list_context_includes_commands_with_description_summary`
Expected: PASS.

- [ ] **Step 7: Full canon suite green**

Run: `cargo test -p karl-canon`
Expected: PASS (all tests, including the Sub-1 `list_context_enumerates_all_three_kinds`).

- [ ] **Step 8: Commit**

```bash
git add crates/canon/src/kind.rs crates/canon/src/project.rs
git commit -m "feat(canon): ContextKind::Command + list_context enumerates commands"
```

---

### Task 2: Backend — `CanonStatus.commands`

**Files:**
- Modify: `crates/canon/src/install.rs` (`CommandRef`, `CanonStatus.commands`, `status()`)
- Test: inline in `crates/canon/src/install.rs`

**Interfaces:**
- Consumes: `list_context`, `ContextKind::Command`.
- Produces: `CanonStatus { installed, agents, contexts, commands }` with `pub struct CommandRef { pub name: String, pub description: Option<String> }`.

- [ ] **Step 1: Write the failing test**

Add to `#[cfg(test)] mod tests` in `crates/canon/src/install.rs`:

```rust
#[test]
fn status_lists_commands_with_description() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let canon = root.join(".covenant/canon");
    std::fs::create_dir_all(canon.join("commands")).unwrap();
    std::fs::write(
        canon.join("commands/review.md"),
        "---\ndescription: Review the diff\n---\nbody\n",
    )
    .unwrap();

    let s = status(root).unwrap();
    assert_eq!(s.commands.len(), 1);
    assert_eq!(s.commands[0].name, "review");
    assert_eq!(s.commands[0].description.as_deref(), Some("Review the diff"));
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p karl-canon status_lists_commands_with_description`
Expected: FAIL — no field `commands` on `CanonStatus`.

- [ ] **Step 3: Add `CommandRef` + the field + populate it**

In `crates/canon/src/install.rs`, add the struct near `AgentRef`/`ContextRef`:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandRef {
    pub name: String,
    pub description: Option<String>,
}
```

Add the field to `CanonStatus`:

```rust
pub struct CanonStatus {
    pub installed: Vec<InstalledRef>,
    pub agents: Vec<AgentRef>,
    pub contexts: Vec<ContextRef>,
    pub commands: Vec<CommandRef>,
}
```

In `status()`, add the `commands` derivation alongside `agents`/`contexts` and include it in the returned struct:

```rust
    let commands = units
        .iter()
        .filter(|u| u.kind == crate::ContextKind::Command)
        .map(|u| CommandRef { name: u.name.clone(), description: u.summary.clone() })
        .collect();
    Ok(CanonStatus { installed, agents, contexts, commands })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p karl-canon status_lists_commands_with_description`
Expected: PASS.

- [ ] **Step 5: Full canon suite green**

Run: `cargo test -p karl-canon`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/canon/src/install.rs
git commit -m "feat(canon): CanonStatus lists commands with description"
```

---

### Task 3: Backend — project commands + `read_source` command wiring

**Files:**
- Modify: `crates/canon/src/project.rs` (`COMMAND_DIRS`, `project_file_per_item`, `project_commands`, `project_with_active`, `projection_status`)
- Modify: `crates/app/src/lib.rs` (`canon_read_source` match accepts `"command"`)
- Test: inline in `crates/canon/src/project.rs`

**Interfaces:**
- Consumes: `read_dir_md`, `strip_covenant_block`, `ContextKind::Command`.
- Produces: commands projected to `.claude/commands/`, `.opencode/commands/`, `.pi/prompts/` (file-per-item); `projection_status` counts them; `canon_read_source` accepts `kind="command"`.

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` in `crates/canon/src/project.rs`:

```rust
#[test]
fn project_commands_writes_all_three_dirs() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    let cmds = vec![("deploy".to_string(), "---\ndescription: x\n---\nRun deploy\n".to_string())];
    project_commands(repo, &cmds).unwrap();
    assert!(repo.join(".claude/commands/deploy.md").exists());
    assert!(repo.join(".opencode/commands/deploy.md").exists());
    assert!(repo.join(".pi/prompts/deploy.md").exists());
    let written = std::fs::read_to_string(repo.join(".claude/commands/deploy.md")).unwrap();
    assert!(written.contains("Run deploy"));
}

#[test]
fn projection_status_flags_stale_command() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    std::fs::create_dir_all(repo.join(".covenant/canon/commands")).unwrap();
    std::fs::write(repo.join(".covenant/canon/commands/deploy.md"), "Run deploy\n").unwrap();
    project(repo).unwrap();
    // Tamper the projected claude command → claude must read stale.
    std::fs::write(repo.join(".claude/commands/deploy.md"), "tampered\n").unwrap();
    let st = projection_status(repo).unwrap();
    let claude = st.executors.iter().find(|e| e.tool == "claude").unwrap();
    assert_eq!(claude.state, ProjState::Stale);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p karl-canon project_commands_writes_all_three_dirs projection_status_flags_stale_command`
Expected: FAIL — `cannot find function project_commands`.

- [ ] **Step 3: Add `COMMAND_DIRS` + the shared helper + `project_commands`, refactor `project_agents`**

In `crates/canon/src/project.rs`, after the `SKILL_DIRS` const add:

```rust
/// Executors that read a multi-file COMMAND dir as file-per-item `<name>.md`
/// slash commands. Codex has no project-level commands; Copilot uses a
/// different extension/frontmatter — both deferred. Add an executor here.
const COMMAND_DIRS: &[&str] = &[".claude/commands", ".opencode/commands", ".pi/prompts"];
```

Add the shared helper (agents and commands are the identical file-per-item shape):

```rust
/// Write each `<stem>.md` (covenant block stripped) into every dir in `dirs`.
/// Shared by agents and commands — the two file-per-item projection kinds.
fn project_file_per_item(
    repo_root: &Path,
    dirs: &[&str],
    items: &[(String, String)],
) -> Result<(), CanonError> {
    if items.is_empty() {
        return Ok(());
    }
    for base in dirs {
        let dir = repo_root.join(base);
        std::fs::create_dir_all(&dir)?;
        for (stem, raw) in items {
            std::fs::write(dir.join(format!("{stem}.md")), strip_covenant_block(raw))?;
        }
    }
    Ok(())
}
```

Replace the body of `project_agents` to delegate (keeps the existing `project_agents` test working):

```rust
fn project_agents(repo_root: &Path, agents: &[(String, String)]) -> Result<(), CanonError> {
    project_file_per_item(repo_root, AGENT_DIRS, agents)
}
```

Add `project_commands`:

```rust
fn project_commands(repo_root: &Path, commands: &[(String, String)]) -> Result<(), CanonError> {
    project_file_per_item(repo_root, COMMAND_DIRS, commands)
}
```

- [ ] **Step 4: Read + project commands in `project_with_active`**

In `project_with_active`, after `let contexts = read_dir_md(&canon_dir(repo_root).join("context"))?;` add:

```rust
    let commands = read_dir_md(&canon_dir(repo_root).join("commands"))?;
```

After the `project_context_skills(repo_root, &contexts)?;` line (in the "File-per-item executors" block) add:

```rust
    project_commands(repo_root, &commands)?;
```

- [ ] **Step 5: Count commands in `projection_status`**

In `projection_status`, after `let contexts = read_dir_md(&canon_dir(repo_root).join("context"))?;` add:

```rust
    let commands = read_dir_md(&canon_dir(repo_root).join("commands"))?;
```

Extend the "no sources at all" early-return guard to include commands:

```rust
    if agents.is_empty() && skills.is_empty() && contexts.is_empty() && commands.is_empty() {
```

In the "Expected file-per-item content" section, after the `contexts` loop that pushes files, add:

```rust
    for (stem, raw) in &commands {
        let content = strip_covenant_block(raw);
        files.push(("claude", repo_root.join(".claude/commands").join(format!("{stem}.md")), content.clone()));
        files.push(("opencode", repo_root.join(".opencode/commands").join(format!("{stem}.md")), content.clone()));
        files.push(("pi", repo_root.join(".pi/prompts").join(format!("{stem}.md")), content));
    }
```

- [ ] **Step 6: Accept `"command"` in the app's `canon_read_source`**

In `crates/app/src/lib.rs`, in the `canon_read_source` command's `match kind.as_str()` (currently agent/context/skill), add the arm before the `other =>` fallback:

```rust
        "command" => karl_canon::ContextKind::Command,
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cargo test -p karl-canon project_commands_writes_all_three_dirs projection_status_flags_stale_command`
Expected: PASS.

- [ ] **Step 8: Full canon suite + app build**

Run: `cargo test -p karl-canon && cargo build -p covenant`
Expected: canon tests PASS; covenant builds clean.

- [ ] **Step 9: Commit**

```bash
git add crates/canon/src/project.rs crates/app/src/lib.rs
git commit -m "feat(canon): project commands to claude/opencode/pi + read_source command arm"
```

---

### Task 4: Frontend — `CanonStatus.commands` TS type + `canonReadSource` union

**Files:**
- Modify: `ui/src/api.ts` (`CommandRef`, `CanonStatus.commands`, `canonReadSource` kind union)
- Modify: `ui/src/canon/panel.test.ts` + `ui/src/canon/cockpit/view.test.ts` (add `commands: []` to status mocks)

**Interfaces:**
- Produces: `export interface CommandRef { name: string; description: string | null }`; `CanonStatus.commands: CommandRef[]`; `canonReadSource(cwd, kind: "agent"|"context"|"command"|"skill", name)`.

- [ ] **Step 1: Update `ui/src/api.ts`**

Add the interface near `AgentRef`/`ContextRef`:

```typescript
export interface CommandRef {
  name: string;
  description: string | null;
}
```

Add the field to `CanonStatus`:

```typescript
export interface CanonStatus {
  installed: InstalledRef[];
  agents: AgentRef[];
  contexts: ContextRef[];
  commands: CommandRef[];
}
```

Extend the `canonReadSource` kind union:

```typescript
export async function canonReadSource(
  cwd: string,
  kind: "agent" | "context" | "command" | "skill",
  name: string,
): Promise<string> {
  return invoke<string>("canon_read_source", { cwd, kind, name });
}
```

- [ ] **Step 2: Fix status mocks in the two canon test files**

In `ui/src/canon/panel.test.ts` and `ui/src/canon/cockpit/view.test.ts`, every inline `CanonStatus` object / mock (they currently have `installed`, `agents`, `contexts`) must add `commands: []`. Grep both files for `contexts:` and add a sibling `commands: []` to each object.

- [ ] **Step 3: Build + tests green**

Run (repo ROOT): `npm run build && npm test -- ui/src/canon`
Expected: TS compiles; canon tests PASS (existing intent unchanged).

- [ ] **Step 4: Commit**

```bash
git add ui/src/api.ts ui/src/canon/panel.test.ts ui/src/canon/cockpit/view.test.ts
git commit -m "feat(canon): CanonStatus.commands TS type + canonReadSource command union"
```

---

### Task 5: Frontend — rail Commands section

**Files:**
- Modify: `ui/src/canon/panel.ts` (`renderStatus`)
- Test: `ui/src/canon/panel.test.ts`

**Interfaces:**
- Consumes: `CanonStatus.commands`, `canonReadSource(cwd, "command", name)`, existing `kindSection`/`skillCard`.

- [ ] **Step 1: Write the failing test**

Add to `ui/src/canon/panel.test.ts` (mirror the existing three-section test's construction):

```typescript
it("renders a Commands section", () => {
  const { panel, host } = mountPanel(); // reuse the suite's existing mount pattern
  panel.renderStatus({
    installed: [],
    agents: [],
    contexts: [],
    commands: [{ name: "deploy", description: "Ship it" }],
  });
  expect(host.textContent).toContain("Commands");
  expect(host.textContent).toContain("deploy");
});

it("shows the commands empty hint when none", () => {
  const { panel, host } = mountPanel();
  panel.renderStatus({ installed: [], agents: [], contexts: [], commands: [] });
  expect(host.textContent).toContain("No commands authored.");
});
```

(If there is no `mountPanel` helper, mirror the existing tests' actual construction pattern — do not invent a helper.)

- [ ] **Step 2: Run the tests to verify they fail**

Run (repo ROOT): `npm test -- ui/src/canon/panel.test`
Expected: FAIL — "Commands" / "No commands authored." not found.

- [ ] **Step 3: Add the Commands section to `renderStatus`**

In `ui/src/canon/panel.ts` `renderStatus`, after the `contexts` `kindSection` block and before the Skills block, add:

```typescript
    // ── Commands ──
    const commands = this.kindSection(
      "Commands",
      s.commands.length,
      "No commands authored.",
      s.commands.map((c) =>
        skillCard({
          name: c.name,
          meta: c.description ?? "command",
          className: "canon-skill-row",
          fetchPreview: () =>
            cwd ? canonReadSource(cwd, "command", c.name) : Promise.resolve("(no project folder)"),
          actions: [],
        }),
      ),
    );
```

Change the final `replaceChildren` to include commands in order Agents → Context → Commands → Skills:

```typescript
    this.body.replaceChildren(agents, contexts, commands, skills);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (repo ROOT): `npm test -- ui/src/canon/panel.test`
Expected: PASS (new + existing sections).

- [ ] **Step 5: Build**

Run (repo ROOT): `npm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add ui/src/canon/panel.ts ui/src/canon/panel.test.ts
git commit -m "feat(canon): rail shows a Commands section"
```

---

### Task 6: Frontend — cockpit Commands nav section

**Files:**
- Modify: `ui/src/canon/cockpit/view.ts`

**Interfaces:**
- Consumes: `CanonStatus.commands`, `canonReadSource(cwd, "command", name)`, existing `renderAgentsSection` pattern (`this.note`, `this.friendlyError`, `canonLocalStatus`, `skillCard`).

- [ ] **Step 1: Add `"commands"` to `SectionKey`, `SECTIONS`, `SECTION_HEAD`, and the render switch**

`SectionKey` union — add `"commands"`:

```typescript
export type SectionKey = "org" | "members" | "agents" | "commands" | "skills" | "registry" | "context" | "loop";
```

In `SECTIONS`, insert after the `agents` entry:

```typescript
  { key: "commands", label: "Commands" },
```

In `SECTION_HEAD`, add:

```typescript
  commands: ["Commands", "Slash commands projected to your executors."],
```

In the render switch (where `key === "agents" ? this.renderAgentsSection()` lives), add a branch:

```typescript
      : key === "commands" ? this.renderCommandsSection()
```

- [ ] **Step 2: Implement `renderCommandsSection`**

Mirror `renderAgentsSection` exactly, reading `status.commands`:

```typescript
  private renderCommandsSection(): HTMLElement {
    const el = document.createElement("div");
    el.className = "canon-cockpit-section is-commands";
    const cwd = this.opts.groupRootDir;

    if (!cwd) {
      el.appendChild(this.note("No project folder linked for this group — point it at a repo from the rail to manage commands."));
      return el;
    }

    const list = document.createElement("div");
    list.className = "canon-cockpit-commands-list";
    list.appendChild(this.note("Loading…"));
    el.appendChild(list);

    void canonLocalStatus(cwd)
      .then((status) => {
        list.replaceChildren();
        if (status.commands.length === 0) {
          list.appendChild(this.note("No commands authored yet."));
          return;
        }
        for (const c of status.commands) {
          list.appendChild(skillCard({
            name: c.name,
            meta: c.description ?? "command",
            className: "canon-skill-row",
            fetchPreview: () => canonReadSource(cwd, "command", c.name),
            actions: [],
          }));
        }
      })
      .catch((e) => {
        list.replaceChildren();
        list.appendChild(this.note(`Failed to load commands: ${this.friendlyError(e)}`));
      });

    return el;
  }
```

- [ ] **Step 3: Build + canon tests green**

Run (repo ROOT): `npm run build && npm test -- ui/src/canon`
Expected: compiles; canon suite PASS (cockpit `view.test.ts` selects sections by `[data-section="..."]`, so inserting `commands` does not break existing assertions).

- [ ] **Step 4: Commit**

```bash
git add ui/src/canon/cockpit/view.ts
git commit -m "feat(canon): cockpit Commands nav section"
```

---

## Final verification

- [ ] `cargo test -p karl-canon` — all green.
- [ ] `cargo build -p covenant` — clean.
- [ ] `npm run build` (repo ROOT) — clean.
- [ ] `npm test -- ui/src/canon` (repo ROOT) — green.
- [ ] Manual smoke (optional): author `.covenant/canon/commands/hello.md`, run projection, confirm `.claude/commands/hello.md`, `.opencode/commands/hello.md`, `.pi/prompts/hello.md` appear; open rail → Commands section shows it; cockpit → Commands nav present.
