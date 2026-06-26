# Beacon — GitHub Deployments Sidebar

**Date:** 2026-06-26
**Status:** Design approved, plan pending

## Goal

A right-side sidebar (same family as Teammate / Notes / Changes) that shows the
**GitHub deployment status** of the repo for the terminal session currently in
view, so the user can see at a glance whether each environment is deployed,
building, or failing. Only active when signed in with GitHub.

## Source of truth

The GitHub **Deployments API** (`/repos/{owner}/{repo}/deployments` +
deployment statuses). This is what Vercel / Netlify / Heroku / CD bots write to,
and gives per-environment state plus the live target URL. Not Actions runs, not
the Environments endpoint.

## Wiring (reuse existing patterns)

- Add `"beacon"` to the `RailTarget` union in `ui/src/titlebar/right-rail.ts`.
- Register a rail button + keyboard shortcut in `main.ts`, mirroring how Changes /
  Notes register. Mount a bespoke panel to its own host element.
- New frontend module: `ui/src/beacon/panel.ts` (+ `ui/src/beacon/beacon.css`).
- No shared sidebar base class exists; follow the bespoke-panel convention.

## Backend — one Tauri command

`beacon_deployments(cwd: String) -> BeaconState` in `crates/app/src/beacon.rs`,
registered in `crates/app/src/lib.rs`.

Steps:

1. **Resolve `owner/repo`** — run `git remote get-url origin` in `cwd`; regex-parse
   `github.com[:/]{owner}/{repo}(\.git)?`. No remote / non-GitHub → `NoRepo`.
2. **Token** — `load_token_from_keychain()` (score auth). Absent → `NotAuthed`.
3. **List** — `GET /repos/{o}/{r}/deployments?per_page=30` via the existing
   `gh_request()` helper in `crates/app/src/teammate/github_tools.rs`.
4. **Latest per environment** — dedupe to the newest deployment per `environment`
   (cap ~10 environments), then one
   `…/deployments/{id}/statuses?per_page=1` per kept deployment for its current
   state.
   <!-- ponytail: only the latest deployment per env gets a status fetch, so we
   make ~1 + N calls (N ≤ 10) instead of 1 + 30. Upgrade to full history if a
   per-env timeline is ever wanted. -->
5. Return `BeaconState`.

### Types

```rust
enum BeaconState {
    NotAuthed,
    NoRepo,
    Ok { repo: String, envs: Vec<EnvDeploy> },
    Error { message: String },
}

struct EnvDeploy {
    environment: String,   // "production", "preview", ...
    state: String,         // success | failure | in_progress | pending | error | inactive
    description: Option<String>,
    target_url: Option<String>,
    sha: String,           // short (7 chars)
    creator: Option<String>,
    updated_at: String,    // ISO; frontend renders relative
}
```

## Frontend panel

- On open: invoke `beacon_deployments(activeCwd)`, render the returned state.
- **Poll every 25s while visible** (`setInterval`), cleared on close. No
  background polling, no status-bar dot.
- Manual refresh button in the panel header.
- States rendered:
  - `NotAuthed` → "Sign in with GitHub" prompt.
  - `NoRepo` → "No GitHub remote here".
  - `Ok` with empty `envs` → "No deployments".
  - `Error` → error message + retry.
  - `Ok` with envs → one card per environment.
- Env card: colored state dot + environment name + relative time + short `sha` +
  creator. Click `target_url` → open the live deploy (existing browser / external
  open). Dot colors: success=green, in_progress/pending=amber, failure/error=red,
  inactive=muted.
- Reuse theme tokens (`--bg-panel`, `--border`, text tokens). Respect True Dark
  neutral-lift rule for elevated/selected surfaces.
- English-only copy. No native `title=` tooltips — use `attachTooltip`.

## Testing

Backend unit tests for the only non-trivial logic:

- git-remote → `owner/repo` parser: ssh (`git@github.com:o/r.git`), https
  (`https://github.com/o/r.git`), and no-`.git` variants; non-GitHub remote
  returns `None`.
- state → dot-color mapping.

## Out of scope (additive follow-ups)

- Background polling + status-bar failure dot.
- Multi-repo / all-sessions view.
- Merging in Actions workflow runs.
- Per-environment deployment timeline / history.
