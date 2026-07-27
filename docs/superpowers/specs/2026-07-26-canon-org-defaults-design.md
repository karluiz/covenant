# Canon Org Defaults — Design

**Date:** 2026-07-26
**Status:** Approved (follow-on to the kind-scoping decision and the
owner-curated operator roster)

## Problem

Registry kinds (skill/agent/command/context/mcp) are repo-bound with explicit
per-repo install — correct, but there is no way for an org to say "every repo
of ours should have these". Operators got org-wide auto-sync; packages need
the equivalent *suggestion* lane without giving up the explicit-install gate
(MCP carries URLs/credentials and projects into `.mcp.json` that executors
execute — never auto-install).

## Model

**Org defaults** = a set of `(kind, name)` package refs per org, curated by
owners (same governance as the operator roster: owner defines, members
consume). Members see which defaults are missing in the current repo and
install them with one action. Nothing lands without that click.

## Server (covenant-server)

Migration `0015_org_defaults.sql`:

```sql
CREATE TABLE org_defaults (
  org_id     BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, kind, name)
);
```

| Endpoint | Auth | Behavior |
|---|---|---|
| `GET /orgs/:slug/defaults` | member | `[{kind, name}]`, ordered |
| `PUT /orgs/:slug/defaults/:kind/:name` | owner | 404 unless the package exists in the org registry; idempotent insert |
| `DELETE /orgs/:slug/defaults/:kind/:name` | owner | 404 if absent |

Defaults reference the package *name* (not a version) — installs resolve
`latest`, consistent with the registry search UI.

## Client

- New Tauri commands wrapping the endpoints (`canon_registry.rs` pattern):
  `canon_org_defaults_list`, `canon_org_default_set`, `canon_org_default_unset`.
- `canon_unit_installed(cwd, kind, name) -> bool` — filesystem check against
  `.covenant/canon/<kind-dir>/` so the UI can diff defaults vs. the repo.
- **Registry cards**: owners get a pin toggle ("Org default") per package;
  the badge is visible to everyone.
- **Organization section**: a defaults block for the current repo — each
  default with installed/missing state and one **Install missing** action
  (resolves `latest` through the existing install paths). Members see the
  same block; only the pin curation is owner-gated.

## Out of scope

- Auto-install (deliberately never).
- Update propagation for already-installed packages (separate "update
  available" concern).
- Per-repo opt-out memory ("don't suggest X here") — add if the suggestion
  gets noisy.

## Tests

Server: gate (member PUT forbidden), 404 on unknown package, idempotent set,
cascade with org. Client: org-section block renders missing state and installs
via the right API per kind; owner-only pin visibility.
