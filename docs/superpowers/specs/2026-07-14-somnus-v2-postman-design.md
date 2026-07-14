# Somnus v2 — Full Client (Collections + Environments) — Design

**Date:** 2026-07-14
**Status:** Draft — pending Karluiz review
**Builds on:** `2026-07-07-somnus-rest-client-design.md` (v1, RELEASED v0.8.133)
**Scope:** Postman-grade request workflow — collections, environments/variables, params/auth/body parity, request tabs, Postman import/export — plus the design pass that turns the expanded view into Somnus's primary surface.

## Goal

Somnus v1 is a scratchpad: compose, send, history. v2 makes it a **workspace**: requests are saved into named collections, environments hold `{{variables}}` that resolve at send time, and the composer grows the four tabs a real client needs (Params / Auth / Headers / Body). Near-1:1 with Postman on the core request workflow — deliberately NOT on scripting, mocking, or cloud sync.

## Decisions

| Question | Decision |
|---|---|
| Collections model | One SQLite tree table (`somnus_tree`): collection → folders (nestable) → requests. |
| Variables | Environments only (named var sets, one active). Resolution order note kept for later collection-vars; not built. |
| `{{var}}` resolution | Pure TS function, applied frontend-side just before `somnus_send`. History stores the **resolved** request (Postman parity, same trust profile as v1 headers). |
| Secrets | `secret: true` flag per variable → masked input in UI, stored plaintext in SQLite (same exposure as v1 Authorization headers). Masking obligation stays at the LLM boundary (operator-tool seam, v1 spec §v2). |
| Auth helpers | Per-request: None / Bearer / Basic / API Key. Compiled to headers at send time, never stored as literal headers. Inherit-from-collection: deferred. |
| Body modes | None / Raw (JSON) / Raw (text) / `x-www-form-urlencoded`. Multipart/file upload: deferred. |
| Params tab | Key/value rows ↔ URL query string, bidirectional sync (single source of truth: the rows; URL edits re-derive rows). |
| Request tabs | Expanded mode only, in-memory (not persisted across app restarts). Rail mode stays single-composer. |
| Import/export | Postman Collection v2.1 + Postman Environment JSON. Import in fase 1, export in fase 2. |
| Scripting / tests / GraphQL / cookies / mock / sync | Out of scope, permanently until someone asks. |
| Primary surface | Expanded mode becomes the real app (3-pane). Rail mode = quick-shot composer + simplified lists. |

## Feature spec

### 1. Collections

- Tree: **Collection** (root) → **Folder** (nestable, any depth) → **Request**.
- CRUD via context menu on rows (shared `.rail-row` + hover-actions pattern): New collection, New folder, New request, Rename (inline input swap), Duplicate, Delete (confirm via the shared danger treatment, not `confirm()` — DESIGN rule 1).
- **Save from composer:** ⌘S with the panel focused → if the open request came from the tree, overwrite in place; if it's a draft, open a small save popover (name + collection/folder `CustomSelect`) anchored to the Send area.
- Clicking a tree request opens it in a tab (expanded) or loads the composer (rail).
- Dirty tracking: tab shows a dot when the draft differs from the saved row; save clears it.
- Ordering: `sort` column, new items appended. Drag-reorder is **fase 2** — pointer events + `elementFromPoint`, never HTML5 DnD (webview swallows it).

### 2. Environments & variables

- Environment = name + list of `{ key, value, secret }`. Any number; **one active** (or none).
- Editor lives in the expanded sidebar's **Env** tab: list of environments, click → var table (key / value / secret toggle / delete), add-row at bottom. Same input chrome as the headers editor.
- Active environment picker: `CustomSelect` at the right end of the composer's method/URL line (expanded) and a compact chip-select under the URL (rail). "No environment" is always the first option.
- **`{{var}}` syntax** accepted in URL, params, headers (key and value), body, and auth fields.
- Resolution: `resolveVars(text, vars)` — pure, single pass, no recursion (a value containing `{{other}}` is left literal; upgrade path documented in the code comment).
- Unresolved `{{var}}` at send time: request still sends with the literal text (Postman parity), but the composer marks the offending field with the `--fail` border treatment and a tooltip listing the missing keys. No hard block.
- Secret values render as password inputs with a reveal toggle; anywhere else they display as `••••`.

### 3. Composer parity (the four tabs)

Tab strip under the method/URL line replaces v1's Headers|Body pair: **Params · Auth · Headers · Body**. Counts render as trailing micro-badges (`Params (2)`) so state is visible from any tab.

- **Params:** key/value rows identical to headers rows. Editing rows rewrites the URL's query string; editing the URL re-derives the rows. Encoding via `URLSearchParams`.
- **Auth:** `CustomSelect` for type. Bearer → one token input. Basic → user + password inputs. API Key → key, value, and an in-header/in-query `CustomSelect`. Compiled at send: Bearer/Basic → `Authorization` header; API Key → header or query param. A literal `Authorization` header typed in the Headers tab wins over the Auth tab (explicit beats helper).
- **Headers:** v1 rows, unchanged, plus a checkbox-less enabled state is NOT added (YAGNI — delete the row instead).
- **Body:** mode `CustomSelect` (None / JSON / Text / Form-urlencoded). JSON mode = v1 textarea + a "format" action (pretty-print on demand); form mode = key/value rows serialized to `k=v&…` with `Content-Type: application/x-www-form-urlencoded` auto-set unless the user set one. Method no longer gates the body (any method may carry one — Postman parity); the tab merely hints "GET requests usually have no body" as a `.rail-notice` in None mode.

### 4. Request tabs (expanded only)

- Horizontal tab strip above the composer: method chip + name (or truncated URL for drafts) + dirty dot + close ×. (× is allowed on tabs — rule 10 bans it only for whole surfaces.)
- In-memory array `openTabs: { treeId: string | null, draft: SomnusDraft, dirty: boolean }[]`; "+" appends a blank draft.
- Closing a dirty tab asks once via the shared danger-confirm pattern. Esc still closes the whole Somnus surface (rule 10) — tabs are never an Esc stop.

### 5. Import / export

- **Import (fase 1):** toolbar action in the Collections sidebar tab → file picker (`.json`). Pure parser `postman.ts`: detects Collection v2.1 (`info._postman_id` / `item[]`, folders recurse) vs Environment (`values[]`). Maps method/url/header/body(raw+urlencoded)/auth(bearer/basic/apikey); everything else (scripts, tests, disabled entries) is dropped **with a visible import summary** ("14 requests imported, 3 scripts skipped") — never silent.
- **Export (fase 2):** collection → v2.1 JSON, environment → Postman env JSON, via save dialog.

### 6. History

Unchanged mechanics; relocates to a sidebar tab (see design). History rows gain a "Save to collection…" hover action so a good scratch request graduates without retyping.

## Design (the pass)

### Expanded mode — primary surface, 3-pane

```
┌──────────────────────────────────────────────────────────────────┐
│ rail-header: ● SOMNUS                    [env ▾]   [esc]         │
├───────────────┬──────────────────────────────────────────────────┤
│ SIDEBAR 280px │ ▸ tab strip: [GET users ●] [POST login] [+]      │
│ ┌───────────┐ ├──────────────────────────────────────────────────┤
│ │Collections│ │ [GET ▾] https://{{base_url}}/users      [Send]   │
│ │Env        │ │ Params · Auth · Headers · Body                   │
│ │History    │ │ (active tab editor)                              │
│ ├───────────┤ ├──────────────────────────────────────────────────┤
│ │ tree /    │ │ 200 OK · 1.39 s · 4.2 KB          ── response ── │
│ │ env list /│ │ json tree / pre                                  │
│ │ history   │ │                                                  │
└─┴───────────┴─┴──────────────────────────────────────────────────┘
```

- Same in-grid span technique as v1 (`body.somnus-expanded`, grid-row `1 / status-start` — keep it; it's the yellow-glow fix). Header keeps rule 10: labelled `esc` pill, no ×; **the rail-mode expand/collapse buttons are replaced by this esc** in expanded mode.
- Sidebar: segmented micro-tabs (Collections / Env / History) using `.rail-tabs`, then the list. One flat material (rule 5), `border-right: 1px solid var(--border)`.
- Tree rows: `.rail-row` chrome. Folders use chevron + indent (12px/level); requests lead with a **method chip**.
- **Method chip:** full verb, mono uppercase (`font-size: var(--fs-micro)`, `font-family: var(--mono-font)`), color from existing tokens only (rule 9-compatible — no ad-hoc palette): GET → `--ok`, POST → `--accent`, PUT/PATCH → `--running`, DELETE → `--danger`, HEAD/OPTIONS → `--text-tertiary`. Chip is colored text only — no filled pills, no per-row gradients.
- Response pane keeps v1 status spine (`--ok`/`--fail` left border) and JSON tree.
- Sharp corners everywhere (radius 0, appearance:none on every native input — light-theme reset gotcha), tooltips via `attachTooltip`, icons from `Icons.*`, all copy English, uppercase via CSS.

### Rail mode — quick shot

- Composer: method + URL + Send, env chip-select, the four tabs collapse to **Params · Auth · Headers · Body** in the same strip (they fit at `--fs-micro`).
- Scroller below: `.rail-tabs` toggling **History | Collections** (flat tree, indent only, no tab strip). Response renders above the lists after a send, as in v1.
- No request tabs, no env editor (a "Manage environments" row opens expanded mode on the Env tab).

## Data model (storage.rs SCHEMA, idempotent)

```sql
CREATE TABLE IF NOT EXISTS somnus_tree (
  id         TEXT PRIMARY KEY,          -- ULID
  parent_id  TEXT,                      -- NULL = root (collection)
  kind       TEXT NOT NULL,             -- 'collection' | 'folder' | 'request'
  name       TEXT NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0,
  request    TEXT,                      -- request-only: JSON SomnusDraft {method,url,params,headers,body,body_mode,auth}
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_somnus_tree_parent ON somnus_tree(parent_id);

CREATE TABLE IF NOT EXISTS somnus_environments (
  id        TEXT PRIMARY KEY,           -- ULID
  name      TEXT NOT NULL,
  vars      TEXT NOT NULL,              -- JSON [{key,value,secret}]
  is_active INTEGER NOT NULL DEFAULT 0  -- at most one row = 1, enforced in the write path
);
```

One JSON blob per request instead of columns: the composer round-trips the whole draft; SQL never queries inside it.

## Backend (somnus.rs — same module, same patterns)

- `somnus_tree_list() -> Vec<SomnusTreeNode>` (flat, frontend builds the tree).
- `somnus_tree_upsert(node)` — covers create, rename, move (parent_id), reorder (sort), save-request.
- `somnus_tree_delete(id)` — recursive delete of descendants, single transaction.
- `somnus_env_list()`, `somnus_env_upsert(env)`, `somnus_env_delete(id)`, `somnus_env_activate(id | null)`.
- `somnus_send` unchanged — variable resolution and auth compilation happen frontend-side, so the backend keeps exactly one job. The operator-tool seam from the v1 spec (§v2) is untouched.

## Frontend architecture

```
ui/src/somnus/
├── panel.ts        # SomnusPanel — shell, rail/expanded switch, wiring (shrinks: composer moves out)
├── composer.ts     # RequestComposer — method/URL/send + 4 tabs, emits SomnusDraft
├── tree.ts         # collections sidebar — render, CRUD, context menu
├── envs.ts         # environment editor + active-env select
├── tabs.ts         # expanded request-tab strip (in-memory)
├── vars.ts         # resolveVars, findUnresolved — pure
├── auth.ts         # compileAuth(draft) -> extra headers/params — pure
├── postman.ts      # importPostman(json) -> tree nodes | env — pure
├── curl.ts         # v1, unchanged
├── json-tree.ts    # v1, unchanged
└── somnus.css      # grows the 3-pane grid
```

`panel.ts` is 534 lines today; without the split it lands near 1500. Each new module is pure-render-helpers + a small class, testable without DOM where possible.

## Send pipeline (v2)

```
draft ──▶ compileAuth(draft) ──▶ mergeParamsIntoUrl ──▶ resolveVars(activeEnv)
      ──▶ SomnusRequest ──▶ somnusSend (unchanged) ──▶ history row (resolved)
```

## Error handling

- Import: malformed JSON / unknown schema → error card in the sidebar ("Not a Postman v2.1 collection or environment"); partial imports impossible (parse fully, then insert in one transaction).
- Tree writes: upsert/delete failures surface as a `.rail-notice.is-error`; the tree re-fetches to stay truthful.
- Unresolved vars: warn, never block (see §2).
- Deleting the active environment deactivates it (send falls back to literal text).

## Testing

- **TS (vitest, repo root):** `vars.ts` (resolution, unresolved detection, no-recursion), `auth.ts` (all four types, explicit-header-wins), `postman.ts` (v2.1 fixtures: nested folders, urlencoded body, auth variants, env file, garbage → null), params↔URL sync helpers, tree build/flatten helpers.
- **Rust:** tree CRUD incl. recursive delete + orphan check, env activate uniqueness, schema idempotency.
- **In-app verify (DOM dump recipe):** tree CRUD, save-from-composer, env switch changes a sent URL, import summary, rail↔expanded both themes.

## Fases

1. **Fase 1:** data model + tree + environments/vars + 4-tab composer + save/open + Postman import + design pass. (This spec's core.)
2. **Fase 2:** export, drag-reorder (pointer events), collection-level auth/vars inheritance, request tabs persistence.

Fase 1 is one implementation plan; fase 2 items are each small follow-ups.

## Out of scope

Pre-request/test scripting, GraphQL/WebSocket/gRPC, cookie manager, mock servers, cloud sync/workspaces, OAuth2 flows (the Auth tab covers static credentials only), multipart bodies, proxy settings.
