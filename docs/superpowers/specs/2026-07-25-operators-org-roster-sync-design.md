# Operators: Org Roster Sync — Design

**Date:** 2026-07-25
**Status:** Approved direction (option C from the kind-scoping review)
**Depends on:** covenant-server (forge.covenant.uno) deploy for the new endpoints

## Problem

Operators are the only Canon kind that is genuinely org-wide — a roster of
"versions of you/your team", not tied to any repo. Today the org association is
cosmetic: `Operator.org_slug` is a local SQLite column used as a client-side
filter (`ui/src/operator/org-filter.ts`). Two members of the same org see
completely different "org" rosters. Meanwhile every `ContextKind`
(skills/commands/subagents/context/mcp) is correctly repo-bound with the org
registry as distribution channel, and memory/specs are correctly repo-only —
those don't change.

This spec makes the **org the source of truth for org-tagged operators**, with
the existing local store (SQLite + SOUL.md) as the offline cache.

## Scoping decision (recorded)

| Kind | Scope |
|---|---|
| Operators | **Org-wide** (this spec) |
| Skills, Commands, Subagents, Context, MCP | Repo-bound, org-distributable via registry (unchanged) |
| Memory, Specs | Repo-only, never packageable (unchanged) |

Follow-up (not this spec): the operator *marketplace* is global/unscoped while
the CDLC registry is org-scoped — reconcile later.

## What travels vs. what stays local

The split already exists in the code as "Registry-only (NOT SOUL frontmatter)"
comments — we promote it to the sync boundary:

**Org-shared (synced):** everything SOUL.md expresses — name, emoji/avatar,
color, tags, persona (soul body), escalate_threshold, model, voice,
hard_constraints. Wire format = the verbatim `soul_md` plus
`{ id, updated_at_unix_ms }`.

**Machine-local (never synced):** `is_default`, `xp`, `github_access`,
`acp_enabled`, `perception_enabled`, `soul_path`, session pins. These are
per-machine trust grants and usage state. A pulled org operator arrives with
all grants Off — each machine opts in locally.

**Personal operators** (`org_slug = None`) are untouched by this spec: local
only, as today.

## Server contract (covenant-server)

New table `org_operators (org_id, operator_id TEXT PK-part, soul_md TEXT,
updated_at_ms INTEGER, updated_by TEXT)`, keyed `(org_id, operator_id)`.

| Endpoint | Auth | Behavior |
|---|---|---|
| `GET /orgs/{org}/operators` | member | Full roster: `[{ operator_id, soul_md, updated_at_ms, updated_by }]` |
| `PUT /orgs/{org}/operators/{id}` | member | Upsert. Body `{ soul_md, updated_at_ms }`. Server keeps the row iff incoming `updated_at_ms` ≥ stored (LWW); returns the winning row either way. |
| `DELETE /orgs/{org}/operators/{id}` | owner | Remove from roster. |

Any member writes (same trust bar as publishing a package to the org); only
owners delete. No tombstones — `GET` returns the full roster and the client
reconciles (rosters are ~tens of rows).

## Client design (crates/app)

New module `crates/app/src/operator_sync.rs`, HTTP via the same
`karl_score::auth::send_authed` pattern as `canon_registry.rs`.

### Push — when a local edit touches an org operator

Triggered by: `operator_set_org(id, Some(slug))` (the promote action),
`operator_update` / `operator_update_from_soul` on an op with `org_slug`.
Fire-and-forget task: `PUT` the current `soul_md` + `updated_at_unix_ms`.
Failure → tracing warn + UI sync chip shows "offline"; next pull reconciles.

### Pull — on org selection and app boot

Triggered by: Canon org chip selection of a non-personal org, and once on boot
for the saved `canon_org` of each restored group.

1. `GET /orgs/{org}/operators`.
2. For each row: parse soul; build/refresh the local `Operator` via the
   existing `OperatorRegistry::import()` (upsert by id, writes verbatim
   soul_md — already implemented and tested). Preserve existing local grant
   fields on update; zero them on insert. Skip rows whose `updated_at_ms` ≤
   local `updated_at_unix_ms` (local is newer → push instead).
3. Reconcile deletions: any local operator with this `org_slug` absent from
   the roster is deleted locally — unless it is the machine default, in which
   case it is demoted to personal (`org_slug = None`) instead of deleted.
4. Pull failure (offline / backend down) → keep local cache, no deletions.
   This matches `org-filter.ts`'s existing "knownSlugs === null" stance:
   never destroy data on a failed fetch.

### Conflicts

Last-write-wins on `updated_at_unix_ms`, both directions. No merge UI. Souls
are small markdown files edited by one person at a time in practice; if LWW
ever bites, the losing version is still on the loser's disk until the next
pull. `// ponytail: LWW on updated_at; add per-field merge only if real users
report clobbers.`

## UI

- Canon cockpit Operators section keeps its rendering; org view now reflects
  the server roster after pull. Add a small sync state to the section header:
  `synced · <n>` / `offline cache` / `syncing…`.
- "Move to org" (existing `operator_set_org` action) becomes the publish
  gesture — copy stays as-is, tooltip gains "shared with <org>".
- Pulled operators are full local citizens: pinnable, editable (edits push),
  grants configurable locally.

## Out of scope

- Syncing personal operators across a user's own machines (belongs to
  `cloud_sync` sections; separate change).
- Marketplace/org-registry unification for operators.
- XP aggregation across the org.
- Real-time push (webhooks/SSE) — pull-on-select is enough at roster scale.

## Phases

**P1 — server + push/pull core.** Server endpoints + table; `operator_sync.rs`
with push-on-edit and pull-on-org-select using `import()`; no deletion
reconcile yet. Tests: sync module unit tests against a mock server; registry
import-preserves-grants test.

**P2 — reconcile + status.** Deletion reconcile with default-demotion guard;
boot-time pull; sync chip in cockpit. Tests: reconcile never deletes on fetch
failure; default demotion path.

## Test notes

- `import()` already has coverage (insert/update/verbatim-soul). Add: update
  preserves `github_access`/`acp_enabled`/`perception_enabled`/`xp`/`is_default`.
- Reconcile: roster-absent op deleted; default demoted not deleted; offline
  no-op.
- Server LWW: stale PUT returns stored row, does not clobber.
