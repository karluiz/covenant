# Spec Share & Review — design

**Date:** 2026-07-14
**Status:** approved for planning

## Problem

Specs authored in Covenant can only be validated by whoever sits at the app. Karluiz wants to validate a spec with another person online — VS Code Live Share energy, but for spec review: share it, get anchored comments and a verdict, iterate.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Mode | Review-with-link: reviewer opens a browser page, comments, gives a verdict. Owner sees comments arrive in the app. Not live co-editing. |
| Link lifetime | Persistent on the covenant server (`forge.covenant.uno`); survives the app closing. |
| Reviewer identity | Secret token in the URL is the credential. Reviewer types a display name (kept in `localStorage`); anonymous allowed. No login. |
| Review output | Comments anchored to markdown headings + threaded replies + resolve, plus a final verdict: **Approve** / **Request changes** (+ optional note). |
| Updates | Explicit republish → new version. Link always shows latest, with an "updated" badge; comments are sealed to the version they were made on. Old versions viewable read-only. |

## Rejected approaches

- **Live session over the RC relay only** — no persistence; link dies with the app. Contradicts link-lifetime decision.
- **Secret GitHub Gist** — laziest, but forces a GitHub account on the reviewer, no section anchoring, no verdict.

## Architecture

Extend the existing covenant server (Rust/axum, Azure, `forge.covenant.uno`). No new services, no frontend framework for the reviewer page.

```
Covenant desktop ── JWT ──► covenant server ◄── token ── reviewer browser
  "Share for review"          /specs CRUD           GET /r/:token
  comments panel (poll)       comments/verdict      comment + verdict forms
```

## Data model (server)

```
SharedSpec   { id, token, title, owner_user_id, created_at, revoked }
SpecVersion  { spec_id, version, markdown, published_at }
Comment      { id, spec_id, version, anchor_heading, parent_id,
               author_name, body, resolved, created_at }
Verdict      { spec_id, version, author_name,
               verdict: approved | changes_requested, note, created_at }
```

- `anchor_heading` is the heading text (e.g. `## Architecture`). Survives edits while the heading exists; if a republish removes it, the comment falls back to an "unanchored" bucket rendered at the top. Duplicate heading texts anchor to the first occurrence (`ponytail:` add an ordinal suffix only if real specs ever collide).
- Republish inserts a new `SpecVersion` row. Comments/verdicts record the version current when they were made.
- Revoke sets `revoked`; the link 404s.
- `parent_id` gives one level of threading (replies to a comment).

## Server endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /specs` | Covenant JWT | Publish v1, returns `{ token, url }` |
| `POST /specs/:id/versions` | JWT | Republish (vN+1) |
| `POST /specs/:id/revoke` | JWT | Kill the link |
| `GET /specs/:id/activity` | JWT | Comments + verdicts (desktop poll) |
| `POST /specs/:id/comments/:cid/resolve` | JWT | Owner resolves |
| `GET /r/:token` | token | Reviewer page (server-rendered HTML) |
| `GET /r/:token/v/:n` | token | Older version, read-only |
| `POST /r/:token/comments` | token | New comment / reply |
| `POST /r/:token/verdict` | token | Approve / request changes |

## Reviewer page (`GET /r/:token`)

- Server-rendered HTML + vanilla JS, same pattern as the `/u/<login>` HUD profile. No build step.
- Markdown rendered with a side TOC of headings; each heading gets a "Comment" affordance opening a drawer: name field (persisted in `localStorage`) + textarea.
- Threads render inline under their section; resolved threads collapse.
- "Updated to vN" badge when a newer version exists than the one last seen; version selector for read-only history.
- Fixed footer: **Approve** / **Request changes** + optional note.

## Desktop (Covenant)

- **"Share for review"** action on existing spec surfaces (Set spec picker / spec view): publishes v1, copies the link, shows a "Shared · v1" chip.
- Chip menu: **Republish** (uploads current markdown as vN+1), **Copy link**, **Revoke**.
- Comments panel in the spec view: threads grouped by section, resolve button, current verdict pinned on top.
- Poll `GET /specs/:id/activity` every ~15s while the spec view is open. `ponytail:` poll; upgrade to push via the RC relay if latency ever matters.
- In-app notification on new comment or verdict (from the same poll — nothing arrives while the app is closed, by design; it catches up on next open).

## Security & errors

- Token: 128 random bits, URL-safe. Possession of the link = read/comment access. Revocable.
- Publish/republish/revoke/resolve require the existing Covenant JWT; reviewer routes require only the token.
- Rate-limit comment/verdict POSTs per token. Max sizes on markdown and comment bodies.
- Sanitize rendered markdown on the reviewer page (owner→reviewer XSS is the vector).
- Revoked or unknown token → generic 404.
- Secrets: specs pass through the same masking expectations as anything leaving the machine — the owner chooses what to publish; no automatic scanning in v1. `ponytail:` no secret-scan on publish; add the agent-side token-pattern mask if specs start embedding env dumps.

## Testing

- Server: CRUD round-trip, token auth boundaries (JWT routes reject token, token routes reject nothing-but-valid-token), anchor fallback when a heading disappears on republish, revoke → 404.
- Desktop: unit test for the heading parser that builds comment anchors.
- Reviewer page: one integration test rendering a spec with comments + posting a comment.

## Out of scope (v1)

- Live co-editing / CRDT, presence ("who's viewing"), reviewer GitHub login, line-level anchors, push notifications while the app is closed, multiple reviewers with distinct permissions (everyone with the link is equal).
