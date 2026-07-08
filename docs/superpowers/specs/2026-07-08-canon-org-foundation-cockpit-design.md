# Canon: Org Foundation + Cockpit — Design

**Date:** 2026-07-08
**Status:** Approved (brainstorming) — ready for implementation plan

## Context

Canon (formerly CDLC) is the governed body of skills / agents / context a group holds and
projects onto executors. Its registry side (`forge.covenant.uno`, served under `/cdlc/packages`)
is **org-scoped and authed** — you only see/publish/install within organizations you belong to.

Today the client has two problems:

1. **Org assignment is random and unserious.** The client only calls `GET /orgs` (`canon_my_orgs`)
   and then blindly uses `orgs[0].slug` for *every* registry operation — search, publish, adoption.
   There is no way to create an org, no way to pick one, and no personal-org guarantee. If the org
   that matters to the user isn't first in the server's list, they can't reach it.
2. **The rail is too cramped** for the heavier flows this needs (org management, members, registry
   browsing, dashboards). Canon has no full-screen "expand" like other Covenant surfaces.

The **server already has the org machinery** — it was never wired on the client:

```
POST   /orgs                       → orgs::create        (creates org, caller becomes owner)
GET    /orgs                       → orgs::list_mine      (caller's orgs, with role)     [wired]
GET    /orgs/:slug/members         → orgs::members
POST   /orgs/:slug/members         → orgs::add_member     (add by GitHub login, role=member)
DELETE /orgs/:slug/members/:login  → orgs::remove_member
```
Guards: `require_member`, `require_owner`, `valid_slug`. The `Org` type carries `{ id, slug, name, role }`.

The registry wire path stays `/cdlc/packages` (the deployed backend serves it; renaming the path is
a separate server+deploy task, out of scope here).

## Goals

- Kill random org assignment. Every user always has at least a personal org; teams are created
  explicitly; the active org is chosen and remembered **per group**.
- Give Canon a full-screen cockpit that hosts the heavy flows; keep the rail as a compact summary.

## Non-Goals

- Renaming the registry wire path `/cdlc/` → `/canon/` (separate server deploy).
- Token-based invite/accept handshake. The server adds members by GitHub login directly; the UI
  uses that model ("invite" = owner adds a login).
- Any other Canon improvement (context editor rework, eval authoring UI, publish wizard) — not in
  this spec.

## Approach: two sequenced phases (one design doc, phased plan)

Phase 1 ships the "serious org" data layer and a rail selector — fixing the random-assignment pain
fast, independently testable. Phase 2 builds the full-screen cockpit on top of that solid layer.

---

## Phase 1 — Org Foundation

### Server (one change)

**Auto personal org, lazily, in `orgs::list_mine`.** If the caller has zero org memberships, create
a personal org before returning:

- `slug` = the caller's GitHub login, run through `valid_slug` sanitization (lowercase, non-`[a-z0-9-]`
  → `-`, collapse repeats, trim). On slug collision, append a short numeric suffix.
- `name` = the GitHub login.
- Caller inserted into `org_members` as `owner` (reuse the create path's insert).

This guarantees "never orgless" by touching a single handler — no surgery to the login/user-upsert
path. Idempotent: once the personal org exists, `list_mine` returns it like any other.

### Client — wire the existing endpoints

`crates/app/src/canon_registry.rs` (+ `#[tauri::command]` wrappers in `lib.rs`, + typed wrappers in
`ui/src/api.ts`):

- `canon_create_org(slug, name) -> Org` → `POST /orgs`
- `canon_org_members(slug) -> Vec<Member>` → `GET /orgs/:slug/members`  (`Member { login, role }`)
- `canon_add_member(slug, login)` → `POST /orgs/:slug/members`
- `canon_remove_member(slug, login)` → `DELETE /orgs/:slug/members/:login`

`canon_my_orgs` (list) already exists.

### Active org, remembered per group

- Add `canonOrg?: string | null` to the group entry in the tab manifest (same store as `color` /
  `root_dir`); add get/set in `ui/src/workspaces/manager.ts`.
- `CanonPanel` reads the active org from the group's `canonOrg`. If unset, default to the personal
  org (the org whose `slug` matches the user's login), else the first org. **No bare `orgs[0]`
  anywhere** — resolve through a single `activeOrg()` helper.

### Rail selector chip

- Replace the hardcoded placeholder/search/publish/adoption `orgs[0]` reads with a dropdown chip in
  the panel head showing the active org (`name`, with `role` hint). Selecting an org persists it to
  the group and refreshes.
- Bottom item **"+ Create organization…"** → small modal: `name` input → `slug` auto-derived
  (editable), Create → calls `canon_create_org`, sets it active, refreshes.

### Error handling (Phase 1)

- Not signed in → `jwt()` already errors `"not signed in to Covenant"`; surface as the panel's
  existing error/empty treatment rather than a bare failure string.
- Owner-only op by a non-owner → server `Forbidden`; surface as a toast + inline line.
- Network/other → existing `errorLine` pattern.

### Testing (Phase 1)

- **Server:** sqlx test — `list_mine` with no memberships creates and returns a personal org; a
  second call is idempotent (no duplicate); slug collision appends a suffix.
- **Client (vitest):** active-org resolves from group `canonOrg`; falls back to personal org when
  unset; selecting an org calls the manager setter; create-org modal derives slug from name and sets
  the new org active. Reuse `ui/src/canon/panel.test.ts` harness.

---

## Phase 2 — Cockpit (full-screen)

### Surface

`CanonCockpitView` — an immersive full-screen overlay mounted on `document.body`, same pattern as
`ContextMinerView` (`ui/src/canon/miner/view.ts`): opaque, Esc/backdrop to close, its own CSS file
under `ui/src/canon/`. Launched from an **expand** button in the rail head. Scoped to the same group
(receives `groupId`, `groupLabel`, `groupRootDir`, active org).

### Layout

Left nav + content panel:

- **Org** — active org, role, slug; create org; switch org (shared with the rail chip logic).
- **Members** — list `{ login, role }`; add by GitHub login (owner only); remove member (owner only).
- **Skills** — installed skills (roomier cards than the rail); publish to registry.
- **Registry** — browse/search the active org's packages; install; preview full `SKILL.md`
  (reuse `openMarkdownReader`).
- **Context** — context files; **New context** (launches the miner); open/read.
- **Loop** — adoption + inference stats + eval pass-rate, as larger charts (reuse the rail's
  `statCell` / `meterRow` building blocks, scaled up).

### Rail after Phase 2

Compact summary only: org chip (from Phase 1), installed-skill count, **Project** button, **expand**
button. The heavy flows (members, registry browsing, dashboards) move to the cockpit. The rail keeps
enough to answer "which org, how many skills, project now" at a glance.

### Error handling (Phase 2)

Same as Phase 1 (sign-in prompt, Forbidden surfacing, inline network errors), rendered in the
cockpit's own layout rather than the narrow rail.

### Testing (Phase 2)

- **Client (vitest):** cockpit nav switches sections; Members renders list and gates add/remove on
  `role === "owner"`; Registry search renders results and install wiring; cockpit reads the same
  active org as the rail. No server round-trips in tests (mock the api layer, as `panel.test.ts` does).

---

## Isolation / boundaries

- **`canon_registry.rs`** owns all registry + org HTTP; commands in `lib.rs` are thin wrappers;
  `api.ts` is the single typed client seam. No component calls `invoke` for Canon directly.
- **`manager.ts`** owns per-group persistence (`canonOrg`); the panel/cockpit never touch the
  manifest directly.
- **`activeOrg()`** helper is the single resolution point for "which org" — no scattered `orgs[0]`.
- **`CanonCockpitView`** is self-contained (own file + CSS), mounted/unmounted like the miner; the
  rail only launches it.

## Open questions

None blocking. Defaults taken: lazy auto-org in `list_mine`; add-by-login instead of token invites;
active org defaults to personal org when a group has none set.
