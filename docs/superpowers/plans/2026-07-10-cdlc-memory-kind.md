# CDLC Memory Kind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `Memory` as a first-class context kind — authored under `.covenant/canon/memory/<slug>.md` (atomic facts), enumerated, carried in `CanonStatus`, projected as a grouped `## Memory` section in every executor's managed block, and surfaced in the rail + cockpit.

**Architecture:** Memory reuses the file-per-item source model (`.md` with `description:` frontmatter, read via `read_dir_md`) and `read_source`'s default arm. Its projection is entirely in the managed block: `managed_body` gains a `memories` param and emits one `## Memory` bullet list. No new per-executor sync checks — Memory rides the managed block `check_managed` already verifies.

**Tech Stack:** Rust (`crates/canon`, `crates/app`), TypeScript (`ui/src/canon/*`, Vitest).

## Global Constraints

- Rust: no `unwrap()` outside `#[cfg(test)]`. Serialized structs derive `Serialize` + `#[serde(rename_all = "camelCase")]`; `Debug + Clone`.
- Memory source is `.covenant/canon/memory/*.md`; `projectable = true`, `packageable = false`.
- Memory projects ONLY into the managed block (`AGENTS.md` / `.github/copilot-instructions.md` / `.hermes.md`); NO file-per-item, NO skill dir. `read_source` is NOT changed (Memory uses the default `.md` arm).
- TypeScript strict; no `as any` without a comment. Tauri commands wrapped in `api.ts`.
- Tests from repo ROOT: `npm test`, `cargo test -p karl-canon`. Never vitest from `ui/`.
- No native `element.title`; UI copy English. Conventional Commits; stage explicit paths.
- Worktree `.claude/worktrees/cdlc-memory` (branch `feat/cdlc-memory-kind`).
- Known pre-existing unrelated failure: `ui/src/tasker/panel.test.ts` "calendar sets and clears dueDate" — ignore.

---

### Task 1: Backend — `ContextKind::Memory` + `list_context` loop

**Files:**
- Modify: `crates/canon/src/kind.rs` (enum variant, `dir()`/`label()`, `list_context` loop)
- Test: inline in `crates/canon/src/kind.rs` and `crates/canon/src/install.rs`

**Interfaces:**
- Produces: `ContextKind::Memory` (`dir()="memory"`, `label()="Memory"`); `list_context` yields `Memory` units (`summary` = `description:` frontmatter, `projectable=true`). `read_source(Memory, name)` resolves `.covenant/canon/memory/<name>.md` via the existing default arm (no code change).

- [ ] **Step 1: Write the failing `list_context` test (`kind.rs`)**

Add to the `#[cfg(test)] mod tests` in `crates/canon/src/kind.rs`:

```rust
#[test]
fn list_context_includes_memory_with_description() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let dir = root.join(".covenant/canon/memory");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("decision-x.md"),
        "---\ndescription: We chose X on 2026-07-10\n---\nlonger body\n",
    )
    .unwrap();

    let units = list_context(root).unwrap();
    let mem = units.iter().find(|u| u.kind == ContextKind::Memory).unwrap();
    assert_eq!(mem.name, "decision-x");
    assert_eq!(mem.summary.as_deref(), Some("We chose X on 2026-07-10"));
    assert!(mem.projectable);
    assert!(!mem.packageable);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p karl-canon list_context_includes_memory_with_description`
Expected: FAIL — no variant `Memory`.

- [ ] **Step 3: Add the `Memory` variant (`kind.rs`)**

Add `Memory` to the enum (between `Context` and `Command`):

```rust
pub enum ContextKind {
    Agent,
    Context,
    Memory,
    Command,
    Mcp,
    Spec,
    Skill,
}
```

Add `dir()` arm `Self::Memory => "memory"` and `label()` arm `Self::Memory => "Memory"`.

- [ ] **Step 4: Add the `list_context` Memory loop**

In `list_context`, immediately after the loop that pushes `ContextKind::Context`
and before the `commands` loop, add:

```rust
    for (name, raw) in read_dir_md(&base.join("memory"))? {
        out.push(ContextUnit {
            kind: ContextKind::Memory,
            summary: parse_frontmatter_str(&raw, "description").or_else(|| parse_summary(&raw)),
            name,
            projectable: true,
            packageable: false,
        });
    }
```

(`kind.rs` already imports `read_dir_md`, `parse_frontmatter_str`, and
`parse_summary` — the `commands` loop uses the same pair.)

- [ ] **Step 5: Run to verify it passes**

Run: `cargo test -p karl-canon list_context_includes_memory_with_description`
Expected: PASS.

- [ ] **Step 6: Add a `read_source` Memory test (`install.rs`) — confirms the default arm works**

Add to the `#[cfg(test)] mod tests` in `crates/canon/src/install.rs`:

```rust
#[test]
fn read_source_reads_memory_from_canon_dir() {
    use crate::ContextKind;
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let dir = root.join(".covenant/canon/memory");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("decision-x.md"), "MEM BODY").unwrap();
    let body = read_source(root, ContextKind::Memory, "decision-x").unwrap();
    assert_eq!(body, "MEM BODY");
}
```

- [ ] **Step 7: Run the new test + full suite**

Run: `cargo test -p karl-canon read_source_reads_memory_from_canon_dir && cargo test -p karl-canon`
Expected: PASS (all green — no `read_source` change was needed; Memory hits the default `.md` arm).

- [ ] **Step 8: Commit**

```bash
git add crates/canon/src/kind.rs crates/canon/src/install.rs
git commit -m "feat(canon): Memory kind — enumerate .covenant/canon/memory facts"
```

---

### Task 2: Backend — `CanonStatus.memory` + app read arm

**Files:**
- Modify: `crates/canon/src/install.rs` (`MemoryRef`, `CanonStatus.memory`, `status()`)
- Modify: `crates/app/src/lib.rs` (`canon_read_source` `"memory"` arm)
- Test: inline in `crates/canon/src/install.rs`

**Interfaces:**
- Consumes: `list_context`, `ContextKind::Memory`.
- Produces: `CanonStatus.memory: Vec<MemoryRef>` where `MemoryRef { name: String, description: Option<String> }`; `canon_read_source` accepts `"memory"`.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn status_lists_memory_with_description() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let dir = root.join(".covenant/canon/memory");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("pref-z.md"), "---\ndescription: User prefers Z\n---\nbody\n").unwrap();
    let s = status(root).unwrap();
    assert_eq!(s.memory.len(), 1);
    assert_eq!(s.memory[0].name, "pref-z");
    assert_eq!(s.memory[0].description.as_deref(), Some("User prefers Z"));
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p karl-canon status_lists_memory_with_description`
Expected: FAIL — no field `memory`.

- [ ] **Step 3: Add `MemoryRef` + field + populate (`install.rs`)**

Add near the other Ref structs:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRef {
    pub name: String,
    pub description: Option<String>,
}
```

Add `pub memory: Vec<MemoryRef>` to `CanonStatus`. In `status()`, derive it from
`list_context` (mirroring `agents`/`contexts`/`commands`) and add to the returned
struct:

```rust
    let memory = units
        .iter()
        .filter(|u| u.kind == crate::ContextKind::Memory)
        .map(|u| MemoryRef {
            name: u.name.clone(),
            description: u.summary.clone(),
        })
        .collect();
    Ok(CanonStatus {
        installed,
        agents,
        contexts,
        commands,
        mcp,
        specs,
        memory,
    })
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p karl-canon status_lists_memory_with_description`
Expected: PASS.

- [ ] **Step 5: Add the `"memory"` arm to `canon_read_source` (`app/src/lib.rs`)**

In the `match kind.as_str()` add before `other =>`:

```rust
        "memory" => karl_canon::ContextKind::Memory,
```

- [ ] **Step 6: Full suite + app build**

Run: `cargo test -p karl-canon && cargo build -p covenant`
Expected: canon tests PASS; covenant builds clean.

- [ ] **Step 7: Commit**

```bash
git add crates/canon/src/install.rs crates/app/src/lib.rs
git commit -m "feat(canon): CanonStatus lists memory + read_source memory command arm"
```

---

### Task 3: Backend — project Memory into the managed block

**Files:**
- Modify: `crates/canon/src/project.rs` (`managed_body` memory param + `## Memory` section; read `memories` + thread into `project_with_active` + `projection_status`; empty guard)
- Test: inline in `crates/canon/src/project.rs`

**Interfaces:**
- Consumes: `read_dir_md`, `parse_frontmatter_str`, `body_after_frontmatter`.
- Produces: `managed_body(active_agent, agents, skills, contexts, memories)` emits a trailing `## Memory` bullet section; `project_with_active`/`projection_status` project + verify it.

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` in `crates/canon/src/project.rs`:

```rust
#[test]
fn project_writes_memory_section_into_agents_md() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    let dir = repo.join(".covenant/canon/memory");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("decision-x.md"), "---\ndescription: We chose X\n---\nbody\n").unwrap();
    project(repo).unwrap();
    let agents_md = std::fs::read_to_string(repo.join("AGENTS.md")).unwrap();
    assert!(agents_md.contains("## Memory"), "memory heading present");
    assert!(agents_md.contains("- We chose X"), "memory bullet present");
}

#[test]
fn projection_status_flags_stale_memory() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    let dir = repo.join(".covenant/canon/memory");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("decision-x.md"), "---\ndescription: We chose X\n---\nbody\n").unwrap();
    project(repo).unwrap();
    // Edit the memory source WITHOUT re-projecting. The managed block in AGENTS.md
    // still says "We chose X" but the expected block now says "We chose Y" → the
    // block's START marker is present but its content differs → check_managed → Differ
    // → codex Stale. (Rewriting AGENTS.md to drop the marker entirely would instead
    // read as Missing → NotProjected, which is not what we want to assert here.)
    std::fs::write(dir.join("decision-x.md"), "---\ndescription: We chose Y\n---\nbody\n").unwrap();
    let st = projection_status(repo).unwrap();
    let codex = st.executors.iter().find(|e| e.tool == "codex").unwrap();
    assert_eq!(codex.state, ProjState::Stale);
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test -p karl-canon project_writes_memory_section_into_agents_md projection_status_flags_stale_memory`
Expected: FAIL — `managed_body` has no `memories` param / memory not projected.

- [ ] **Step 3: Add the `memories` param + `## Memory` section to `managed_body`**

Change the signature:

```rust
fn managed_body(
    active_agent: Option<&str>,
    agents: &[(String, String)],
    skills: &[(String, String, String)],
    contexts: &[(String, String)],
    memories: &[(String, String)],
) -> Option<String> {
```

After the `contexts` loop that pushes `## {stem} (context)` sections, and BEFORE
the `if sections.is_empty()` check, add:

```rust
    let mem_bullets: Vec<String> = memories
        .iter()
        .filter_map(|(_, raw)| {
            parse_frontmatter_str(raw, "description")
                .or_else(|| {
                    body_after_frontmatter(raw)
                        .lines()
                        .map(|l| l.trim())
                        .find(|l| !l.is_empty())
                        .map(|s| s.to_string())
                })
                .filter(|s| !s.is_empty())
                .map(|fact| format!("- {fact}"))
        })
        .collect();
    if !mem_bullets.is_empty() {
        sections.push(format!("## Memory\n\n{}", mem_bullets.join("\n")));
    }
```

- [ ] **Step 4: Read `memories` + thread it into both `managed_body` call sites**

In `project_with_active`, after `let contexts = read_dir_md(&canon_dir(repo_root).join("context"))?;` add:

```rust
    let memories = read_dir_md(&canon_dir(repo_root).join("memory"))?;
```

and change the `managed_body(active_agent, &agents, &skills, &contexts)` call to:

```rust
    match managed_body(active_agent, &agents, &skills, &contexts, &memories) {
```

In `projection_status`, after its `let contexts = read_dir_md(&canon_dir(repo_root).join("context"))?;` add:

```rust
    let memories = read_dir_md(&canon_dir(repo_root).join("memory"))?;
```

and change the `let body = managed_body(None, &agents, &skills, &contexts);` call to:

```rust
    let body = managed_body(None, &agents, &skills, &contexts, &memories);
```

- [ ] **Step 5: Extend the empty-source guard in `projection_status`**

Change the guard (currently `... && mcp_servers.is_empty()`) to also require no
memory facts:

```rust
        && mcp_servers.is_empty()
        && memories.is_empty()
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cargo test -p karl-canon project_writes_memory_section_into_agents_md projection_status_flags_stale_memory`
Expected: PASS.

- [ ] **Step 7: Full suite + app build**

Run: `cargo test -p karl-canon && cargo build -p covenant`
Expected: canon tests PASS (existing `managed_body`/projection tests still green after the signature change); covenant builds clean.

- [ ] **Step 8: Commit**

```bash
git add crates/canon/src/project.rs
git commit -m "feat(canon): project memory facts as a Memory section in the managed block"
```

---

### Task 4: Frontend — `CanonStatus.memory` TS type + `canonReadSource` union

**Files:**
- Modify: `ui/src/api.ts` (`MemoryRef`, `CanonStatus.memory`, `canonReadSource` union)
- Modify: `ui/src/canon/panel.test.ts` + `ui/src/canon/cockpit/view.test.ts` (add `memory: []` to status mocks)

**Interfaces:**
- Produces: `export interface MemoryRef { name: string; description: string | null }`; `CanonStatus.memory: MemoryRef[]`; `canonReadSource(cwd, kind: "agent"|"context"|"memory"|"command"|"mcp"|"spec"|"skill", name)`.

- [ ] **Step 1: Update `ui/src/api.ts`**

Add near `SpecRef`:

```typescript
export interface MemoryRef {
  name: string;
  description: string | null;
}
```

Add `memory: MemoryRef[];` to `CanonStatus`. Extend the `canonReadSource` kind union to include `"memory"`: `"agent" | "context" | "memory" | "command" | "mcp" | "spec" | "skill"`.

- [ ] **Step 2: Add `memory: []` to every `CanonStatus` literal**

Grep `ui/src/canon/panel.test.ts`, `ui/src/canon/cockpit/view.test.ts`, and the production `.catch(() => (...) as CanonStatus)` fallback in `ui/src/canon/cockpit/view.ts` for each `CanonStatus` object (they currently have `installed/agents/contexts/commands/mcp/specs`) and add `memory: []`. Grep the whole `ui/src` to confirm none is missed — the build fails otherwise.

- [ ] **Step 3: Build + tests green**

Run (repo ROOT): `npm run build && npm test -- ui/src/canon`
Expected: TS compiles; canon tests PASS.

- [ ] **Step 4: Commit**

```bash
git add ui/src/api.ts ui/src/canon/panel.test.ts ui/src/canon/cockpit/view.test.ts ui/src/canon/cockpit/view.ts
git commit -m "feat(canon): CanonStatus.memory TS type + canonReadSource memory union"
```

---

### Task 5: Frontend — rail Memory section

**Files:**
- Modify: `ui/src/canon/panel.ts` (`renderStatus`)
- Test: `ui/src/canon/panel.test.ts`

**Interfaces:**
- Consumes: `CanonStatus.memory`, `canonReadSource(cwd, "memory", name)`, existing `kindSection`/`skillCard`.

- [ ] **Step 1: Write the failing test**

Add to `ui/src/canon/panel.test.ts` (mirror the existing section tests' construction):

```typescript
it("renders a Memory section", () => {
  const { panel, host } = mountPanel(); // reuse the suite's actual mount pattern
  panel.renderStatus({
    installed: [], agents: [], contexts: [], commands: [], mcp: [], specs: [],
    memory: [{ name: "decision-x", description: "We chose X" }],
  });
  expect(host.textContent).toContain("Memory");
  expect(host.textContent).toContain("decision-x");
});

it("shows the memory empty hint when none", () => {
  const { panel, host } = mountPanel();
  panel.renderStatus({ installed: [], agents: [], contexts: [], commands: [], mcp: [], specs: [], memory: [] });
  expect(host.textContent).toContain("No memories authored.");
});
```

(If there is no `mountPanel` helper, mirror the existing tests' actual construction pattern — do not invent one.)

- [ ] **Step 2: Run to verify they fail**

Run (repo ROOT): `npm test -- ui/src/canon/panel.test`
Expected: FAIL.

- [ ] **Step 3: Add the Memory section to `renderStatus`**

After the `contexts` `kindSection` and before the `commands` block, add:

```typescript
    // ── Memory (persistent recall, folded into the managed block) ──
    const memory = this.kindSection(
      "Memory",
      s.memory.length,
      "No memories authored.",
      s.memory.map((m) =>
        skillCard({
          name: m.name,
          meta: m.description ?? "memory",
          className: "canon-skill-row",
          fetchPreview: () =>
            cwd ? canonReadSource(cwd, "memory", m.name) : Promise.resolve("(no project folder)"),
          actions: [],
        }),
      ),
    );
```

Update the final `replaceChildren` to order Agents → Context → Memory → Commands → Mcp → Specs → Skills:

```typescript
    this.body.replaceChildren(agents, contexts, memory, commands, mcp, specs, skills);
```

- [ ] **Step 4: Run to verify they pass + build**

Run (repo ROOT): `npm test -- ui/src/canon/panel.test && npm run build`
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/canon/panel.ts ui/src/canon/panel.test.ts
git commit -m "feat(canon): rail shows a Memory section"
```

---

### Task 6: Frontend — cockpit Memory nav section

**Files:**
- Modify: `ui/src/canon/cockpit/view.ts`

**Interfaces:**
- Consumes: `CanonStatus.memory`, `canonReadSource(cwd, "memory", name)`, existing `renderMcpSection` pattern.

- [ ] **Step 1: Add `"memory"` to `SectionKey`, `SECTIONS`, `SECTION_HEAD`, render switch**

`SectionKey` union — add `"memory"`. In `SECTIONS`, insert after the `spec` entry:

```typescript
  { key: "memory", label: "Memory" },
```

In `SECTION_HEAD`, add:

```typescript
  memory: ["Memory", "Durable facts this group carries into every executor's managed block."],
```

In the render switch, after the `spec` branch:

```typescript
      : key === "memory" ? this.renderMemorySection()
```

- [ ] **Step 2: Implement `renderMemorySection`**

Mirror `renderMcpSection` exactly, reading `status.memory`:

```typescript
  private renderMemorySection(): HTMLElement {
    const el = document.createElement("div");
    el.className = "canon-cockpit-section is-memory";
    const cwd = this.opts.groupRootDir;

    if (!cwd) {
      el.appendChild(this.note("No project folder linked for this group — point it at a repo from the rail to manage memory."));
      return el;
    }

    const list = document.createElement("div");
    list.className = "canon-cockpit-memory-list";
    list.appendChild(this.note("Loading…"));
    el.appendChild(list);

    void canonLocalStatus(cwd)
      .then((status) => {
        list.replaceChildren();
        if (status.memory.length === 0) {
          list.appendChild(this.note("No memories authored yet."));
          return;
        }
        for (const m of status.memory) {
          list.appendChild(skillCard({
            name: m.name,
            meta: m.description ?? "memory",
            className: "canon-skill-row",
            fetchPreview: () => canonReadSource(cwd, "memory", m.name),
            actions: [],
          }));
        }
      })
      .catch((e) => {
        list.replaceChildren();
        list.appendChild(this.note(`Failed to load memory: ${this.friendlyError(e)}`));
      });

    return el;
  }
```

- [ ] **Step 3: Build + canon tests green**

Run (repo ROOT): `npm run build && npm test -- ui/src/canon`
Expected: compiles; canon suite PASS (cockpit `view.test.ts` selects by `[data-section=...]`, so inserting a section does not break existing assertions).

- [ ] **Step 4: Commit**

```bash
git add ui/src/canon/cockpit/view.ts
git commit -m "feat(canon): cockpit Memory nav section"
```

---

## Final verification

- [ ] `cargo test -p karl-canon` — all green.
- [ ] `cargo build -p covenant` — clean.
- [ ] `npm run build` (repo ROOT) — clean.
- [ ] `npm test -- ui/src/canon` (repo ROOT) — green.
- [ ] Manual smoke (optional): author `.covenant/canon/memory/decision-x.md` (`---\ndescription: We chose X\n---`), run projection, confirm `AGENTS.md` gains a `## Memory` section with `- We chose X`; rail → Memory section lists it; cockpit → Memory nav present.
