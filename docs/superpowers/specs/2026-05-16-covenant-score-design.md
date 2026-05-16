# Covenant Score — Design

**Date:** 2026-05-16
**Status:** Draft, awaiting review
**Author:** karluiz (with Claude)

## Goal

Give the operator a daily, at-a-glance signal of how much they've collaborated with Covenant's executor agents — rendered as a GitHub-style contribution heatmap. Local-first; optional GitHub sign-in syncs to an Azure backend for backup, multi-device, and a public profile page.

This is a personal motivation/visibility feature, not a leaderboard or social product (yet).

## Non-goals

- No XP/score formula, no levels, no badges. Two raw numbers only.
- No team/org features.
- No leaderboards in v1.
- No real-time multiplayer presence.

## Metrics

Exactly two counters, tracked per day (local date, user's tz):

| Metric | Source | Counts as |
|---|---|---|
| **Prompts** | Every prompt sent to an executor adapter (Claude Code, Codex, Ollama, OpenAI-compat, future Pi RPC) | Heatmap cell intensity |
| **Commits** | `git log --author=<user> --since=<date>` across tracked repos | Stats only (not heatmap) |

**Heatmap intensity scale** (prompts per day):
- 0 → empty
- 1–5 → l1
- 6–15 → l2
- 16–40 → l3
- 41+ → l4 (glow)

## UI

### Status bar chip (bottom-right)

Minimalist, dotted-underline text — order: **score chip first, version last.**

```
Signed-out:  Sign in                v0.5.20
Signed-in:   247 prompts · 12d      v0.5.20
```

Click → opens the Score modal.

### Score modal (Layout A: stacked)

```
┌──────────────────────────────────────────────┐
│  [avatar]  karluiz                           │
│            Covenant Operator · since 04-12   │
│                                              │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐         │
│  │ 1247 │ │  73  │ │ 12d  │ │  38  │         │
│  │PROMPT│ │TODAY │ │STREAK│ │COMMIT│         │
│  └──────┘ └──────┘ └──────┘ └──────┘         │
│                                              │
│  May Jun Jul Aug … Apr                       │
│  ▢▢▣▣▢▢▢▣▣▣▢▢▢▢▣▣▣▣▣ … (heatmap, 53×7)       │
│                          Less ▢▣▤▥▦ More     │
│                                              │
│  View on covenant.dev/karluiz →   Synced 2m  │
└──────────────────────────────────────────────┘
```

Signed-out variant: stats reflect local-only data, replace footer link with a "Sign in with GitHub" banner CTA.

## Architecture

### Local (Rust crate: `crates/score`)

- **SQLite table `score_events`**: `(timestamp, kind, executor, ref)` — append-only, one row per prompt and one row per detected commit. Local source of truth.
- **Subscribes to existing executor adapters** — every time a prompt fires (Claude Code, Codex, Ollama, OpenAI-compat, Pi RPC), an event lands here. Hook point: existing LLM provider dispatch (`crates/llm` per recent multi-provider work) — single instrumentation site.
- **Commit detection**: periodic (every 5min while app is open) scan of recently-touched repos using `git log --author=$git_user.email --since=$last_check`. Repos are inferred from the cwd of any session that has been active.
- **Daily aggregation view**: a materialized rollup `score_daily(day, prompts, commits)` for fast heatmap rendering.

### Sync (optional)

When the user is signed in:

- **Auth**: GitHub OAuth Device Flow (no embedded browser, no client secret leaks; standard for CLI/desktop apps).
- **Sync protocol**: client POSTs new `score_events` rows since last cursor; server returns ack + canonical cursor. Idempotent on `(user_id, timestamp, kind, ref)`.
- **Cadence**: on app start, on sign-in, and every ~5 minutes while online. Manual "Sync now" in modal.

### Server (Azure)

- **Compute**: Azure App Service (Linux, B1) running a small Rust (axum) or Node (Fastify) service — pick Rust to keep stack uniform.
- **DB**: Azure Database for PostgreSQL Flexible Server, Burstable B1ms. Schema mirrors local `score_events` + `users(github_id, login, avatar_url, created_at)`.
- **Auth**: GitHub OAuth App registered to `covenant.dev` (or a placeholder domain). Server validates `code` from device flow, issues a signed JWT (HS256, 30-day) the client stores in OS keychain.
- **Public profile**: `GET /u/{login}` renders SSR HTML with heatmap + stats. No auth needed.
- **API surface** (v1):
  - `POST /auth/device` — start device flow
  - `POST /auth/poll` — exchange device code for JWT
  - `POST /sync/events` — push new events
  - `GET /sync/cursor` — fetch sync cursor
  - `GET /u/{login}` — public profile (HTML)
  - `GET /u/{login}.json` — public profile (JSON)
- **Estimated cost**: B1 App Service (~$13/mo) + B1ms Postgres (~$15/mo) + minimal egress. ~$30/mo, scales to thousands of users before tier change.

### Privacy

- We sync **counts and timestamps**, never prompt content, cwd, file paths, or repo names.
- Local DB stores executor name (anonymizable: `claude` / `codex` / `ollama` / `openai`), never the model id or the prompt text.
- Commit detection uses `git log` count only — no SHAs, no messages leave the device.

## Detection details

### What counts as a "prompt"?

A prompt = a user-initiated message that the LLM dispatcher actually sends to a provider. Specifically:
- ✅ User sends a chat message in PiChatView / familiar panel / executor adapter
- ✅ User invokes a slash-command that routes through the LLM
- ❌ Internal agent self-talk (chain-of-thought continuation)
- ❌ Failed/cancelled before bytes hit the wire

Instrumentation: one call to `score::record_prompt(executor)` inside `crates/llm` dispatch path, after the request is committed but before await — guarantees one count per user prompt regardless of provider.

### Streak

Streak = consecutive days (local tz) with `prompts >= 1`. Resets on first day with `prompts == 0` that has fully elapsed. Today does not break a streak until midnight.

## Edge cases

- **Clock skew across devices**: server stores both client-reported and server-received timestamps; aggregation uses client timestamp but trusts server-received for ordering.
- **Multi-device same account**: events keyed by `(user_id, timestamp_ms, kind, ref)` — collisions are deduped server-side.
- **Pre-login local history**: on first sign-in, client uploads its entire local `score_events` table; server merges idempotently.
- **Sign-out**: JWT discarded; local DB preserved; chip reverts to `Sign in`.
- **Offline**: everything works locally; sync resumes on reconnect.

## Implementation phases

1. **CS-1 — Local tracking only.** SQLite schema, `score::record_prompt` hook in LLM dispatcher, commit scanner, chip + modal (signed-out look only, local stats). Ship this first; everything else is optional.
2. **CS-2 — GitHub OAuth device flow.** Local-only auth (no backend yet) — just verifies identity and shows avatar/login in modal.
3. **CS-3 — Azure backend skeleton.** App Service + Postgres + `/auth/*` and `/sync/*` endpoints. Empty public profile.
4. **CS-4 — Sync engine.** Client push, cursor management, multi-device merge.
5. **CS-5 — Public profile page.** SSR heatmap at `covenant.dev/u/{login}`.

CS-1 and CS-2 are pure macOS-side; CS-3+ needs the Azure provisioning step (user-driven, since it touches billing).

## Open questions for review

- Domain name for the backend (`covenant.dev`? something else owned by user?). Affects OAuth callback URL.
- Rust vs Node for the server — Rust keeps stack uniform but Node ships faster.
- Whether to track **per-executor breakdown** in the modal (e.g., "Claude 60% · Codex 30% · Ollama 10%") — easy to add since we already store `executor` per event. Not in v1 but trivial follow-up.
