# Somnus REST Client — Design

**Date:** 2026-07-07
**Status:** Approved (brainstorm complete)
**Scope:** v1 — request composer + automatic history, rail panel with fullscreen expand. v2 (operator awareness) is designed as a seam only, not built.

## Goal

A REST/HTTP client living in Covenant's right rail: compose a request (method, URL, headers, body), send it, see the formatted response, and keep an automatic history of everything sent. Persistence is backend-side (SQLite) from day one so that v2 can give operators a `somnus_request` tool **and** read access to the user's request history.

## Decisions (from brainstorm)

| Question | Decision |
|---|---|
| v1 scope | Composer + automatic history. No collections, no environments. |
| Layout | Right-rail panel + expand-to-fullscreen. |
| Execution | All HTTP through Rust `reqwest` via a Tauri command (repo convention — the webview never fetches cross-origin). |
| Persistence | `somnus_history` table in `crates/app/src/storage.rs` (history.db). `somnus_send` writes the row itself — single write-path shared with v2 operator requests. |
| v2 meaning | Operator gets a `somnus_request` tool (gated per-operator like `gh_*`) and can read the user's request history. |
| curl paste | Included: pasting a `curl ...` command into the URL input parses it into the composer. |

## UX

### Identity

- New `RailTarget: "somnus"` in `ui/src/titlebar/right-rail.ts`.
- Titlebar button `#titlebar-somnus`, tooltip "Somnus" (via `attachTooltip`, never `element.title`), moon icon.
- Keyboard shortcut: **⌘⌥R** proposed — verify against existing bindings at implementation time; pick a free chord if taken.
- Host: in-grid `<aside id="somnus-panel" class="hidden">` in `ui/index.html`, sibling of `#beacon-panel`. `.hidden` **class** semantics (not the `hidden` attribute — known `[hidden]`-loses-to-`display:flex` trap).

### Rail mode (240px, `--right-sidebar-w`)

Standard `.rail-*` chrome (homologation v1):

- `.rail-header`: dot + `SOMNUS` label + expand button + close button.
- Compact composer: method `select` (GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS) + URL input + Send.
- Below the URL, `.rail-tabs`: **Headers** (key/value pairs, add/remove rows) and **Body** (textarea; only enabled for methods that take a body).
- `.rail-body` (the only scroller): after a send, the response — status + duration + size line, body pretty-printed when JSON. Below it, **History**: `.rail-row` entries with a method chip, truncated URL, status spine (`data-spine`: 2xx→`ok`, 4xx/5xx→`fail`, network error→`fail`, in-flight→`run`) and relative time. Clicking a row loads that request back into the composer.

### Fullscreen mode

- `body.somnus-expanded` switches `#somnus-panel` to fixed fullscreen — exact precedent: Tasker board (`body.tasker-board`, `ui/src/styles.css:16354`). Same DOM, class flip only, zero re-mount.
- Layout: history as a left column; request editor (URL bar + roomy headers/body editors) on top; response below with response headers visible.
- Esc or the collapse button returns to rail mode.

### curl paste

Pasting a string starting with `curl ` into the URL input parses method (`-X`), URL, headers (`-H`), and body (`-d`/`--data`/`--data-raw`) into the composer. One pure function + unit tests. Unsupported flags are ignored silently.

### Layout gotchas to apply (from rail homologation)

- `overflow: hidden` on the grid-item host — long content must scroll in `.rail-body`, not stretch `#layout`'s 1fr row.
- `border-left: 1px solid var(--border)` lives on the **host** `#somnus-panel`, not on `.rail-panel`.
- Entrance: the shared 6px opaque nudge (`right-rail-panel-in`) — no opacity fades on `#layout`-hosted panels (vibrancy bleed).
- `body.sidebar-view-somnus` grid rules cloned from the beacon block (both tabbar modes), plus the `#layout:has(...)` hide rules when full-page routes are open.

## Frontend architecture

```
ui/src/somnus/
├── panel.ts        # SomnusPanel class — builds .rail-panel DOM, owns state
├── curl.ts         # parseCurl(text) → SomnusRequest | null (pure)
├── somnus.css      # host/fullscreen layout only; visual chrome comes from .rail-*
├── panel.test.ts   # vitest — pure render helpers
└── curl.test.ts    # vitest — curl parser
```

- `SomnusPanel` follows `BeaconPanel`'s shape: constructor `(host, { onClose })`, builds its own DOM, exposes pure render helpers for tests. No polling — Somnus is user-initiated.
- Wiring in `main.ts`: import, host lookup, `railButtons` entry, `openRail`/`closeRail` switch cases, keyboard shortcut.
- Typed wrappers in `ui/src/api.ts`: `somnus.send(req)`, `somnus.history(limit)`, `somnus.deleteEntry(id)`, `somnus.clear()`.

## Backend

New module `crates/app/src/somnus.rs` (pattern: `beacon.rs` — all logic + unit tests in the module; thin `#[tauri::command]` shims in `lib.rs`, registered in the `generate_handler!` list).

### Types (derive `Serialize`/`Deserialize`, mirrored in api.ts)

```rust
pub struct SomnusRequest {
    pub method: String,              // validated against the 7 supported verbs
    pub url: String,                 // http/https only
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

pub struct SomnusResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    pub body: String,                // up to 2 MB; empty for binary
    pub body_truncated: bool,
    pub body_binary: bool,           // non-text content-type → body omitted, show "binary (N bytes)"
    pub duration_ms: u64,
    pub size_bytes: u64,
}
```

### Commands

- `somnus_send(req) -> Result<SomnusResponse, String>` — `reqwest` with 30 s timeout, default redirect policy, rustls. Reads the response body up to **2 MB** (sets `body_truncated`). Text detection by content-type: `text/*`, `application/json`, `application/xml`, `application/x-www-form-urlencoded`, and `+json`/`+xml` suffixes; anything else (or no content-type) → `body_binary: true`, body not returned or stored. **Writes the history row itself** (success or network error) before returning.
- `somnus_history(limit) -> Vec<SomnusHistoryEntry>` — newest first.
- `somnus_history_delete(id)`, `somnus_history_clear()`.

### Data model

Table in `crates/app/src/storage.rs` `SCHEMA` (idempotent `CREATE TABLE IF NOT EXISTS`, same as the ~20 existing tables):

```sql
CREATE TABLE IF NOT EXISTS somnus_history (
  id TEXT PRIMARY KEY,          -- ULID
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  req_headers TEXT NOT NULL,    -- JSON array of [k,v]
  req_body TEXT,
  status INTEGER,               -- NULL when the send failed at the network layer
  resp_headers TEXT,            -- JSON array of [k,v]
  resp_body TEXT,               -- capped at 256 KB stored
  error TEXT,                   -- network/timeout error message, NULL on success
  duration_ms INTEGER,
  size_bytes INTEGER,
  created_at INTEGER NOT NULL
);
```

Stored `resp_body` is capped at **256 KB** to keep history.db lean (display cap stays 2 MB in-memory). Rows are written via `spawn_blocking` like the rest of storage.rs.

## Data flow

Panel Send → `api.ts somnus.send()` → `invoke("somnus_send")` → reqwest → history row written → `SomnusResponse` back → panel renders response + prepends the history entry locally (no re-fetch needed; `somnus_history` is for panel open / reload).

## Error handling

- Network / DNS / timeout → `Err("somnus: <cause>")`. UI shows an error card in the response area; the attempt is still recorded in history with `error` set and a `fail` spine.
- Invalid URL / unsupported scheme → validated on both sides; frontend disables Send until the URL parses.
- Oversized body → `body_truncated: true` + a visible "Response truncated at 2 MB" notice.
- Binary responses → "binary (N bytes)" placeholder; body neither rendered nor stored.

## Security & secrets

- v1 is user-initiated only — same trust profile as the user running `curl` in their shell. No blocklist needed (there is no autonomous execution path yet).
- Request headers (including `Authorization`) are stored **raw, locally** in history.db — identical exposure to shell history recording `curl -H "Authorization: ..."`.
- The masking obligation is at the **LLM boundary in v2**: when operator tooling reads history to feed a model, Authorization-like headers and token-shaped values must be masked (CLAUDE.md pitfall 7). Not a v1 concern.

## Testing

- **Rust** (`somnus.rs`, mockito pattern from `github_tools.rs`): happy path GET/POST, header roundtrip, body truncation at cap, binary content-type handling, error shaping (`somnus: ...`), history row written on success and on network error. Storage: history CRUD + cap enforcement.
- **TS** (vitest, run from repo root): `parseCurl` (method/url/headers/data variants, garbage input → null), status→spine mapping, size/duration formatting.

## v2 seam (documented only — NOT built in v1)

1. `crates/app/src/teammate/somnus_tools.rs` mirroring `github_tools.rs`: tool def + handler calling the **same** core send function in `somnus.rs` (so operator requests land in the same history automatically).
2. Gate on `ToolEnv` (`tools.rs`): `somnus` flag + `with_somnus()` builder, mirroring `acp_enabled`.
3. Register in `all_tool_defs()` and `execute_tool()` in `teammate/llm.rs` (both Anthropic and OpenAI-compat loops pick it up), with a defense-in-depth refusal arm when gated off (see `dispatch_acp` pattern).
4. Per-operator toggle on `Operator` in `operator_registry.rs` (like `github_access`).
5. History-read tool masks Authorization-like headers / token-shaped values before returning content to the LLM.
6. Update the roster-count test in `llm.rs`.

## Out of scope (v1)

- Collections, environments/variables (`{{base_url}}`), request tabs.
- Auth helpers (OAuth flows, token refresh).
- WebSocket / GraphQL / gRPC.
- Import/export (OpenAPI, Postman collections) — curl paste is the only import.
- Operator tooling (v2).
