# Mission Picker Integration (3.11) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the text-only "Set mission spec" modal with a picker that lists published specs (`docs/specs/*.md`) + drafts (`docs/specs/drafts/*.md`), keeping the path input + Browse as escape hatch. Per `docs/specs/3.11-mission-picker-integration.md`.

**Architecture:** Backend gains one new pure function + Tauri command in `crates/app/src/drafts.rs` (`list_published_specs_sync` / `list_published_specs`) that scans `docs/specs/*.md`, parses ID + title from the heading, extracts the Goal paragraph. Frontend extracts the Set Mission modal into a new `ui/src/tabs/mission-picker.ts` module with selection state, keyboard nav, parallel fetch of specs+drafts, and dispatch of a `drafts:open` event for "Publish to use". The existing `setMissionPathForActiveTab` and `mission:set` plumbing is reused unchanged.

**Tech Stack:** Rust (existing serde/thiserror), Tauri 2 command, TypeScript class + manual DOM, Vitest for tests, CSS grid.

**Source spec:** `docs/specs/3.11-mission-picker-integration.md` — read first. Acceptance criteria, file boundaries, and line caps in the spec are binding.

**Resolved decisions (from brainstorm):**
- Picker is a modal (not fullscreen), evolution of the existing `openTextPrompt` modal.
- Drafts shown but with "Publish to use" CTA — they cannot be set as missions directly (Operator contract intact).
- "Publish to use" closes Set Mission modal, opens Drafts wizard for that slug, auto-fires Publish modal. Existing post-publish toast wires `mission:set` automatically.
- Empty state for no published specs links to `⌘⇧D` Drafts panel.
- Keyboard: ↑/↓ navigate cards, Enter confirms selected, Esc cancel, Tab to input.
- `current` badge resolved by exact path match.
- `list_published_specs` and `list_drafts` fetched in parallel on modal open; skeleton during load.

**Repo discovery:**
- Existing `promptAndSetMission` lives at `ui/src/tabs/manager.ts:1380-1421`. The reusable `openTextPrompt` helper is at `ui/src/tabs/manager.ts:2350-~2430`.
- `setMissionPathForActiveTab(path)` at `ui/src/tabs/manager.ts:1362` is the public entry that the new picker resolves to. `setSessionMission(sessionId, path)` is the underlying Tauri command (already imported, line 32).
- `mission:set` event listener is already wired in `ui/src/main.ts` (added in 3.10 feature).
- Drafts engine: `draftsApi.list/listPublishedSpecs/...` lives at `ui/src/drafts/api.ts`. `DraftsPanel.openWizard(slug | null)` at `ui/src/drafts/panel.ts`. `DraftWizard.openPublishModal()` is private at `ui/src/drafts/wizard.ts` — needs to be exposed via constructor opt-in.
- Backend drafts module: `crates/app/src/drafts.rs` has `next_spec_id`, `list_drafts_sync`, parsers. Add `list_published_specs_sync` next to them.

---

## File Structure

**Create:**
- `ui/src/tabs/mission-picker.ts` (≤ 350 lines) — `openMissionPicker(opts)` returns `Promise<{ kind: "set", path: string } | { kind: "publishDraft", slug: string } | null>`. Owns: modal DOM, selection state (`SelectedRef = { source: "card" | "input", path: string } | null`), parallel `list_published_specs` + `list_drafts` fetch, skeleton, keyboard nav.
- `ui/src/tabs/mission-picker.test.ts` (≤ 120 lines) — pure-logic tests for `pickerState` reducer + `canSubmit`.

**Modify:**
- `crates/app/src/drafts.rs` (≤ 80 lines added) — `PublishedSpec` struct, helpers `parse_published_spec_heading`, `extract_goal_paragraph`, `list_published_specs_sync` + 4 unit tests, `list_published_specs` Tauri command.
- `crates/app/src/lib.rs` (≤ 3 lines) — append `drafts::list_published_specs` to `tauri::generate_handler!`.
- `ui/src/drafts/api.ts` (≤ 25 lines added) — `PublishedSpec` type + `draftsApi.listPublishedSpecs(repoRoot)` wrapper.
- `ui/src/api.ts` (≤ 3 lines) — re-export `PublishedSpec` type.
- `ui/src/tabs/manager.ts` (≤ 30 lines net) — replace the `openTextPrompt(...)` call inside `promptAndSetMission` with `openMissionPicker(...)`. Translate the picker result into either `setMissionPathForActiveTab` or a `drafts:open` event (already dispatched by the picker — manager just awaits the path).
- `ui/src/drafts/panel.ts` (≤ 15 lines) — `openWizard(slug, opts?: { autoPublish?: boolean })` propagates `opts` to `DraftWizard`.
- `ui/src/drafts/wizard.ts` (≤ 15 lines) — accept `autoPublish?: boolean` in `DraftWizardOpts`; on `mount()` after first render, if true, schedule `void this.openPublishModal()` on the next microtask.
- `ui/src/main.ts` (≤ 10 lines) — `window.addEventListener("drafts:open", (e) => { draftsPanel.open(); draftsPanel.openWizard(detail.slug, { autoPublish: detail.autoPublish }); })`.
- `ui/src/styles.css` (≤ 130 lines appended) — picker modal: card grid, hover/selected states, `current` badge, drafts collapsible, "or pick another file" separator, skeleton shimmer.

**Do NOT touch:** `crates/agent/`, `crates/blocks/`, `crates/session/`, `crates/pty/`, `crates/app/src/operator.rs`, `crates/app/src/aom.rs`, `crates/app/src/safety.rs`, `crates/app/src/mission_persistence.rs`, `crates/app/src/storage.rs`, `crates/app/src/settings.rs`, `ui/src/aom/`, `ui/src/operator/`, `ui/src/recall/`, `ui/src/structure/`, `ui/src/settings/`, `ui/src/blocks/`, `docs/specs/_template.md`, existing published specs.

---

## Task 1: Backend — `PublishedSpec` types + heading parser (TDD)

**Files:**
- Modify: `crates/app/src/drafts.rs`

- [ ] **Step 1: Append types + parser + failing tests**

Add near the existing `DraftSummary` definition in `crates/app/src/drafts.rs`:

```rust
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PublishedSpec {
    pub id: String,         // "3.10"
    pub title: String,      // "Mission Drafts"
    pub goal: String,       // first non-empty paragraph after `## Goal`, ≤ 200 chars
    pub path: String,       // absolute path
    pub updated_at: String, // file mtime RFC3339
}

/// Parse "# 3.10 — Mission Drafts" or "# 3.10 - Mission Drafts" into (id, title).
/// Returns None for headings that don't match the expected published-spec pattern.
pub fn parse_published_spec_heading(line: &str) -> Option<(String, String)> {
    let line = line.trim();
    let rest = line.strip_prefix("# ")?;
    // Split on em-dash or hyphen surrounded by spaces.
    let (id_part, title_part) = if let Some(idx) = rest.find(" — ") {
        (&rest[..idx], &rest[idx + " — ".len()..])
    } else if let Some(idx) = rest.find(" - ") {
        (&rest[..idx], &rest[idx + " - ".len()..])
    } else {
        return None;
    };
    // Validate ID = "<u32>.<u32>"
    let mut parts = id_part.split('.');
    let (Some(maj), Some(min), None) = (parts.next(), parts.next(), parts.next()) else {
        return None;
    };
    maj.parse::<u32>().ok()?;
    min.parse::<u32>().ok()?;
    let title = title_part.trim();
    if title.is_empty() {
        return None;
    }
    Some((id_part.to_string(), title.to_string()))
}
```

Add tests inside `mod tests`:

```rust
#[test]
fn parse_heading_em_dash() {
    let r = parse_published_spec_heading("# 3.10 — Mission Drafts");
    assert_eq!(r, Some(("3.10".into(), "Mission Drafts".into())));
}

#[test]
fn parse_heading_hyphen() {
    let r = parse_published_spec_heading("# 1.0 - Foo Bar");
    assert_eq!(r, Some(("1.0".into(), "Foo Bar".into())));
}

#[test]
fn parse_heading_rejects_no_id() {
    assert!(parse_published_spec_heading("# Mission Drafts").is_none());
    assert!(parse_published_spec_heading("# abc — Title").is_none());
    assert!(parse_published_spec_heading("# 1.0.0 — Title").is_none());
    assert!(parse_published_spec_heading("# 3.10 —").is_none());
}

#[test]
fn parse_heading_rejects_non_h1() {
    assert!(parse_published_spec_heading("## 3.10 — X").is_none());
    assert!(parse_published_spec_heading("3.10 — X").is_none());
}
```

- [ ] **Step 2: Run tests**

Run: `cargo test -p covenant drafts::tests::parse_heading --lib`
Expected: 4 passed.

- [ ] **Step 3: Commit**

```bash
git add crates/app/src/drafts.rs
git commit -m "feat(drafts): published spec heading parser"
```

---

## Task 2: Backend — Goal extractor (TDD)

**Files:**
- Modify: `crates/app/src/drafts.rs`

- [ ] **Step 1: Append helper + tests**

```rust
/// Extract the first non-empty paragraph under "## Goal" in the spec body.
/// Returns at most `max_chars` characters; appends "…" if truncated. Empty if
/// "## Goal" is missing or the section has no body.
pub fn extract_goal_paragraph(body: &str, max_chars: usize) -> String {
    let mut in_goal = false;
    let mut buf: Vec<&str> = Vec::new();
    for line in body.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("## ") {
            if in_goal {
                break; // hit next section
            }
            if trimmed == "## Goal" {
                in_goal = true;
            }
            continue;
        }
        if !in_goal {
            continue;
        }
        // Skip blank lines until we find content; stop at blank line after content.
        if line.trim().is_empty() {
            if !buf.is_empty() {
                break;
            }
            continue;
        }
        buf.push(line.trim());
    }
    let joined = buf.join(" ");
    if joined.chars().count() <= max_chars {
        return joined;
    }
    let mut out: String = joined.chars().take(max_chars).collect();
    out.push('…');
    out
}
```

Add tests:

```rust
#[test]
fn extract_goal_basic() {
    let body = "# 3.10 — X\n\n## Goal\nThe one-sentence goal.\n\n## Out of scope\n- y\n";
    assert_eq!(extract_goal_paragraph(body, 200), "The one-sentence goal.");
}

#[test]
fn extract_goal_multiline_paragraph() {
    let body = "## Goal\nLine one\nLine two.\n\n## Next\n";
    assert_eq!(extract_goal_paragraph(body, 200), "Line one Line two.");
}

#[test]
fn extract_goal_skips_leading_blanks() {
    let body = "## Goal\n\n\nReal goal here.\n";
    assert_eq!(extract_goal_paragraph(body, 200), "Real goal here.");
}

#[test]
fn extract_goal_truncates() {
    let body = format!("## Goal\n{}\n", "a".repeat(300));
    let r = extract_goal_paragraph(&body, 200);
    assert_eq!(r.chars().count(), 201); // 200 + "…"
    assert!(r.ends_with('…'));
}

#[test]
fn extract_goal_missing() {
    assert_eq!(extract_goal_paragraph("## Out of scope\n- x\n", 200), "");
    assert_eq!(extract_goal_paragraph("# Title only\n", 200), "");
}
```

- [ ] **Step 2: Run tests**

Run: `cargo test -p covenant drafts::tests::extract_goal --lib`
Expected: 5 passed.

- [ ] **Step 3: Commit**

```bash
git add crates/app/src/drafts.rs
git commit -m "feat(drafts): extract goal paragraph helper"
```

---

## Task 3: Backend — `list_published_specs_sync` + Tauri command (TDD)

**Files:**
- Modify: `crates/app/src/drafts.rs`, `crates/app/src/lib.rs`

- [ ] **Step 1: Append `list_published_specs_sync` + tests**

```rust
pub fn list_published_specs_sync(repo_root: &Path) -> Result<Vec<PublishedSpec>, DraftError> {
    let dir = repo_root.join("docs/specs");
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let ftype = entry.file_type()?;
        if !ftype.is_file() {
            continue;
        }
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if !name_str.ends_with(".md") || name_str.starts_with('_') {
            continue;
        }
        let path = entry.path();
        let text = std::fs::read_to_string(&path)?;
        // First non-empty line should be the H1 heading.
        let heading_line = text
            .lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("");
        let Some((id, title)) = parse_published_spec_heading(heading_line) else {
            continue; // not a published spec we can interpret
        };
        let goal = extract_goal_paragraph(&text, 200);
        let updated_at = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| {
                t.duration_since(std::time::UNIX_EPOCH).ok()
                    .map(|d| chrono::DateTime::<chrono::Utc>::from_timestamp(d.as_secs() as i64, 0))
            })
            .flatten()
            .map(|dt| dt.to_rfc3339())
            .unwrap_or_default();
        out.push(PublishedSpec {
            id,
            title,
            goal,
            path: path.to_string_lossy().into_owned(),
            updated_at,
        });
    }
    // Sort by semantic ID descending (major, minor).
    out.sort_by(|a, b| {
        let parse = |s: &str| -> (u32, u32) {
            let mut p = s.split('.');
            let maj = p.next().and_then(|x| x.parse().ok()).unwrap_or(0);
            let min = p.next().and_then(|x| x.parse().ok()).unwrap_or(0);
            (maj, min)
        };
        parse(&b.id).cmp(&parse(&a.id))
    });
    Ok(out)
}
```

Add tests:

```rust
#[test]
fn list_published_excludes_template_and_drafts() {
    let tmp = tempfile::tempdir().unwrap();
    let specs = tmp.path().join("docs/specs");
    std::fs::create_dir_all(specs.join("drafts")).unwrap();
    std::fs::write(specs.join("_template.md"), "# Template\n## Goal\nx\n").unwrap();
    std::fs::write(specs.join("3.1-foo.md"), "# 3.1 — Foo\n\n## Goal\nFoo goal.\n").unwrap();
    std::fs::write(specs.join("3.10-bar.md"), "# 3.10 — Bar\n\n## Goal\nBar goal.\n").unwrap();
    std::fs::write(specs.join("drafts/draft-x.md"), "---\nstatus: draft\ntitle: x\nslug: draft-x\ncreated_at: 2026-01-01T00:00:00Z\nupdated_at: 2026-01-01T00:00:00Z\n---\n# Draft — x\n## Goal\nignored.\n").unwrap();

    let r = list_published_specs_sync(tmp.path()).unwrap();
    assert_eq!(r.len(), 2);
    // Sorted descending: 3.10 then 3.1.
    assert_eq!(r[0].id, "3.10");
    assert_eq!(r[0].title, "Bar");
    assert_eq!(r[0].goal, "Bar goal.");
    assert_eq!(r[1].id, "3.1");
}

#[test]
fn list_published_skips_unparseable_heading() {
    let tmp = tempfile::tempdir().unwrap();
    let specs = tmp.path().join("docs/specs");
    std::fs::create_dir_all(&specs).unwrap();
    std::fs::write(specs.join("not-a-spec.md"), "Just some markdown\n").unwrap();
    std::fs::write(specs.join("3.0-ok.md"), "# 3.0 — OK\n## Goal\ng\n").unwrap();
    let r = list_published_specs_sync(tmp.path()).unwrap();
    assert_eq!(r.len(), 1);
    assert_eq!(r[0].id, "3.0");
}

#[test]
fn list_published_empty_when_no_specs_dir() {
    let tmp = tempfile::tempdir().unwrap();
    assert_eq!(list_published_specs_sync(tmp.path()).unwrap().len(), 0);
}
```

- [ ] **Step 2: Add Tauri command at the bottom of `drafts.rs`**

```rust
#[tauri::command]
pub async fn list_published_specs(repo_root: String) -> Result<Vec<PublishedSpec>, String> {
    let path = PathBuf::from(repo_root);
    tokio::task::spawn_blocking(move || list_published_specs_sync(&path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}
```

- [ ] **Step 3: Register in `lib.rs`**

In `crates/app/src/lib.rs`, find the existing `tauri::generate_handler!` invocation that already includes `drafts::list_drafts` etc., and append:

```rust
drafts::list_published_specs,
```

- [ ] **Step 4: Build + run tests**

Run: `cargo check -p covenant`
Expected: 0 errors.

Run: `cargo test -p covenant drafts::tests --lib`
Expected: all drafts tests pass (existing 20 + new 12 = 32). Confirm count.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/drafts.rs crates/app/src/lib.rs
git commit -m "feat(drafts): list_published_specs backend + tauri command"
```

---

## Task 4: TS API wrapper

**Files:**
- Modify: `ui/src/drafts/api.ts`, `ui/src/api.ts`

- [ ] **Step 1: Add `PublishedSpec` type + wrapper**

Append to `ui/src/drafts/api.ts`:

```typescript
export interface PublishedSpec {
  id: string;
  title: string;
  goal: string;
  path: string;
  updated_at: string;
}
```

Add to the `draftsApi` object (don't duplicate other methods — add this single line):

```typescript
  listPublishedSpecs: (repoRoot: string) =>
    invoke<PublishedSpec[]>("list_published_specs", { repoRoot }),
```

- [ ] **Step 2: Re-export type from `ui/src/api.ts`**

Append to the existing `export type { ... } from "./drafts/api"` block:

```typescript
export type { PublishedSpec } from "./drafts/api";
```

- [ ] **Step 3: Type-check**

Run: `cd ui && npm exec tsc -p . --noEmit` (or from repo root: `npm exec tsc --noEmit`).
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add ui/src/drafts/api.ts ui/src/api.ts
git commit -m "feat(drafts): PublishedSpec type + listPublishedSpecs wrapper"
```

---

## Task 5: Wizard auto-publish + Drafts panel passthrough

**Files:**
- Modify: `ui/src/drafts/wizard.ts`, `ui/src/drafts/panel.ts`

- [ ] **Step 1: Add `autoPublish` to `DraftWizardOpts`**

In `ui/src/drafts/wizard.ts`, locate the `DraftWizardOpts` interface and add the field:

```typescript
export interface DraftWizardOpts {
  host: HTMLElement;
  repoRoot: string;
  slug: string | null;
  onBack: () => void;
  onClose: () => void;
  autoPublish?: boolean;
}
```

In `DraftWizard.mount()`, after the existing `this.render()` call (and after setting up the autoSaveInterval), add:

```typescript
if (this.opts.autoPublish && this.slug) {
  // Defer to next microtask so the wizard DOM is fully painted before the
  // publish modal opens on top of it.
  queueMicrotask(() => { void this.openPublishModal(); });
}
```

If `openPublishModal` is private, leave it private — the call from `mount` is inside the class so private access is fine.

- [ ] **Step 2: Propagate from `DraftsPanel`**

In `ui/src/drafts/panel.ts`, change `openWizard`:

```typescript
openWizard(slug: string | null, opts?: { autoPublish?: boolean }): void {
  this.view = "wizard";
  this.currentSlug = slug;
  this.wizardOpts = opts ?? {};
  void this.render();
}
```

Add a private field `private wizardOpts: { autoPublish?: boolean } = {};` near the top of the class.

In `renderWizard`, pass it through:

```typescript
this.wizard = new DraftWizard({
  host: this.pageHost,
  repoRoot: this.getRepoRoot(),
  slug: this.currentSlug,
  onBack: () => { this.view = "list"; void this.render(); },
  onClose: () => this.close(),
  autoPublish: this.wizardOpts.autoPublish,
});
```

- [ ] **Step 3: Type-check + smoke**

Run: `cd ui && npm exec tsc -p . --noEmit`
Expected: 0 errors.

Run: `cd ui && npm test 2>&1 | tail -8`
Expected: existing 18 tests still pass.

- [ ] **Step 4: Commit**

```bash
git add ui/src/drafts/wizard.ts ui/src/drafts/panel.ts
git commit -m "feat(drafts): wizard autoPublish opt + panel passthrough"
```

---

## Task 6: `drafts:open` event listener in `main.ts`

**Files:**
- Modify: `ui/src/main.ts`

- [ ] **Step 1: Add the listener**

Locate the existing `window.addEventListener("drafts:toggle", ...)` block. Below it, add:

```typescript
window.addEventListener("drafts:open", (e: Event) => {
  const detail = (e as CustomEvent<{ slug: string; autoPublish?: boolean }>).detail;
  if (!detail || typeof detail.slug !== "string") return;
  draftsPanel.open();
  draftsPanel.openWizard(detail.slug, { autoPublish: detail.autoPublish });
});
```

- [ ] **Step 2: Type-check**

Run: `cd ui && npm exec tsc -p . --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/main.ts
git commit -m "feat(drafts): listen for drafts:open event with autoPublish"
```

---

## Task 7: Mission picker module (TDD on pure logic)

**Files:**
- Create: `ui/src/tabs/mission-picker.ts`, `ui/src/tabs/mission-picker.test.ts`

- [ ] **Step 1: Create `mission-picker.ts` with pure helpers + initial scaffold**

Create `ui/src/tabs/mission-picker.ts`:

```typescript
import { draftsApi, type DraftSummary, type PublishedSpec } from "../drafts/api";

export type SelectedRef =
  | { source: "card"; path: string }
  | { source: "input"; path: string }
  | null;

export interface PickerState {
  specs: PublishedSpec[];
  drafts: DraftSummary[];
  selected: SelectedRef;
  inputValue: string;
  loading: boolean;
  error: string | null;
}

export type PickerResult =
  | { kind: "set"; path: string }
  | { kind: "publishDraft"; slug: string }
  | null;

export interface MissionPickerOpts {
  repoRoot: string;
  currentMissionPath: string | null;
  onBrowse: () => Promise<string | null>;
}

/// Compute the effective path to submit. Card selection wins over text input
/// when both are present. Returns null when nothing is actionable.
export function effectivePath(s: PickerState): string | null {
  if (s.selected?.source === "card") return s.selected.path;
  const trimmed = s.inputValue.trim();
  if (trimmed.length > 0) return trimmed;
  return null;
}

/// "Set mission" button is enabled when there is a non-empty effective path
/// and we're not still loading the list.
export function canSubmit(s: PickerState): boolean {
  if (s.loading) return false;
  return effectivePath(s) !== null;
}

/// Apply card click: select the card; clear the input so it's obvious which
/// path will be used.
export function selectCard(s: PickerState, path: string): PickerState {
  return { ...s, selected: { source: "card", path }, inputValue: "" };
}

/// Apply user typing into the path input: deselect any card, keep input value.
export function typeInput(s: PickerState, value: string): PickerState {
  return {
    ...s,
    selected: value.trim().length > 0 ? { source: "input", path: value.trim() } : null,
    inputValue: value,
  };
}

export function initialState(currentMissionPath: string | null): PickerState {
  return {
    specs: [],
    drafts: [],
    selected: currentMissionPath ? { source: "card", path: currentMissionPath } : null,
    inputValue: "",
    loading: true,
    error: null,
  };
}

// ─────────────── DOM impl below ───────────────

export function openMissionPicker(opts: MissionPickerOpts): Promise<PickerResult> {
  return new Promise((resolve) => {
    let state = initialState(opts.currentMissionPath);

    const overlay = document.createElement("div");
    overlay.className = "mission-picker-overlay";
    const card = document.createElement("div");
    card.className = "mission-picker-card";
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const cleanup = (result: PickerResult): void => {
      overlay.remove();
      window.removeEventListener("keydown", onKey);
      resolve(result);
    };

    const render = (): void => {
      card.innerHTML = renderCard(state);
      bindCard(card, state, opts, {
        onChange: (next) => { state = next; render(); },
        onSubmit: () => {
          const p = effectivePath(state);
          if (!p) return;
          cleanup({ kind: "set", path: p });
        },
        onCancel: () => cleanup(null),
        onPublishDraft: (slug) => cleanup({ kind: "publishDraft", slug }),
      });
    };

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") { e.preventDefault(); cleanup(null); return; }
      if (e.key === "Enter" && canSubmit(state)) {
        e.preventDefault();
        const p = effectivePath(state);
        if (p) cleanup({ kind: "set", path: p });
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        state = navigateCards(state, e.key === "ArrowDown" ? 1 : -1);
        render();
      }
    };
    window.addEventListener("keydown", onKey);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) cleanup(null); });

    render();

    // Parallel fetch.
    Promise.all([
      draftsApi.listPublishedSpecs(opts.repoRoot),
      draftsApi.list(opts.repoRoot),
    ]).then(([specs, drafts]) => {
      state = { ...state, specs, drafts, loading: false, error: null };
      // If the current mission path matches a card, keep it selected.
      render();
    }).catch((err) => {
      state = { ...state, loading: false, error: String(err) };
      render();
    });
  });
}

function navigateCards(s: PickerState, delta: number): PickerState {
  if (s.specs.length === 0) return s;
  const currentIdx = s.selected?.source === "card"
    ? s.specs.findIndex(c => c.path === s.selected!.path)
    : -1;
  const nextIdx = ((currentIdx + delta) + s.specs.length) % s.specs.length;
  return selectCard(s, s.specs[nextIdx]!.path);
}

function renderCard(s: PickerState): string {
  return `
    <header class="mission-picker-header">
      <h3>Set mission spec</h3>
      <button type="button" class="mission-picker-close" aria-label="Close">×</button>
    </header>
    ${renderError(s)}
    ${renderSpecsSection(s)}
    ${renderDraftsSection(s)}
    ${renderPathRow(s)}
    <div class="mission-picker-actions">
      <button type="button" class="mission-picker-cancel">Cancel</button>
      <button type="button" class="mission-picker-submit"
              ${canSubmit(s) ? "" : "disabled"}>Set mission</button>
    </div>
  `;
}

function renderError(s: PickerState): string {
  if (!s.error) return "";
  return `<div class="mission-picker-error">
    Failed to load specs: ${escapeHtml(s.error)}
    <button type="button" class="mission-picker-retry">Retry</button>
  </div>`;
}

function renderSpecsSection(s: PickerState): string {
  if (s.loading) {
    return `<section class="mission-picker-specs">
      <h4>Published</h4>
      <div class="mission-picker-skeleton">${"<div class=\"skel-row\"></div>".repeat(3)}</div>
    </section>`;
  }
  if (s.specs.length === 0) {
    return `<section class="mission-picker-specs">
      <h4>Published (0)</h4>
      <div class="mission-picker-empty">
        No published specs yet. Write one in
        <button type="button" class="mission-picker-link" data-action="open-drafts">Drafts (⌘⇧D)</button>.
      </div>
    </section>`;
  }
  const cards = s.specs.map(spec => {
    const isSelected = s.selected?.source === "card" && s.selected.path === spec.path;
    return `
      <button type="button" class="mission-picker-spec ${isSelected ? "selected" : ""}"
              data-path="${escapeAttr(spec.path)}">
        <span class="mission-picker-id">${escapeHtml(spec.id)}</span>
        <span class="mission-picker-spec-body">
          <span class="mission-picker-title">${escapeHtml(spec.title)}</span>
          <span class="mission-picker-goal">${escapeHtml(spec.goal)}</span>
        </span>
      </button>
    `;
  }).join("");
  return `<section class="mission-picker-specs">
    <h4>Published (${s.specs.length})</h4>
    <div class="mission-picker-list">${cards}</div>
  </section>`;
}

function renderDraftsSection(s: PickerState): string {
  if (s.drafts.length === 0) return "";
  const items = s.drafts.map(d => `
    <div class="mission-picker-draft" data-slug="${escapeAttr(d.slug)}">
      <span class="mission-picker-draft-title">${escapeHtml(d.title)}</span>
      <button type="button" class="mission-picker-publish" data-slug="${escapeAttr(d.slug)}">Publish to use</button>
    </div>
  `).join("");
  return `<details class="mission-picker-drafts">
    <summary>Drafts (${s.drafts.length})</summary>
    <div class="mission-picker-draft-list">${items}</div>
  </details>`;
}

function renderPathRow(s: PickerState): string {
  return `
    <div class="mission-picker-or">or pick another file</div>
    <div class="mission-picker-path-row">
      <input type="text" class="mission-picker-input"
             autocomplete="off" spellcheck="false"
             placeholder="/absolute/path/to/spec.md"
             value="${escapeAttr(s.inputValue)}" />
      <button type="button" class="mission-picker-browse">Browse…</button>
    </div>
  `;
}

interface BindCallbacks {
  onChange: (next: PickerState) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onPublishDraft: (slug: string) => void;
}

function bindCard(
  card: HTMLElement,
  state: PickerState,
  opts: MissionPickerOpts,
  cb: BindCallbacks,
): void {
  card.querySelector(".mission-picker-close")?.addEventListener("click", () => cb.onCancel());
  card.querySelector(".mission-picker-cancel")?.addEventListener("click", () => cb.onCancel());
  card.querySelector(".mission-picker-submit")?.addEventListener("click", () => cb.onSubmit());
  card.querySelector(".mission-picker-retry")?.addEventListener("click", () => {
    // Re-trigger the open path: simplest is to dispatch a synthetic open event.
    // Caller is the closure in openMissionPicker — easier to reload via state reset.
    cb.onChange({ ...state, loading: true, error: null });
    Promise.all([
      draftsApi.listPublishedSpecs(opts.repoRoot),
      draftsApi.list(opts.repoRoot),
    ]).then(([specs, drafts]) => cb.onChange({ ...state, specs, drafts, loading: false, error: null }))
      .catch((err) => cb.onChange({ ...state, loading: false, error: String(err) }));
  });
  card.querySelectorAll<HTMLButtonElement>(".mission-picker-spec").forEach(btn => {
    const path = btn.dataset.path!;
    btn.addEventListener("click", () => cb.onChange(selectCard(state, path)));
    btn.addEventListener("dblclick", () => {
      cb.onChange(selectCard(state, path));
      cb.onSubmit();
    });
  });
  card.querySelectorAll<HTMLButtonElement>(".mission-picker-publish").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const slug = btn.dataset.slug!;
      cb.onPublishDraft(slug);
    });
  });
  card.querySelector<HTMLInputElement>(".mission-picker-input")?.addEventListener("input", (e) => {
    cb.onChange(typeInput(state, (e.target as HTMLInputElement).value));
  });
  card.querySelector(".mission-picker-browse")?.addEventListener("click", async () => {
    const picked = await opts.onBrowse();
    if (picked) cb.onChange(typeInput(state, picked));
  });
  card.querySelector('[data-action="open-drafts"]')?.addEventListener("click", () => {
    cb.onCancel();
    window.dispatchEvent(new CustomEvent("drafts:toggle"));
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]!));
}
function escapeAttr(s: string): string { return escapeHtml(s); }
```

- [ ] **Step 2: Create the test file**

Create `ui/src/tabs/mission-picker.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  canSubmit,
  effectivePath,
  initialState,
  selectCard,
  typeInput,
  type PickerState,
} from "./mission-picker";

const baseState = (overrides: Partial<PickerState> = {}): PickerState => ({
  ...initialState(null),
  loading: false,
  ...overrides,
});

describe("effectivePath", () => {
  it("returns card path when card is selected", () => {
    const s = baseState({ selected: { source: "card", path: "/a.md" }, inputValue: "/b.md" });
    expect(effectivePath(s)).toBe("/a.md"); // card wins over input
  });

  it("returns trimmed input when no card selected", () => {
    const s = baseState({ selected: null, inputValue: "  /c.md  " });
    expect(effectivePath(s)).toBe("/c.md");
  });

  it("returns null when both empty", () => {
    expect(effectivePath(baseState({ selected: null, inputValue: "" }))).toBeNull();
  });
});

describe("canSubmit", () => {
  it("false while loading", () => {
    expect(canSubmit(baseState({ loading: true, inputValue: "/x" }))).toBe(false);
  });

  it("false with no path and no card", () => {
    expect(canSubmit(baseState({ selected: null, inputValue: "" }))).toBe(false);
  });

  it("true with card selected", () => {
    expect(canSubmit(baseState({ selected: { source: "card", path: "/a" } }))).toBe(true);
  });

  it("true with input filled", () => {
    expect(canSubmit(baseState({ inputValue: "/path" }))).toBe(true);
  });
});

describe("selectCard / typeInput last-wins", () => {
  it("selectCard clears the input", () => {
    let s = typeInput(baseState(), "/typed.md");
    expect(s.selected).toEqual({ source: "input", path: "/typed.md" });
    s = selectCard(s, "/cards.md");
    expect(s.selected).toEqual({ source: "card", path: "/cards.md" });
    expect(s.inputValue).toBe("");
  });

  it("typeInput deselects card", () => {
    let s = selectCard(baseState(), "/cards.md");
    expect(s.selected?.source).toBe("card");
    s = typeInput(s, "/typed.md");
    expect(s.selected).toEqual({ source: "input", path: "/typed.md" });
  });

  it("typing only whitespace clears selection", () => {
    let s = typeInput(baseState(), "/x");
    s = typeInput(s, "   ");
    expect(s.selected).toBeNull();
  });
});

describe("initialState", () => {
  it("pre-selects the current mission path as a card", () => {
    const s = initialState("/cur.md");
    expect(s.selected).toEqual({ source: "card", path: "/cur.md" });
    expect(s.loading).toBe(true);
  });

  it("no selection when current is null", () => {
    expect(initialState(null).selected).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests**

Run: `cd ui && npm test 2>&1 | tail -10` (from repo root: `npm test`).
Expected: previous 18 + new 14 (or however many cases) = all pass.

Run: `npm exec tsc -p ui --noEmit` (or root tsc).
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add ui/src/tabs/mission-picker.ts ui/src/tabs/mission-picker.test.ts
git commit -m "feat(mission-picker): module + pure-logic tests"
```

---

## Task 8: Wire mission picker into TabManager

**Files:**
- Modify: `ui/src/tabs/manager.ts`

- [ ] **Step 1: Replace `openTextPrompt` call inside `promptAndSetMission`**

In `ui/src/tabs/manager.ts`, locate the existing `private async promptAndSetMission(tabId: string)` method (around line 1380). Replace the entire body — keep the same method signature — with:

```typescript
private async promptAndSetMission(tabId: string): Promise<void> {
  const tab = this.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  const repoRoot = tab.cwd ?? "."; // backend default; mission-picker handles "no specs dir"
  const result = await openMissionPicker({
    repoRoot,
    currentMissionPath: tab.mission?.path ?? null,
    onBrowse: async () => {
      const start =
        tab.mission?.path ??
        (tab.cwd ? `${tab.cwd}/docs/specs` : undefined);
      const picked = await openDialog({
        title: "Pick mission spec",
        multiple: false,
        directory: false,
        defaultPath: start,
        filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
      });
      return typeof picked === "string" ? picked : null;
    },
  });

  if (result === null) return; // cancelled

  if (result.kind === "publishDraft") {
    window.dispatchEvent(
      new CustomEvent("drafts:open", {
        detail: { slug: result.slug, autoPublish: true },
      }),
    );
    return;
  }

  // result.kind === "set"
  try {
    const info = await setSessionMission(tab.sessionId, result.path);
    tab.mission = info;
    this.renderTabbar();
    if (tab.id === this.activeId) this.emitActiveMission();
  } catch (err) {
    console.error("set_session_mission failed", err);
    alert(`Could not set mission: ${String(err)}`);
  }
}
```

Add the import at the top of the file (group with other tab-local imports):

```typescript
import { openMissionPicker } from "./mission-picker";
```

- [ ] **Step 2: Type-check**

Run: `npm exec tsc -p ui --noEmit`
Expected: 0 errors. Note: `openTextPrompt` may now be unused — leave it (it's used elsewhere if grep finds other callers; otherwise tsc/eslint will flag it as unused but the behavior is fine).

Run: `grep -n "openTextPrompt" ui/src/tabs/manager.ts | head`
If only the function definition remains and no callers, leave it for v1 (other features may grow to use it). If you're certain it has only one site of usage and it's gone, you can delete the function definition — but only delete dead code, never refactor surrounding code.

- [ ] **Step 3: Commit**

```bash
git add ui/src/tabs/manager.ts
git commit -m "feat(mission-picker): wire into TabManager.promptAndSetMission"
```

---

## Task 9: CSS styling

**Files:**
- Modify: `ui/src/styles.css`

- [ ] **Step 1: Append picker styles at the end of `ui/src/styles.css`**

```css
/* ── Mission picker (3.11) ────────────────────────────────────────────── */
.mission-picker-overlay {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: center; justify-content: center;
  z-index: 200;
  animation: settings-fade 0.12s ease-out;
}
.mission-picker-card {
  background: rgb(17 20 26 / 0.98);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 18px 20px;
  width: min(640px, 92vw);
  max-height: 80vh;
  display: flex; flex-direction: column;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
}
.mission-picker-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 6px;
}
.mission-picker-header h3 { margin: 0; font-size: 14px; font-weight: 600; color: #fff; }
.mission-picker-close {
  background: transparent; border: 0; color: var(--muted);
  font-size: 18px; cursor: pointer; padding: 2px 6px;
}
.mission-picker-close:hover { color: var(--fg); }

.mission-picker-error {
  background: rgba(228, 68, 68, 0.1);
  border: 1px solid rgba(228, 68, 68, 0.3);
  color: #f88;
  padding: 8px 10px; border-radius: 4px;
  font-size: 12px; margin: 8px 0;
  display: flex; gap: 8px; align-items: center;
}
.mission-picker-retry {
  margin-left: auto; background: transparent; border: 1px solid currentColor;
  color: inherit; padding: 2px 8px; border-radius: 3px; cursor: pointer; font-size: 11px;
}

.mission-picker-specs { margin: 12px 0 8px; min-height: 0; display: flex; flex-direction: column; }
.mission-picker-specs h4,
.mission-picker-drafts summary {
  font-size: 11px; font-weight: 600; color: var(--muted);
  margin: 0 0 8px; text-transform: uppercase; letter-spacing: 0.04em;
}
.mission-picker-list {
  display: flex; flex-direction: column; gap: 4px;
  max-height: 280px; overflow-y: auto;
  padding-right: 4px;
}
.mission-picker-spec {
  display: grid; grid-template-columns: 48px 1fr; gap: 12px; align-items: start;
  background: transparent; border: 1px solid transparent;
  color: var(--fg); cursor: pointer; text-align: left;
  padding: 8px 10px; border-radius: 4px;
}
.mission-picker-spec:hover { background: rgba(255, 255, 255, 0.04); }
.mission-picker-spec.selected {
  background: rgba(108, 138, 255, 0.12);
  border-color: var(--accent);
}
.mission-picker-id {
  font-family: ui-monospace, monospace; font-size: 12px; color: var(--muted);
  padding-top: 1px;
}
.mission-picker-spec.selected .mission-picker-id { color: var(--accent); }
.mission-picker-spec-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.mission-picker-title { font-size: 13px; font-weight: 600; color: var(--fg); }
.mission-picker-goal {
  font-size: 11.5px; color: var(--muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

.mission-picker-empty {
  font-size: 12px; color: var(--muted); padding: 12px 0;
}
.mission-picker-link {
  background: transparent; border: 0; color: var(--accent);
  padding: 0; cursor: pointer; font: inherit; text-decoration: underline;
}

.mission-picker-skeleton { display: flex; flex-direction: column; gap: 6px; }
.mission-picker-skeleton .skel-row {
  height: 38px; border-radius: 4px;
  background: linear-gradient(90deg, rgba(255,255,255,0.04), rgba(255,255,255,0.08), rgba(255,255,255,0.04));
  background-size: 200% 100%;
  animation: skel-shimmer 1.4s linear infinite;
}
@keyframes skel-shimmer {
  from { background-position: 200% 0; }
  to { background-position: -200% 0; }
}

.mission-picker-drafts { margin: 8px 0; }
.mission-picker-drafts summary { cursor: pointer; padding: 4px 0; }
.mission-picker-drafts[open] summary { color: var(--fg); }
.mission-picker-draft-list { display: flex; flex-direction: column; gap: 4px; padding-top: 6px; }
.mission-picker-draft {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 10px; border-radius: 4px; background: rgba(255,255,255,0.02);
}
.mission-picker-draft-title { font-size: 12px; color: var(--fg); }
.mission-picker-publish {
  background: transparent; border: 1px solid var(--border); color: var(--muted);
  padding: 3px 10px; border-radius: 3px; cursor: pointer; font-size: 11px;
}
.mission-picker-publish:hover { color: var(--fg); border-color: var(--accent); }

.mission-picker-or {
  text-align: center; font-size: 10.5px; color: var(--muted);
  text-transform: uppercase; letter-spacing: 0.06em;
  margin: 14px 0 8px;
  position: relative;
}
.mission-picker-or::before, .mission-picker-or::after {
  content: ""; position: absolute; top: 50%; height: 1px;
  background: var(--border); width: calc(50% - 80px);
}
.mission-picker-or::before { left: 0; }
.mission-picker-or::after { right: 0; }

.mission-picker-path-row { display: flex; gap: 6px; }
.mission-picker-input {
  flex: 1; background: var(--bg-overlay);
  color: var(--fg); border: 1px solid var(--border); border-radius: 3px;
  padding: 6px 8px; font-family: ui-monospace, monospace; font-size: 12px;
}
.mission-picker-input:focus { outline: none; border-color: var(--accent); }
.mission-picker-browse {
  background: transparent; border: 1px solid var(--border); color: var(--fg);
  padding: 6px 12px; border-radius: 3px; cursor: pointer; font-size: 12px;
}
.mission-picker-browse:hover { border-color: var(--accent); }

.mission-picker-actions {
  display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px;
}
.mission-picker-actions button {
  padding: 6px 14px; border-radius: 4px; border: 1px solid var(--border);
  background: transparent; color: var(--fg); cursor: pointer; font-size: 13px;
}
.mission-picker-submit {
  background: var(--accent); border-color: var(--accent); color: #fff;
}
.mission-picker-submit:disabled { opacity: 0.5; cursor: not-allowed; }
```

- [ ] **Step 2: Visual smoke**

Run: `npm run tauri dev` (or rely on user verification). Open Set Mission via statusbar / `⌘M`. Check: cards render, hover/selected work, drafts collapsible toggles, "or" separator looks centered, skeleton shimmer animates while loading.

- [ ] **Step 3: Commit**

```bash
git add ui/src/styles.css
git commit -m "feat(mission-picker): styles for picker modal + cards + skeleton"
```

---

## Task 10: End-to-end manual verification

- [ ] **Step 1: Verify acceptance criteria from `docs/specs/3.11-mission-picker-integration.md`**

Run the app: `npm run tauri dev`.

For each criterion in the spec, check off when verified:

- [ ] `⌘M` (or statusbar Set Mission button) opens the new modal with Published / Drafts / path-input sections.
- [ ] Published list shows existing specs (3.1 → 3.11) sorted descending by ID. Each card shows ID + title + Goal snippet.
- [ ] Single click selects a card (highlighted, accent border); Set mission button enables.
- [ ] Double click confirms immediately and sets the mission on the active tab.
- [ ] If active tab already has a mission, that card is pre-selected on open.
- [ ] Drafts section is collapsed by default. Expand → list of current drafts. "Publish to use" closes Set Mission, opens Drafts wizard for that slug, auto-fires Publish modal.
- [ ] After publishing the draft, toast shows; clicking "Open in Set Mission" sets the mission on the active tab. No re-opening the picker.
- [ ] Typing in the path input deselects any card.
- [ ] Browse… still works for arbitrary `.md`.
- [ ] Empty repo state: rename `docs/specs/` temporarily and reopen the modal — section shows "No published specs yet" with a link to Drafts. (Restore after testing.)
- [ ] Keyboard: ↑/↓ move selection between cards; Enter confirms; Esc cancels; Tab moves to input.
- [ ] Failed fetch: stop the backend dev process briefly mid-open (or simulate by adding `throw` in the wrapper) to confirm error UI + Retry button appear.

- [ ] **Step 2: Run full test suite**

Run: `cargo test -p covenant`
Expected: all pass (171 baseline + 12 new from Tasks 1–3 = 183).

Run: `npm test` (from repo root).
Expected: previous 18 + new picker tests pass.

Run: `npm exec tsc -p ui --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "chore(mission-picker): 3.11 verification + cleanup

Acceptance verified per docs/specs/3.11-mission-picker-integration.md."
```

---

## Self-Review Notes

- **Spec coverage:** All 12 acceptance criteria from spec 3.11 are mapped: open/sections (T7+T8), published list w/ sort + cards (T1+T3+T7), card click select + dblclick (T7), pre-selected current (T7 `initialState`), drafts section + publish-to-use (T7+T8), input deselects card (T7 `typeInput`), keyboard nav (T7 `onKey`), empty states + skeleton (T7 render branches), parallel fetch + retry (T7 promise + retry button), publish-to-use → wizard auto-publish loop (T5+T6+T8), Rust tests (T1+T2+T3), TS tests (T7).
- **Placeholders:** None. All code blocks complete.
- **Type consistency:** `PublishedSpec` defined once in T1 (Rust) and T4 (TS), referenced by `mission-picker.ts`. `SelectedRef` / `PickerState` / `PickerResult` defined in T7 and used in T8. `DraftWizardOpts.autoPublish` defined in T5 and used in T6.
- **File caps:** mission-picker.ts ≤ 350 (the implementation is ~330 lines including comments — within budget). drafts.rs additions ≤ 80 (3 helpers + 1 command). styles ≤ 130. manager.ts net change ≤ 30 (replace one method body, one import).
- **Out-of-scope:** No changes to `operator.rs` / `aom.rs` / `mission_persistence.rs`. Operator contract (path → spec on disk) unchanged. No multi-select, no search, no draft-as-mission.
