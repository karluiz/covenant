# Shareable Covenant Score + Achievements Profile — Design

**Date:** 2026-06-14
**Status:** Approved (pending spec review)
**Repos:** `karlTerminal` (desktop) + `covenant-server` (backend, `~/Sources/covenant-server`)
**Theme:** Seed of the Covenant community — a public, shareable reputation profile. No leaderboard in this phase.

---

## Goal

Let a signed-in user **opt in** to publish a shareable profile at `https://forge.covenant.uno/u/<login>` showing their **Covenant Score** (a real composite number, 0–10), their six reputation dimensions, and their earned achievement badges — alongside the activity heatmap the profile already renders.

This is Phase 0 of the community idea: shareable score + achievements, no competitive leaderboard yet (the score column we add is the leaderboard's future foundation).

---

## What already exists (do not rebuild)

Verified in code during brainstorming:

**Backend (`covenant-server`, axum 0.7 + Postgres):**
- `POST /sync/events` (JWT) ingests activity events (`kind` ∈ prompt|commit, executor, day, repo/branch/group), deduped + idempotent (`src/sync.rs`).
- `GET /u/:login` (HTML, `src/profile.rs` + `src/templates/profile.html`) and `GET /u/:login/json` already render a **public** profile: avatar, login, `total_prompts`, `total_commits`, `today_prompts`, `current_streak`, 52-week heatmap.
- `POST /auth/exchange` mints an HS256 JWT (`{ sub: github_id, login, iat, exp }`, 30-day TTL) from a GitHub token (`src/auth.rs`, `src/jwt.rs`).
- Tables: `users(github_id PK, login, avatar_url, …)`, `score_events(…)` (`migrations/0001`, `0002`).

**Desktop (`karlTerminal`):**
- `crates/score/src/sync.rs` auto-pushes activity events on sign-in (JWT in Keychain). `crates/score/src/auth.rs` device-flow → `/auth/exchange`.
- Achievements engine (local-only): `crates/score/src/achievements.rs` (catalog, 6 reputation dimensions craft/safety/reliability/orchestration/memory/focus, tier points 10/25/60/150/400), `store.rs` (`achievement_awards`, `achievement_progress`, and `achievement_summary()` returning `by_category` reputation rollups), Tauri commands in `crates/app/src/score_commands.rs`.

**Confirmed gaps this design fills:**
1. No composite "Covenant Score" number exists anywhere (the landing's `8.4` is a mockup).
2. Achievements are local-only — never synced, stored, or rendered by the backend.
3. No opt-in to publish; sync is currently automatic and the profile is already public.

---

## Decisions (locked during brainstorming)

- **Distribution:** backend-hosted profiles (`/u/<login>`), not a local-only image.
- **Score basis:** blend, reputation-majority + documented formula (70% verified reputation / 30% consistency).
- **Publishing:** explicit opt-in toggle, **off by default**. Score + achievements publish only when the user enables it. (Existing activity-event sync stays as-is.)
- **Achievement sync model:** push a derived **snapshot** (aggregates), not raw `achievement_facts`. Simpler, privacy-aligned, sufficient for a public card.

---

## The Covenant Score formula

A pure, unit-tested function in `karl_score` with named constants. Mirrored verbatim on the backend (so the server recomputes the headline from the same inputs — the client cannot POST an inflated number).

```text
INPUTS
  dim[6]          reputation points per dimension (craft, safety, reliability,
                  orchestration, memory, focus) — from achievement awards,
                  tier-weighted, verification-aware (already computed locally)
  current_streak  consecutive active days

CONSTANTS
  REP_SCALE    = 600.0    // saturating scale for reputation
  STREAK_SCALE = 21.0     // saturating scale for streak (days)
  W_REP        = 0.70
  W_ACT        = 0.30

COMPUTE
  rep_total = sum(dim)
  rep01     = 1 - exp(-rep_total / REP_SCALE)          // 0..1, saturating
  act01     = 1 - exp(-current_streak / STREAK_SCALE)  // 0..1, saturating
  score10   = round1((W_REP * rep01 + W_ACT * act01) * 10.0)   // 0.0..10.0
```

Notes:
- Saturating curves give diminishing returns → no incentive to farm tokens/PRs.
- The card displays the headline **and** the decomposition: `reputation01`, `activity01` (e.g. "Reputation 7.2 · Consistency 5.1 → 8.4").
- Constants are tunable in one place and covered by tests asserting representative inputs → expected bands (e.g. fresh user ≈ 0; solid user ≈ 6–8; veteran ≈ 9+).
- The six dimension bars on the card are normalized for display the same way the existing `ui/src/score/achievements.ts` reputation bars are (relative to the max dimension in the set).

---

## The published payload (privacy contract)

`PublicProfileSnapshot` — built on the desktop, pushed on publish. **Aggregates only.**

```jsonc
{
  "schema_version": 1,
  "github_id": 123,
  "login": "karluiz",
  "avatar_url": "https://…",
  "generated_at_ms": 1750000000000,
  "score": { "headline": 8.4, "reputation01": 0.72, "activity01": 0.55 },
  "dimensions": [
    { "category": "craft", "points": 320 },
    { "category": "safety", "points": 110 }
    // … all 6, always present (0 if none)
  ],
  "awards": [
    { "achievement_id": "finisher", "tier": 3, "rarity": "common",
      "title": "The Finisher", "earned_at_ms": 1749000000000 }
    // … one per earned (achievement, tier)
  ],
  "totals": {
    "awards_count": 14,
    "current_streak": 12,
    "total_prompts": 4100,
    "total_commits": 412
  }
}
```

**Never included** (explicit, documented, grepable): repo names, branch names, group names, file paths, command text, per-executor breakdown, LLM token contents, raw `achievement_facts` or their metadata, session details. The snapshot builder constructs only the fields above; there is no passthrough of raw rows.

---

## Backend changes (`covenant-server`)

### Migration `0003_profile.sql`
```sql
ALTER TABLE users ADD COLUMN profile_public BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE published_profiles (
  github_id      BIGINT PRIMARY KEY REFERENCES users(github_id) ON DELETE CASCADE,
  snapshot       JSONB  NOT NULL,            -- the PublicProfileSnapshot (server-validated)
  covenant_score REAL   NOT NULL,            -- recomputed server-side (sortable; future leaderboard)
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Endpoints
- `PUT /profile/publish` (JWT). Body = the full `PublicProfileSnapshot`. Server:
  1. authenticates, takes `github_id` from `claims.sub` (ignores any client `github_id`/`login` in the body — uses the token's identity);
  2. validates sizes (cap `awards` length, string lengths) and clamps `dimensions[].points ≥ 0`;
  3. **ignores the client-sent `score` and recomputes `covenant_score`** from `dimensions` + `totals.current_streak` using the shared formula (the recomputed value also overwrites `snapshot.score` before storage, so the rendered card and the sortable column always agree);
  4. upserts `published_profiles`, sets `users.profile_public = TRUE`;
  5. returns `{ "url": "https://forge.covenant.uno/u/<login>", "covenant_score": 8.4 }`.
- `DELETE /profile/publish` (JWT): set `users.profile_public = FALSE` (keep the row, or delete — keep, so re-enable is instant). Returns `{ ok: true }`.

### Profile rendering
- `GET /u/:login/json`: when `profile_public`, include `covenant_score`, `score` decomposition, `dimensions`, `awards` from the stored snapshot. When not public, behave exactly as today (activity only).
- `GET /u/:login` (HTML, `templates/profile.html`): when public, add a **score hero** (headline 0–10 + decomposition), **six dimension bars** (rarity/teal styling consistent with the app), and a **badge grid** (rarity-colored tiles, tier shown), above the existing heatmap. Add per-profile **OpenGraph meta tags** (`og:title` = "`<login>` · Covenant Score 8.4", `og:description`, `og:image` = static fallback for v1) for social unfurl, plus a copy-link / share button.

The score formula is duplicated in `covenant-server` (small Rust fn) and covered by a server test asserting the same representative inputs → same bands as desktop.

---

## Desktop changes (`karlTerminal`)

- **`crates/score/src/profile_card.rs`** (new): pure `compute_score(dimensions, current_streak) -> ScoreBreakdown { headline, reputation01, activity01 }` and `build_snapshot(...) -> PublicProfileSnapshot` from `achievement_summary()` + activity `Summary`. Fully unit-tested (formula bands + snapshot contains only allowed fields).
- **`crates/score/src/sync.rs`**: `publish_profile(store)` (builds snapshot, `PUT /profile/publish` with JWT) and `unpublish_profile()` (`DELETE`). On a successful activity sync, if `publish_profile` setting is on, also publish the snapshot (debounced — only when score/awards changed).
- **Setting `publish_profile: bool`** (default `false`) in the score/app settings store.
- **Tauri commands** (`crates/app/src/score_commands.rs`): `score_profile_get_publish() -> bool`, `score_profile_set_publish(enabled: bool)` (enabling publishes immediately; disabling unpublishes), `score_profile_share_url() -> Option<String>` (`…/u/<login>` when signed in), `score_profile_preview() -> PublicProfileSnapshot` (local, for the UI card preview).
- **UI** — a "Public profile" section in the Score/Achievements area (`ui/src/score/`): the opt-in toggle, a live preview of the card, copy-link, and "View profile" (opens `forge.covenant.uno/u/<login>`). Off state explains exactly what would be shared (links the privacy contract).

---

## Testing

- **Desktop:** unit tests for `compute_score` (representative inputs → expected bands; saturation monotonic), and `build_snapshot` (asserts the snapshot contains only the allowed keys — a guard against accidental leakage of repo/branch/path). Sync tests with a mock backend for `publish`/`unpublish`.
- **Backend:** test that `PUT /profile/publish` recomputes the score from inputs (a client-sent headline is ignored), that `/u/:login/json` exposes score+achievements only when public, and that non-public profiles are unchanged. Score-formula parity test mirroring the desktop bands.
- Follow project conventions: TDD, one commit per feature, agent edits in a git worktree (a worktree **per repo** at execution).

---

## Out of scope (this phase)

- **Competitive leaderboard** — Phase 2; the `covenant_score` column is its foundation.
- **Server-generated OG image** (rendered PNG card) — fast-follow; v1 ships OG *meta tags* with a static fallback image.
- **Full anti-cheat** — v1 recomputes the score number server-side but trusts the client's reported `dimensions`/`awards`. Hardening (sync raw `achievement_facts`, recompute reputation server-side) is Phase 2; the threat model for a vanity card is low.
- **Vanity domain** `covenant.uno/u/<login>` — profiles live at `forge.covenant.uno/u/<login>`; a covenant.uno proxy/redirect is a later nicety.

---

## File map

**`covenant-server`:** `migrations/0003_profile.sql`, `src/profile.rs` (extend), `src/templates/profile.html` (extend), new `src/publish.rs` (`PUT/DELETE /profile/publish`), `src/score.rs` (shared formula), `src/main.rs` (routes).

**`karlTerminal`:** `crates/score/src/profile_card.rs` (new), `crates/score/src/sync.rs` (extend), `crates/score/src/store.rs` / settings (publish flag), `crates/app/src/score_commands.rs` (commands), `ui/src/score/` (Public profile UI section).
