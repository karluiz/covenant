# Project Notes — Design

**Date:** 2026-05-06
**Status:** Approved, pending implementation plan

## Summary

Per-group panel with three typed tabs — **Commands**, **Notes**, **Docs** — that
serve a dual purpose: a quick scratchpad for the user, and structured
pre-context fed into the operator's system prompt for better mission decisions.

The container today called "group" in the UI (e.g. `COVENANT`) is conceptually
a project. We keep "group" in code (no rename) and surface the feature as
"Project Notes" in the UI.

## Goals

1. Quick paste of reusable commands into the active terminal of the group.
2. Lightweight append-only journal of working notes ("where I was", TODOs,
   decisions in flight).
3. Stable markdown docs that document the project (architecture,
   conventions, how to run things).
4. Inject 1–3 as **pre-context** into operator missions, so the agent's
   decisions are grounded in project-specific knowledge.

## Non-Goals

- Sharing notes between groups.
- Full-text search across notes (future work, easy to add later).
- Templating / variable substitution in commands (future work — YAGNI until
  it hurts).
- Auto-execute commands on click. Paste-only by design.
- Tag-based or `@ref` selective inclusion in operator pre-context.
- File-on-disk storage in the project repo (see Future Work).

## UI

**Trigger:** click on the group header (`> COVENANT`) opens a right-side
overlay panel (~420px). Shortcut: `⌘⇧N` with the group active. The panel does
not steal focus from the terminal.

**Layout:**

```
┌─ COVENANT ─────────────── [⤢] [×] ┐
│  [ Commands ] [ Notes ] [ Docs ]  │
├───────────────────────────────────┤
│  (tab content)                    │
└───────────────────────────────────┘
```

- `[⤢]` expands to fullscreen (reuses the existing Docs fullscreen pattern).
- `[×]` or `Esc` closes.
- Last active tab persists per group.

**Commands tab:** vertical list of snippets. Each entry shows title, command
(monospace), and a "paste" button. Click → pastes into the prompt of the
group's active terminal, **without trailing newline** — the user confirms
with Enter. Affordances: `+` (new), inline edit, delete, drag to reorder.

**Notes tab:** chronological stream, newest first. A fixed input at the top;
`Enter` appends. Each entry: relative timestamp + body. Hover → `×` to
delete. Entries are not editable. (Append-only is the journal contract.)

**Docs tab:** a single markdown blob, edited via the existing Docs editor.
Auto-save with debounce.

## Data Model

```rust
pub struct Command {
    pub id: Ulid,
    pub group_id: GroupId,
    pub title: String,
    pub command: String,
    pub sort_order: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

pub struct Note {
    pub id: Ulid,
    pub group_id: GroupId,
    pub body: String,
    pub created_at: DateTime<Utc>,
}

pub struct Docs {
    pub group_id: GroupId,
    pub body: String,
    pub updated_at: DateTime<Utc>,
}
```

**SQLite schema** (extends the existing app DB used for tab persistence):

```sql
CREATE TABLE project_commands (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    title TEXT NOT NULL,
    command TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX idx_cmd_group ON project_commands(group_id, sort_order);

CREATE TABLE project_notes (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX idx_note_group_created ON project_notes(group_id, created_at DESC);

CREATE TABLE project_docs (
    group_id TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
```

Cascade-delete project rows when a group is hard-deleted. (Confirm current
group-delete semantics during implementation.)

## Tauri Commands (IPC)

```
project_notes_get(group_id) -> ProjectNotesSnapshot
    // { commands, docs, notes (last 50) }

command_create(group_id, title, command) -> Command
command_update(id, title, command) -> Command
command_delete(id) -> ()
command_reorder(group_id, ordered_ids) -> ()

note_append(group_id, body) -> Note
note_delete(id) -> ()
note_list(group_id, limit, before_ts?) -> Vec<Note>

docs_get(group_id) -> String
docs_save(group_id, body) -> ()

paste_to_active_tab(group_id, text) -> ()
    // resolves the group's active tab and writes text to its PTY.
    // NO trailing newline — the user confirms with Enter.
```

**Broadcast events:**

```
ProjectNotesEvent::CommandsChanged { group_id }
ProjectNotesEvent::NoteAppended    { group_id, note }
ProjectNotesEvent::DocsChanged     { group_id }
```

## Operator Pre-Context Injection

When an operator in the group starts or resumes a mission, the agent system
prompt includes a project-context block built by:

```rust
// crates/agent/src/project_context.rs
pub fn build_project_context(group_id: &GroupId, budget_tokens: usize) -> String
```

**Budget:** 2000 tokens hard cap. Inclusion priority, in order:

1. **Commands** (always): `title + command` for each. If they exceed ~30% of
   the budget, keep the most-recently-updated ones and truncate the rest.
2. **Docs**: first the heading TOC (`##` lines), then the body until
   ~50% of the budget is filled. Mark truncation explicitly:
   `[truncated — see full docs in panel]`.
3. **Notes**: the most recent that fit in the remaining budget, max 20.
   Timestamp + body, newest first.

**Format** (plain text, not JSON — fewer tokens, easier on the LLM):

```
# Project: COVENANT

## Saved Commands
- Run UI dev: `cd ui && npm run dev`
- Tail backend: `tail -f /tmp/super-term.log`

## Project Docs
[markdown content, possibly truncated]

## Recent Notes (newest first)
- [2h ago] migrating event bus to broadcast::Sender
- [yesterday] decided to skip vt100 for M1
```

**Caching:** the block sits in the cached segment of the system prompt
(after the static prompt, before the rolling world-model summary). It is
invalidated and rebuilt when any `ProjectNotesEvent` arrives for the
`group_id`. Between invalidations, prompt-cache hits make the marginal cost
near zero.

If the group has no notes/commands/docs at all, the builder returns an
empty string — no orphan `# Project: X` header is injected.

## Testing

- **`project-notes` crate:** CRUD round-trip; ordering invariants on
  `command_reorder`; truncation behavior of the context builder across
  several budgets and content shapes; cascade delete on group removal.
- **IPC layer:** each Tauri command — happy path with a valid group, plus
  error cases (unknown `group_id`, empty body, etc.).
- **UI:** panel renders for a group; tab switch persists across reopen;
  optimistic note append with rollback on error; paste targets the active
  tab of the *current* group, never another group's PTY.
- **Smoke:** open panel → create command → click paste → bytes land in the
  active tab's PTY without a trailing newline.

## Error Handling

- DB write failure → toast in UI, no crash. Note append never silently
  drops: if the DB write fails, leave the input populated and surface the
  error.
- Paste with no active tab in the group → toast "no active tab in group",
  no-op.
- Operator context builder for a group with no project data → returns
  empty string; no project section is injected.

## Future Work

These are deliberately out of scope for the first cut. Track them so we
revisit at the right time:

1. **Repo-backed storage (hybrid):** make a project optionally bound to a
   filesystem root (default: common ancestor cwd of the group's tabs). When
   a root is set, persist `commands.toml`, `notes.jsonl`, and `project.md`
   under `<root>/.covenant/`. Pros: portable across installs, git-versioned,
   readable directly by operator subagents without IPC. Fall back to the
   SQLite-only path when no root is set. **This is the most interesting
   medium-term direction — see also the README note for context.**
2. **Search:** full-text search across notes / docs / commands.
3. **Templating in commands:** `{{var}}` placeholders with a small modal
   asking for values before paste. Add only if a clear pattern emerges.
4. **Selective pre-context:** tags or `@project/...` references to inject
   only relevant sections instead of the always-on budget approach.
5. **Group → "project" rename:** a UI/code rename if the project framing
   becomes dominant. Today the churn is not justified.

## Open Questions

None — all design questions resolved during brainstorming.
