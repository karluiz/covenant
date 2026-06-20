# Covenant Cloud Sync — Design

> Status: design approved (sections 1–4 + specs addition). Next: implementation plan.
> Date: 2026-06-20

## Goal

A **Covenant Cloud** section in Settings that backs up and restores a user's
account-level state across machines: **workspaces, operators, specs, and
preferences**. The user's account always holds the latest snapshot (auto-push);
pulling onto a machine is always an explicit, confirmed **Restore** — never a
silent overwrite. Keyed by the existing GitHub identity + Covenant JWT.

## Sync model (chosen: "auto-push, manual restore")

- **Auto-push**: a debounced (~5 s) background push fires whenever any synced
  category changes locally. Fire-and-forget with silent retry; never blocks the
  UI. Guarantees the account trails the most-recent machine.
- **Manual restore**: pulling onto a machine is an explicit "Restore from
  cloud…" action with a confirmation dialog spelling out what changes.
- **Conflict**: last-write-wins by `updated_at_ms`. No merge UI. The section
  shows "last synced from `<device>` · `<time>`" for visibility. Two machines
  pushing near-simultaneously → last write wins (acceptable for this data).

## Non-negotiable: secrets never leave the device

`Settings` contains secrets (`anthropic_api_key`, `sendgrid_api_key`,
per-provider credentials, `telegram.bot_token`). These are **stripped before
upload** and **preserved-from-local on restore** (the cloud never carries them).
This honors CLAUDE.md pitfall #7. Enforced in Rust against the typed `Settings`
struct — one place, not duplicated in TS.

## Architecture & data flow

```
Settings UI ("Covenant Cloud" section)
   │  push (debounced, on change)        restore (explicit, confirmed)
   ▼                                              ▼
Tauri cmd cloud_sync_push()            cloud_sync_restore()
   │                                              │
   ▼  crates/app/src/cloud_sync.rs                ▼
gather:                                fetch blob from server
  tab_manifest.json (workspaces)       apply per-category:
  operators (SQLite + SOUL.md)           workspaces → overwrite tab_manifest
  specs (spec-drafts/*.json)             operators  → upsert by ULID, no delete
  Settings → strip secrets               specs      → upsert by ULID, no delete
build envelope                           prefs      → merge, keep local secrets
   │  PUT /sync/state  (Bearer JWT)
   ▼
covenant-server: user_sync_state (github_id PK, JSONB, device, updated_at)
   last-write-wins; returns updated_at + device for the readout
```

- **Auth**: reuse `karl_score::auth::load_jwt()` + `backend_url()`. The JWT
  stays in the keychain / Rust side; the webview never sees it. If not signed
  in, the section shows "Sign in to enable" (reuses the existing Score sign-in).
- **Where work lives**: Rust does gather + secret-strip + HTTP + apply. The
  frontend owns triggers (debounced push from save paths; explicit restore).
  Mirrors the existing Score sync (`/sync/events` is Rust-side).

## Envelope (server-side JSONB, one row per github_id)

```json
{
  "schema_version": 1,
  "updated_at_ms": 1718900000000,
  "device": "Karluiz-MacBook-Pro",
  "sections": {
    "workspaces":  { "…TabManifestV2…" }          ,
    "operators":   [ { "meta": {}, "soul_md": "" } ],
    "specs":       [ { "…SpecDraft…" } ]           ,
    "preferences": { "…Settings minus secrets…" }
  }
}
```

A section is `null` when its category toggle is off. The toggles + an `enabled`
flag live in a new device-local `cloud_sync` block in `Settings` (these settings
do **not** themselves sync).

## Per-category restore semantics

- **Workspaces** — wholesale overwrite of `tab_manifest.json`; `WorkspaceManager`
  re-reads. cwds are absolute and may not exist on another machine; a tab whose
  cwd is gone spawns at `$HOME`. Acceptable — that's "workspaces follow me".
- **Operators** — **upsert by ULID `id`, never delete.** Updates metadata +
  rewrites `SOUL.md` from synced content; locally-only operators are left alone.
  Deleting would orphan XP/decisions/memories keyed by id. `soul_path` is
  machine-specific → stripped on upload, regenerated locally from the slug on
  import.
- **Specs** — **upsert by ULID `id`, never delete.** `repo_root` kept as-is
  (a filter tag; harmless if the path is absent on another machine — the draft
  still appears in the global list). No secrets. Sync only the 20 most-recent
  drafts (matches the existing `list_drafts` cap), bounding payload size.
- **Preferences** — **merge that preserves local secrets.** Pull cloud prefs
  (never contained secrets), re-inject this machine's local secret fields, then
  save. A fresh machine gets fonts/theme/model-routes/notch/AOM config without
  clobbering (or needing) locally-entered keys.

## Server endpoint (covenant-server)

Migration `migrations/0004_cloud_sync.sql`:

```sql
CREATE TABLE user_sync_state (
  github_id  BIGINT PRIMARY KEY REFERENCES users(github_id) ON DELETE CASCADE,
  state      JSONB NOT NULL,
  device     TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Route (in `src/main.rs`, beside the existing `/sync/*`):

```rust
.route("/sync/state",
   put(sync::put_state).get(sync::get_state).delete(sync::wipe_state))  // all JWT
```

- `put_state` — `bearer()` + `jwt::verify()` → `claims.sub`, then
  `INSERT … ON CONFLICT (github_id) DO UPDATE`. Returns `{ updated_at_ms }`.
  **Payload cap 5 MB** (worst case ~2 MB; cap protects the DB).
- `get_state` — returns blob + `updated_at_ms` + `device`, or 204 if none.
- `wipe_state` — deletes the row (for "disable & remove cloud copy").

Reuses existing auth helpers and the `published_profiles` JSONB pattern — no new
server primitives.

## Settings UI — "Covenant Cloud" section

New nav entry **Covenant Cloud** (after Workspace). Contents:

- **Account state**: signed in → avatar + login + "Last synced from `<device>` ·
  `<time>`"; not signed in → "Sign in with GitHub to enable" (reuses Score
  sign-in).
- **Master toggle** "Sync to Covenant Cloud" + four category checkboxes:
  **Workspaces / Operators / Specs / Preferences**, with a permanent sub-note:
  *"API keys and tokens are never uploaded."*
- **Buttons**: "Back up now" (manual push) and "Restore from cloud…" (explicit;
  confirm dialog: workspaces *replaced*, operators/specs *merged*, preferences
  *merged, keys kept*).
- **Status line** mirroring the Models page "✓ reachable" style: "✓ synced · N
  categories" / "✗ sign-in required" / "⟳ syncing".

## Tauri commands (`crates/app/src/cloud_sync.rs`)

- `cloud_sync_status()` → `{ signed_in, enabled, toggles, last_synced_ms, device }`
- `cloud_sync_push()` → `{ updated_at_ms }` (gather, strip, PUT)
- `cloud_sync_restore()` → applies the cloud blob per category; returns a summary
- `cloud_sync_set_config(cfg)` → persists toggles to local `Settings`
- `cloud_sync_wipe()` → DELETE `/sync/state` and clear local sync state

## Auto-push wiring (frontend)

A single debounced `scheduleCloudPush()` (~5 s) called from the existing local
save paths:

- `WorkspaceManager.saveAll()` (workspaces)
- operator create / update / delete (operators)
- `spec_author_save_markdown` / spec step completion (specs)
- settings save (preferences)

Fire-and-forget; failures retry silently; never blocks the UI. No-op when not
signed in or `enabled` is false.

## Testing (where a bug loses data)

- **Secret round-trip** (unit, Rust): `Settings` with keys → strip → assert keys
  absent in uploaded JSON; restore-merge with a cloud blob → assert local secret
  fields preserved.
- **Operator/spec upsert-no-delete** (unit, Rust): restore a blob missing a
  locally-present operator/spec → assert the local one survives; restore an
  updated one → assert it's overwritten.
- **Server upsert** (handler/integration): `put_state` then `get_state`
  round-trips the blob; second `put_state` overwrites; `wipe_state` removes.

## Out of scope (YAGNI)

- CRDT / field-level merge. Last-write-wins is sufficient.
- Exact-mirror restore with deletions (operators/specs). Upsert-only for now;
  a "mirror" toggle can come later if asked.
- Real-time live sync / multi-device presence. Auto-push + manual restore covers
  the need.
- Syncing secrets, history.db blocks, familiars, or score data (already synced
  via `/sync/events`).
