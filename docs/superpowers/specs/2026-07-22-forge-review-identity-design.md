# Forge Review Identity — GitHub sign-in for spec review writes

**Date:** 2026-07-22
**Status:** Approved (brainstorm)
**Repos:** `covenant-server` (primary), `karlTerminal` (Activity feed rendering)

## Problem

Spec shares (`/r/:token` on forge.covenant.uno) let anyone with the secret link
comment and — worse — APPROVE or REQUEST CHANGES with a free-text "Your name"
field. A verdict is an authorization artifact ("this was approved by X"), and
today it is spoofable: anyone with the link can type any name and approve.
This blocks adoption in security-reviewed environments and blocks the planned
collaborative layer (threads, mentions, resolve attribution), which needs
stable identities.

Reading by secret link is fine and stays as-is — capability URLs are the
industry standard for view access (Google Docs, Figma). `/g/` (gists) and
`/b/` (boards) are view-only and are untouched.

## Decision (user-approved)

- **All writes on the reviewer page require GitHub sign-in**: per-section
  comments AND verdicts. Viewing stays open by secret link.
- Mechanism: **web OAuth authorization-code flow + HttpOnly session cookie**,
  reusing the existing GitHub OAuth App (`Ov23liWVUtut6NkCyDAE`, today used by
  the desktop's device flow) and the server's existing `jwt.rs` + `users`
  table.

### Alternatives rejected

- **Magic-link email**: needs email-sending infra forge doesn't have; a
  verified email is weaker identity than a GitHub account for a dev audience.
- **Device flow in the browser**: copy-a-code-in-another-tab UX; the
  authorization-code flow exists precisely for browsers.
- **Per-share "require sign-in" toggle**: extra UI + state + logic branch for
  a mode (anonymous writes) we've decided against.
- **Reviewer allowlist / roles**: friction and code for a problem no real
  share has hit yet. Add when one does.

## Design

### 1. Server — web OAuth (`covenant-server`, new `src/web_auth.rs` or extend `auth.rs`)

- `GET /auth/github?next=<path>` → 302 to
  `https://github.com/login/oauth/authorize` with `client_id`, scope
  `read:user` (minimal — the desktop device flow's `repo` scope is not
  requested here; scopes are per-token), and a random `state`.
  - `state` is also set in a short-lived (~10 min) HttpOnly cookie; callback
    rejects on mismatch (CSRF).
  - `next` is validated to be a same-origin path (starts with `/`, no `//`)
    to prevent open redirects.
- `GET /auth/github/callback?code&state` → exchange `code` with
  `GITHUB_CLIENT_SECRET` (new env var) → fetch `/user` from the GitHub API →
  upsert into the existing `users` table (`github_id`, `login`,
  `avatar_url`) → set session cookie → 302 to `next`.
- Session cookie: `forge_session`, value = JWT from the existing `jwt.rs`
  (subject = user id + login), `HttpOnly; Secure; SameSite=Lax`, ~30-day
  expiry consistent with existing JWT policy.
- The GitHub access token is used once for the `/user` fetch and discarded —
  not stored.

### 2. Server — write gating (`src/review.rs`)

- `POST /r/:token/comments` and `POST /r/:token/verdict` require a valid
  `forge_session` cookie. Missing/invalid → `401` JSON
  `{ "login_url": "/auth/github?next=/r/<token>" }`.
- Author fields come from the session, never from the request body. The
  `author_name` body field is ignored on new writes.
- Migration: add nullable `author_login TEXT` and `avatar_url TEXT` columns
  to `spec_comments` and `spec_verdicts`. Legacy rows keep `author_name`;
  rendering prefers `@login` when present, falls back to `author_name`.
- Existing per-spec rate limits (`MAX_VERDICTS_PER_SPEC`, comment caps)
  unchanged.

### 3. Reviewer page (`/r/:token` template)

- **Signed out:** page renders fully readable. The ADD COMMENT affordances
  and the bottom verdict bar (name input, note, APPROVE / REQUEST CHANGES)
  are replaced by a single "Sign in with GitHub to review" button →
  `/auth/github?next=<current path>`.
- **Signed in:** avatar + `@login` render where the "Your name" input was;
  the free-text name input is removed entirely.
- Comment/verdict rows in the page's activity display show avatar +
  `@login` for authenticated rows, plain name for legacy rows.

### 4. Desktop (`karlTerminal`)

- `/specs/:id/activity` response rows (`CommentRow`, `VerdictRow`) gain
  optional `author_login` + `avatar_url`. The spec Activity feed in the app
  renders avatar + `@login` when present, `author_name` otherwise.
- Publishing/revoking flow untouched. No desktop auth changes — the desktop
  already has its own device-flow identity.

## One-time manual setup

- Add `https://forge.covenant.uno/auth/github/callback` as the Authorization
  callback URL on the existing GitHub OAuth App (device flow does not use the
  callback URL, so this is additive).
- Set `GITHUB_CLIENT_SECRET` on the App Service.
- Local dev: GitHub OAuth Apps allow one callback URL; test the OAuth flow
  against prod or a scratch OAuth App with a localhost callback. The gating
  logic itself is testable without GitHub (forge a session JWT in tests).

## Error handling

- OAuth callback failures (denied consent, bad code, GitHub API error) →
  redirect to `next` with a `?auth_error=1` query; page shows a small
  non-blocking notice and the sign-in button again.
- Expired session on POST → same `401 { login_url }` path; the page JS
  redirects to sign-in, and `next` returns the reviewer to where they were.

## Testing

- `review.rs`: POST comment/verdict without cookie → 401 with `login_url`;
  with valid session JWT → row inserted with `author_login` from session,
  body `author_name` ignored.
- OAuth: `state` mismatch → 400; `next` validation rejects absolute URLs and
  `//host` forms.
- Migration applies on a DB with existing legacy rows; activity render
  prefers login, falls back to name.
- Template: reviewer page renders both signed-in and signed-out states.

## Out of scope

- Reviewer allowlist / roles / permissions beyond "signed in".
- Gating `/g/` gists and `/b/` boards (view-only surfaces).
- Threads, mentions, notifications — the collaborative layer builds on these
  identities in a later iteration.
- Token expiry for share links (revoke already exists at `/specs/:id/revoke`).
