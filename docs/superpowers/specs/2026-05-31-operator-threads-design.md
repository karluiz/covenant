# Operator Threads — Design Spec

**Date:** 2026-05-31
**Status:** Approved for planning
**Author:** Karluiz + Claude

## Summary

Give each operator multiple **separate conversations** (ChatGPT-style), instead of the
single flat chat that exists today. A thread owns its own message history and context
window. The operator's persona, XP/level, sentiment, and live terminal world-model remain
**global** — one operator entity having several conversations. Tasks and Activity stay
global per-operator. Only the **Chat** tab is scoped to a thread.

## Feasibility

Low-risk and additive. Today `teammate_messages` is a flat table keyed by `operator_id`,
and the LLM already consumes only a windowed slice (last ~20) of one operator's stream.
Threads is a grouping layer above this: add a `thread_id`, filter by it, add a switcher.
No change to the agent loop, tools, executors, persona, XP, sentiment, or world-model.

## Decisions

| Question | Decision |
|---|---|
| Thread model | Separate conversations (ChatGPT-style), own history + context window |
| Cross-thread state | Conversation isolated; persona/XP/sentiment/world-model shared (global) |
| Thread scope | Chat only. Tasks + Activity stay global per-operator |
| UI surface | Dropdown from a thread row under the operator name |
| Existing history | Migrated into one default thread per operator — nothing lost |

## Data Model

New table + one nullable column on the existing messages table.

```sql
CREATE TABLE teammate_threads (
    id                      TEXT PRIMARY KEY,        -- ULID
    operator_id             TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
    title                   TEXT NOT NULL,           -- auto-generated, editable
    created_at_unix_ms      INTEGER NOT NULL,
    last_message_at_unix_ms INTEGER NOT NULL,
    archived                INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_threads_operator
    ON teammate_threads(operator_id, last_message_at_unix_ms DESC);

ALTER TABLE teammate_messages ADD COLUMN thread_id TEXT
    REFERENCES teammate_threads(id) ON DELETE CASCADE;
CREATE INDEX idx_messages_thread
    ON teammate_messages(thread_id, created_at_unix_ms);
```

### Migration

On first run after upgrade, for each operator that has existing messages:
1. Create one default thread (title `"General"`).
2. Backfill `thread_id` on all that operator's existing messages.

Idempotent: skip operators that already have threads. Existing flat history becomes
thread #1 — nothing is lost.

## Backend (Rust)

### New type — `crates/app/src/teammate/types.rs`

```rust
pub struct TeammateThread {
    pub id: ThreadId,
    pub operator_id: OperatorId,
    pub title: String,
    pub created_at_unix_ms: u64,
    pub last_message_at_unix_ms: u64,
    pub archived: bool,
}
```

`ThreadId(Ulid)` newtype, consistent with `SessionId`/`BlockId`.

### Storage — `crates/app/src/storage.rs`

- `teammate_create_thread(operator_id, title) -> ThreadId`
- `teammate_list_threads(operator_id) -> Vec<TeammateThread>` — non-archived, ordered by
  `last_message_at_unix_ms DESC`
- `teammate_rename_thread(thread_id, title)`
- `teammate_archive_thread(thread_id)`
- `teammate_list_messages` gains a `thread_id` filter param
- `teammate_insert_message` writes `thread_id` and bumps the thread's
  `last_message_at_unix_ms`

### Commands — `crates/app/src/teammate/commands.rs`

- `teammate_send_text_message` gains a `thread_id` arg. The background reply task fetches
  history filtered to that thread (the existing last-20 window, now thread-scoped) and
  tags both the user message and the reply with `thread_id`.
- New thin commands: `teammate_create_thread`, `teammate_list_threads`,
  `teammate_rename_thread`, `teammate_archive_thread`.
- The `"teammate-message"` event payload gains `thread_id` so the UI only appends when
  that thread is active.

### Auto-titling

After the first user message in a new thread, set a 3–5 word title via a small/cheap LLM
call (a fast model). Until it resolves, show `"New conversation"`. Title is editable.
This is the only new LLM call introduced.

### Tasks stay global

`propose_task` still writes to the single Tasks list. A task's originating message keeps
its `thread_id`, but the Tasks tab ignores it (Chat-only scope).

## UI (TypeScript) — `ui/src/teammate/panel.ts`

- Thin **thread-title row** directly under the operator name/level. Clicking it opens a
  dropdown listing the operator's threads (title + relative timestamp), with a pinned
  **`+ New thread`** at top and a checkmark on the active thread.
- `TeammatePanel` tracks `activeThreadId` per operator. On `openFor(operator)`, load
  threads, pick most-recent (or create a default if none). `send()` passes
  `activeThreadId`. The `teammate-message` listener appends only when
  `payload.thread_id === activeThreadId`.
- Rename via double-click / edit affordance in the dropdown row; archive via a hover
  action (`⌫`).
- Empty-state ("Chat with {name}" + suggestion chips) shows for a fresh thread.
- The existing top-right **trash** icon is rescoped to "clear/delete this thread" rather
  than all operator history.

A visual mockup was reviewed and approved (header dropdown layout).

## API bindings — `ui/src/api.ts`

- `interface TeammateThread { ... }`
- Typed wrappers for the four new commands + updated `teammateSendText(operatorId,
  threadId, text)` and `teammateListMessages(operatorId, threadId)`.

## Out of Scope (YAGNI)

- Cross-thread long-term memory / recall.
- Per-thread Tasks or Activity.
- Permanent always-visible sidebar.
- Thread search, pinning, folders.

## Testing

- Storage: create/list/rename/archive round-trip; `list_messages` filters by thread;
  `insert_message` bumps `last_message_at`.
- Migration: operator with N existing messages → one "General" thread, all messages
  backfilled; idempotent on re-run.
- Commands: send routes history + reply to the correct thread; event payload carries
  `thread_id`.
- UI: switching threads swaps history; incoming message for inactive thread is not
  appended to the active view.
