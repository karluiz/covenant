# Tasker Board Share — design

**Date:** 2026-07-20
**Status:** approved, not implemented
**Branch:** `worktree-tasker-board-share`

## Problem

Tasker tells Karluiz what he is working on. Nobody else can see it. A boss or a
collaborator asking "what are you on?" gets an ad-hoc answer typed by hand,
which goes stale the moment it is sent.

Covenant already publishes two artifacts to the forge behind a secret link — a
file (`/g/:token`) and a spec (`/r/:token`). A Tasker board is the third.

## What it is

A read-only mirror of ONE Tasker project, published at `/b/:token`, that
re-publishes itself on every board mutation. Send the link once; it stays true.

Explicitly not: a curated report, a digest, a collaboration surface. The board
the owner sees is the board the viewer sees, minus the free-text notes.

## Architecture

```
Tasker (TS, localStorage)
  │  mutation on a shared project
  ▼
ui/src/tasker/share.ts       debounce 2s → toSnapshot() → redacted payload
  │  invoke("board_publish", { projectId, payload })
  ▼
crates/app/src/covenant_board.rs
  │  clones covenant_gist.rs: jwt() / client() / send_authed()
  │  board_shares.json  { projectId → { board_id, token, url } }
  │  POST /boards  (first time)   |   PUT /boards/:id  (every re-push)
  ▼
covenant-server (separate repo)
  boards(id, token UNIQUE, user_id, title, payload JSONB, updated_at, revoked)
  GET /b/:token        → board.html (minijinja + escaped JSON island)
  GET /b/:token.json   → snapshot, ETag = updated_at
       revoked or unknown → generic 404, indistinguishable
  ▼
Viewer page: poll /b/:token.json every 20s, 304 most of the time,
             re-render client-side when the ETag changes.
```

Three independently testable units: **redaction** (pure TS, `Project` →
`BoardSnapshot`), **transport** (Rust, mirrors the gist module), **render**
(server, `BoardSnapshot` → HTML).

The local store is a map, so any number of projects can be shared, each with its
own token.

### Why a new artifact rather than reusing the gist table

`/b/:token` is a surface we expect to grow — viewer-side metrics, and possibly
comments later. Overloading `gists.language` with `covenant-board` would save one
migration today and cost clarity in every query afterwards.

## Payload — `BoardSnapshot`

```ts
type BoardSnapshot = {
  v: 1
  title: string                 // Project.name
  updatedAt: string             // ISO, stamped at publish
  columns: [                    // fixed: pending | active | done
    { status: TaskStatus, label: string, tasks: SharedTask[] }
  ]
}

type SharedTask = {
  id: string
  title: string
  priority: "low" | "normal" | "high" | "urgent"
  dueDate?: string
  dueTime?: string
  tags?: string[]
  subtasks?: { title: string, done: boolean }[]
  estimatedMinutes?: number
  spentMinutes?: number
  createdAt: string
  updatedAt: string
  completedAt?: string
}
```

- **`description` is absent from the type.** Redaction is structural, not a flag
  that can be left off — free-text notes are where paths, tokens and venting end
  up, and they have nowhere to land in the payload.
- **`cancelled` tasks are dropped.** The board has three columns; a cancelled
  task belongs in none of them.
- **`done` is capped at the 20 most recent by `completedAt`.** Otherwise the
  column becomes a wall and the payload grows without bound. The server paginates
  nothing.
- **`projectId`, `groupId`, `sessionId`, `recurrence` are not sent.** Internal
  plumbing, meaningless to a viewer.

Implemented as one pure function in `ui/src/tasker/share.ts`:
`toSnapshot(project: Project): BoardSnapshot`.

## Covenant UI

**Entry point:** the project row in the Tasker panel, in the existing actions
menu → `Share board`. Once shared, the row carries the shared badge and the menu
becomes `Copy link` / `Stop sharing` — same vocabulary as the gist share.

**Auto-push:** `TaskStorage` currently emits nothing on save. It gains a
`CustomEvent` on write. `share.ts` subscribes; if the mutated project is in the
share store it schedules a push with a 2s debounce. Projects that were never
shared cost nothing.

**Push state:** three states, no toasts — *synced* (still dot), *pushing* (live
dot), *stale* (dimmed dot + tooltip carrying the error). A board that syncs
itself must not interrupt every two seconds.

**Failure:** retried on the next mutation, not on a timer. Each PUT carries the
whole snapshot, so a viewer never sees a half-applied state — only an older
coherent one. The stale dot is the only signal.

**On app start:** one push per shared board, reconciling changes made while the
app was closed.

**`Stop sharing`:** `POST /boards/:id/revoke`, drop the local entry, link dies —
404, identical to a fabricated token.

## The `/b/:token` page

Built from the `gist.html` mould: minijinja, escaped JSON island, inline vanilla
JS, no build step.

**Header.** Project name; on the right the only metric a viewer needs —
`7 in progress · 3 to do · 12 done`. Below it, mono and grey, `updated 40s ago`,
recomputed client-side every second. That line is the proof the link is live;
without it the page reads as a PDF.

**Body.** Three fixed columns, sharp corners, no shadows. A task is a row, not a
padded card: title, then a mono meta line — due date, tags, `3/5` subtasks when
present. Priority is not a coloured badge but a 2px bar on the row's left edge,
shown only for `high` and `urgent`.

**Done** is collapsed by default with its count in the header; one click opens
it. It is the past — it may take width, not attention.

**Overdue** (`dueDate` in the past, not `done`) renders the date in the alert
colour. It is the page's only red.

**Mobile.** Under 720px the columns stack, To Do and In Progress first, headers
sticky. The viewer is probably on a phone.

**On poll change:** rows that appear or change column fade in over 200ms.
Nothing else animates and nothing reorders with transitions — enough to notice
movement without the page dancing on its own.

**No login, no marketing footer, no controls.** The page contains no `<form>` and
no `fetch` other than the poll GET.

## Testing

- `toSnapshot` — a task carrying a distinctive description string must not appear
  anywhere in `JSON.stringify(snapshot)`. This is the regression test that fails
  if notes ever find a path back into the payload.
- `toSnapshot` — cancelled tasks excluded; done capped at 20, newest first.
- Rust — `share_store_roundtrip` for `board_shares.json`, cloned from the gist
  module's test.
- Debounce — N mutations inside the window produce exactly one publish call.

## Out of scope

- Comments or any write surface on the public page.
- Sharing all projects at once, or a cross-project digest.
- SSE / sub-second freshness. 20s polling is the contract.
- Per-task visibility flags.
