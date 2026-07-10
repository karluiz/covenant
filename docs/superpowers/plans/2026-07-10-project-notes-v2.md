# Project Notes v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the project-notes panel to a self-explaining 3-tab taxonomy (Commands · Prompts · Notes), merge docs into an editable Notes stream, add an "Add to notes" capture in the terminal selection menu, and give the expanded view the Canon cockpit shell.

**Architecture:** SQLite-backed `project_notes` gains a `source` column and edit support; the retired `project_docs` blob is migrated into a Note on first snapshot. The `notes` tab renders editable cards with a provenance line. The panel's fullscreen toggle mounts a `.canon-cockpit` overlay reusing Canon's existing CSS classes (no new CSS).

**Tech Stack:** Rust (rusqlite, tokio, tauri commands), TypeScript (Vitest), no new dependencies.

## Global Constraints

- All UI chrome copy is English.
- No native `element.title` tooltips — use `attachTooltip` from `ui/src/tooltip/tooltip.ts`.
- Group/project names render uppercase via CSS, never string mutation.
- No `unwrap()` outside `#[cfg(test)]`/`main()`. Sync rusqlite calls run inside `spawn_blocking`.
- Reuse existing `.canon-cockpit*` CSS classes for the expanded shell — do not fork styles.
- Run Vitest and `cargo test` from the repo ROOT, not `ui/`.
- Executor id→label map (verbatim, from `manager.ts:4512`): `{ copilot: "Copilot", pi: "pi", claude: "Claude", opencode: "OpenCode" }`.

---

### Task 1: Backend — `source` column, `update_note`, `project_note_update`

**Files:**
- Modify: `crates/app/src/storage.rs` (SCHEMA `project_notes` block ~155-171; migration section ~671)
- Modify: `crates/app/src/project_notes.rs` (Note struct ~33; append_note ~206; list_notes free fn ~318; add update_note; command surface ~600; snapshot ~77 will change in Task 2)
- Modify: `crates/app/src/lib.rs` (invoke_handler ~4851)

**Interfaces:**
- Produces: `Note { id, group_id, body, source: Option<String>, created_at_unix_ms }`; `Store::append_note(&self, group_id, body, source: Option<&str>) -> Result<Note>`; `Store::update_note(&self, id, body) -> Result<Option<Note>>`; tauri command `project_note_update(id, body) -> Option<Note>`; `project_note_append(group_id, body, source: Option<String>) -> Note`.

- [ ] **Step 1: Write failing tests** in `crates/app/src/project_notes.rs` `mod tests`:

```rust
#[tokio::test]
async fn note_source_persists_and_updates() {
    let s = fresh_store();
    let n = s.append_note("g1", "hello", Some("from Claude · tab 2")).await.unwrap();
    assert_eq!(n.source.as_deref(), Some("from Claude · tab 2"));

    let plain = s.append_note("g1", "plain", None).await.unwrap();
    assert_eq!(plain.source, None);

    let updated = s.update_note(&n.id, "edited").await.unwrap().unwrap();
    assert_eq!(updated.body, "edited");
    assert_eq!(updated.source.as_deref(), Some("from Claude · tab 2")); // source preserved
    assert!(s.update_note("missing-id", "x").await.unwrap().is_none());
}
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cargo test -p covenant-app project_notes::tests::note_source_persists_and_updates 2>&1 | tail -20`
Expected: FAIL — `append_note` takes 2 args / `update_note` not found. (If the crate name differs, get it from `crates/app/Cargo.toml` `[package] name` and use `-p <name>`.)

- [ ] **Step 3: Add `source` to the schema** in `crates/app/src/storage.rs`. In the `CREATE TABLE IF NOT EXISTS project_notes (...)` block add the column:

```sql
CREATE TABLE IF NOT EXISTS project_notes (
    id                 TEXT PRIMARY KEY,
    group_id           TEXT NOT NULL,
    body               TEXT NOT NULL,
    source             TEXT,
    created_at_unix_ms INTEGER NOT NULL
);
```

Then add an idempotent migration for existing DBs, next to the other `let _ = conn.execute("ALTER TABLE ...")` calls (~line 730):

```rust
// Project Notes v2: capture provenance ("from Claude · tab 2"). NULL for
// pre-v2 notes and hand-written ones.
let _ = conn.execute("ALTER TABLE project_notes ADD COLUMN source TEXT", []);
```

- [ ] **Step 4: Add `source` to the `Note` struct** (`project_notes.rs` ~33):

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    pub id: String,
    pub group_id: String,
    pub body: String,
    pub source: Option<String>,
    pub created_at_unix_ms: i64,
}
```

- [ ] **Step 5: Thread `source` through `append_note`** (`project_notes.rs` ~206):

```rust
pub async fn append_note(&self, group_id: &str, body: &str, source: Option<&str>) -> Result<Note> {
    let conn = self.conn.clone();
    let group_id = group_id.to_owned();
    let body = body.to_owned();
    let source = source.map(|s| s.to_owned());
    tokio::task::spawn_blocking(move || -> Result<Note> {
        let conn = conn.blocking_lock();
        let now = Self::now_ms();
        let id = Ulid::new().to_string();
        conn.execute(
            "INSERT INTO project_notes (id, group_id, body, source, created_at_unix_ms)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![&id, &group_id, &body, &source, now],
        )?;
        Ok(Note { id, group_id, body, source, created_at_unix_ms: now })
    })
    .await
    .map_err(|e| Error::Join(e.to_string()))?
}
```

- [ ] **Step 6: Update both `list_notes` SELECTs** (free fn ~318) to read `source`. In each of the two branches, change the SQL column list and the row closure:

```rust
// SQL (both branches): "SELECT id, group_id, body, source, created_at_unix_ms FROM project_notes ..."
// row closure (both branches):
|r| Ok(Note {
    id: r.get(0)?,
    group_id: r.get(1)?,
    body: r.get(2)?,
    source: r.get(3)?,
    created_at_unix_ms: r.get(4)?,
})
```

(Keep `ORDER BY created_at_unix_ms DESC` and the `LIMIT`/`before_ts` params exactly as they are — only the column list, the closure, and the `?N` index of the trailing params shift by one where `created_at_unix_ms` was column 3.)

- [ ] **Step 7: Add `update_note`** (in `impl Store`, after `delete_note`):

```rust
pub async fn update_note(&self, id: &str, body: &str) -> Result<Option<Note>> {
    let conn = self.conn.clone();
    let id = id.to_owned();
    let body = body.to_owned();
    tokio::task::spawn_blocking(move || -> Result<Option<Note>> {
        let conn = conn.blocking_lock();
        let changed = conn.execute(
            "UPDATE project_notes SET body = ?2 WHERE id = ?1",
            params![&id, &body],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        let note = conn.query_row(
            "SELECT id, group_id, body, source, created_at_unix_ms
               FROM project_notes WHERE id = ?1",
            params![&id],
            |r| Ok(Note {
                id: r.get(0)?,
                group_id: r.get(1)?,
                body: r.get(2)?,
                source: r.get(3)?,
                created_at_unix_ms: r.get(4)?,
            }),
        )?;
        Ok(Some(note))
    })
    .await
    .map_err(|e| Error::Join(e.to_string()))?
}
```

- [ ] **Step 8: Add the `project_note_update` command** and widen `project_note_append` (command surface ~600):

```rust
#[tauri::command]
pub async fn project_note_append(
    store: State<'_, Store>,
    group_id: String,
    body: String,
    source: Option<String>,
) -> std::result::Result<Note, String> {
    store.append_note(&group_id, &body, source.as_deref()).await.map_err(map_err)
}

#[tauri::command]
pub async fn project_note_update(
    store: State<'_, Store>,
    id: String,
    body: String,
) -> std::result::Result<Option<Note>, String> {
    store.update_note(&id, &body).await.map_err(map_err)
}
```

- [ ] **Step 9: Register `project_note_update`** in `crates/app/src/lib.rs` invoke_handler, right after `project_notes::project_note_list,`:

```rust
            project_notes::project_note_update,
```

- [ ] **Step 10: Run tests, verify pass**

Run: `cargo test -p covenant-app project_notes 2>&1 | tail -20`
Expected: PASS (the new test plus the existing `command_crud_roundtrip` / `snapshot_isolated_per_group`). Existing tests that call `append_note("..","..")` with two args must be updated to pass `None` as the third arg — do that now if the compiler flags them.

- [ ] **Step 11: Commit**

```bash
git add crates/app/src/storage.rs crates/app/src/project_notes.rs crates/app/src/lib.rs
git commit -m "feat(notes): note source column + update_note command"
```

---

### Task 2: Backend — retire `project_docs`, migrate into a Note

**Files:**
- Modify: `crates/app/src/project_notes.rs` (Snapshot struct ~40; snapshot ~77; remove get_docs/save_docs async methods ~259; remove project_docs_get/save commands ~630)
- Modify: `crates/app/src/lib.rs` (invoke_handler — remove two lines ~4854-4855)

**Interfaces:**
- Consumes: `get_docs` free fn (kept — used by migration and the reserved `build_context`), `append_note` (Task 1).
- Produces: `Snapshot { commands: Vec<Command>, notes: Vec<Note> }` (no `docs` field). Migration runs inside `snapshot`.

- [ ] **Step 1: Write the failing migration test** in `mod tests`:

```rust
#[tokio::test]
async fn docs_migrates_into_a_note_once() {
    let s = fresh_store();
    // Seed a legacy docs blob directly.
    {
        let conn = s.conn_for_test();
        conn.execute(
            "INSERT INTO project_docs (group_id, body, updated_at_unix_ms) VALUES ('g1','# legacy doc',1)",
            [],
        ).unwrap();
    }
    let snap = s.snapshot("g1").await.unwrap();
    assert!(snap.notes.iter().any(|n| n.body == "# legacy doc" && n.source.is_none()));
    // Idempotent: second snapshot does not create a duplicate.
    let snap2 = s.snapshot("g1").await.unwrap();
    assert_eq!(
        snap2.notes.iter().filter(|n| n.body == "# legacy doc").count(),
        1
    );
}
```

Add a test accessor in `impl Store` (guarded to tests):

```rust
#[cfg(test)]
pub fn conn_for_test(&self) -> std::sync::MutexGuard<'_, Connection> {
    self.conn.blocking_lock()
}
```

(If `Mutex` here is tokio's, `blocking_lock()` returns a `tokio::sync::MutexGuard` — adjust the return type to `tokio::sync::MutexGuard<'_, Connection>` to match the type already imported in this file.)

- [ ] **Step 2: Run test, verify it fails**

Run: `cargo test -p covenant-app project_notes::tests::docs_migrates_into_a_note_once 2>&1 | tail -20`
Expected: FAIL — Snapshot still has `docs`, no migration yet, or `conn_for_test` missing.

- [ ] **Step 3: Drop `docs` from `Snapshot`** (~40):

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Snapshot {
    pub commands: Vec<Command>,
    pub notes: Vec<Note>, // newest first, capped to 50
}
```

- [ ] **Step 4: Migrate inside `snapshot`** (~77) — replace the closure body:

```rust
tokio::task::spawn_blocking(move || -> Result<Snapshot> {
    let conn = conn.blocking_lock();
    // One-time migration: an existing per-group docs blob becomes a Note,
    // then the docs row is cleared so this never runs twice. Guarded by the
    // connection mutex, so concurrent opens can't double-insert.
    let legacy = get_docs(&conn, &group_id)?;
    if !legacy.trim().is_empty() {
        let now = Self::now_ms();
        let id = Ulid::new().to_string();
        conn.execute(
            "INSERT INTO project_notes (id, group_id, body, source, created_at_unix_ms)
             VALUES (?1, ?2, ?3, NULL, ?4)",
            params![&id, &group_id, &legacy, now],
        )?;
        conn.execute("DELETE FROM project_docs WHERE group_id = ?1", params![&group_id])?;
    }
    let commands = list_commands(&conn, &group_id)?;
    let notes = list_notes(&conn, &group_id, 50, None)?;
    Ok(Snapshot { commands, notes })
})
```

- [ ] **Step 5: Remove the docs async methods** — delete `pub async fn get_docs` and `pub async fn save_docs` (~259-289). Keep the free `fn get_docs(conn, group_id)` (~365) — the migration and the reserved `build_context` still use it.

- [ ] **Step 6: Remove the docs commands** — delete `#[tauri::command] pub async fn project_docs_get` and `project_docs_save` (~630). In `lib.rs`, delete these two invoke_handler lines:

```rust
            project_notes::project_docs_get,
            project_notes::project_docs_save,
```

- [ ] **Step 7: Run the whole crate's notes tests, verify pass**

Run: `cargo test -p covenant-app project_notes 2>&1 | tail -25`
Expected: PASS. Then `cargo build -p covenant-app 2>&1 | tail -15` — expect clean (a `dead_code` warning on the free `get_docs` is acceptable; if it errors, add `#[allow(dead_code)]` above the free fn).

- [ ] **Step 8: Commit**

```bash
git add crates/app/src/project_notes.rs crates/app/src/lib.rs
git commit -m "feat(notes): migrate project_docs into a Note; retire docs surface"
```

---

### Task 3: Frontend API — types + methods

**Files:**
- Modify: `ui/src/project-notes/api.ts`

**Interfaces:**
- Produces: `Note { id, group_id, body, source?: string, created_at_unix_ms }`; `Snapshot { commands, notes }`; `projectNotesApi.appendNote(groupId, body, source?)`, `projectNotesApi.updateNote(id, body)`. Removes `getDocs`/`saveDocs` and `Snapshot.docs`.

- [ ] **Step 1: Edit `Note`, `Snapshot`, and the notes methods** in `ui/src/project-notes/api.ts`:

```ts
export interface Note {
  id: string;
  group_id: string;
  body: string;
  source?: string | null;
  created_at_unix_ms: number;
}

export interface Snapshot {
  commands: Command[];
  notes: Note[];
}
```

Replace the note methods + delete the docs methods:

```ts
  appendNote: (groupId: string, body: string, source?: string) =>
    invoke<Note>("project_note_append", { groupId, body, source: source ?? null }),
  updateNote: (id: string, body: string) =>
    invoke<Note | null>("project_note_update", { id, body }),
  deleteNote: (id: string) => invoke<void>("project_note_delete", { id }),
  listNotes: (groupId: string, limit: number, beforeTs?: number) =>
    invoke<Note[]>("project_note_list", { groupId, limit, beforeTs }),
```

(Delete the `getDocs` and `saveDocs` entries entirely.)

- [ ] **Step 2: Type-check**

Run: `npm run build 2>&1 | tail -25` (from repo root)
Expected: FAIL, pointing at `docs-tab.ts` and `notes-tab.ts` (they use the removed methods / old signature). Those are fixed in Tasks 4-5. Confirm the errors are ONLY in those files, not in `api.ts` itself.

- [ ] **Step 3: Commit**

```bash
git add ui/src/project-notes/api.ts
git commit -m "feat(notes): api — note source, updateNote, drop docs"
```

---

### Task 4: Notes tab — provenance line + editable cards

**Files:**
- Modify: `ui/src/project-notes/notes-tab.ts`
- Test: `ui/src/project-notes/notes-tab.test.ts` (create)

**Interfaces:**
- Consumes: `projectNotesApi.appendNote/updateNote/deleteNote`, `Note.source` (Task 3).

- [ ] **Step 1: Write the failing test** `ui/src/project-notes/notes-tab.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotesTab } from "./notes-tab";
import { projectNotesApi } from "./api";

vi.mock("./api", () => ({
  projectNotesApi: {
    snapshot: vi.fn(),
    appendNote: vi.fn(),
    updateNote: vi.fn(),
    deleteNote: vi.fn(),
  },
}));

const note = (over = {}) => ({
  id: "1", group_id: "g", body: "hello", source: null,
  created_at_unix_ms: Date.now(), ...over,
});

describe("NotesTab", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders a source line when present, omits it when absent", async () => {
    vi.mocked(projectNotesApi.snapshot).mockResolvedValue({
      commands: [],
      notes: [note({ id: "a", source: "from Claude · tab 2" }), note({ id: "b", source: null })],
    } as never);
    const host = document.createElement("div");
    const tab = new NotesTab({ groupId: "g" });
    tab.mount(host);
    await Promise.resolve(); await Promise.resolve();
    const cards = host.querySelectorAll(".pn-note-card");
    expect(cards[0].querySelector(".pn-note-source")?.textContent).toBe("from Claude · tab 2");
    expect(cards[1].querySelector(".pn-note-source")).toBeNull();
  });

  it("saves an edit via updateNote", async () => {
    vi.mocked(projectNotesApi.snapshot).mockResolvedValue({ commands: [], notes: [note()] } as never);
    vi.mocked(projectNotesApi.updateNote).mockResolvedValue(note({ body: "edited" }) as never);
    const host = document.createElement("div");
    new NotesTab({ groupId: "g" }).mount(host);
    await Promise.resolve(); await Promise.resolve();
    (host.querySelector(".pn-note-edit") as HTMLButtonElement).click();
    const ta = host.querySelector(".pn-note-editor") as HTMLTextAreaElement;
    ta.value = "edited";
    (host.querySelector(".pn-note-save") as HTMLButtonElement).click();
    await Promise.resolve();
    expect(projectNotesApi.updateNote).toHaveBeenCalledWith("1", "edited");
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test -- notes-tab 2>&1 | tail -20`
Expected: FAIL — no `.pn-note-source` / `.pn-note-edit` yet.

- [ ] **Step 3: Render the source line** in `notes-tab.ts` `render()`. In the per-note `li.innerHTML`, add a source element and populate it:

```ts
      li.innerHTML = `
        <div class="pn-note-body"></div>
        <div class="pn-note-source"></div>
        <div class="rail-meta pn-note-stamp"></div>
        <button class="rail-row-action pn-note-edit" aria-label="Edit note">${Icons.pencil({ size: 13 })}</button>
        <button class="rail-row-action pn-note-del" aria-label="Delete note">${Icons.trash({ size: 13 })}</button>
      `;
      (li.querySelector(".pn-note-stamp") as HTMLElement).textContent = stamp;
      (li.querySelector(".pn-note-body") as HTMLElement).textContent = n.body;
      const srcEl = li.querySelector(".pn-note-source") as HTMLElement;
      if (n.source) srcEl.textContent = n.source;
      else srcEl.remove();
      li.querySelector(".pn-note-del")!.addEventListener("click", () => this.delete(n));
      li.querySelector(".pn-note-edit")!.addEventListener("click", () => this.beginEdit(li, n));
```

(If `Icons.pencil` does not exist, use `Icons.edit` — check `ui/src/icons.ts` and pick the pencil/edit glyph that's there.)

- [ ] **Step 4: Add inline edit** — add these methods to `NotesTab`:

```ts
  private beginEdit(li: HTMLElement, n: Note): void {
    if (li.querySelector(".pn-note-editor")) return;
    const editor = document.createElement("textarea");
    editor.className = "pn-note-editor";
    editor.value = n.body;
    editor.rows = 3;
    const save = document.createElement("button");
    save.className = "rail-row-action pn-note-save";
    save.textContent = "Save";
    save.addEventListener("click", () => void this.saveEdit(n, editor.value));
    li.appendChild(editor);
    li.appendChild(save);
    editor.focus();
  }

  private async saveEdit(n: Note, body: string): Promise<void> {
    const trimmed = body.trim();
    if (!trimmed || trimmed === n.body) { await this.refresh(); return; }
    await projectNotesApi.updateNote(n.id, trimmed);
    await this.refresh();
    this.hooks.onChange?.();
  }
```

- [ ] **Step 5: Run test, verify pass**

Run: `npm test -- notes-tab 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 6: Add minimal CSS** in `ui/src/project-notes/styles.css` (source line is muted, small):

```css
.pn-note-source { font-size: 11px; color: var(--text-dim, #888); margin-top: 2px; }
.pn-note-editor { width: 100%; margin-top: 6px; font: inherit; }
```

- [ ] **Step 7: Commit**

```bash
git add ui/src/project-notes/notes-tab.ts ui/src/project-notes/notes-tab.test.ts ui/src/project-notes/styles.css
git commit -m "feat(notes): editable note cards with provenance line"
```

---

### Task 5: Panel — 3 tabs, delete docs & drafts tabs

**Files:**
- Modify: `ui/src/project-notes/panel.ts`
- Modify: `ui/src/project-notes/panel.test.ts`
- Delete: `ui/src/project-notes/docs-tab.ts`, `ui/src/project-notes/drafts-tab.ts`, `ui/src/project-notes/drafts-tab.test.ts`

**Interfaces:**
- Produces: `PanelTab = "commands" | "prompts" | "notes"`. The `onOpenDraft`/`onNewSpec`/`groupRootDir` opts stay in `PanelOpts` (unused now — main.ts still passes them; ponytail: leave the plumbing, harmless).

- [ ] **Step 1: Delete the retired files**

```bash
git rm ui/src/project-notes/docs-tab.ts ui/src/project-notes/drafts-tab.ts ui/src/project-notes/drafts-tab.test.ts
```

- [ ] **Step 2: Update `panel.ts`** — remove the DocsTab/DraftsTab imports; narrow the type + tab list + storage guard + routing:

```ts
// (remove: import { DocsTab } ... and import { DraftsTab } ...)
export type PanelTab = "commands" | "prompts" | "notes";
```

In `readLastTab`, narrow the guard:

```ts
    if (raw === "commands" || raw === "prompts" || raw === "notes") return raw;
```

In the tab-button loop, drop docs/drafts:

```ts
    for (const t of ["commands", "prompts", "notes"] as PanelTab[]) {
```

In `updateTabUI`, replace the body block with only three branches and drop the `pn-body--flush` docs special-case (all three are flush now):

```ts
    this.body.replaceChildren();
    this.body.classList.add("pn-body--flush");
    if (this.currentTab === "commands") {
      new CommandsTab({ groupId: this.opts.groupId }).mount(this.body);
    } else if (this.currentTab === "prompts") {
      new PromptsTab({ groupId: this.opts.groupId }).mount(this.body);
    } else {
      new NotesTab({ groupId: this.opts.groupId }).mount(this.body);
    }
```

- [ ] **Step 3: Update `panel.test.ts`** — remove the `vi.mock("./docs-tab", ...)` and `vi.mock("./drafts-tab", ...)` blocks and any assertion referencing `.pn-docs-tab` / `.pn-drafts-tab`. Add an assertion that exactly three tabs render:

```ts
  it("renders exactly three tabs", () => {
    const host = document.createElement("div");
    new ProjectNotesPanel({ groupId: "g", groupLabel: "G" }).mount(host);
    expect(host.querySelectorAll(".rail-tab").length).toBe(3);
  });
```

- [ ] **Step 4: Run panel tests + type-check**

Run: `npm test -- project-notes/panel 2>&1 | tail -20 && npm run build 2>&1 | tail -15`
Expected: PASS and clean type-check (the Task 3 errors are now resolved). If `npm run build` flags an unused import, remove it.

- [ ] **Step 5: Commit**

```bash
git add -A ui/src/project-notes/
git commit -m "feat(notes): collapse panel to commands/prompts/notes"
```

---

### Task 6: "Add to notes" in the terminal selection menu

**Files:**
- Create: `ui/src/project-notes/note-source.ts`
- Test: `ui/src/project-notes/note-source.test.ts`
- Modify: `ui/src/tabs/manager.ts` (selection block ~1512, after "Create prompt")

**Interfaces:**
- Consumes: `projectNotesApi.appendNote` (Task 3), `pushInfoToast`, `tabDisplayName(tab)` (module-level in manager.ts), `pane.executor`.
- Produces: `noteSource(executorId: string | null, tabName: string): string`.

- [ ] **Step 1: Write the failing test** `ui/src/project-notes/note-source.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { noteSource } from "./note-source";

describe("noteSource", () => {
  it("labels the executor when one is running", () => {
    expect(noteSource("claude", "tab 2")).toBe("from Claude · tab 2");
    expect(noteSource("copilot", "api")).toBe("from Copilot · api");
  });
  it("falls back to the raw id for unknown executors", () => {
    expect(noteSource("mystery", "x")).toBe("from mystery · x");
  });
  it("uses just the tab name when idle", () => {
    expect(noteSource(null, "tab 2")).toBe("tab 2");
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test -- note-source 2>&1 | tail -15`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `ui/src/project-notes/note-source.ts`**:

```ts
/** Build the provenance line stored on a captured note, e.g.
 *  "from Claude · tab 2". Idle panes (no detected executor) → just the tab name. */
const EXEC_LABEL: Record<string, string> = {
  copilot: "Copilot", pi: "pi", claude: "Claude", opencode: "OpenCode",
};

export function noteSource(executorId: string | null | undefined, tabName: string): string {
  if (!executorId) return tabName;
  const label = EXEC_LABEL[executorId] ?? executorId;
  return `from ${label} · ${tabName}`;
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `npm test -- note-source 2>&1 | tail -15`
Expected: PASS.

- [ ] **Step 5: Wire the menu item** in `ui/src/tabs/manager.ts`. Add the import near the other project-notes imports:

```ts
import { noteSource } from "../project-notes/note-source";
```

Inside `showPaneContextMenu`, in the `if (selection.length > 0) { ... }` block, immediately after the `addItem("Create prompt", ...)` call, add:

```ts
      // Capture the selection into this group's Notes with provenance. Only
      // when the pane belongs to a group (notes are per-group).
      if (groupId) {
        addItem(
          "Add to notes",
          () => {
            const source = noteSource(pane?.executor ?? null, tabDisplayName(tab));
            void projectNotesApi
              .appendNote(groupId, selection, source)
              .then(() => pushInfoToast({ message: "Added to notes" }))
              .catch(() => pushInfoToast({ message: "Couldn’t add to notes" }));
          },
          Icons.noteText(),
        );
      }
```

- [ ] **Step 6: Type-check**

Run: `npm run build 2>&1 | tail -15`
Expected: clean. (Confirm `tabDisplayName` and `pushInfoToast` are already in scope in manager.ts — they are, per the existing "Create prompt" handler and `tabDisplayName` usages.)

- [ ] **Step 7: Commit**

```bash
git add ui/src/project-notes/note-source.ts ui/src/project-notes/note-source.test.ts ui/src/tabs/manager.ts
git commit -m "feat(notes): Add to notes in selection context menu"
```

---

### Task 7: Expanded view — Canon cockpit shell

**Files:**
- Modify: `ui/src/project-notes/panel.ts` (import cockpit.css; replace `toggleFullscreen`)
- Test: `ui/src/project-notes/panel.test.ts`

**Interfaces:**
- Consumes: existing `.canon-cockpit*` classes incl. `.canon-cockpit-grouplabel` (`ui/src/canon/cockpit/cockpit.css`), `CommandsTab`/`PromptsTab`/`NotesTab`.

- [ ] **Step 1: Write the failing test** — add to `panel.test.ts`:

```ts
  it("expands into a canon-cockpit shell with grouped nav", () => {
    const host = document.createElement("div");
    const p = new ProjectNotesPanel({ groupId: "g", groupLabel: "G" }).mount(host);
    (host.querySelector('[aria-label="Toggle fullscreen"]') as HTMLButtonElement).click();
    const shell = document.querySelector(".canon-cockpit");
    expect(shell).not.toBeNull();
    expect(shell!.querySelectorAll(".canon-cockpit-grouplabel").length).toBe(2); // LIBRARY, KNOWLEDGE
    expect(shell!.querySelectorAll(".canon-cockpit-nav-btn").length).toBe(3);    // Commands, Prompts, Notes
    p.close();
    (document.querySelector(".canon-cockpit") as HTMLElement | null)?.remove();
  });
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test -- project-notes/panel 2>&1 | tail -20`
Expected: FAIL — clicking fullscreen only toggles a class, no `.canon-cockpit` exists.

- [ ] **Step 3: Import the cockpit CSS** at the top of `panel.ts`:

```ts
import "../canon/cockpit/cockpit.css";
```

- [ ] **Step 4: Replace `toggleFullscreen`** with an overlay that reuses the cockpit shell. Delete the old body of `toggleFullscreen` and the `private fullscreen = false;` field's CSS-toggle use; implement:

```ts
  private expandRoot: HTMLElement | null = null;

  toggleFullscreen(): void {
    if (this.expandRoot) { this.collapseExpanded(); return; }
    this.openExpanded();
  }

  private collapseExpanded(): void {
    this.expandRoot?.remove();
    this.expandRoot = null;
    document.body.classList.remove("canon-cockpit-open");
  }

  private openExpanded(): void {
    const groups: { label: string; items: { key: PanelTab; label: string; desc: string }[] }[] = [
      { label: "Library", items: [
        { key: "commands", label: "Commands", desc: "Shell snippets you run in this project." },
        { key: "prompts",  label: "Prompts",  desc: "Reusable prompts you send to an agent." },
      ]},
      { label: "Knowledge", items: [
        { key: "notes", label: "Notes", desc: "Things worth keeping — captures and your own notes." },
      ]},
    ];

    const root = document.createElement("div");
    root.className = "canon-cockpit";

    const nav = document.createElement("nav");
    nav.className = "canon-cockpit-nav";
    const navTitle = document.createElement("div");
    navTitle.className = "canon-cockpit-nav-title";
    navTitle.textContent = `${this.opts.groupLabel} — COVENANT`;
    nav.appendChild(navTitle);

    const content = document.createElement("section");
    content.className = "canon-cockpit-content";

    const buttons: Partial<Record<PanelTab, HTMLButtonElement>> = {};
    const select = (key: PanelTab, label: string, desc: string): void => {
      for (const b of nav.querySelectorAll(".canon-cockpit-nav-btn")) b.classList.remove("is-active");
      buttons[key]?.classList.add("is-active");
      const wrap = document.createElement("div");
      wrap.className = "canon-cockpit-section-wrap";
      const head = document.createElement("header");
      head.className = "canon-cockpit-sec-head";
      const h = document.createElement("h2");
      h.className = "canon-cockpit-sec-title";
      h.textContent = label;
      const p = document.createElement("p");
      p.className = "canon-cockpit-sec-desc";
      p.textContent = desc;
      head.append(h, p);
      const body = document.createElement("div");
      body.className = "pn-body pn-body--flush";
      if (key === "commands") new CommandsTab({ groupId: this.opts.groupId }).mount(body);
      else if (key === "prompts") new PromptsTab({ groupId: this.opts.groupId }).mount(body);
      else new NotesTab({ groupId: this.opts.groupId }).mount(body);
      wrap.append(head, body);
      content.replaceChildren(wrap);
    };

    for (const g of groups) {
      const gl = document.createElement("div");
      gl.className = "canon-cockpit-grouplabel";
      gl.textContent = g.label;
      nav.appendChild(gl);
      for (const item of g.items) {
        const b = document.createElement("button");
        b.className = "canon-cockpit-nav-btn";
        b.textContent = item.label;
        b.addEventListener("click", () => select(item.key, item.label, item.desc));
        buttons[item.key] = b;
        nav.appendChild(b);
      }
    }

    const close = document.createElement("button");
    close.className = "canon-cockpit-close";
    close.innerHTML = `<kbd class="settings-esc">esc</kbd>`;
    close.addEventListener("click", () => this.collapseExpanded());

    root.append(nav, content, close);
    document.body.appendChild(root);
    document.body.classList.add("canon-cockpit-open");
    this.expandRoot = root;
    // Open on the tab the rail currently shows (falls back to commands).
    const first = (["commands", "prompts", "notes"] as PanelTab[]).includes(this.currentTab)
      ? this.currentTab : "commands";
    const found = groups.flatMap(g => g.items).find(i => i.key === first)!;
    select(found.key, found.label, found.desc);
  }
```

Update `close()` to also tear down the overlay if open — add `this.collapseExpanded();` as its first line. Update the `onKey` Escape handler so that when expanded, Escape collapses the overlay instead of closing the whole panel:

```ts
  private onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    if (this.expandRoot) this.collapseExpanded();
    else this.close();
  };
```

- [ ] **Step 5: Run test, verify pass**

Run: `npm test -- project-notes/panel 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 6: Full check**

Run: `npm test 2>&1 | tail -15 && npm run build 2>&1 | tail -10`
Expected: green (repo has some pre-existing unrelated failures per project notes — confirm any failures are NOT in `project-notes/` or `tabs/`).

- [ ] **Step 7: Commit**

```bash
git add ui/src/project-notes/panel.ts ui/src/project-notes/panel.test.ts
git commit -m "feat(notes): expanded view uses the Canon cockpit shell"
```

---

## Self-Review

**Spec coverage:**
- Taxonomy → 3 tabs, 2 groups → Task 5 (collapse) + Task 7 (grouped nav). ✓
- Notes = editable entry cards with source line → Task 4. ✓
- Backend source column + update + append(source) → Task 1. ✓
- docs→note migration, docs surface deleted → Task 2. ✓
- "Add to notes" menu item with provenance → Task 6. ✓
- Expanded = Canon shell (title+desc header, subtle borders) → Task 7. ✓
- Drafts leaves the panel → Task 5 (files deleted; opts left dead). ✓
- Prompts stays global → unchanged; only presentation moves (Task 7 nav). ✓

**Placeholder scan:** none — every step carries real code/commands.

**Type consistency:** `Note.source: Option<String>` (Rust) ↔ `source?: string | null` (TS); `appendNote(groupId, body, source?)` matches command `project_note_append(group_id, body, source)`; `update_note`/`project_note_update`/`updateNote` names align across tasks; `Snapshot` drops `docs` in both Rust (Task 2) and TS (Task 3); `noteSource` signature matches its test and its manager.ts call site.

**Open verification (manual, post-implementation):** in-app — expand the panel and confirm it matches the Canon shell in True Dark; "Add to notes" from a real agent selection creates a captured card with the right source line; a group that had a docs blob shows it as a migrated note once.
