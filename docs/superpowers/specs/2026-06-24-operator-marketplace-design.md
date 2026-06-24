# Operator Marketplace — Design

> Status: approved design, pre-implementation. Date: 2026-06-24.

## Goal

Let Covenant users **publish** their operator configurations and **search/install**
operators published by others, directly from the desktop app. Curated: a
submission is private (pending) until `karluiz` approves it.

## Guiding principle (ponytail)

This is mostly assembly of existing parts, not a new system:

- `soul_md` (the SOUL.md text) is already the canonical operator interchange format.
- `operator_create_from_soul` already imports a SOUL.md into the local registry.
- covenant-server already has GitHub-JWT auth, Postgres, an HTTP client on the
  desktop (`cloud_sync`), and minijinja templating (the forge profile pages).

So the marketplace = **one table + ~5 routes + one settings tab + one publish action.**

## Interchange format

The unit shared is **`soul_md` only** — not the full `OperatorExport.meta`.

SOUL.md carries everything shareable: `name`, `avatar`/emoji, `color`, `model`,
`voice`, `escalate_threshold`, `tags`, `hard_constraints`, and the persona body.

It deliberately **excludes** per-user / security state, which MUST NOT travel:

- `github_access` → imported operators default to `Off`. **(security: do not change)**
- `xp`, `is_default`, `id`, timestamps → all regenerated locally on import.

## Server (covenant-server, Postgres)

### Table `marketplace_operators`

```sql
CREATE TABLE marketplace_operators (
  id                TEXT PRIMARY KEY,           -- ULID, generated on submit
  author_github_id  BIGINT NOT NULL,
  author_login      TEXT NOT NULL,
  name              TEXT NOT NULL,
  emoji             TEXT NOT NULL,
  color             TEXT NOT NULL,
  tags              JSONB NOT NULL DEFAULT '[]',
  tagline           TEXT NOT NULL DEFAULT '',
  soul_md           TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  installs          INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX marketplace_operators_status ON marketplace_operators(status);
```

The desktop sends already-parsed identity fields alongside `soul_md`, so the
**server does no YAML parsing**.

### Routes (all behind the existing JWT middleware)

| Method | Path | Auth | Behavior |
|---|---|---|---|
| `POST` | `/marketplace/operators` | any signed-in | Insert row, `status='pending'`, author from JWT. Body: `{name, emoji, color, tags, tagline, soul_md}`. |
| `GET`  | `/marketplace/operators?q=&tag=` | any signed-in | Return `status='approved'` rows incl. `soul_md` (so install is one call). `q` = case-insensitive substring over name+tagline+tags; `tag` = exact tag match. Sort: `installs DESC, created_at DESC`. |
| `POST` | `/marketplace/operators/:id/install` | any signed-in | `installs += 1`. Fire-and-forget. |
| `GET`  | `/marketplace/admin` | login==`karluiz` | minijinja HTML: list pending rows, each with Approve / Reject buttons. |
| `POST` | `/marketplace/operators/:id/approve` | login==`karluiz` | `status='approved'`. |
| `POST` | `/marketplace/operators/:id/reject` | login==`karluiz` | `status='rejected'`. |

Admin gate: a small helper that reads the JWT login and 403s unless it equals
`karluiz` (hardcoded constant — `ponytail: single curator, lift to an admin
table if a second curator is ever needed`).

## Desktop (ui + crates/app)

### api.ts (typed wrappers)

- `marketplacePublish(op: Operator): Promise<void>` — derive `tagline` (first
  non-heading line of persona, truncated), read the operator's `soul_md` via a
  Tauri command, POST it.
- `marketplaceSearch(q?: string, tag?: string): Promise<MarketplaceListing[]>`
- `marketplaceInstall(listing): Promise<Operator>` — `operatorCreateFromSoul(soul_md)`,
  then POST the install counter.

`MarketplaceListing = { id, name, emoji, color, tags, tagline, author_login, installs, soul_md }`.

The HTTP calls reuse the `cloud_sync` client + bearer token already used for
desk sync (same base URL, same auth header).

### Tauri commands (crates/app)

- `operator_read_soul(id) -> String` — return the operator's SOUL.md text for publish.
  *(may already exist via cloud_sync export; reuse if so.)*
- Reuse existing `operator_create_from_soul(soul_md)` for install.

### Operators pane (`ui/src/settings/operators.ts`)

- New **"Marketplace" tab/segment** next to the local operator list.
- Search box + responsive card grid of approved operators. Card: emoji on
  `color` chip, name, tagline, tag pills, `@author_login`, install count, and an
  **Install** button.
- Install flow: `marketplaceInstall()` → operator appears in the local list. On
  name collision (local has a unique-name index), append ` (community)` before
  create; if still colliding, append a short suffix.
- **Publish action** on each *local* operator (card context menu or editor
  footer): `marketplacePublish()` → toast "Submitted — pending review."

## Error handling

- Publish when not signed into Covenant Cloud → inline notice prompting sign-in
  (same path as cloud sync's unauthenticated state).
- Install name collision → suffix as above; never overwrite an existing local operator.
- Server 403 on admin routes for non-curators → plain 403 page.
- Empty search results → friendly empty state in the grid.

## Testing

- Server: a route test that submit → (still pending, absent from GET) → approve →
  (now present in GET) → install (counter increments). One test covers the lifecycle.
- Desktop: unit test for `tagline` derivation and the name-collision suffixing
  (pure functions, assert-based).

## Explicitly out of scope (YAGNI — add when needed)

- Versioning / changelogs — re-publish overwrites the author's listing.
- Ratings / reviews — `installs` is the only popularity signal for v1.
- Dependency graph, licensing/author-bio metadata.
- In-app moderation queue — the forge admin page covers curation.
- Public (unauthenticated) web gallery — all routes require sign-in for v1.
