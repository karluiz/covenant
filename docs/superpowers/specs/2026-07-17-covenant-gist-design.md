# Covenant Gist — share any file, view-only

**Date:** 2026-07-17
**Branch:** `feat/covenant-gist`
**Status:** Approved design, pending implementation plan

## Problem

Covenant can share a **spec** (markdown) behind a secret `/r/:token` link with
per-section comments and a verdict (see
`docs/superpowers/plans/2026-07-14-spec-share-review.md`). There is no way to
share an **arbitrary file** — a config, a log excerpt, a source file — as a
plain, view-only link. That's a gist: one file, one unguessable link, read-only.

This reuses the spec-share plumbing almost entirely **by subtraction**: same
token model, same minijinja JSON-island render pattern, minus comments, verdict,
and versioning.

## Scope (v1)

- **One file → one secret link.** No multi-file bundles.
- **View-only.** No comments, no verdict, no viewer login. Security is the
  unguessable 32-hex token (122 bits), identical to spec-share.
- **Rendering:** `.md` / `.markdown` → rendered markdown (reuse review.html's
  escape-first inline-JS renderer). Every other extension → `<pre>` with a
  line-number gutter, no syntax color.
- **Two launch points:** file-editor header icon, and Files-tree right-click.

### Out of scope (follow-ups)

- Multi-file bundles (true gist with a file sidebar).
- Versioning / republish history.
- Syntax-highlight colors (highlight.js).
- Expiry / TTL — revoke covers takedown.

## Architecture

Two repos, same as spec-share.

### Server — repo `covenant-server` (deployed to forge.covenant.uno)

Not checked out in this workspace; edited in its own repo and deployed via its
own pipeline. Model the new module on the existing view-only `src/profile.rs` +
`src/templates/profile.html` and the token/island pattern in `src/review.rs`.

**Migration `0010_gists.sql`** — one flat table (additive, runs at boot):

```sql
CREATE TABLE gists (
    id             BIGSERIAL PRIMARY KEY,
    token          TEXT NOT NULL UNIQUE,
    filename       TEXT NOT NULL,
    language       TEXT NOT NULL,        -- file extension, e.g. "rs", "md", "json"
    content        TEXT NOT NULL,        -- whole file, inline
    owner_github_id BIGINT NOT NULL,
    revoked        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**`src/gist.rs`** — routes:

| Route | Auth | Handler |
|---|---|---|
| `POST /gists` | JWT | insert row, token = `Uuid::new_v4().simple()`, return `{id, token}` |
| `PUT /gists/:id` | JWT owner | update `filename`/`language`/`content` in place (re-share keeps the link) |
| `POST /gists/:id/revoke` | JWT owner | set `revoked = true` |
| `GET /g/:token` | none | render page; `WHERE token=$1 AND NOT revoked` → generic 404 if missing/revoked |

Owner gating: `owned_gist(pool, id, owner)` → non-owner returns generic 404
(copy `owned_spec` in `review.rs`). Body-limit layer 1 MiB on the write routes.

**`src/templates/gist.html`** — trimmed clone of `review.html`:

- Keep: the `<script type="application/json">` island parsed client-side, the
  `.replace('<', "\\u003c")` script-safety escape, the escape-first inline
  markdown renderer.
- Drop: TOC/comment drawers, `#verdict-bar`, all `POST` fetch calls.
- Renderer branches on `language`: `md`/`markdown` → render markdown;
  otherwise → escape content, split on `\n`, emit `<pre>` with a
  line-number gutter.
- Template vars: `{{ title }}` (= filename, auto-escaped via `.html` template
  name) and `{{ data_json | safe }}`.

### Desktop — repo `karlTerminal` (this repo)

**`crates/app/src/covenant_gist.rs`** — clone `covenant_review.rs` minus
comments/activity/poll:

- Local store `gist_shares.json` in `app_config_dir()`:
  `HashMap<absoluteFilePath, GistShare { gist_id, token, url }>`.
- HTTP via the same `jwt()` / `client()` / `send_authed()` trio (401 → refresh
  + retry) and `auth::backend_url()`.
- Commands (registered in `crates/app/src/lib.rs`):
  - `gist_get_share(path) -> Option<GistShare>`
  - `gist_publish(path) -> GistShare` — read file, derive `filename` +
    `language` (extension) from the path; if already shared and not revoked →
    `PUT /gists/:id` and reuse the link, else `POST /gists`; save store;
    `url = {backend}/g/{token}`.
  - `gist_revoke(path)` — `POST /gists/:id/revoke`, drop from store.

**`ui/src/gist/api.ts`** — thin wrapper: `gistApi.{ getShare, publish, revoke }`
invoking the Tauri commands.

**Launch points** (both: call `gist_publish`, copy URL to clipboard, toast):

1. **File-editor header** — a share icon (`Icons.share`) that shares the
   currently open file. Icon reflects shared state; click when shared opens a
   small menu (Copy link / Revoke).
2. **Files-tree right-click** — menu items that adapt to share state:
   unshared → "Share as gist"; shared → "Copy gist link" / "Revoke".

## Data flow

```
editor/tree action
  → gist_publish(absPath)
      read file → {filename, language, content}
      POST /gists (or PUT /gists/:id if in store)   [JWT]
      ← {id, token}
      url = {backend}/g/{token}; save gist_shares.json
  → clipboard.write(url) + toast

viewer opens {backend}/g/{token}
  → GET /g/:token   → gist.html + JSON island
  → client renders: md → markdown, else → <pre> + line numbers
```

## Error handling

- Publish on unreadable/missing file → surface error toast, no store write.
- Revoked or unknown token → generic 404 page (no distinction, matches
  spec-share; avoids token enumeration).
- 401 on any authed call → `send_authed` refreshes JWT once and retries
  (existing behavior).
- File > 1 MiB → server 413 (body-limit layer); surface as toast.

## Testing

- **Server:** unit test for `owned_gist` gating (non-owner → 404); a
  render test asserting a code file produces a `<pre>` with line numbers and a
  `.md` file renders markdown; an XSS regression test — filename `</script>` and
  `<script>` in content must not break out of the island (mirror review.html's
  guard).
- **Desktop:** unit test for `language` derivation from path extension
  (`.rs` → `rs`, no extension → sensible default). Store round-trip:
  publish then `gist_get_share` returns the same token; re-publish reuses the
  gist_id (PUT path); revoke drops the entry.
- **In-app e2e (manual/DOM-dump):** share from editor → open `/g/:token` in
  browser → renders → revoke → 404.
