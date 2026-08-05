# Collaborative Terminal Share (read-write) — Design

**Date:** 2026-08-05
**Status:** Approved
**Builds on:** `2026-07-23-terminal-share-design.md` (read-only share), `2026-06-07-covenant-rc-remote-tab-control-design.md` (RC write plumbing)

## Summary

Extend the existing read-only terminal share (`/t/:token` over the RC relay) with a
**collaborative mode**: the owner invites another dev into a live terminal session,
and that dev — after GitHub auth and an explicit per-request grant from the owner —
can type into the PTY as the single remote **driver**. Traycer-style "multiplayer",
scoped to one tab for v1.

## Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Guest identity | **GitHub auth required to write** | Owner sees who is connected and who types; kick by identity; server already has users + JWT + OAuth. Viewing stays anonymous (as today). |
| Input model | **Single driver with handoff** | One remote writer at a time; owner grants/revokes; avoids byte-interleaved chaos of two keyboards on one PTY cursor. |
| Scope | **One tab (session), v1** | Reuses the whole `/t/:token` + RC hub infrastructure. Workspace/group multiplayer is a later evolution on top. |
| Write authority | **Desktop-side** | Matches the RC invariant: the relay is a dumb router that cannot execute anything. A compromised relay cannot inject input. |

## User flow

1. Owner: tab context menu → **Share collaborative…** (next to the existing
   *Share read-only…*). Mints a `/t/:token` link with `mode=collab`.
2. Guest opens the link → sees the read-only mirror immediately, no login (same as today).
3. Guest clicks **Request control** → must sign in with GitHub (forge OAuth).
4. Owner's desktop shows a toast: *"<login> wants control of `<tab title>`"* with
   avatar → **Accept / Decline**.
5. On grant the guest becomes **driver**: their xterm enables stdin and raw
   keystrokes flow to the PTY.
6. Owner reclaims control with one click — or **automatically by typing locally
   in that tab** (owner always wins). Guest can also release voluntarily.

Exactly one driver per session. The owner never loses the ability to type; the
guest's grant is what gets revoked.

## Architecture

### Token & server (`covenant-server`)

- `term_shares` gains a `mode` column (`ro` | `collab`).
- Partial unique index relaxed from `(owner_github_id, session_id) WHERE NOT revoked`
  to `(owner_github_id, session_id, mode) WHERE NOT revoked` — a broad read-only
  link and a collab link for one dev **coexist** on the same tab.
- `POST /term-shares` accepts `mode` (default `ro` for back-compat).
- Revoke, `kick_guests`, startup revoke-all: reused unchanged. Revoking a collab
  share kicks its guests and therefore any active driver.
- `GET /rc/guest` accepts optional guest identity: `?token=<share>&auth=<guest JWT>`.
  The server resolves login/avatar from the JWT and **tags every inbound guest frame
  with the verified identity**. The desktop never trusts self-declared names.
  Unauthenticated guests on a collab link can still view; they just cannot request
  control.

### Relay routing (`covenant-server/src/rc.rs`)

Today `handle_guest` reads and drops all inbound guest frames. For `mode=collab`
shares the relay forwards a **closed set** of guest→desktop frames, each stamped
with the server-verified identity:

| Frame | Payload | Notes |
|---|---|---|
| `guest_hello` | `{conn_id, login, avatar}` | on authed connect; relay also emits on disconnect |
| `guest_request_control` | `{conn_id}` | |
| `guest_input` | `{conn_id, data}` | base64 raw bytes |
| `guest_release` | `{conn_id}` | |

Desktop→guest frames added: `control_granted {login}`, `control_revoked`,
`guests {roster}` (presence list with login/avatar). Guests on `ro` shares keep
today's behavior exactly (frames dropped, mirror only).

The relay interprets nothing — it routes, refcounts mirrors (unchanged), and
guarantees `login` is verified.

### Desktop (`crates/app/src/rc_agent.rs` + session state)

- Per-session state: `driver: Option<GuestConnId>`.
- `guest_input` from any conn that is **not** the current driver is silently
  dropped (same pattern as the `armed` gate).
- Grant is an explicit owner decision per request (toast). No persistent grants,
  no allowlist. Grant dies on: guest disconnect, owner revoke, owner local
  keystroke in that tab, stop-sharing (`kick_guests`), app restart, and the
  existing `rc_disarm_all` kill switch.
- **Blocklist, best-effort:** per-driver line-assembly buffer on the desktop; on
  `\r` the accumulated line is scanned with `safety::is_dangerous`. On match the
  submit is suppressed and both sides are notified. Documented limitation: a
  TUI/editor evades line-assembly — the real trust boundary is the explicit grant
  to a known identity (equivalent to handing over the keyboard).
- Writes enter through `inject_to_session` (same choke point RC uses today).
- The existing regression test "no arbitrary bytes via `send_keys`" stays intact:
  `guest_input` is a new channel, gated by driver-grant, not a loosening of
  `send_keys`.

### Guest page (`templates/term.html`, collab variant)

- xterm stdin enabled only while driver; `term.onData` → `guest_input`.
- Status chip: `VIEWING` / `YOU ARE DRIVING` / `DRIVING: <login>`.
- **Request control / Release control** button; GitHub sign-in flow when needed.
- No guest-side resize — follows desktop dims via mirror frames, as today.

### Desktop UI

- Tab share badge grows a guest roster: avatars/count of connected guests
  (requires counting guests in the hub presence — today only owner-webs are
  counted).
- While a remote driver is active: unmistakable pane indicator — chip
  `REMOTE DRIVER: <login>` plus an accent on the pane border; clicking it revokes.
- Grant toast with avatar, Accept/Decline.
- DESIGN.md hard rules apply: sharp corners, inline SVG icons (no emoji), no
  native tooltips, English chrome.

## Security posture

Writing requires **all** of: a valid `collab` token + GitHub-authenticated
identity + an explicit, per-request owner grant, scoped to one session, held by
at most one guest at a time. Revocation is instant (live-socket kick already
exists) and multi-path. The relay cannot forge identity or inject input; the
desktop is the sole write authority. The blocklist line-scan is best-effort and
documented as such.

## Testing

- **Rust unit (`rc_agent`)**: input without grant is dropped; grant/revoke
  transitions; owner local keystroke revokes; line-assembly + blocklist
  suppression; driver uniqueness.
- **Server (`#[sqlx::test]`)**: `mode` column + ro/collab coexistence on one
  session; identity tagging on guest frames; collab-vs-ro routing; kick on revoke.
- **E2E manual**: two browsers (owner desktop + authed guest), full
  request → grant → type → owner-typing-revokes → re-grant → stop-sharing loop.

## Out of scope (v1)

Natural next steps, explicitly deferred: group/workspace-level multiplayer
(Traycer's full vision), multiple simultaneous drivers, chat, named cursors over
the output, guest allowlists, grant persistence across reconnects.
