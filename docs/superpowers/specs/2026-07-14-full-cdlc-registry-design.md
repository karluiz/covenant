# Full CDLC Registry + Context Section Chrome

**Date:** 2026-07-14
**Status:** Approved
**Repos:** `karlTerminal` (client) + `covenant-server` (registry backend)

## Problem

1. Canon's Registry section only exposes Skills and Operators, but Canon's
   CDLC roadmap enumerates seven context kinds. Subagents, Commands, Context
   and MCP are authored locally (`.covenant/canon/<dir>/`) with no way to
   share them org-wide. The registry server (`/cdlc/packages`) has no notion
   of `kind` — it stores only skill packages (`skill_toml` + `skill_md`).
2. The Context section's "New context" button renders as a full-width
   bordered bar (the section column stretches it) and duplicates the
   empty-state's own "New context" button when the list is empty.

## Scope

Publishable kinds after this work: **skill, agent (Subagent), command,
context, mcp** via `/cdlc/packages`, plus **operators** via the existing
marketplace API (unchanged). **Spec and Memory stay local-only** — they are
inherently repo-specific.

## Design

### Server — covenant-server

**Migration `0008_package_kinds.sql`:**

```sql
ALTER TABLE cdlc_packages
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'skill'
  CHECK (kind IN ('skill','agent','command','context','mcp'));
ALTER TABLE cdlc_packages
  DROP CONSTRAINT cdlc_packages_org_id_name_version_key;
ALTER TABLE cdlc_packages
  ADD CONSTRAINT cdlc_packages_org_kind_name_version_key
  UNIQUE (org_id, kind, name, version);
```

Existing rows become `kind='skill'` via the column default.

**`src/cdlc.rs`:**

- `PublishReq` gains `#[serde(default = "default_kind")] kind: String`
  (default `"skill"`), validated against the allowed set. Old clients omit
  it and keep publishing skills.
- `SearchQ` gains `kind: Option<String>`; the query filters
  `AND kind = COALESCE($kind, 'skill')`. Defaulting to `'skill'` means old
  clients never see non-skill packages rendered as skills.
- `PkgMeta` and `PkgFull` gain `kind`.
- `resolve` path is unchanged (`org/name/version`) but the SQL filters by
  kind passed as a query param `?kind=`, defaulting to `'skill'`.
- Payload limits unchanged (`skill_md` ≤ 256 KiB covers every kind;
  non-skill kinds send `skill_toml: ""`).

Deploy: push to main → GHCR → webhook auto-deploy (existing CD).

### Client — karlTerminal

**`crates/app/src/canon_registry.rs`:** `search`, `publish`, `resolve` gain a
`kind: &str` param; `PkgMeta`/`PkgFull` gain `kind` (serde default
`"skill"` so a not-yet-deployed server doesn't break the client).

**Publish (`canon_publish` command gains `kind: String`):**

- `skill` — unchanged: `read_skill_package`, sends toml + md.
- `agent` / `command` / `context` — raw source `.md` via
  `karl_canon::read_source`, sent as `skill_md`, `skill_toml: ""`.
- `mcp` — the server JSON via `read_source`, **with every `env` value
  blanked (keys kept)** before upload. Secrets never reach the registry.
  Blanking happens in a pure helper with unit tests (safety-relevant).
- **Version for non-skill kinds:** first 12 hex chars of sha256(content).
  Content-addressed: re-publishing unchanged content → server Conflict,
  surfaced as "already published"; changed content → new version. `latest`
  resolve orders by `created_at`, so installs always get the newest.

**Install (`canon_install_registry` gains `kind`):**

- `skill` — unchanged (`install_package`).
- Other kinds — new `karl_canon::install_unit(repo, kind, name, content)`
  writes `.covenant/canon/<kind.dir()>/<name>.md` (`.json` for mcp), then
  the command re-projects (`project_with_active`). Install records to the
  server counter as today.
- Installed MCP servers arrive with blank env values — the row's existing
  edit affordance is where the user fills them in (no new UI).

**`crates/canon/src/kind.rs`:** `packageable: true` for Agent, Command,
Context, Mcp. Spec and Memory remain `false`.

**Registry UI (`ui/src/canon/cockpit/view.ts`):**

- Kind toggle generalizes from two buttons to a row driven by a list:
  `Skills | Operators | Subagents | Commands | Context | MCP`.
- Operators keep the marketplace search path (unchanged). All other kinds
  share `runSkillsSearch` generalized to pass `kind`.
- Result cards: version + sha chips hidden for non-skill kinds (the sha12
  version is noise); preview fetches `skill_md` as today (works for every
  kind — MCP previews as JSON in the markdown reader's code block).
- Install button dispatches per-kind as above.

**Publish affordances:** Subagents, Commands, Context and MCP section rows
gain the same upload icon button Skills rows have (org must be active;
tooltip "Publish to registry").

### Context section chrome

- `sectionHead(title, desc, action?)` gains an optional action slot: a
  compact button (existing `.canon-card-head button` secondary styling)
  right-aligned in the header row — not full-width.
- Context section: delete the full-width `.canon-new-context-btn`; "New
  context" becomes the head action. It renders only when the list is
  non-empty — the empty state keeps its single `rail-empty` button, so
  there is exactly one affordance at a time.
- The head-action slot is available to other sections but only Context
  adopts it in this change.

## Compatibility matrix

| Client \ Server | old | new |
|---|---|---|
| old | today's behavior | publish/search default to `kind='skill'` — unchanged |
| new | non-skill publish rejected (unknown field ignored → lands as skill!) | full CDLC |

**Old-server hazard:** an old server ignores the unknown `kind` field and
would store a command as a skill. Mitigation: server deploys first (same
day, CD is automatic); the client change ships in a later app release, and
`PkgMeta.kind` defaulting client-side is read-only. Acceptable because both
ends are ours and deploy ordering is controlled.

## Testing

- **Server:** publish/search/resolve round-trip per kind; old-client shape
  (no `kind`) still lands and searches as skill; unique constraint allows
  same name across kinds.
- **canon crate:** `install_unit` writes to the right dir per kind and
  re-projection picks the unit up; `list_context` flips packageable.
- **App crate:** MCP env-blanking helper (keys kept, values emptied,
  non-env JSON untouched).
- **UI (vitest):** kind toggle renders all six tabs; install dispatch per
  kind; head action hidden when context list empty.

## Out of scope

- Publishing Specs or Memory.
- Registry-side versioning UX for non-skill kinds (content-addressed only).
- Cross-org / public registry discovery.
- Filling MCP env values at install time.
