# Covenant Score v2 — Context-aware tracking + Settings page

**Status**: Design
**Date**: 2026-05-17
**Builds on**: [2026-05-16-covenant-score-design.md](./2026-05-16-covenant-score-design.md)
**Mockup**: `/tmp/covenant-v2-mockup.html` (rendered HTML; canonical reference for visuals)

## 1. Goals

1. Attribute every prompt/commit to the **context** it happened in: `repo` + `branch` + tab `group`.
2. Replace the cramped chip-modal with a real **Settings → Covenant** tab inside a refactored tabbed Settings panel.
3. Add three new breakdowns: per-repo bars (30d), top-N branches inside selected repo, per-group bars.
4. Add a recent-sessions feed (last N work sessions with repo/branch/group/duration/prompts/commits).
5. Full server sync of the new context dimensions.

## 2. Non-Goals (v2)

- Cross-repo analytics on the public profile page (covenant.uno/u/:login) — that's v3.
- Renaming/merging branches retroactively (e.g. detecting that `notch` and `worktree-notch` are the same feature).
- Per-file or per-language attribution.
- Mobile/responsive Settings page — desktop-only.

## 3. Data Model

### 3.1 Local (`crates/score`, SQLite)

`score_events` gains three nullable columns:

```sql
ALTER TABLE score_events ADD COLUMN repo       TEXT;     -- e.g. "karlTerminal"
ALTER TABLE score_events ADD COLUMN branch     TEXT;     -- e.g. "notch"
ALTER TABLE score_events ADD COLUMN group_name TEXT;     -- karlTerminal tab group, e.g. "main"
CREATE INDEX IF NOT EXISTS idx_events_repo   ON score_events(repo);
CREATE INDEX IF NOT EXISTS idx_events_branch ON score_events(repo, branch);
CREATE INDEX IF NOT EXISTS idx_events_group  ON score_events(group_name);
```

Migration is additive — historical rows have NULL context (displayed as "unknown" in breakdowns, excluded from per-repo bars but counted in totals/heatmap).

### 3.2 Context resolution

When `append()` is called, the recorder receives a `Context { repo, branch, group_name }`. Resolution rules:

- **repo**: `git -C <session_cwd> rev-parse --show-toplevel` → basename. Cached per-session (re-resolved on `CwdChanged`).
- **branch**: `git -C <repo> branch --show-current`. Detached HEAD → `"detached:<sha7>"`.
- **group_name**: passed in by caller; comes from the karlTerminal tab/group state already in scope.
- Any resolution failure → field stays `None`. Never block prompt recording on git lookup; resolution is best-effort and cached with a 5s TTL.

A new `ContextResolver` lives in `crates/score/src/context.rs` with a small LRU keyed by `session_id`.

### 3.3 Server (covenant-server, Postgres)

```sql
ALTER TABLE prompts ADD COLUMN repo       TEXT;
ALTER TABLE prompts ADD COLUMN branch     TEXT;
ALTER TABLE prompts ADD COLUMN group_name TEXT;
CREATE INDEX prompts_user_repo_idx ON prompts(user_id, repo);
```

Sync payload extends `PromptEvent` JSON: `{ ts, executor, repo?, branch?, group_name? }`. Old clients keep working (fields optional).

New endpoints (auth required):

- `GET /api/breakdown/repos?range=30d` → `[{ repo, prompts, commits }]`
- `GET /api/breakdown/branches?repo=karlTerminal&range=30d` → `[{ branch, prompts, commits }]`
- `GET /api/breakdown/groups?range=30d` → `[{ group_name, prompts }]`
- `GET /api/sessions/recent?limit=10` → `[{ start_ts, end_ts, repo, branch, group_name, prompts, commits }]`

"Session" on the server is derived: group consecutive prompt events from the same `(user, repo, branch)` with gaps < 15 min.

## 4. UI

### 4.1 Settings tabbed refactor

Current `ui/src/settings/panel.ts` is a single scrolling form. Refactor:

- Add a left rail (200px) listing tabs: **General · Appearance · Shortcuts · Covenant · Executors · Notifications · Familiars · Advanced**.
- Each existing settings section moves into one tab. No new behavior beyond layout.
- Settings panel API: `openSettings(tab?: SettingsTab)`. Default `General`.
- The chip click handler in `ui/src/score/chip.ts` changes from `openScoreModal()` to `openSettings('covenant')`.
- The existing modal (`ui/src/score/modal.ts`) is **deleted**. No fallback.

### 4.2 Covenant tab content

Built in `ui/src/score/page.ts` (replaces `modal.ts`). Sections, top to bottom:

1. **Page head**: title, "synced N s ago", sync pill (`@login` on covenant.uno) or "Local only" with Sign-in button.
2. **Filter chips**: time range (All / 30d / 7d), repo, branch, group. Active filters are mutually compounding. `✕` clears one.
3. **Stat cards (4)**: Total prompts (+today delta), Today, Streak, Total commits. All respect filters.
4. **Year heatmap**: kept from v1. Adds click-on-cell → adds a `day:YYYY-MM-DD` chip to filters.
5. **Two-column row**:
   - **By repo · 30d**: stacked horizontal bars (prompts teal, commits dim-teal). Click row → adds repo filter.
   - **Top branches**: only shown when a repo filter is active; lists top 5 branches.
6. **By group**: bars per karlTerminal tab group.
7. **Recent sessions**: last 10, columns `when · repo/branch [group] · prompts · commits + duration`.
8. **Sync card**: status, "Sync now", "Disconnect" — or "Sign in with GitHub" if not connected.

All sections call `crates/score` Tauri commands; no business logic in TS beyond rendering.

### 4.3 New Tauri commands

```rust
score_breakdown_repos(range: TimeRange) -> Vec<RepoCell>
score_breakdown_branches(repo: String, range: TimeRange) -> Vec<BranchCell>
score_breakdown_groups(range: TimeRange) -> Vec<GroupCell>
score_recent_sessions(limit: u32) -> Vec<SessionRow>
score_summary_filtered(filter: ScoreFilter) -> Summary  // existing summary + filters
score_heatmap_filtered(filter: ScoreFilter) -> Vec<DailyCell>
```

`ScoreFilter { range, repo?, branch?, group?, day? }` — all backend-evaluated SQL.

## 5. Wiring

- `record_prompt` callsites (in `crates/app/src/executors/*`) receive the active session's `cwd` and `group_name`; they call `ContextResolver::resolve(session_id, cwd)` to get `repo` + `branch`, then `store.append_with_context(...)`.
- `commit_scanner` already knows `repo_path` and can read branch via `git branch --show-current` at scan time. Group is unknown for commits → `None`.
- Sync uploader (`crates/score/src/sync.rs`) serializes the three new columns; pushes batch with extended schema.

## 6. Migration & Compat

- SQLite: `PRAGMA user_version` bump 1 → 2; migration runs `ALTER TABLE` on first open. Idempotent.
- Server: Postgres migration adds nullable columns; deploy server first, then ship client. Old clients keep posting events without context — accepted.
- No data backfill. Historical rows are NULL and shown as "—" in breakdowns.

## 7. Testing

- `crates/score`: unit tests for `ContextResolver` (cache hits, git failure fallback, detached HEAD), breakdown SQL (per-repo sums, per-branch within repo, session bucketing 15-min gap rule).
- `covenant-server`: integration test for each new endpoint (auth, filtering by repo, empty-result shape).
- UI: visual smoke only — open Settings, click Covenant tab, verify each section renders against a fixture store. No E2E.

## 8. Rollout

1. Server schema migration + new endpoints (deployable independently; old clients ignore).
2. Local SQLite migration + `ContextResolver` + `append_with_context` (behind feature flag in code only — no setting toggle).
3. Settings tabbed refactor (no Covenant changes yet).
4. Build Covenant page; delete `modal.ts`.
5. Sync uploader sends new fields.
6. Cut v0.6.0 (minor bump — UI restructure warrants it).

## 9. Open Questions

None blocking. Future v3 candidates: public profile per-repo breakdown, branch-merge detection, language attribution from commit diffs.
