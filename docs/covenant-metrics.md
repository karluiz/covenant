# Covenant Metrics

Covenant Score is the local-first telemetry layer baked into Covenant. It
records what the user (and their AI executors) actually do across every
terminal session — prompts issued, commits landed, LLM tokens spent, specs
written — and attributes each event to its `(repo, branch, group)` context
so it can be sliced, summarized, and synced.

It is *not* an analytics SDK. Everything is captured in-process, stored in
a local SQLite database, and optionally pushed to a self-hosted
`covenant-server` for cross-device aggregation.

---

## What is recorded

| Event       | Source                                                                  |
|-------------|-------------------------------------------------------------------------|
| `Prompt`    | A user prompt routed to an executor (Claude Code, Codex, opencode, pi). |
| `Commit`    | A git commit observed by `commit_scanner` (per repo, per branch).       |
| `LlmCall`   | Tokens in/out/cache for any internal or external model call.            |
| `Spec`      | A spec file appearing under a watched root (via `spec_watcher`).        |

Each event carries:

- `timestamp_ms` (UTC, day-bucketed by local tz at query time)
- `executor` — `anthropic`, `openai_compat`, or `<repo>:<sha7>` for commits
- `agent` — optional executor sub-label (e.g. `claude-code`, `codex`)
- `Context { repo, branch, group_name }` — resolved automatically

See `crates/score/src/types.rs` for the wire types.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Tab / session activity (PTY)                                │
│       │                                                       │
│       ▼  score_set_current_session(session_id, cwd, group)   │
│  CurrentSession slot ──► ContextResolver (git rev-parse,     │
│                          5s LRU per session)                  │
│       │                                                       │
│       ▼                                                       │
│  karl_score::record_* ──► ScoreStore (SQLite)                │
│                            │                                  │
│   ┌────────────────────────┼────────────────────────────┐    │
│   ▼                        ▼                            ▼    │
│  commit_scanner       external pollers           spec_watcher│
│  (git log since)      (Claude Code / Codex /     (notify fs) │
│                       opencode / pi token logs)              │
│                            │                                  │
│                            ▼                                  │
│                       sync::push_once ──► covenant-server    │
└──────────────────────────────────────────────────────────────┘
```

Key files:

- `crates/score/src/lib.rs` — global `set_recorder` / `record_prompt` /
  `record_commit` / `record_llm_call` / `record_spec` API. A
  `OnceCell<Mutex<Option<Arc<ScoreStore>>>>` lets call sites record without
  threading a `State` handle through.
- `crates/score/src/store.rs` — SQLite store (`ScoreStore::open`), schema
  migrations gated by `PRAGMA user_version`, all summary/breakdown queries.
- `crates/score/src/context.rs` — `ContextResolver` shelling out to
  `git rev-parse` / `git branch --show-current` with a 5s LRU per session.
- `crates/score/src/commit_scanner.rs` — periodic `git log` walker that
  emits `Commit` events with branch attribution.
- `crates/score/src/spec_watcher.rs` — `notify` watcher for spec files.
- `crates/score/src/external/{claude_code,codex,opencode,pi}.rs` — tail
  external token-usage logs and convert them into `LlmCall` events.
- `crates/score/src/sync.rs` — pushes `unsynced_events` to the server using
  watermarks (`get_sync_cursor` / `set_sync_cursor`).
- `crates/score/src/auth.rs` — GitHub device-flow sign-in, token in keyring.
- `crates/app/src/score_commands.rs` — Tauri commands wired into the app
  (see `crates/app/src/lib.rs` ≈ line 3026 for setup, ≈ line 3185 for the
  invoke handler list).
- `ui/src/score/` — chip (`chip.ts`), settings page (`page.ts`),
  breakdowns, sign-in, usage view.

---

## Data model (SQLite v2)

`score_events` columns: `timestamp_ms, kind, executor, agent, repo,
branch, group_name`. The three context columns are nullable; historical v1
rows are read with NULLs and never backfilled. Migration is idempotent via
`PRAGMA user_version`.

Supporting tables: `llm_calls` (per-call tokens), `spec_events`,
`sync_cursor`, `watermarks` (per-source byte offsets for external log
tailers).

---

## Tauri command surface

Registered in `crates/app/src/lib.rs`:

```
score_signin_start, score_signin_poll, score_current_user, score_signout
score_sync_now, score_sync_status
score_set_current_session
score_summary, score_summary_filtered
score_heatmap, score_heatmap_filtered
score_breakdown_repos, score_breakdown_branches, score_breakdown_groups
score_breakdown_agents, score_breakdown_specs, score_breakdown_models
score_recent_sessions
```

All filtered/breakdown commands accept a `ScoreFilter`:

```rust
ScoreFilter {
    range: TimeRange,        // All | Last7d | Last30d
    repo:   Option<String>,
    branch: Option<String>,
    group_name: Option<String>,
    day:    Option<String>,  // "YYYY-MM-DD"
    agent:  Option<String>,
}
```

---

## UI surface

- **Status-bar chip** (`ui/src/score/chip.ts`) — opens
  `Settings → Covenant` directly (no modal).
- **Settings → Covenant page** (`ui/src/score/page.ts`) — cycleable
  range chips (all/30d/7d), repo/branch/group/day filters, 4 stat cards,
  53-week heatmap, per-repo stacked bars, top-branches drill-in, per-group
  bars, recent-sessions feed, sync card, sign-in card.
- **Usage tab** (`ui/src/score/usage.ts`) — model/agent token breakdowns.

---

## Sync to `covenant-server`

- Auth: GitHub device flow (`crates/score/src/auth.rs`), token stored in
  the OS keyring (`keyring` crate).
- Wire format: `PushEvent { ..., repo?, branch?, group_name? }` — context
  fields are `#[serde(default)]` so old servers/clients stay compatible.
- Cursor: `(last_ts_ms, last_id, last_seq)` tracked in `sync_cursor`.
- Server endpoints (covenant-server, behind `/api/`): `breakdown/repos`,
  `breakdown/branches?repo=…`, `breakdown/groups`, `sessions/recent`.
- Recent-sessions bucketing: strict `>15 min` gap per `(repo, branch)` —
  client and server use the same `>` comparison (aligned in v0.6.0).

Push runs on a tokio interval task spawned in `setup`
(`crates/app/src/lib.rs` ≈ line 3074).

---

## Streaks & summary

`Summary { total_prompts, total_commits, today_prompts, today_commits,
current_streak, longest_streak, total_tokens, total_specs }`.
Streak computation lives in `compute_streaks` at the bottom of
`crates/score/src/store.rs` and runs over `DailyCell`s in local-tz date
order.

---

## Adding a new event source

1. Define the recording entry point in `crates/score/src/lib.rs` if the
   event doesn't fit `record_prompt` / `record_commit` / `record_llm_call`
   / `record_spec`.
2. Persist via `ScoreStore::append_*` — extend the schema with a new
   `PRAGMA user_version` bump in `store.rs` if needed.
3. If the source is an external log file, model it after
   `crates/score/src/external/claude_code.rs` (watermarked tail loop) and
   register it in `external::start`.
4. Wire any new query into `score_commands.rs` + the Tauri invoke handler
   list in `crates/app/src/lib.rs`, then surface it under `ui/src/score/`.

---

## Privacy

All events live in the local SQLite store under the app data dir. Nothing
is sent anywhere unless the user signs in via GitHub and the sync task
pushes deltas to their `covenant-server`. Commit SHAs and repo/branch
names are recorded; commit message bodies and diffs are not.

---

## OpenTelemetry (OTEL) export

Covenant can push all CDLC metrics to any OpenTelemetry-compatible backend
(Grafana/Prometheus, Datadog, Honeycomb, New Relic, etc.) via the standard
OTLP gRPC protocol. This is opt-in: set the `OTEL_EXPORTER_OTLP_ENDPOINT`
environment variable before launching Covenant.

### Quick start

```bash
# Point at a local OTEL Collector (default gRPC port)
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317

# Or a cloud backend that speaks OTLP
export OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.example.com:4317
```

When the variable is set, Covenant initializes an OTLP meter provider at
startup and registers observable gauges that read from the score store on
each collection cycle (every 60 s by default).

When the variable is **not** set, no OTEL code runs — zero overhead.

### Exported metrics

All metrics live under the `covenant.cdlc` namespace.

| Metric | Type | Labels | Description |
|---|---|---|---|
| `covenant.cdlc.total_prompts` | gauge | — | Lifetime prompt count |
| `covenant.cdlc.total_commits` | gauge | — | Lifetime commit count |
| `covenant.cdlc.total_tokens` | gauge | — | Lifetime LLM token consumption |
| `covenant.cdlc.today_prompts` | gauge | — | Prompts recorded today |
| `covenant.cdlc.today_commits` | gauge | — | Commits recorded today |
| `covenant.cdlc.current_streak` | gauge | — | Current consecutive-day activity streak |
| `covenant.cdlc.longest_streak` | gauge | — | Longest streak ever |
| `covenant.cdlc.total_specs` | gauge | — | Total spec/note files tracked |
| `covenant.cdlc.repo.prompts` | gauge | `repo` | Prompts by repository |
| `covenant.cdlc.repo.commits` | gauge | `repo` | Commits by repository |
| `covenant.cdlc.agent.prompts` | gauge | `agent` | Prompts by executor agent |
| `covenant.cdlc.model.input_tokens` | gauge | `provider`, `model` | Input tokens by model |
| `covenant.cdlc.model.output_tokens` | gauge | `provider`, `model` | Output tokens by model |
| `covenant.cdlc.model.cache_read_tokens` | gauge | `provider`, `model` | Cache-read tokens by model |

### Architecture

```
ScoreStore (SQLite)
    │
    ▼  observable gauge callbacks (60 s)
opentelemetry_sdk::SdkMeterProvider
    │
    ▼  PeriodicReader
opentelemetry-otlp (gRPC/tonic)
    │
    ▼
OTEL Collector / Grafana / Datadog / …
```

The implementation lives in `crates/score/src/otel.rs` behind the `otel`
Cargo feature (enabled by default in the app crate). Key entry points:

- `otel::start(store)` — called during app setup; returns `None` when the
  env var is unset (no-op path).
- `otel::init_meter_provider()` — builds the `SdkMeterProvider` with an
  OTLP exporter.
- `otel::register_metrics(meter, store)` — registers all observable gauges
  against a given meter + store.

### Standard OTEL environment variables

The exporter respects the full set of
[OTLP exporter env vars](https://opentelemetry.io/docs/specs/otel/protocol/exporter/):

| Variable | Default | Purpose |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | *(none — opt-in)* | Collector endpoint |
| `OTEL_EXPORTER_OTLP_HEADERS` | — | Auth headers (`key=value` pairs) |
| `OTEL_EXPORTER_OTLP_TIMEOUT` | `10000` | Export timeout (ms) |
| `OTEL_RESOURCE_ATTRIBUTES` | — | Extra resource attributes |

### Example: local Grafana stack

```bash
# 1. Run the Grafana LGTM stack (Loki + Grafana + Tempo + Mimir)
docker run -d --name lgtm -p 3000:3000 -p 4317:4317 grafana/otel-lgtm

# 2. Launch Covenant
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317 /Applications/Covenant.app/Contents/MacOS/Covenant

# 3. Open Grafana at http://localhost:3000 → Explore → Mimir
#    Query: covenant_cdlc_total_prompts
```

### Testing

```bash
cargo test -p karl-score --features otel --test otel
```

The smoke test uses the SDK's `InMemoryMetricExporter` to verify all gauges
register and produce values without needing a live collector.

---

## Relevant history

See `CHANGELOG.md` — most context-aware behavior landed in **v0.6.0**
("Covenant Score v2: per-repo/branch tracking + Settings page"), with
follow-up polish in v0.6.2+. Design notes live in
`docs/superpowers/specs/2026-05-16-covenant-score-design.md` and
`2026-05-17-covenant-score-v2-design.md`.
