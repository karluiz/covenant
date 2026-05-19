# Covenant Metrics — Agent, Specs, Tokens

Date: 2026-05-18
Status: Design — pending implementation plan

## Goal

Extend the Covenant Settings page (`ui/src/score/page.ts`, backed by `crates/score`) with three new dimensions:

1. **Execution-agent usage** — rank prompts by which foreground CLI ran them (Claude Code, Copilot, Codex, OpenCode, pi, Covenant-internal, plain shell).
2. **Spec creation count** — count spec files emitted under workspace spec paths.
3. **Token & model usage** — per-model input/output token totals and call counts, split into Covenant orchestrator vs external agents.

All three respect existing Covenant filters (range / repo / branch / day / group).

## Non-goals

- $ cost estimation (raw tokens only).
- PTY output sniffing for token usage.
- Embeddings over spec contents.
- New cross-session correlation triggers off these events (M5+).

---

## 1. Data model & recording

All additions are backwards-compatible: new fields are `#[serde(default)]`, new tables are additive migrations. `karl_score::sync` upload payload gains the two new tables.

### 1.1 `events` table — add `agent` column

`ScoreEvent` (in `crates/score/src/types.rs`) gains:

```rust
pub agent: Option<String>, // serde(default)
```

Canonical labels: `claude_code`, `copilot`, `codex`, `opencode`, `pi`, `internal`, or `None` (plain shell / unknown).

Stamped at `record_prompt` time by resolving the focused tab's foreground process. Reuse the existing `fg_proc` logic that powers the notch (argv fallback per existing memory note "Claude Code renames its comm").

Mapping (in a new `crates/score/src/agent_label.rs`):

| Process / argv contains | Label |
|---|---|
| `claude` (binary or argv[0]) | `claude_code` |
| `codex` | `codex` |
| `gh copilot` / `copilot` | `copilot` |
| `opencode` | `opencode` |
| `pi` (banco-chile pi CLI) | `pi` |
| (Covenant's internal orchestrator) | `internal` |
| anything else | `None` |

### 1.2 `specs` table (new)

```sql
CREATE TABLE specs (
  id          INTEGER PRIMARY KEY,
  ts_ms       INTEGER NOT NULL,
  path        TEXT    NOT NULL UNIQUE,
  repo        TEXT,
  branch      TEXT,
  group_name  TEXT
);
CREATE INDEX idx_specs_ts ON specs(ts_ms);
```

Populated by two sources, both calling the same `record_spec(path, ctx)`:

- **Filesystem watcher** (`crates/score/src/spec_watcher.rs`, new): notify-based watcher rooted at each tracked workspace. Match glob `**/docs/**/specs/**/*.md` plus a configurable extra glob in settings. Debounced 500ms. Dedup is enforced by the `UNIQUE(path)` constraint.
- **Spec author finalize** (`crates/app/src/spec_author.rs`): calls `record_spec` on save. Belt-and-suspenders with the watcher; the unique constraint makes double-emission a no-op.

### 1.3 `llm_calls` table (new)

```sql
CREATE TABLE llm_calls (
  id                INTEGER PRIMARY KEY,
  ts_ms             INTEGER NOT NULL,
  source            TEXT    NOT NULL CHECK (source IN ('internal','external')),
  agent             TEXT,           -- claude_code / codex / ... ; null for internal
  provider          TEXT    NOT NULL, -- anthropic / openai_compat / ...
  model             TEXT    NOT NULL,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_read        INTEGER NOT NULL DEFAULT 0,
  cache_creation    INTEGER NOT NULL DEFAULT 0,
  repo              TEXT,
  branch            TEXT,
  group_name        TEXT
);
CREATE INDEX idx_llm_calls_ts ON llm_calls(ts_ms);
CREATE INDEX idx_llm_calls_source_model ON llm_calls(source, model);
```

**Internal source** — stamped at `agent::dispatch()` (the existing chokepoint per CLAUDE.md) after each provider response. Anthropic returns `usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`; OpenAI-compat returns `usage.{prompt_tokens, completion_tokens}`. Normalize both into the columns above.

**External source** — per-agent poller modules under `crates/score/src/external/`:

- `claude_code.rs` — tail `~/.claude/projects/**/*.jsonl`; each line is a JSON message with `message.usage`. Watermark = `(path, byte_offset)` persisted in a new `external_watermarks` table.
- `codex.rs` — tail `~/.codex/sessions/**/rollout-*.jsonl` (or equivalent).
- `opencode.rs`, `pi.rs` — best-effort; ship stubs that no-op if files aren't found.
- Copilot CLI — no known usage file; omit from v0 (Copilot prompts are still counted via the agent column on `events`).

All pollers run on a single background tokio task, ~30s interval, started in `crates/app/src/lib.rs` next to the existing commit scanner.

---

## 2. Backend API

New Tauri commands in `crates/app/src/score_commands.rs`, all accepting `ScoreFilter`:

```rust
score_breakdown_agents(filter) -> Vec<AgentCell>
score_breakdown_specs(filter)  -> SpecBreakdown
score_breakdown_models(filter, source: ModelSource) -> Vec<ModelCell>
```

Types (in `crates/score/src/types.rs`):

```rust
pub struct AgentCell { pub agent: String, pub prompts: u32, pub share: f32 }
pub struct SpecRow   { pub ts_ms: i64, pub path: String, pub repo: Option<String> }
pub struct SpecBreakdown { pub total: u32, pub recent: Vec<SpecRow> }
pub enum   ModelSource { Internal, External }
pub struct ModelCell {
    pub source: ModelSource,
    pub agent: Option<String>,
    pub provider: String,
    pub model: String,
    pub calls: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read: u64,
}
```

`Summary` gains two fields, both filter-scoped:

```rust
pub total_tokens: u64, // input + output across both sources under filter
pub total_specs:  u32,
```

`ScoreFilter` gains an optional `agent: Option<String>` so the new chip can scope all other cards by selected agent.

All breakdown SQL extends the existing pattern in `crates/score/src/filter.rs`; `repo`/`branch`/`day`/`group_name` clauses are reused verbatim against the new tables.

---

## 3. UI

### 3.1 Page layout (`ui/src/score/page.ts`)

Template additions, inserted between the existing "By group" card and "Recent sessions":

```
[ stat row: total prompts | today | streak | total commits | total tokens ]
[ activity heatmap ]
[ by repo  ][ top branches ]
[ by group ]
[ by agent · last <range> ]                                  <-- new
[ specs created ][ token usage · per model ]                 <-- new (two-col)
[ recent sessions ]
[ sync ]
```

- **Total tokens tile** — added to the existing `renderStats` row.
- **By agent card** — horizontal bars styled like `renderRepoBars` from `breakdowns.ts`. Bar colors per agent (Claude Code green, Codex orange, Copilot purple, OpenCode red, pi cyan, internal magenta, shell grey). Click a bar → set `state.filter.agent` and `refresh()`; emit a dismissable chip in `renderFilters`.
- **Specs card** — large total at top, then a list of up to 5 most recent spec paths with relative time. No drilldown in v0.
- **Token usage card** — pill toggle at the top: `Covenant` / `External`. Below: table with columns model · calls · input · output (cache-read shown dimmed in parentheses on the input column). External tab adds an "agent" column.

### 3.2 New files

- `ui/src/score/usage.ts` — renderers for agent bars, spec list, model tables (keeps `breakdowns.ts` from ballooning).
- New CSS in `ui/src/score/styles.css` for the pill toggle and model table.

### 3.3 TypeScript types (`ui/src/score/api.ts`)

Add `AgentCell`, `SpecRow`, `SpecBreakdown`, `ModelSource`, `ModelCell`; extend `Summary` and `ScoreFilter`. Wrap the three new commands in typed functions next to the existing `scoreBreakdownRepos` etc.

---

## 4. Files touched

| File | Change |
|---|---|
| `crates/score/src/types.rs` | new types; `ScoreEvent.agent`; `Summary` fields; `ScoreFilter.agent` |
| `crates/score/src/store.rs` | migrations; insert/query for `specs`, `llm_calls`; `record_spec`, `record_llm_call` |
| `crates/score/src/filter.rs` | extend WHERE-builder to cover new tables and `agent` filter |
| `crates/score/src/sync.rs` | upload new tables |
| `crates/score/src/agent_label.rs` | new — proc/argv → canonical agent label |
| `crates/score/src/spec_watcher.rs` | new — notify-based watcher |
| `crates/score/src/external/{mod,claude_code,codex,opencode,pi}.rs` | new — external usage pollers |
| `crates/app/src/score_commands.rs` | new commands; wire into `lib.rs` invoke_handler |
| `crates/app/src/lib.rs` | start spec watcher + external pollers next to commit scanner |
| `crates/app/src/spec_author.rs` | call `record_spec` on finalize |
| `crates/agent/src/provider/anthropic.rs` | emit `record_llm_call` with usage |
| `crates/agent/src/provider/openai_compat.rs` | emit `record_llm_call` with usage |
| `crates/app/src/operator.rs` / wherever `record_prompt` is called | resolve agent label and pass it through |
| `ui/src/score/page.ts` | template + new cards + filter chip |
| `ui/src/score/usage.ts` | new renderers |
| `ui/src/score/api.ts` | types + command wrappers |
| `ui/src/score/styles.css` | pill toggle, model table, agent bar colors |
| `ui/src/api.ts` | typed wrappers |

---

## 5. Testing

### Unit

- `agent_label`: each known proc/argv pattern → expected label; unknown → `None`.
- `external::claude_code`: parse a sample JSONL fixture, assert token sums and watermark advance; second run from the watermark adds zero rows.
- `external::codex`: same shape, fixture-driven.
- `spec_watcher`: emitting two events for the same path produces a single row (UNIQUE constraint).
- `filter`: each new breakdown returns expected aggregates under every `ScoreFilter` permutation (range × repo × branch × day × group × agent).

### Integration

- End-to-end record → query for each new event kind through a temporary `ScoreStore` with all filter dimensions applied.
- Watcher creates a file inside a temp workspace; assert `score_breakdown_specs` reflects it within the debounce window.
- Stub provider returning a known `usage` object; assert `score_breakdown_models` aggregates correctly across multiple calls.

---

## 6. Risks & open questions

- **External parser drift** — Claude Code / Codex JSONL schemas can change between versions. Mitigation: parsers are isolated per-agent; failures log and skip rather than poison the table.
- **Foreground-process attribution races** — if the agent label is resolved a moment after the prompt is sent, attribution may slip to the wrong tab. Acceptable for v0; revisit if data looks noisy.
- **Sync payload size** — `llm_calls` could grow fast on heavy days. Mitigation: existing sync already batches; monitor and add a TTL/compaction pass later if needed.
- **Copilot tokens** — not captured in v0. Prompt counts to Copilot are still tracked via the `agent` column.
