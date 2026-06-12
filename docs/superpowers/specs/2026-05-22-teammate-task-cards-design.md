# Teammate Task Cards in DM — Design

**Date:** 2026-05-22
**Status:** Draft
**Scope:** First increment toward the "Roster page + DM rail con task card" vision. Closes the conversational loop where the user asks an operator to do work and the operator responds with a structured, confirmable task — not just free text.

## Vision Recap

From the mockup: user DMs an operator ("Mibli, revisa la migración de auth y dime qué romperías"). Operator answers with a **task card** inside the chat (Archetype badge · Deliverable · Scope) plus **Confirmar / Editar / Cancelar** buttons. On confirm, a `Do` task spawns a new tab where the operator works; the chat continues with progress messages.

This spec covers **only the task-card-in-DM flow**. The OPERATORS page (Roster/Tasks/Audit/Settings tabs) is a later increment.

## Naming

The new module stays under `teammate/` (backend) and `ui/src/teammate/` (frontend). We do **not** rename to "convergence" — `ui/src/convergence/` already exists for the multi-tab aggregation overlay (⌘⇧M) and the name fits its current purpose.

## Current State

**Backend (`crates/app/src/teammate/`):**
- `types.rs`: `Task`, `TaskArchetype { Watch | Do | Review }`, `TaskStatus`, `TaskScope`, `WatchPredicate`, `MessageContent::{Text, TaskDraft, TaskUpdate, Propose, Report}`, `ProposeTask`, `TaskDraft`, `Role`, `OperatorState` — **all present**.
- `runtime.rs`: `start_task` / `finish_task` state transitions — **present**.
- `tools.rs`: only `read_file` tool today.
- `llm.rs`: dispatches Anthropic Messages API; handles `tool_use` for `read_file`.
- `commands.rs`: `teammate_list_tasks` returns empty stub.

**Frontend (`ui/src/teammate/panel.ts`):**
- Working DM rail with bubble-style chat. Renders only `Text` content. `TeammateContent` is typed `unknown` in `api.ts`.

**Gap:** operator can chat but cannot propose a structured task; user has no way to confirm and turn a proposal into a live task with a spawned session.

## Approach

The operator (LLM) gains a new tool `propose_task`. When the model decides the user's message is actionable (not chitchat), it calls `propose_task` instead of returning text. The runtime persists the result as a `MessageContent::Propose` message. The UI renders that message as a task card with Confirmar/Editar/Cancelar. Confirming calls `teammate_confirm_task`, which (for `Do`) spawns a new session, transitions the operator to `OnTask`, and emits a `TaskUpdate::Started` into the thread.

**Rejected alternatives:**
- *Parse JSON out of operator text* — brittle, escapes/markdown break it.
- *Two LLM calls (classify, then draft)* — extra latency and cost, no quality gain.

## Components

### Backend

**`crates/app/src/teammate/tools.rs`**
- Add `propose_task_tool_def() -> serde_json::Value`. Schema:
  ```
  {
    name: "propose_task",
    description: "Propose a structured task when the user is asking for actionable work...",
    input_schema: {
      type: "object",
      required: ["archetype", "title", "deliverable", "rationale"],
      properties: {
        archetype: { enum: ["do", "review", "watch"] },
        title: string,
        deliverable: string,
        rationale: string,
        scope: {
          type: "object",
          properties: {
            paths: { type: "array", items: { type: "string" } },
            tabs:  { type: "array", items: { type: "string" } }   // session ids
          }
        }
      }
    }
  }
  ```
- No execution handler — `propose_task` is "structured output", consumed by the LLM dispatcher itself (see `llm.rs` below).

**`crates/app/src/teammate/llm.rs`**
- When the model response contains `tool_use` with `name == "propose_task"`:
  - Build `ProposeTask { draft: TaskDraft { archetype, title, deliverable, scope }, rationale }`.
  - Return it as `MessageContent::Propose(...)` — **do not** also append the text block from the same response (if both are present, the text becomes a sibling message with `Role::Operator` only when non-empty; default behavior is "Propose replaces text").
- Existing `read_file` flow unchanged.

**`crates/app/src/teammate/commands.rs`**
- `teammate_confirm_task(message_id: MessageId) -> Result<Task, Error>`
  - Lookup the `Propose` message; error if message is not a `Propose` or already confirmed/cancelled.
  - Build `Task` with `status = Active`, `created_at_unix_ms = now`, `cost_usd_cents = 0`.
  - If `archetype == Do`: call `SessionManager::spawn` (same path used elsewhere) and store the returned `SessionId` in `Task.spawned_session`.
  - Call `runtime.start_task(operator_id, task.id, task.spawned_session)`. If state transition fails (operator already on task), return error — UI surfaces it as a toast.
  - Insert a `MessageContent::TaskUpdate { task: task.id, kind: Started }` into the thread.
  - Mark the original `Propose` message as confirmed (new column `confirmed_at_unix_ms` on `teammate_messages`, nullable).
  - Persist `Task` to a new `teammate_tasks` table (see Schema).
  - Emit `teammate://task` Tauri event with the new Task; emit `teammate://message` for the `Started` update.
- `teammate_cancel_task_proposal(message_id: MessageId) -> Result<(), Error>`
  - Set `dismissed_at_unix_ms` on the `Propose` message. UI greys out the card.
- `teammate_edit_task_proposal(message_id: MessageId, draft: TaskDraft) -> Result<(), Error>`
  - Replace the `draft` portion of the `Propose` content in-place. `rationale` preserved.
- Implement `teammate_list_tasks(operator_id)` against the new table.

**Schema (`crates/app/migrations/`)**
- New table:
  ```sql
  CREATE TABLE teammate_tasks (
    id TEXT PRIMARY KEY,
    operator_id TEXT NOT NULL,
    archetype TEXT NOT NULL,         -- 'do' | 'review' | 'watch'
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    deliverable TEXT NOT NULL,
    status TEXT NOT NULL,            -- 'draft' | 'active' | 'blocked' | 'done' | 'cancelled'
    scope_json TEXT NOT NULL,
    spawned_session TEXT,
    created_at_unix_ms INTEGER NOT NULL,
    updated_at_unix_ms INTEGER NOT NULL,
    completed_at_unix_ms INTEGER,
    cost_usd_cents INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX teammate_tasks_op_idx ON teammate_tasks(operator_id, status);
  ```
- Alter `teammate_messages`: `ALTER TABLE teammate_messages ADD COLUMN confirmed_at_unix_ms INTEGER; ADD COLUMN dismissed_at_unix_ms INTEGER;`

### Frontend

**`ui/src/api.ts`**
- Replace `TeammateContent = unknown` with a tagged union:
  ```ts
  type TeammateContent =
    | { kind: "text"; data: string }
    | { kind: "task_draft"; data: TaskDraft }
    | { kind: "task_update"; data: { task: string; kind: UpdateKind } }
    | { kind: "propose"; data: ProposeTask }
    | { kind: "report"; data: TaskReport };
  ```
- Add wrappers: `teammateConfirmTask`, `teammateCancelTaskProposal`, `teammateEditTaskProposal`.

**`ui/src/teammate/task-card.ts` (new)**
- `renderTaskCard(message: TeammateMessage, propose: ProposeTask, handlers): HTMLElement`
- Layout follows mockup: archetype badge (color: Do=purple, Review=green, Watch=amber), title, **Archetype:** / **Deliverable:** / **Scope:** rows, then `[Confirmar] [Editar] [Cancelar]`.
- Disabled state when `message.confirmed_at_unix_ms` or `dismissed_at_unix_ms` is set; shows a small "confirmed · 2m" or "cancelled" footer.
- Edit opens an inline form (same card, fields become inputs, buttons become `[Guardar] [Cancelar]`). Submitting calls `teammateEditTaskProposal`.

**`ui/src/teammate/panel.ts`**
- In the thread renderer, switch on `message.content.kind`:
  - `text` → existing bubble.
  - `propose` → `renderTaskCard(...)`.
  - `task_update` → small system line ("tab abierto · 14:03").
  - `task_draft` / `report` → out of scope for MVP, render as JSON-debug bubble.
- Subscribe to `teammate://task` to refresh roster status badges (operator transitions to "on task").

## User Flow

1. User types: *"Mibli, revisa la migración de auth y dime qué romperías"* → `teammate_send_message`.
2. LLM runs with tools `[read_file, propose_task]`. Decides to call `propose_task` with `archetype=do`, `title="Revisar migración de auth"`, `deliverable="resumen + riesgos + PR draft"`, `scope.paths=["crates/app/src/auth_mig.rs"]`.
3. Runtime persists `Propose` message; UI renders task card.
4. User clicks **Confirmar**.
5. `teammate_confirm_task` spawns a new session, calls `start_task`, inserts `TaskUpdate::Started`.
6. UI shows the card as "confirmed", appends a "tab abierto, voy leyendo" line (system-formatted from the `Started` update).

## Out of Scope (Next Increments)

- OPERATORS page with Roster/Tasks/Audit/Settings tabs.
- Autonomous operator loop working inside the spawned tab (infrastructure exists in `crates/agent` / familiar; wiring is a separate hito).
- `Watch` predicates actually subscribing to webhooks / exit codes.
- `Review` archetype with diff viewer.
- Multiple concurrent tasks per operator (today `start_task` rejects this — that constraint stays).

## Testing

**Rust unit tests**
- `llm.rs`: given a mocked Anthropic response with `tool_use=propose_task`, the returned thread message is `MessageContent::Propose(...)` with the expected draft, no duplicate text message.
- `commands.rs`:
  - `teammate_confirm_task` on a `Do` propose spawns a session (mock `SessionManager`), persists the task, transitions operator state, inserts `Started` update.
  - Confirming an already-confirmed message returns an error.
  - Cancelling sets `dismissed_at_unix_ms` and refuses subsequent confirm.
- `runtime.rs`: existing tests remain green.

**Frontend unit tests (`ui/src/teammate/panel.test.ts`)**
- Render thread with one `propose` message → DOM contains a task card with the right archetype badge and the three buttons.
- Click Confirmar → `api.teammateConfirmTask` called once with the message id.
- After confirmation event arrives, the card shows disabled state.

**Manual smoke (`/run` skill after implementation)**
- Open DM with Mibli, send the auth-migration prompt, verify card appears, confirm, verify a new tab spawns and operator's roster status flips to "on task".

## Risks

- **LLM choosing `propose_task` too eagerly** (every message becomes a task). Mitigate via the tool description and a one-shot example in the system prompt: "Only propose a task for clearly actionable, multi-step requests. For Q&A or clarification, answer directly."
- **Session spawn failure leaves the task half-created.** `teammate_confirm_task` must be transactional: spawn first, then `start_task`, then persist. If `start_task` fails, kill the spawned session before returning error.
- **Schema migration** adds two columns to `teammate_messages`. Existing rows default to NULL — no data loss.

## File Map

| Path | Change |
|---|---|
| `crates/app/src/teammate/tools.rs` | add `propose_task_tool_def` |
| `crates/app/src/teammate/llm.rs` | handle `propose_task` tool_use → `Propose` content |
| `crates/app/src/teammate/commands.rs` | add `confirm` / `cancel` / `edit` commands; implement `list_tasks` |
| `crates/app/src/teammate/runtime.rs` | (no change) |
| `crates/app/migrations/NNNN_teammate_tasks.sql` | new table + alter messages |
| `ui/src/api.ts` | type `TeammateContent` union; new wrappers |
| `ui/src/teammate/task-card.ts` | new — renders the card |
| `ui/src/teammate/panel.ts` | switch on content kind; subscribe to task events |
| `ui/src/teammate/panel.test.ts` | propose-render + confirm-click tests |
