# CDLC Spec Kind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `Spec` as a first-class *enumerable, readable* context kind — `list_context` surfaces the repo's `docs/specs/*.md`, `CanonStatus` carries them, and the rail + cockpit show a Specs section (read/preview). No projection.

**Architecture:** Spec is the only kind whose source lives at the repo root (`docs/specs/`), not under `.covenant/canon/`, and the only kind with `projectable = false`. A `read_specs` enumerator + a special-cased `read_source` arm handle the repo-root path. Projection code is untouched.

**Tech Stack:** Rust (`crates/canon`, `crates/app`), TypeScript (`ui/src/canon/*`, Vitest).

## Global Constraints

- Rust: no `unwrap()` outside `#[cfg(test)]`. Serialized structs derive `Serialize` + `#[serde(rename_all = "camelCase")]`; `Debug + Clone`.
- Spec source is `<repo_root>/docs/specs/*.md` (repo root, NOT `.covenant/canon/`). Spec `projectable = false` — it is NEVER projected; `project_with_active`/`projection_status` are NOT modified.
- `read_specs` skips non-`.md` entries (so `drafts/`, `assets/` subdirs are excluded) and `_`-prefixed files (e.g. `_template.md`).
- TypeScript strict; no `as any` without a comment. Tauri commands wrapped in `api.ts`.
- Tests from repo ROOT: `npm test`, `cargo test -p karl-canon`. Never vitest from `ui/`.
- No native `element.title`; UI copy English. Conventional Commits; stage explicit paths.
- Worktree `.claude/worktrees/cdlc-spec` (branch `feat/cdlc-spec-kind`).
- Known pre-existing unrelated failure: `ui/src/tasker/panel.test.ts` "calendar sets and clears dueDate" — ignore.

---

### Task 1: Backend — `ContextKind::Spec` + `read_specs` + `read_source` arm

**Files:**
- Modify: `crates/canon/src/kind.rs` (enum variant, `dir()`/`label()`, `read_specs`, `spec_title`, `list_context` loop)
- Modify: `crates/canon/src/install.rs` (`read_source` `Spec` arm — restructure to drop the shared `base`)
- Test: inline in `crates/canon/src/kind.rs` and `crates/canon/src/install.rs`

**Interfaces:**
- Produces: `ContextKind::Spec` (`dir()="docs/specs"` repo-root-relative, `label()="Spec"`); `pub(crate) read_specs(repo_root) -> Result<Vec<(String, String)>>` (stem, title); `list_context` yields `Spec` units with `projectable=false`; `read_source(Spec, name)` reads `<repo_root>/docs/specs/<name>.md`.

- [ ] **Step 1: Write the failing `read_specs` test (in `kind.rs`)**

Add to the `#[cfg(test)] mod tests` in `crates/canon/src/kind.rs`:

```rust
#[test]
fn read_specs_lists_published_excluding_template_and_subdirs() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let dir = root.join("docs/specs");
    std::fs::create_dir_all(dir.join("drafts")).unwrap();
    std::fs::write(dir.join("3.1-alpha.md"), "# 3.1 — Alpha\n\nbody").unwrap();
    std::fs::write(dir.join("3.2-beta.md"), "no heading here").unwrap();
    std::fs::write(dir.join("_template.md"), "# Template\n").unwrap();
    std::fs::write(dir.join("drafts/wip.md"), "# WIP\n").unwrap();

    let specs = read_specs(root).unwrap();
    // _template excluded, drafts/ excluded → 2 specs, sorted.
    assert_eq!(specs.len(), 2);
    assert_eq!(specs[0].0, "3.1-alpha");
    assert_eq!(specs[0].1, "3.1 — Alpha"); // first heading, hashes stripped
    assert_eq!(specs[1].0, "3.2-beta");
    assert_eq!(specs[1].1, "3.2-beta"); // no heading → stem fallback
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p karl-canon read_specs_lists_published_excluding_template_and_subdirs`
Expected: FAIL — `read_specs` not found.

- [ ] **Step 3: Add the `Spec` variant + `read_specs` + `spec_title` (`kind.rs`)**

Add `Spec` to the enum (between `Mcp` and `Skill`):

```rust
pub enum ContextKind {
    Agent,
    Context,
    Command,
    Mcp,
    Spec,
    Skill,
}
```

Add `dir()` arm `Self::Spec => "docs/specs"` and `label()` arm `Self::Spec => "Spec"`.

Add these functions (near `read_mcp_servers`'s call site is in `mcp.rs`; put these in `kind.rs`):

```rust
/// Enumerate published specs under `<repo_root>/docs/specs/*.md` as (stem, title).
/// Spec is the one kind whose source is the repo root, not `.covenant/canon/`.
/// Skips subdirs (drafts/, assets/) via the extension check and `_`-prefixed
/// files (e.g. `_template.md`). Title = first Markdown heading, else the stem.
pub(crate) fn read_specs(repo_root: &Path) -> Result<Vec<(String, String)>, CanonError> {
    let dir = repo_root.join("docs/specs");
    let mut out: Vec<(String, String)> = Vec::new();
    if !dir.exists() {
        return Ok(out);
    }
    for entry in std::fs::read_dir(&dir)? {
        let path = entry?.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let stem = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        if stem.starts_with('_') {
            continue;
        }
        let raw = std::fs::read_to_string(&path)?;
        let title = spec_title(&raw).unwrap_or_else(|| stem.clone());
        out.push((stem, title));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

/// First Markdown heading line, hashes + whitespace stripped. `None` if none.
fn spec_title(md: &str) -> Option<String> {
    md.lines()
        .map(|l| l.trim())
        .find(|l| l.starts_with('#'))
        .map(|l| l.trim_start_matches('#').trim().to_string())
        .filter(|s| !s.is_empty())
}
```

(`kind.rs` already imports `std::path::Path` and `crate::CanonError`; no new imports needed.)

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p karl-canon read_specs_lists_published_excluding_template_and_subdirs`
Expected: PASS.

- [ ] **Step 5: Add the `list_context` Spec loop**

In `list_context`, after the `mcp` loop and before the `skills` loop, add:

```rust
    for (name, title) in read_specs(repo_root)? {
        out.push(ContextUnit {
            kind: ContextKind::Spec,
            summary: Some(title),
            name,
            projectable: false,
            packageable: false,
        });
    }
```

- [ ] **Step 6: Add a `list_context` Spec test**

Add to `kind.rs` tests:

```rust
#[test]
fn list_context_includes_spec_not_projectable() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    std::fs::create_dir_all(root.join("docs/specs")).unwrap();
    std::fs::write(root.join("docs/specs/3.1-alpha.md"), "# 3.1 — Alpha\n").unwrap();
    let units = list_context(root).unwrap();
    let spec = units.iter().find(|u| u.kind == ContextKind::Spec).unwrap();
    assert_eq!(spec.name, "3.1-alpha");
    assert_eq!(spec.summary.as_deref(), Some("3.1 — Alpha"));
    assert!(!spec.projectable);
    assert!(!spec.packageable);
}
```

- [ ] **Step 7: Add the `read_source` Spec arm (`install.rs`)**

Replace the `read_source` path-building block so Spec resolves against the repo
root instead of `canon_dir` (remove the shared `base` binding):

```rust
    let path = match kind {
        ContextKind::Spec => repo_root.join("docs/specs").join(format!("{name}.md")),
        ContextKind::Skill => canon_dir(repo_root).join(kind.dir()).join(name).join("SKILL.md"),
        ContextKind::Mcp => canon_dir(repo_root).join(kind.dir()).join(format!("{name}.json")),
        _ => canon_dir(repo_root).join(kind.dir()).join(format!("{name}.md")),
    };
```

- [ ] **Step 8: Add a `read_source` Spec test (`install.rs`)**

Add to `install.rs` tests:

```rust
#[test]
fn read_source_reads_spec_from_docs_specs() {
    use crate::ContextKind;
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    std::fs::create_dir_all(root.join("docs/specs")).unwrap();
    std::fs::write(root.join("docs/specs/3.1-alpha.md"), "SPEC BODY").unwrap();
    let body = read_source(root, ContextKind::Spec, "3.1-alpha").unwrap();
    assert_eq!(body, "SPEC BODY");
}
```

- [ ] **Step 9: Run all new tests + full suite**

Run: `cargo test -p karl-canon read_specs_lists_published_excluding_template_and_subdirs list_context_includes_spec_not_projectable read_source_reads_spec_from_docs_specs`
Expected: PASS. Then `cargo test -p karl-canon` — all green.

- [ ] **Step 10: Commit**

```bash
git add crates/canon/src/kind.rs crates/canon/src/install.rs
git commit -m "feat(canon): Spec kind — read_specs enumerator + docs/specs read_source arm"
```

---

### Task 2: Backend — `CanonStatus.specs` + app read arm

**Files:**
- Modify: `crates/canon/src/install.rs` (`SpecRef`, `CanonStatus.specs`, `status()`)
- Modify: `crates/app/src/lib.rs` (`canon_read_source` `"spec"` arm)
- Test: inline in `crates/canon/src/install.rs`

**Interfaces:**
- Consumes: `read_specs` (Task 1).
- Produces: `CanonStatus.specs: Vec<SpecRef>` where `SpecRef { name: String, title: String }`; `canon_read_source` accepts `"spec"`.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn status_lists_specs_with_title() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    std::fs::create_dir_all(root.join("docs/specs")).unwrap();
    std::fs::write(root.join("docs/specs/3.1-alpha.md"), "# 3.1 — Alpha\n").unwrap();
    let s = status(root).unwrap();
    assert_eq!(s.specs.len(), 1);
    assert_eq!(s.specs[0].name, "3.1-alpha");
    assert_eq!(s.specs[0].title, "3.1 — Alpha");
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p karl-canon status_lists_specs_with_title`
Expected: FAIL — no field `specs`.

- [ ] **Step 3: Add `SpecRef` + field + populate**

Add near the other Ref structs:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpecRef {
    pub name: String,
    pub title: String,
}
```

Add `pub specs: Vec<SpecRef>` to `CanonStatus`. In `status()`, derive it and add to the returned struct:

```rust
    let specs = crate::kind::read_specs(repo_root)?
        .into_iter()
        .map(|(name, title)| SpecRef { name, title })
        .collect();
    Ok(CanonStatus {
        installed,
        agents,
        contexts,
        commands,
        mcp,
        specs,
    })
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p karl-canon status_lists_specs_with_title`
Expected: PASS.

- [ ] **Step 5: Add the `"spec"` arm to `canon_read_source` (`app/src/lib.rs`)**

In the `match kind.as_str()` add before `other =>`:

```rust
        "spec" => karl_canon::ContextKind::Spec,
```

- [ ] **Step 6: Full suite + app build**

Run: `cargo test -p karl-canon && cargo build -p covenant`
Expected: canon tests PASS; covenant builds clean.

- [ ] **Step 7: Commit**

```bash
git add crates/canon/src/install.rs crates/app/src/lib.rs
git commit -m "feat(canon): CanonStatus lists specs + read_source spec command arm"
```

---

### Task 3: Frontend — `CanonStatus.specs` TS type + `canonReadSource` union

**Files:**
- Modify: `ui/src/api.ts` (`SpecRef`, `CanonStatus.specs`, `canonReadSource` union)
- Modify: `ui/src/canon/panel.test.ts` + `ui/src/canon/cockpit/view.test.ts` (add `specs: []` to status mocks)

**Interfaces:**
- Produces: `export interface SpecRef { name: string; title: string }`; `CanonStatus.specs: SpecRef[]`; `canonReadSource(cwd, kind: "agent"|"context"|"command"|"mcp"|"spec"|"skill", name)`.

- [ ] **Step 1: Update `ui/src/api.ts`**

Add near `McpRef`:

```typescript
export interface SpecRef {
  name: string;
  title: string;
}
```

Add `specs: SpecRef[];` to `CanonStatus`. Extend the `canonReadSource` kind union to `"agent" | "context" | "command" | "mcp" | "spec" | "skill"`.

- [ ] **Step 2: Add `specs: []` to every `CanonStatus` literal**

Grep `ui/src/canon/panel.test.ts`, `ui/src/canon/cockpit/view.test.ts`, and the production `.catch(() => (...) as CanonStatus)` fallback in `ui/src/canon/cockpit/view.ts` for each `CanonStatus` object (they currently have `installed/agents/contexts/commands/mcp`) and add `specs: []`. Grep the whole `ui/src` to confirm none is missed — the build fails otherwise.

- [ ] **Step 3: Build + tests green**

Run (repo ROOT): `npm run build && npm test -- ui/src/canon`
Expected: TS compiles; canon tests PASS.

- [ ] **Step 4: Commit**

```bash
git add ui/src/api.ts ui/src/canon/panel.test.ts ui/src/canon/cockpit/view.test.ts ui/src/canon/cockpit/view.ts
git commit -m "feat(canon): CanonStatus.specs TS type + canonReadSource spec union"
```

---

### Task 4: Frontend — rail Specs section

**Files:**
- Modify: `ui/src/canon/panel.ts` (`renderStatus`)
- Test: `ui/src/canon/panel.test.ts`

**Interfaces:**
- Consumes: `CanonStatus.specs`, `canonReadSource(cwd, "spec", name)`, existing `kindSection`/`skillCard`.

- [ ] **Step 1: Write the failing test**

Add to `ui/src/canon/panel.test.ts` (mirror the existing section tests' construction):

```typescript
it("renders a Specs section", () => {
  const { panel, host } = mountPanel(); // reuse the suite's actual mount pattern
  panel.renderStatus({
    installed: [], agents: [], contexts: [], commands: [], mcp: [],
    specs: [{ name: "3.1-alpha", title: "3.1 — Alpha" }],
  });
  expect(host.textContent).toContain("Specs");
  expect(host.textContent).toContain("3.1 — Alpha");
});

it("shows the specs empty hint when none", () => {
  const { panel, host } = mountPanel();
  panel.renderStatus({ installed: [], agents: [], contexts: [], commands: [], mcp: [], specs: [] });
  expect(host.textContent).toContain("No specs published.");
});
```

(If there is no `mountPanel` helper, mirror the existing tests' actual construction pattern — do not invent one.)

- [ ] **Step 2: Run to verify they fail**

Run (repo ROOT): `npm test -- ui/src/canon/panel.test`
Expected: FAIL.

- [ ] **Step 3: Add the Specs section to `renderStatus`**

After the `mcp` `kindSection` and before the Skills block, add:

```typescript
    // ── Specs (surface-only, not projected) ──
    const specs = this.kindSection(
      "Specs",
      s.specs.length,
      "No specs published.",
      s.specs.map((sp) =>
        skillCard({
          name: sp.name,
          meta: sp.title,
          className: "canon-skill-row",
          fetchPreview: () =>
            cwd ? canonReadSource(cwd, "spec", sp.name) : Promise.resolve("(no project folder)"),
          actions: [],
        }),
      ),
    );
```

Update the final `replaceChildren` to order Agents → Context → Commands → Mcp → Specs → Skills:

```typescript
    this.body.replaceChildren(agents, contexts, commands, mcp, specs, skills);
```

- [ ] **Step 4: Run to verify they pass + build**

Run (repo ROOT): `npm test -- ui/src/canon/panel.test && npm run build`
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/canon/panel.ts ui/src/canon/panel.test.ts
git commit -m "feat(canon): rail shows a Specs section"
```

---

### Task 5: Frontend — cockpit Specs nav section

**Files:**
- Modify: `ui/src/canon/cockpit/view.ts`

**Interfaces:**
- Consumes: `CanonStatus.specs`, `canonReadSource(cwd, "spec", name)`, existing `renderMcpSection` pattern.

- [ ] **Step 1: Add `"spec"` to `SectionKey`, `SECTIONS`, `SECTION_HEAD`, render switch**

`SectionKey` union — add `"spec"`. In `SECTIONS`, insert after the `mcp` entry:

```typescript
  { key: "spec", label: "Specs" },
```

In `SECTION_HEAD`, add:

```typescript
  spec: ["Specs", "Task-anchor specs published in this repo (docs/specs)."],
```

In the render switch, after the `mcp` branch:

```typescript
      : key === "spec" ? this.renderSpecSection()
```

- [ ] **Step 2: Implement `renderSpecSection`**

Mirror `renderMcpSection` exactly, reading `status.specs`:

```typescript
  private renderSpecSection(): HTMLElement {
    const el = document.createElement("div");
    el.className = "canon-cockpit-section is-spec";
    const cwd = this.opts.groupRootDir;

    if (!cwd) {
      el.appendChild(this.note("No project folder linked for this group — point it at a repo from the rail to see specs."));
      return el;
    }

    const list = document.createElement("div");
    list.className = "canon-cockpit-spec-list";
    list.appendChild(this.note("Loading…"));
    el.appendChild(list);

    void canonLocalStatus(cwd)
      .then((status) => {
        list.replaceChildren();
        if (status.specs.length === 0) {
          list.appendChild(this.note("No specs published yet."));
          return;
        }
        for (const sp of status.specs) {
          list.appendChild(skillCard({
            name: sp.name,
            meta: sp.title,
            className: "canon-skill-row",
            fetchPreview: () => canonReadSource(cwd, "spec", sp.name),
            actions: [],
          }));
        }
      })
      .catch((e) => {
        list.replaceChildren();
        list.appendChild(this.note(`Failed to load specs: ${this.friendlyError(e)}`));
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
git commit -m "feat(canon): cockpit Specs nav section"
```

---

## Final verification

- [ ] `cargo test -p karl-canon` — all green.
- [ ] `cargo build -p covenant` — clean.
- [ ] `npm run build` (repo ROOT) — clean.
- [ ] `npm test -- ui/src/canon` (repo ROOT) — green.
- [ ] Manual smoke (optional): with a repo that has `docs/specs/*.md`, open the rail → Specs section lists them with titles; clicking preview reads the spec body; cockpit → Specs nav present. Confirm Specs do NOT appear in any per-executor projection status (they don't project).
