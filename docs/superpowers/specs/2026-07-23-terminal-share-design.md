# Terminal Share (read-only) — Design

**Date:** 2026-07-23
**Status:** Approved approach A (guest lane on the RC relay)

## Goal

Share one live terminal session read-only with an external dev via a secret
link, no account required. Link dies on revoke or when the session closes.

## Decisions (user-confirmed)

- Access: secret link `/t/:token` on forge, gist-style. No viewer account.
- Content: live mirror of the visible screen only (existing `MirrorScreen` +
  `MirrorData` stream). No scrollback.
- Lifetime: until owner revokes or the session/tab closes. No timed expiry.
- Entry point: tab context menu → "Share read-only". Badge on the tab while
  shared. Same UX pattern as gist share.

## Architecture

Reuses the existing RC pipeline end-to-end. The desktop already streams a
read-only mirror (`MirrorStart` → `MirrorScreen{screen, cols, rows}` +
`MirrorData{b64}`) to the relay hub in `covenant-server/src/rc.rs`, keyed by
the owner's `gid`. The feature adds a **Guest** lane to that hub plus a token
table, and a share entry point in the app.

```
guest browser ──/t/:token (HTML+xterm)──► forge
guest browser ──WS /rc/guest?token=T───► hub(gid) ◄──WS /rc/desktop── Covenant app
                    │  filter: only Mirror* frames for the shared session_id
```

### covenant-server (repo: covenant-server, on top of main)

1. **DB**: `term_shares (id, token, owner_github_id, session_id, revoked,
   created_at)`. Token = `uuid::Uuid::new_v4().simple()` (same as gists).
2. **Owner routes** (JWT-gated, mirrors `gist.rs`):
   - `POST /term-shares {session_id}` → `{id, token}`. Re-share of the same
     session returns the existing live token (keep the link stable).
   - `POST /term-shares/:id/revoke` → marks revoked AND kicks any connected
     guest sockets for that token.
3. **Viewer page**: `GET /t/:token` → server-rendered HTML page with an
   xterm.js viewer (xterm loaded from CDN — the page is only useful online
   anyway). Revoked/unknown token → generic 404, never distinguishing which
   (same rule as gist). Page JS connects to the guest WS and renders
   `MirrorScreen` (resize to cols×rows, write screen) and `MirrorData`
   (write b64-decoded bytes). Shows a "desktop offline" state from the
   existing presence frame.
4. **Guest WS**: `GET /rc/guest?token=T`. Validates token → joins the hub for
   the owner's `gid` as new `Role::Guest { session_id }`:
   - **May send** only `mirror_start` for its own `session_id` (relay
     validates/rewrites; anything else is dropped). Guests never send
     `mirror_stop`.
   - **Receives** only `mirror_screen` / `mirror_data` frames whose
     `session_id` matches, plus presence frames. Never `tabs` (leaks every
     tab's title/cwd), never anything else. Relay peeks frames with a minimal
     serde struct (`t`, `session_id`).
   - Multiple guests per token work for free (hub already fans out).
   - Viewer-refcount: the relay forwards a `mirror_stop` to the desktop only
     when the **last** viewer (owner web or guest) of that session leaves —
     one guest closing their tab must not kill the stream for others.
5. **Hub changes**: `Role` grows the `Guest` variant; `route()` filters
   desktop→guest frames per the rules above; `leave()` handles the refcount
   stop. All existing Desktop↔Web behavior unchanged.

### Covenant app (this repo)

1. **Commands** (`crates/app/src/term_share.rs`, mirrors `covenant_gist.rs`):
   `term_share_create(session_id)`, `term_share_revoke(session_id)`,
   `term_share_get(session_id)`, `term_share_list()`. Local state file
   `term_shares.json` in app config dir (session_id → {id, token, url}).
2. **Auto-revoke**: on session close (and on app quit for live shares), call
   revoke and drop local state. If the app crashes, the link survives but
   guests just see "desktop offline" until revoked — acceptable.
3. **UI**: tab context menu "Share read-only" → creates share, copies URL to
   clipboard, toast. While shared: badge on the tab (same visual language as
   the gist shared-state badge) and the menu item flips to
   "Copy share link / Stop sharing".
4. **No streaming changes**: desktop already answers `mirror_start` for any
   of its sessions regardless of which web asked.

## Security

- 122-bit random token; possession = view access. Same threat model as
  `/g/:token`, accepted.
- Read-only is enforced **server-side in the hub** — the guest socket has no
  path to `send_input`/`send_keys`/`close_tab`/etc. The desktop never has to
  trust guest behavior.
- Guests never receive the tab list or any frame about other sessions.
- The mirror shows whatever is on the owner's screen; masking is out of
  scope — the owner is sharing deliberately and can stop any time.
- Revoke is immediate: DB flag + live socket kick.

## Error handling

- Desktop offline / reconnecting → viewer shows offline state (existing
  presence frames), auto-recovers when the desktop reconnects.
- Guest WS with revoked/unknown token → close with policy code; page shows
  "link no longer active".
- Share-create with forge unreachable → surfaced as toast error, no local
  state written.

## Testing

- Hub unit tests (pattern already in `rc.rs`): guest receives only matching
  `mirror_*` frames; guest never receives `tabs`; guest `send_input` is
  dropped; last-viewer-leave emits `mirror_stop`; revoked-token join is
  rejected; cross-gid isolation holds for guests.
- Gist-style route tests for create/revoke/ownership.
- App-side: state-file round-trip test (pattern from `gist/share.test.ts` /
  `covenant_gist.rs` tests).

## Out of scope (explicitly)

- Scrollback for viewers, input/control for viewers, viewer identity,
  timed expiry, multiple-session sharing in one link, WebRTC.

## Rollout

Two repos: covenant-server (hub + routes + viewer page, deploy to forge) and
covenant (app commands + UI). Server ships first; app change is inert
without it.
