# Changelog

All notable changes to Covenant.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Each version section may include any of: **Added**, **Changed**, **Fixed**,
**Removed**.

## v0.8.0 — Teammate foundation + light-mode operator cards

### Added

- **Teammate runtime scaffold**: New `crates/app/src/teammate/` with an in-memory per-operator state machine (`Idle` / `Pinned(s)` / `OnTask(t, _)`) and Tauri-managed instance held from app boot (`crates/app/src/lib.rs`). No LLM dispatch yet — Phase 2 plugs in.

- **Teammate persistence**: SQLite tables `teammate_tasks`, `teammate_messages`, `teammate_artifacts`, plus `operators.rolling_summary` column for Phase 2 prompt caching. Schema additions are idempotent (`crates/app/src/storage.rs`).

- **Teammate Tauri commands**: `teammate_list_messages_for_operator`, `teammate_send_text_message`, `teammate_list_tasks` (stub) — text-only DM persistence end-to-end (`crates/app/src/teammate/commands.rs`).

- **DM rail placeholder**: New chat icon in the titlebar (`ui/index.html`, `ui/src/icons/index.ts`) toggles a `TeammatePanel` in the right rail. Text-only echo end-to-end; no operator reply yet (`ui/src/teammate/panel.ts`, `ui/src/main.ts`).

### Fixed

- **Light-theme contrast on operator cards**: Edit / Duplicate buttons no longer ghost into the card background in light mode. Semantic `--settings-btn-fill` and `--op-card-fill` tokens with light-mode overrides give cards a white surface + drop shadow and buttons a visible fill. Also removed a stale duplicate `.settings-btn` block that was silently defeating the new tokens (`ui/src/styles.css`, `ui/src/styles/operator_chip.css`).

- **Tabbar-left right-rail bleed on full-page routes**: Earlier in this cycle, `:has()`-scoped overrides were added so the layout collapses to a 2-column grid when Settings / Docs / Drafts / Mission / Operator / Capabilities is open under `sidebar-view-activity` or `project-notes-open` (`ui/src/styles.css`).

## v0.7.12 — Tabbar-left full-page rail collapse fix

### Fixed

- **Background bleed next to full-page routes in tabbar-left mode**: With the activity sidebar enabled, the layout reserves a 3rd grid column for the right rail. When Settings / Docs / Drafts / Mission / Operator / Capabilities are open the rail is hidden, but the reserved column kept the gap and the window background showed through. Added `:has()`-scoped overrides that collapse `#layout` to a 2-column `var(--tabbar-w) minmax(0, 1fr)` grid for each of those routes under both `sidebar-view-activity` and `project-notes-open` (`ui/src/styles.css`). Also ignores local `scratch/` from git.

## v0.7.11 — Persona preset chips + tab XP ring + tabbar-left polish

### Added

- **Rich operator persona presets**: Expanded the "Start from preset" row in the New / Edit Operator modal from 4 stubs to 8 chips (**Reviewer, Yolo, QA, Scout, Pair, Spec, Watcher, Auto**) and wired each chip to a full persona charter from `ui/src/operator/persona-templates.ts`. One click now seeds name, color, voice, model, escalate threshold and a multi-paragraph persona instead of a one-liner like *"Autonomous operator with conservative allowlist."* (`ui/src/settings/operator_presets.ts`).

- **XP ring on tab operator avatars**: Tab pills now render an SVG progress ring around the leading operator avatar, driven by a per-tab `--xp-progress` CSS variable that resets at each level-up. Makes XP gain visible without opening the operator panel (`ui/src/tabs/manager.ts`, `ui/src/styles.css`).

### Changed

- **Settings tabs share a styling vocabulary**: Introduced shared tokens (`.settings-section-desc`, `.settings-card`, `.settings-card-title`, `.settings-field-label`, `.settings-btn`) and migrated Providers, Models and Operators onto them. Fixes the oversized intro paragraph in Providers (was browser-default ~16px) and unifies button sizing and radius across the three tabs (`ui/src/settings/providers.ts`, `ui/src/settings/model_routes.ts`, `ui/src/settings/operators.ts`, `ui/src/styles.css`, `ui/src/styles/operator_chip.css`).

- **Drop active-tab left accent stripe in vertical tabbar**: The pill background plus border-color already convey selection, and the stripe collided with the new XP ring at the same left edge. Removed the `::before` rules for both `.tab-btn.active` and `.tab-grouped.active` under `body.tabbar-left` (`ui/src/styles.css`).

### Fixed

- **Operator modal scroll no longer snaps to top**: Toggling Voice / Color / Avatar / Model in the New / Edit Operator modal called a full `render()` rebuild, which reset `.op-modal-body` scroll to 0. The render path now snapshots and restores `scrollTop` so deep fields stay anchored while editing (`ui/src/settings/operators.ts`).

- **Full-page routes coexist with vertical tabbar**: The `#layout:has(> #settings-page:not([hidden]))` rules that collapsed the grid to `1fr` were unconditional, which under `body.tabbar-left` pushed Settings / Docs / Drafts / Mission / Operators / Capabilities off-screen and let the sidebar swallow the viewport. The collapse is now scoped to `body:not(.tabbar-left)`, preserving the two-column layout in vertical-tabbar mode while horizontal-tabbar still gets full-width pages (`ui/src/styles.css`).

## v0.7.10 — Full-page rail coverage + zsh % marker suppression

### Fixed

- **Full-page routes cover the right rail**: Settings, Docs, Drafts, Mission, Operator, and Capabilities pages now span the full layout grid (`grid-column: 1 / -1`) and hide `#activity-sidebar` while open, so the Activity / Project Notes rail no longer bleeds through next to an open page when `body.sidebar-view-activity` is set (`ui/src/styles.css`).

- **Zsh partial-line `%` marker suppressed**: The OSC 133 zsh integration now `unsetopt PROMPT_SP` and blanks `PROMPT_EOL_MARK`, so the inverse `%` that zsh shows when the previous output lacks a trailing newline no longer appears on every fresh session. Covenant already segments output into Blocks via OSC 133, and the `OSC 133;A` sequence itself counts as output without a newline, which made the marker fire spuriously (`shell-integration/osc133.zsh`).

## v0.7.9 — Sidebar resizer + DPR-aware letter spacing

### Fixed

- **Sidebar resizers stop at the status bar**: The left/right sidebar resize handles are now placed into a named grid row (`status-start`) instead of using hardcoded `top: 38px; bottom: 26px` offsets, so they naturally confine to rows above the status bar and reclaim the space when the status bar is hidden (`ui/src/styles.css`).

- **Letter-spacing on 1x external displays**: Negative `letter_spacing` values are now scaled by `devicePixelRatio` in `ui/src/tabs/manager.ts`. On Retina (DPR=2) sub-pixel AA absorbs glyph overlap so the value applies in full; on a 1x external display the same setting fell back to 0 instead of literally stacking glyphs on top of each other. Applied to both initial terminal options and live config updates.

## v0.7.8 — Activity card cap + boot splash polish

### Changed

- **Activity card height cap and light boot splash polish**: The inline Activity/Notch selector now caps the header card and clamps long process text so active commands no longer stretch the sidebar (`ui/src/styles.css`). Light-mode boot splash styles in `ui/index.html` and `ui/src/styles.css` now mirror the persisted theme surface earlier in startup.

- **Horizon WIP handoff**: The release skill now commits current WIP on `main` before release checks so `/skill:horizon` can include the latest local work while still refusing to push if the tree stays dirty (`.pi/skills/horizon/SKILL.md`).

## v0.7.7 — Pi activity tracking + workspace UI polish

### Added

- **Pi activity sidebar tracking** (`crates/app/src/pi_commands.rs`,
  `crates/app/src/notch.rs`, `crates/session/src/lib.rs`,
  `ui/src/inline-notch.ts`, `ui/notch/main.ts`): Pi RPC text/tool
  updates now heartbeat through the notch hub, external-session
  snapshots replay the displayed phase with the executor label, and the
  Activity sidebar waits for its listener before requesting replay so Pi
  no longer appears as "no agent" while it is active.
- **Pi RPC launch and panel polish** (`crates/agent/src/pi_rpc/session.rs`,
  `ui/src/executors/pi/view.ts`, `ui/src/executors/pi/pi.css`): GUI
  launches augment PATH so `pi --mode rpc` and its Node shebang resolve
  reliably, while the Pi chat panel gains a branded empty state, clearer
  submit hint, and light-theme-safe controls.
- **Git branch/worktree controls** (`crates/app/src/git_tools.rs`,
  `crates/app/src/lib.rs`, `ui/src/api.ts`, `ui/src/status/bar.ts`,
  `ui/src/main.ts`): Covenant can summarize the active repo's branches
  and worktrees, switch branches through the status-bar popover, and open
  worktrees in dedicated terminal tabs.
- **Workspace UI and release-command polish** (`ui/src/styles.css`,
  `ui/src/structure/editor.ts`, `ui/src/tabs/manager.ts`,
  `.pi/prompts/horizon.md`, `.pi/skills/horizon/SKILL.md`): sidebars and
  editor panes pick up new resizing/open-path affordances, score and
  operator chips get styling refinements, and the Horizon release ritual
  is available as both a Pi prompt and skill.

## v0.7.6 — Formatting pass + pi/operator/score iteration

### Changed

- **Workspace-wide rustfmt + iteration on operator and metrics surfaces**
  (`crates/app/src/operator.rs`, `crates/app/src/pi_commands.rs`,
  `crates/app/src/telegram/`, `crates/app/src/notch.rs`,
  `crates/app/src/vitals.rs`, `crates/blocks/src/executor_phase.rs`,
  `crates/score/src/`, `crates/session/src/operator_ref.rs`,
  `ui/src/inline-notch.ts`, `ui/src/status/vitals.ts`,
  `ui/src/styles.css`): broad formatting normalization across the
  app, score, blocks, and session crates, plus incremental work on
  `pi_commands` (token usage / agent message plumbing), operator
  prompt builder, executor phase mapping, vitals, and inline notch
  styling. Test files updated to match.

## v0.7.5 — Operator identity v1 + metrics, themes, landing

### Added

- **Covenant Score metrics expansion** (`crates/score/src/store.rs`,
  `crates/score/src/spec_watcher.rs`, `crates/score/src/external/`,
  `crates/score/src/agent_label.rs`, `ui/src/score/`): migration v3
  adds `specs`, `llm_calls`, and an `agent` column on `score_events`.
  Internal LLM calls are recorded via `record_llm_call`; specs are
  picked up by a `notify`-based watcher; external pollers tail Claude
  Code JSONL, Codex, opencode, and pi token logs. New
  `breakdown_models` / `breakdown_agents` / `breakdown_specs` queries
  back three new Settings → Covenant cards (by-agent, specs, token
  usage). New top-level doc `covenant-metrics.md` describes the full
  surface.
- **Inline notch D-combo slot in vertical tabbar**
  (`ui/src/inline-notch.ts`, `ui/src/styles.css`, `ui/src/main.ts`):
  in fullscreen, the floating notch overlay is suppressed and a
  foldable inline slot rides inside the vertical tabbar with a strict
  60/40 split between tab pills and notch content. Light-mode palette
  fixed; seam/gradient dropped for a flat continuous surface.
- **Activity sidebar view** (`ui/src/`): a third right-sidebar view
  alongside Blocks/Files, with group/project tags uppercased via CSS.
- **Theme: dark / light / system** (`crates/app/src/settings.rs`,
  `crates/app/src/window.rs`, `ui/src/theme.ts`, `ui/src/styles.css`):
  `ThemeMode` lands on `WindowConfig`. A new `set_window_theme`
  command swaps the macOS `NSVisualEffectView` material at runtime.
  Frontend exposes `resolveTheme` + `watchSystemTheme` and applies a
  `body.theme-light` class that drives token overrides, including a
  GitHub Light xterm palette. Chrome hex literals were tokenized via a
  new `--ink-rgb` invertible surface token for legibility under light.
- **Landing site** (`landing/`): Astro + Tailwind project with hero,
  four-pillar companion section, safety-contract Covenant section,
  Covenant Score funnel animation, deep-dive, open-source, install,
  and footer sections. Playwright smoke test covers sections + score
  funnel. README, OG placeholder, and size budget verified.
- **SDD steering workspace** (`docs/sdd/`): scaffolding for spec /
  design / decision docs.
- **Pi session rename** (`crates/pi/`, `crates/app/`, `ui/src/api.ts`,
  `ui/src/tabs/manager.ts`): `set_session_name` exposed as a Tauri
  command and wrapped in `api.ts`; tab rename now forwards into the
  pi session when previously unnamed.
- **Operator identity** (`crates/operator/src/registry.rs`,
  `crates/storage/src/lib.rs`, `crates/operator/src/lib.rs`): operators now
  carry a `voice` (`Terse` / `Warm` / `Formal`) tone that flows into the
  per-operator system prompt. `operators.voice` column lands via migration
  with a `Terse` default; existing rows keep working.
- **Telegram messages get operator + project context**
  (`crates/telegram/src/outbound.rs`, `crates/session/src/event.rs`):
  escalations render as `🟣 Maya · karlTerminal (main)\n<summary>` with
  typed action buttons (Approve push / Reject / Snooze / Custom) instead
  of `[tab: session:01KRRP] BLOCKED`. `SessionEvent::EscalationRequested`
  now carries typed `operator: OperatorRef`, `project: ProjectRef`, and
  `actions: Vec<OperatorAction>` (was `Vec<String>`).
- **Named confirmation replies** (`crates/telegram/src/inbound.rs`):
  Telegram resolutions reply with `✓ Maya pushed and opened …` instead of
  a generic "Resolved" message. Inbound callback data is parsed through a
  typed dispatch.
- **Operator settings redesigned**
  (`ui/src/operators/modal.ts`, `ui/src/operators/grid.ts`,
  `ui/src/operators/chip.ts`, `ui/src/operators/presets.ts`): two-step
  modal (Identity, Behavior) with starter presets (Reviewer, Pair,
  Watcher, Auto) and a card-grid list view. Shared `OperatorChip`
  component used in settings and the AFK active-operators strip.

### Fixed

- **Operator chip avatar resolution** (`ui/src/operators/chip.ts`):
  operator chips now resolve `pack:<id>` avatars instead of rendering
  the literal string.
- **Operator edit modal styled as overlay** (`ui/src/operators/modal.ts`,
  `ui/src/operators/styles.css`): backdrop + card + form polish so it
  reads as a proper modal instead of an inline form. Sticky topbar
  and footer, dynamic project name in preview, email-type inputs
  styled, light-mode score-sync buttons readable, modal inputs use
  `box-sizing: border-box` so they no longer overflow the card, and
  the slider track + fill render visibly under light mode.
- **Workspace row menu anchoring** (`ui/src/workspaces/`): row menu
  now anchors to the popover edge instead of the cursor position.
- **Notch overlay on fullscreen Space** (`crates/app/src/notch.rs`):
  keep the floating overlay off the fullscreen Space; inline slot
  carries the load there.
- **Parse-failure quarantine** (`crates/operator/src/operator_mind.rs`,
  `crates/operator/tests/compile_fail/parse_failure_to_outbound.rs`):
  `operator_mind` JSON parse failures can no longer surface as Telegram
  escalations. After 3 failures in a 60-second window the session is
  force-quarantined (suggest-only) and a single in-app notice fires.
  Quarantine is enforced via a typed `ParseFailure` boundary that has no
  conversion into `OutboundContext` — proven by a `trybuild` compile-fail
  test.

### Changed

- `SessionEvent::EscalationRequested` payload is now typed
  (`OperatorRef` / `ProjectRef` / `Vec<OperatorAction>`); previous
  consumers passing `Vec<String>` will not compile.
- `TelegramNotifier::send_escalation` takes a typed
  `SendEscalationArgs<'_>` instead of positional fields.

### Known follow-ups

- **AOM banner** doesn't yet render the operator chip — it currently
  shows AOM mode state only; needs an operator slot.
- **Activity feed** entries can't render the operator chip yet —
  `DecisionEvent` payload only carries `session_id`; needs operator
  threading.
- **Tab pill** still uses the legacy `renderAvatarHtml` + level overlay;
  needs a name-less chip variant before swapping in.

## v0.7.4 — Updater banner inline in titlebar

### Fixed

- **Updater banner no longer stacks as its own row** (`ui/src/updater/banner.ts`,
  `ui/src/styles.css`). The "Update available" bar was a `position: fixed`
  34px row pinned above `#layout`, pushing the entire app down and leaving
  an awkward empty strip below the titlebar. The banner now mounts inside
  `#app-titlebar-center`, replacing the COVENANT brand only while an update
  is pending — compact pill with pulse · version · "What's new ›" · Install
  · dismiss, styled to match the rest of the titlebar chrome. Dropped the
  `body.has-update-banner #layout { padding-top: 34px }` shift and the
  redundant "Later" button (× dismisses).

## v0.7.3 — LM Studio provider fix + scrollback PROMPT_SP fix

### Fixed

- **OpenAI-compatible providers can be saved again**
  (`crates/agent/src/provider/mod.rs`). `ProviderKind` used
  `#[serde(rename_all = "snake_case")]`, which serializes `OpenAiCompat`
  as `open_ai_compat`. The frontend (and the `provider_id` strings
  elsewhere in the backend) use `openai_compat`, so `set_settings`
  rejected any attempt to add an LM Studio / Ollama / llama.cpp
  provider with `unknown variant 'openai_compat'`. Pinned the variant
  to `openai_compat` explicitly and kept `open_ai_compat` as a
  deserialize alias for any settings already on disk.

- **No more inverse `%` artifact above the first prompt on tab reopen**
  (`crates/app/src/scrollback.rs`). When the replayed scrollback tail
  ended mid-line, the freshly-spawned zsh ran its `PROMPT_SP` probe
  and drew an inverse `%` glyph before the prompt. `trim_after_last_command_finish`
  now appends `\r\n` when the tail doesn't already end at column 0, so
  zsh sees a clean line and skips the probe.

## v0.7.2 — Vitals polish — multi-cc tailer + custom tooltips

### Fixed

- **Tailer binds to the freshly-spawned `cc`, not the noisiest one in the
  cwd** (`crates/app/src/exec_vitals.rs`). The previous
  `newest_jsonl_for_cwd` heuristic broke when two Claude Code sessions
  shared one project dir — e.g. dev'ing Covenant from inside Covenant.
  Whichever session wrote most recently won, so the new tab tailed a
  stale transcript and the cluster stayed empty. Replaced the one-shot
  pick with a discovery loop: snapshot the dir at attach time, then
  poll up to 10s for a jsonl that's NEW or whose mtime advanced past
  the attach baseline. First match wins. Falls back to the old behavior
  if nothing fresh appears (preserves the single-cc case).

- **Vitals appear on the first `cc` response instead of needing a
  warm-up message** (`crates/app/src/exec_vitals.rs`). After discovery
  picked the right jsonl, the tail still seeked to EOF, so the very
  line whose append triggered detection was skipped — the cluster only
  populated on the *next* message round-trip. Now the discovery loop
  also captures each jsonl's byte size at attach time, and the tail
  starts there: new files tail from byte 0, mtime-advanced files tail
  from the snapshotted size. First response now lights up the cluster.

- **Vitals chip tooltips use Covenant's custom tooltip system instead
  of the native browser one** (`ui/src/status/vitals.ts`). Native
  `element.title = "..."` rendered as plain OS chrome (white box on
  macOS) over Covenant's dark glass aesthetic. Routed the five vitals
  chip tooltips through `attachTooltip` from `ui/src/tooltip/tooltip.ts`
  like the rest of the status bar.

## v0.7.1 — Per-tab vitals + Claude Code transcript tailer

### Added

- **Per-tab vitals scoping** (`crates/app/src/vitals.rs`,
  `crates/app/src/lib.rs`, `ui/src/main.ts`). The status-bar cluster
  was process-wide: any session's summariser / fix-proposer / triage
  call painted into the cluster regardless of which tab was active, so
  an empty plain-shell tab still showed live Sonnet 4.6 + 2s latency
  because another tab was mid-summary. Each `VitalsEvent` now carries
  a `SessionId`; the aggregator keeps a per-session bucket map plus an
  `active` field set by the frontend on every tab activation via the
  new `set_active_session_for_vitals` command. `vitals_update` only
  emits for the active session.
- **Claude Code transcript tailer** (`crates/app/src/exec_vitals.rs`).
  New module that tails `~/.claude/projects/<slug>/<sid>.jsonl` per
  session whenever the foreground executor is `claude`. Each
  `assistant` turn with non-zero usage feeds `record_complete` on the
  shared `VitalsHandle`, with latency derived from the preceding
  `user` line's timestamp (clamped to [50ms, 600s]). Polls every 1s,
  seeks to EOF on attach (no history replay), reattaches on
  `CwdChanged`. Hand-rolled ISO-8601 parser avoids pulling chrono.
- **Spawns: clickable flag chips in Settings**
  (`ui/src/settings/spawns.ts`, `ui/src/spawns/styles.css`). Each
  preset row now renders its flags / subcommands as monospace pill
  chips below the inputs; clicking one appends it to the args field
  and selects any placeholder (`<prompt>`, `<id>`, `<path>`) so the
  user can type over it immediately.
- **Project-notes titlebar button** (`ui/src/main.ts`,
  `ui/index.html`). New affordance in the titlebar to open the
  per-project notes panel without going through the command menu.

### Changed

- **Refreshed modal-footer button styling** (`ui/src/styles.css`).
  Cancel / Save / Set mission pairs in Settings, Mission viewer, and
  Mission page now share a unified treatment — pill shape, tinted
  gradient with inset highlight + colored halo on primary, subtle
  ghost on secondary, proper pressed state, accent focus ring, and a
  legible (translucent-tint vs. opacity:0.4) disabled state.
- **Update banner padding** (`ui/src/styles.css`). Pad the in-app
  updater banner 84px from the left so it clears macOS traffic lights
  instead of slipping under them.
- **Sidebar fold-button icons** (`ui/src/icons/index.ts`,
  `ui/src/main.ts`). Swap the static fold buttons for `panel-left /
  right open / close` icons that reflect the current collapsed state.

### Fixed

- **UTF-8 boundary panic in `truncate_for_persist`**
  (`crates/app/src/lib.rs`). `&s[..64*1024]` panicked in
  `slice_error_fail` whenever byte 65536 landed inside a multi-byte
  char (emoji, accented, CJK in agent output), aborting the tokio
  worker → SIGABRT. Walk back to the nearest char boundary before
  slicing. Same class as the earlier `truncate_for_log` fix that was
  missed in `lib.rs`.
- **Busy pulse dot on executor / pi tabs**
  (`ui/src/tabs/manager.ts`). The dot duplicated information already
  conveyed by the executor chip; suppress it on those tab kinds.

## v0.7.0 — Live LLM vitals in the status bar

### Added

- **Status bar center-zone vitals** — sparkline of tokens/min, cache-hit %, current model (`Sonnet 4.6`), and last-call latency now live to the left of the executor chip. Aggregates every Anthropic call Covenant makes (operator, summarizer, fix proposer, cross-session). Fades out after 60s of inactivity so the bar stays calm when you aren't running the agent.

## v0.6.4 — CI lockfile sync (reissues v0.6.3)

### Fixed

- **Release pipeline: sync `package-lock.json` with `@xterm/addon-search`**
  (`package-lock.json`). v0.6.3's macOS and Windows release workflows both
  failed at `npm ci` because `@xterm/addon-search@0.16.0` (added for the
  ⌘F finder) was listed in `package.json` but missing from the lockfile.
  Regenerated the lockfile and removed a stray empty
  `ui/package-lock.json` created by running npm inside the `ui/`
  subdirectory. v0.6.4 reissues the v0.6.3 feature set with working
  release artifacts.

## v0.6.3 — Spawns executor catalog + ⌘F find + custom tooltips

### Added

- **Spawns: titlebar executor catalog with backend store + CRUD**
  (`crates/app/src/spawns_store.rs`, `crates/app/src/spawns_commands.rs`,
  `ui/src/spawns/chip.ts`, `ui/src/spawns/api.ts`, `ui/src/spawns/styles.css`,
  `ui/src/settings/spawns.ts`). New SpawnSpec store persists user-defined
  executor presets (id, label, command, model). Titlebar chip + popover
  lets the user pick a spawn and bind it to the active tab; Settings →
  Spawns adds a full CRUD tab. Brand-tinted dots and glow accents per
  executor (Claude, Codex, Copilot, opencode, Pi, Gemini, Ollama) so the
  chip reads at a glance.

- **Per-tab spawn binding deploys on the active PTY**
  (`ui/src/tabs/manager.ts`, `ui/src/main.ts`): selecting a spawn from
  the chip injects the bound command into the active session, so the
  catalog becomes the launcher for everything Covenant can drive.

- **⌘F in-terminal find overlay** (`ui/src/terminal/finder.ts`,
  `ui/src/tabs/manager.ts`, `ui/src/main.ts`, `ui/src/shortcuts/registry.ts`):
  Apple Terminal-style floating finder pinned to the active tab pane,
  backed by `@xterm/addon-search`. Highlights every match, shows live
  `n / total` counter, Enter / ⇧⏎ for next/prev, Esc to close.
  Pre-populates from the current xterm selection if any.

- **Custom tooltip system** (`ui/src/tooltip/tooltip.ts`,
  `ui/src/styles.css`): replaces native browser tooltips on chrome
  elements with a singleton Linear-style flat dark card (`#0e0e10` /
  `#2a2a2e` border, 350ms open delay, edge-aware positioning).
  Supports structured content (title / subtitle / meta / preview /
  hint / kbd). Wired across all status-bar segments, mission viewer
  buttons, and the Covenant Score heatmap cells — the mission tooltip
  is the showcase with monospaced path + tasks-done meta + clamped
  content preview + action hint.

### Changed

- **Status bar / notch / context-menu polish** (`crates/app/src/notch.rs`,
  `ui/notch/styles.css`, `ui/src/status/bar.ts`, `ui/src/menu/context-menu.ts`,
  `ui/src/score/page.ts`, `ui/src/score/styles.css`, `ui/src/tabs/manager.ts`):
  notch repositioning tweaks, status-bar zone spacing refinements,
  context-menu polish, and Covenant Score chip cleanup. Also bundles
  three new design HTML explorations under `design/` (executor rail
  variants, notch pill variants, status bar preview).

### Fixed

- **Spawns chip robustness** (`crates/app/src/spawns_store.rs`,
  `crates/app/src/spawns_commands.rs`, `ui/src/spawns/chip.ts`):
  escape user-controlled HTML in chip rendering, propagate Mutex
  errors out of the store instead of poisoning silently, and refresh
  the chip list every time the popover opens so manual edits in
  Settings land without restart.

## v0.6.2 — Notch phase icons + Covenant Score polish

### Added

- **Premium SVG phase icons in the notch** (`ui/notch/pill.ts`,
  `ui/notch/styles.css`, `design/notch-icons-preview.html`): replaced
  pulse-dot indicators with six motion-distinct SVGs — orbital dots
  (thinking), sweep (reading), caret+ink trail (writing), chevrons
  (running), halo pulse (waiting), and a draw-on check with glow
  (done). Pill gets a real glass treatment: gradient backdrop, inner
  highlight stroke, saturated blur, spring easing on transitions.

### Changed

- **Sticky active phase in the notch hub** (`crates/app/src/notch.rs`):
  hold Writing/Reading/Running on screen for 2s before letting the
  detector flap back to Thinking. Claude Code routinely flashes a
  tool-call line for one frame and snaps the spinner back ~50ms later,
  which made the pill stutter Writing→Thinking→Writing too fast to
  read. The tool-call is the meaningful signal; the spinner that
  follows is noise.
- **Covenant Score recent-sessions list polish**
  (`ui/src/score/breakdowns.ts`, `ui/src/score/styles.css`): repo and
  group names rendered uppercase, group moved to its own meta line as
  a pill so long names don't push metric columns out of alignment,
  branch in monospace, tabular-nums on the metric cells so digits line
  up cleanly across rows.

### Fixed

- **Activity heatmap no longer scrolls horizontally**
  (`ui/src/score/styles.css`): switched to a fluid 53×7 grid with
  `aspect-ratio: 53/7` and `overflow: hidden`, so the full 12 months
  always fits the card width. Legend cells get a fixed 11px override
  so they don't stretch with the grid.
- **Notch top-corner clearance below the custom titlebar**
  (`crates/app/src/notch.rs`): bumped `pad_y` from 40→72 for the top
  corners so the pill sits well clear of the 38px titlebar and its
  window-control icons. Bottom corners unchanged.
- **Editor preview fills pane when blocks sidebar is globally hidden**
  (`ui/src/styles.css`): the editor-host overlay's `right` offset
  tracked the blocks sidebar width, but `body.blocks-globally-collapsed`
  hides the rail entirely without resetting that offset — the terminal
  bled through a 240px strip on the right. Pinned `right: 0` in that
  case, and capped `.structure-preview-md` to a 820px readable column.
- **Dedupe agent-idle notifications with 10m cooldown**
  (`crates/app/src/executor_idle.rs`): spinners in agent TUIs briefly
  break PTY quiescence, producing an Idle→Resumed→Idle cycle every few
  seconds. The dispatcher now tracks the last-notified instant per
  session and suppresses repeat `AgentIdleWaiting` events within a
  10-minute window. Cooldown clears on `AgentResumed` or `Closed`.

## v0.6.1 — Custom macOS titlebar + notch & settings polish

### Added

- **Custom macOS title bar with sidebar toggles** (`crates/app/tauri.conf.json`,
  `crates/app/capabilities/default.json`, `ui/index.html`, `ui/src/main.ts`,
  `ui/src/styles.css`, `ui/src/tabs/manager.ts`, `ui/src/blocks/manager.ts`,
  `ui/src/icons/index.ts`): replaced the native title bar with a 38px overlay
  bar in sidebar color. Left side hosts the panel-toggle + collapse-all
  buttons (LM Studio panel-toggle icons); the centre carries the COVENANT
  brand; the right side holds the Blocks/Files switcher and a panel-right
  toggle that collapses the right sidebar globally via
  `body.blocks-globally-collapsed`. Window drag goes through
  `getCurrentWindow().startDragging()` on mousedown, dblclick toggles
  maximize, and the layout drops the 84px traffic-light gutter when macOS
  hides the lights (`body.app-fullscreen`). The in-sidebar BLOCKS/FILES tab
  row and inner BLOCKS label are gone — both moved into the title bar.

### Changed

- **Hide Familiars surface across the app** (`ui/src/main.ts`,
  `ui/src/settings/panel.ts`, `ui/src/settings/tabs.ts`,
  `ui/src/shortcuts/registry.ts`, `ui/src/docs/panel.ts`,
  `ui/src/docs/content/familiars.ts`): the Familiars feature is hidden from
  Settings (nav + section), shortcuts (⌘⇧L), docs, status bar, and the panel
  mount while we focus on Operators. Backend code is untouched. Dead doc file
  and the orphaned `"familiars-host"` mapping were also removed so
  `tsc --noEmit` is clean again.

- **Drafts → spec-chat for new specs** (`ui/src/main.ts`): the "+ New spec
  (AI-assisted)" entry in project notes now opens the spec-chat flow directly
  instead of the form wizard.

- **Softer done chime** (`ui/src/main.ts`, `docs/mockups/done-sounds.html`):
  replaced the descending B5→E5 sine bell — which read as creepy in actual
  use — with a soft 880 Hz pop. Mockup HTML retained for future iteration.

- **Settings save bar pins to bottom** (`ui/src/styles.css`): `.settings-form`
  is a flex column with `margin-top: auto` on `.settings-actions`, so
  Save/Cancel always sits at the bottom of the form viewport even when the
  content is short.

### Fixed

- **Operator escalations with "anthropic api key is empty"**
  (`crates/agent/src/provider/anthropic.rs`): `AnthropicProvider` was reading
  the key exclusively from `req.api_key` and erroring with `MissingKey` when
  it was empty. All resolver-driven call sites — operator triage and
  decision, familiar commands routed through `provider_resolve`, etc. —
  leave `req.api_key` empty on purpose and expect the provider, instantiated
  with a `ProviderConfig` that already carries the key from settings, to
  supply it. Result: the operator escalated every action no matter how many
  times the user saved their key. Honor `req.api_key` when non-empty
  (legacy direct callers in `crates/app/src/lib.rs:2014`) and fall back to
  `self.config.api_key` otherwise.

- **Notch pill flicker on PTY output** (`ui/notch/store.ts`,
  `ui/notch/render.ts`): two compounding causes. `store.apply()` emitted on
  every PTY `OutputChunk` even when only `lastEventAt` changed, and
  `mountRender` replaced `stack.innerHTML` on every emit — tearing down each
  pill element and restarting the `slideIn` entry animation plus the `pulse`
  loader mid-cycle. Skip the emit when phase + tab metadata are identical,
  and replace the wipe-and-rebuild render with a keyed reconciler that
  reuses pill nodes across updates and patches inner DOM only on phase or
  meta changes.

- **Covenant Score widget missing in Settings → Covenant**
  (`ui/src/settings/panel.ts`, `ui/src/main.ts`): the Score panel was only
  mounted by the statusbar pill click handler in `main.ts`. Opening
  Settings normally and clicking the "Covenant" nav item just showed the
  section header with an empty `#covenant-page-root` underneath. Mount is
  now owned by `SettingsPanel`: `mountCovenantOnce()` fires when the
  Covenant tab is activated (initial tab or nav click) and resets on close
  so the next open re-mounts against the freshly rebuilt DOM.

- **Activity heatmap overflowing as a single row** (`ui/src/score/styles.css`):
  the 12-month grid declared 53 explicit columns and `grid-auto-flow: column`
  but never constrained rows, so column-flow had no row ceiling and every
  cell ended up on row 1, overflowing horizontally. Flipped the template to
  7 explicit rows + auto-columns for a GitHub-style 7×53 contributions grid,
  with `justify-content: start` to keep natural width and `overflow-x: auto`
  as a narrow-viewport safety net.

- **GitHub device-flow signin button** (`ui/src/score/signin.ts`):
  `window.open` is a no-op inside the Tauri webview, so the device-flow
  authorize button silently did nothing. Switched to
  `@tauri-apps/plugin-opener` `openUrl` which routes through the system
  browser as expected.

## v0.6.0 — Covenant Score v2: per-repo/branch tracking + Settings page

### Added

- **Context-aware prompt + commit tracking** (`crates/score/src/context.rs`,
  `crates/score/src/types.rs`, `crates/score/src/lib.rs`,
  `crates/score/src/store.rs`, `crates/app/src/score_commands.rs`,
  `ui/src/tabs/manager.ts`): every prompt and commit is now attributed
  to its `(repo, branch, group_name)` automatically. A new
  `ContextResolver` with a 5-second LRU shells out to `git rev-parse`
  / `git branch --show-current` (or `detached:<sha7>` on a detached
  HEAD) and caches per session. The active tab's `(sessionId, cwd,
  groupName)` is pushed into karl-score via a `score_set_current_session`
  Tauri command on every tab focus and cwd change, so the recorder
  always has fresh context. `commit_scanner` attributes commits to
  the branch they were made on.

- **Covenant Score Settings page** (`ui/src/score/page.ts`,
  `ui/src/score/breakdowns.ts`, `ui/src/score/styles.css`,
  `ui/src/score/chip.ts`, `ui/src/status/bar.ts`, `ui/src/main.ts`):
  the chip-modal is gone. The status-bar chip now opens
  `Settings → Covenant`, a full page with filter chips (time range
  cyclable through all/30d/7d, plus repo/branch/group/day),
  4 stat cards, the 53-week heatmap (click a cell → filter by day),
  per-repo stacked bars (click to drill in), top-branches list
  inside the selected repo, per-group bars, a recent-sessions feed,
  and a sync card.

- **Tauri commands for filtered + breakdown queries**
  (`crates/app/src/score_commands.rs`): six new commands —
  `score_summary_filtered`, `score_heatmap_filtered`,
  `score_breakdown_repos`, `score_breakdown_branches`,
  `score_breakdown_groups`, `score_recent_sessions` — back the new
  UI. All accept a `ScoreFilter { range, repo?, branch?, group?, day? }`.

- **Local SQLite v2 migration** (`crates/score/src/store.rs`):
  `score_events` gains nullable `repo`, `branch`, `group_name`
  columns plus supporting indexes, gated by `PRAGMA user_version`
  so it's idempotent on reopen. Historical rows keep working with
  NULL context — no backfill.

- **Server-side context columns + breakdown endpoints**
  (covenant-server: `migrations/0002_context.sql`, `src/sync.rs`,
  `src/breakdown.rs`): Postgres `score_events` mirrors the new
  columns. `/sync/events` accepts optional `repo`/`branch`/`group_name`
  per event (`#[serde(default)]` keeps old clients working). Four new
  authenticated GETs ship behind the `/api/` namespace:
  `breakdown/repos`, `breakdown/branches?repo=…`, `breakdown/groups`,
  `sessions/recent?limit=…`. Recent-sessions uses a window-function
  CTE to bucket events into sessions on a strict `>15-min` gap per
  `(repo, branch)`.

- **Session-pushed context on sync** (`crates/score/src/sync.rs`,
  `crates/score/src/store.rs`): the local→server uploader now
  reads the three new columns out of `unsynced_events` and
  serializes them on each `PushEvent` (skipped when None for a
  clean wire format).

### Changed

- **Settings panel tabbed** (`ui/src/settings/panel.ts`,
  `ui/src/settings/tabs.ts`): the long scrolling settings page is
  now mutually-exclusive tabs. A single `activateTab(root, tab)`
  helper drives section visibility from the sidebar nav, and
  `SettingsPanel.open(tab?)` accepts an optional initial tab so the
  Covenant chip and the Telegram pill can route to the right view.
  The previous `IntersectionObserver`-based scroll tracking is gone.

### Fixed

- **Trim pasted API keys** (`ui/src/settings/providers.ts`):
  pasted Anthropic keys often pick up trailing whitespace which the
  API rejects without a clear error. The provider card's API-key
  input now `.trim()`s on every keystroke.

- **Session boundary aligned with server** (`crates/score/src/store.rs`,
  `crates/score/tests/breakdown.rs`): client `recent_sessions`
  previously bucketed on `>= 900000 ms` while the server used `>`.
  Aligned both to strict `>` so events spaced exactly 15 min apart
  belong to the same session. Test gap bumped from 16 → 17 min.

## v0.5.28 — Notch settings: corner + chime + fullscreen-aware rack

### Added

- **Notch corner setting** (`crates/app/src/settings.rs`,
  `crates/app/src/notch.rs`, `ui/src/settings/panel.ts`,
  `ui/notch/styles.css`): new `notch_corner` setting picks where the
  floating overlay anchors (bottom-right default, plus BL/TR/TL). The
  overlay repositions live when changed; the stack CSS flips
  alignment to match. Surfaced as a dropdown in the settings panel.

- **Group prefix on pill labels** (`ui/src/tabs/manager.ts`,
  `ui/src/api.ts`, `crates/app/src/lib.rs`): the pill's tabchip now
  reads `GROUP › tab` instead of just `tab`, via a new
  `notch_set_label` Tauri command. AOM session-name slugs still use
  the bare title — only the notch display is prefixed.

- **Done chime + per-turn dedupe** (`crates/app/src/notch.rs`,
  `ui/notch/main.ts`, `crates/app/src/settings.rs`): a short
  synthesized bell plays when an executor finishes a turn. Backend
  tracks `done_emitted` per session so successive OSC 133;D markers
  inside the same turn never re-fire it. New `notch_sound_on_done`
  setting toggle.

- **Fullscreen-aware inline rack** (`crates/app/src/lib.rs`,
  `ui/src/inline-notch.ts`, `ui/src/main.ts`): when the main Covenant
  window enters fullscreen, the OS-level overlay is suppressed and
  pills render inline in the status-bar host instead. Avoids the
  floating overlay covering terminal content. Restores automatically
  on exit.

### Changed

- **Sidebar idle-agent indicator** (`ui/src/styles.css`, sidebar
  components): the per-tab idle dot is now a left-edge stripe that
  matches the active-tab indicator style, for visual consistency.

- **Tabs cleanup** (`ui/src/tabs/manager.ts`): removed dead
  `setColor` method (was unreferenced; tripped TS6133).

- **Covenant Score v2 spec** (`docs/superpowers/specs/`): design
  notes for context-aware tracking + dedicated Settings page.

## v0.5.27 — Fix release build (unused TS constants)

### Fixed

- **TS strict-mode build** (`ui/notch/store.ts`): removed unused
  `STABLE_MS` / `COMPACT_THRESHOLD` constants that broke the
  release-macos / release-windows workflows for v0.5.26.

## v0.5.26 — Notch detection rewrite + drafts in project notes

### Added

- **Settings toggle for the notch** (`crates/app/src/settings.rs`,
  `crates/app/src/notch.rs`, `ui/src/settings/panel.ts`): new
  `notch_enabled` boolean (default `true`) gates the entire feature.
  `NotchHub::ingest` now bails on an atomic load when disabled — zero
  overhead. Flipping the toggle off at runtime emits `Idle` for every
  active session so existing pills clear immediately. UI checkbox lives
  in Settings → Display alongside the status-bar toggle.
- **Drafts tab in ProjectNotesPanel** (`ui/src/project-notes/`,
  `ui/src/main.ts`): drafts are now scoped per group and live inside
  ProjectNotesPanel instead of the old standalone DraftsPanel. ⌘⇧D
  retargeted to open the drafts tab. New `groupRootDirFor()` accessor
  on TabManager and `activeGroup()` now returns `rootDir` so the tab
  can resolve the right path. Cross-window `draft:saved` Tauri event
  triggers toast + refresh.
- **`[dev]` indicator in status bar** (`ui/src/status/bar.ts`,
  `ui/src/styles.css`): the version chip renders as `v0.5.26 [dev]`
  with an amber tint when `import.meta.env.DEV` is true, so it's
  unambiguous which build is in focus during development.

### Changed

- **Notch phase detection rewritten** (`crates/blocks/src/executor_phase.rs`):
  matches Claude Code v2.1 output. New patterns for tool-call forms
  (`⏺ Bash/Task/Agent/Explore/WebFetch/WebSearch(...)` → Running;
  `⏺ Read/Grep/Glob/LS(...)` → Reading; `⏺ Update/Write/Create/Edit/
  MultiEdit/NotebookEdit(...)` → Writing) plus collapsed-summary headers
  (`Read N file`, `Listing N directories`, `Listed N directories`,
  `Searching`). Thinking is now whitelist-only — gerund + ellipsis +
  duration (`Hyperspacing… (3s · …)`) — so plain output no longer
  promotes the detector to Thinking. Past-tense `<Verb>ed for Ns`
  (`Cooked for 7s`, `Worked for 10s`, `Brewed for 3s`) routes to Done
  instead of Thinking. All captured targets pass through
  `clamp_target(60)` so cursor-redrawn chunks without newlines can't
  smear an entire status screen into one pill.
- **Notch stale-clear** (`crates/app/src/notch.rs`): if the detector
  stays in the same Running/Reading/Writing/Thinking phase for >8s
  without any transition, the hub now emits `Idle` automatically. CC's
  status-bar redraw loop no longer leaves pills stuck on "Reading 1
  file…" after the agent has finished.
- **Notch pills always expanded** (`ui/notch/store.ts`): the compact-mode
  shrink animation read as a glitch in actual use, so `recomputeCompact`
  now leaves every pill `expanded`. Constants remain for future use.
- **DraftsPanel trimmed to wizard-only** (`ui/src/drafts/`): the standalone
  drafts list and its sidebar nav button were removed; the wizard remains
  the entry point for drafting from anywhere. Listing is owned by the
  new project-notes tab.

### Fixed

- **Notch shadow / oversized empty pill** (`ui/notch/styles.css`,
  `ui/notch/main.ts`): removed the heavy box-shadows on both pill
  variants. `Idle` and `Thinking` events from the backend no longer
  spawn empty pills — `Idle` triggers `store.drop(sid)` so a previous
  tool-call pill clears the moment the agent quits.
- **Context menu flipped to left of cursor at right edge**
  (`ui/src/menu/context-menu.ts`): measure the menu off-screen first,
  then flip horizontally when opening near the right edge so options
  no longer get clipped by the window border.

## v0.5.25 — Fix notch main-thread crash on launch

### Fixed

- **Notch AppKit calls from tokio worker** (`crates/app/src/notch.rs`):
  v0.5.24 switched the spawner to `tauri::async_runtime::spawn` but that
  still runs on a tokio worker thread. The bridge then called
  `setCollectionBehavior` / `show` / `position_bottom_right` directly on
  the `NSWindow`, hitting AppKit's main-thread assertion and triggering
  `EXC_BREAKPOINT` (`Must only be used from the main thread`) during the
  first `ExecutorStateChanged` event. Wrapped the show/position/collection-
  behavior block in `win.run_on_main_thread(...)` so all AppKit calls
  marshal back to the main thread.

## v0.5.24 — Fix notch startup panic

### Fixed

- **Notch bridge startup panic** (`crates/app/src/notch.rs`):
  `spawn_bridge` called `tokio::spawn` from Tauri's synchronous `setup`
  closure, where no Tokio reactor is active. On launch the app aborted
  with *"there is no reactor running, must be called from the context
  of a Tokio 1.x runtime"* (visible in `~/.karlTerminal/crash.log`),
  triggering SIGABRT during `did_finish_launching`. Switched to
  `tauri::async_runtime::spawn`, matching every other background task
  spawned from `setup` in `lib.rs`.

## v0.5.23 — Notch executor status overlay

### Added

- **Notch overlay** (`crates/blocks/src/executor_phase.rs`,
  `crates/app/src/notch.rs`, `ui/notch/*`): floating, always-on-top,
  transparent Tauri window that shows one Whirr-style pill per active
  executor agent. Each pill displays the agent's current phase
  (Thinking, Running, Writing, Reading, Waiting, Done) plus an optional
  target (file path or command), with a per-phase animated loader and a
  tab-coloured accent bar. State is detected heuristically from the
  executor PTY stream (`ExecutorPhaseDetector`) and fanned out as
  `SessionEvent::ExecutorStateChanged`. The stack auto-collapses pills
  to a compact form when there are 4+ active or a state lingers >5s;
  `Waiting` stays expanded. Click-through everywhere except over the
  pills; ⌘⇧N toggles visibility. Cross-space on macOS.

## v0.5.21 — UTF-8 crash fix + local LLM providers + Pi RPC

### Added

- **Local LLM providers (Phase 1)** (`crates/agent/src/providers/*`,
  `crates/app/src/settings.rs`, `ui/src/settings/providers.ts`): Summary,
  Chat, and Triage roles can now route to any OpenAI-compatible local
  runtime (Ollama, LM Studio, llama.cpp `server`, vLLM). New `LlmProvider`
  trait abstracts Anthropic and OpenAI-compatible backends; settings
  expose a Providers tab (add/test/delete), per-role model dropdowns, and
  per-route connectivity badges (reachable / unreachable / model-found).
  Tauri commands cover provider catalogue + Ollama probing.
  `provider_resolve` routes summarizer, drafts, cross-session, fix
  proposer, and operator decision/triage calls through the trait.
  Operator role keeps Anthropic as default; routing it to a local
  provider degrades to SuggestOnly until tool-use translation lands in
  Phase 2. Legacy `anthropic_api_key` migrates automatically into the
  providers map on first launch.

- **Pi RPC executor (PI-0…PI-9)** (`crates/agent/src/pi/*`,
  `ui/src/pi/*`, `crates/app/src/lib.rs`): Pi is now a first-class
  `TabKind` with a byte-exact JSONL framer, persistent session manifest,
  streaming chat view, tool execution + thinking + queue + steer /
  follow-up, capabilities adapter with UI filter pill, extension UI
  dialogs (select + confirm), and a `PiPanel` overlay bound to ⌘⌥P.

- **Headphones operator glyph** (`ui/src/icons/index.ts`,
  `ui/src/status/bar.ts`, `ui/src/tabs/manager.ts`): switchboard-operator
  metaphor replaces the robot icon in status-bar operator chips, the
  Set/Remove-operator tab context-menu entries, and AOM dry-run / live
  indicators. The old `Icons.bot` glyph stays for back-compat.

### Changed

- **Shortcut cleanup** (`ui/src/keymap.ts`, docs): removed unused ⌘⇧V
  (Release log), ⌘⇧R (AOM morning report), and ⌘⇧E (per-tab AOM toggle),
  and scrubbed stale references throughout the codebase.

- **Mission chip context menu** (`ui/src/status/bar.ts`): right-click on
  the mission status-bar chip now opens an edit/remove menu.

- **AGENTS.md contributor guide** (`AGENTS.md`): repo-level overview of
  structure, build/test commands, coding style, and PR conventions.

### Fixed

- **UTF-8 boundary panic in notification logging**
  (`crates/app/src/notify.rs`): `truncate_for_log` did `s[..200]`, which
  panicked when byte 200 landed inside a multi-byte UTF-8 character
  (emoji or accented chars in a notification body). The panicking tokio
  worker aborted the process and SIGABRT-crashed the whole app — this is
  the cause of the spontaneous Covenant crashes reported on 0.5.20. Fix
  walks back to the nearest char boundary before slicing; regression
  test covers an emoji straddling byte 200.

- **Scrollback replay trims tail to last OSC 133;D marker**
  (`crates/app/src/scrollback.rs`): prevents partial command output
  from being replayed past the last completed command boundary.

- **Settings UI hardening** (`ui/src/settings/providers.ts`,
  `ui/src/settings/forms.ts`): replaced `prompt()` / `confirm()` (Tauri
  webview blocks them) with an inline form; marked the **+ Add provider**
  button as `type="button"` so it no longer submits the surrounding form;
  removed duplicate Anthropic section and restyled providers/models
  panels; offline indicator now lives inline in the status bar with the
  Claude chip dimmed and tagged "no internet".

## v0.5.20 — Restore Covenant boot splash + workspace popover anchor

### Fixed

- **Covenant boot splash restored (`ui/index.html`, `ui/src/boot-splash.ts`,
  `ui/src/styles.css`, `ui/src/main.ts`)**: v0.5.18/.19 removed the branded
  orb splash along with the unwanted workspace-switch loader, but only the
  loader was meant to go. The boot splash (orb + "COVENANT" wordmark +
  "BOOTING…" meta) now paints on the first frame again via inline styles in
  `index.html`, and `dismissBootSplash()` fades it out after `boot()`
  resolves. The workspace-switch loader stays suppressed on initial
  hydration via the `silent` flag on `replaceFromManifest`.

- **Workspace switcher popover anchored mid-screen**: `openPopover` in
  `ui/src/workspaces/switcher.ts` positioned the popover with
  `bottom: innerHeight - rect.top` against the chip, but the sticky
  `#tabbar-actions` container (with `backdrop-filter`) promoted the chip's
  containing block — so `position: fixed` resolved against the wrong origin
  and the popover floated mid-screen instead of just above the chip. Now
  we render the popover off-screen, measure its actual height, and anchor
  `top` deterministically so it sits 4px above the chip in all layouts.

## v0.5.19 — Filename fuzzy finder in ⌘⇧F + boot polish

### Added

- **Filename mode in the search palette (`ui/src/search/palette.ts`)**:
  ⌘⇧F now toggles between *content* (grep, the existing behavior) and
  *files* (fuzzy filename) modes via **Tab**. A mode chip in the header
  shows which is active and the placeholder swaps to match. The new
  backend command `structure_find_files` (`crates/app/src/structure.rs`,
  `crates/app/src/lib.rs`) reuses the same `.gitignore`-honoring walker
  as `structure_search`; scoring boosts basename hits, contiguous-run
  matches, and basename-start anchors, while penalizing long paths so
  short relative paths win on ties. Frontend wrapper `structureFindFiles`
  added in `ui/src/api.ts`.

### Fixed

- **Boot loader flashed on first launch**: `replaceFromManifest` in
  `ui/src/tabs/manager.ts` unconditionally added the
  `body.workspace-switching` class while restoring tabs, which painted
  the spinner+"Switching workspace…" overlay during initial hydration.
  The overlay is meant for explicit user-driven workspace swaps; first
  boot now passes `{ silent: true }` from `ui/src/workspaces/manager.ts`
  so the loader is skipped. Real switches (`switchTo`, `importIntoActive`)
  keep the existing UX.
- **"What's new" modal dismissed itself on boot**: `manager.onTabActivated`
  in `ui/src/main.ts` called `release.close()` alongside the other
  fullscreen-panel teardowns. During app launch, tab restoration fires
  `onTabActivated` for the first restored tab, which closed the release
  modal the moment it appeared — users saw the loader flash, the modal
  flash, then everything vanish. The release modal is centered (not a
  page), so it's been removed from the auto-dismiss set; close via ×,
  ESC, or backdrop click.

## v0.5.18 — Boot splash cleanup + editor autocomplete

### Fixed

- **Release build (TS2304 on `dismissBootSplash`)**: v0.5.17 removed the
  `#boot-splash` overlay from `ui/index.html` and the `dismissBootSplash`
  import, but left an orphan call in `ui/src/main.ts:1199`. The frontend
  `tsc` step in both `Release macOS` and `Release Windows` failed
  before `vite build` could run, so no v0.5.17 artifacts were ever
  published. Drop the call (and the now-dead `ui/src/boot-splash.ts`
  module) so the release workflow type-checks.

### Added

- **Structure editor: language-aware autocomplete + bracket closing**.
  CodeMirror `@codemirror/autocomplete` is wired into `StructureEditor`
  with `activateOnTyping`, `closeOnBlur`, and bracket auto-close. Uses
  the existing per-language packs (rust/ts/py/json/css/html/sql/yaml/
  md) plus buffer-word fallback. No network calls. Ctrl-Space opens
  the popup manually; Tab/Enter accepts.

## v0.5.17 — Per-tab scrollback persistence + zoom/idle fixes

### Added

- **Per-tab scrollback persistence**: every tab now keeps a stable
  `replayKey` in the tab manifest and the backend appends PTY bytes to
  `<data_dir>/scrollback/<key>.log` (capped at 2 MiB, trimmed from the
  front on reopen). On tab spawn the UI calls `replay_scrollback` and
  writes the tail into xterm **before** the live channel attaches, so
  closed-and-reopened tabs come back with their previous output. Logs
  are deleted on explicit tab close; workspace switches preserve them.
  New module `crates/app/src/scrollback.rs`; Tauri commands
  `replay_scrollback` and `delete_scrollback`; manifest field
  `replay_key` (optional, backward-compatible).

### Changed

- **Zoom rescales xterm cell metrics, not CSS**: ⌘+/⌘-/⌘0 used to refit
  on top of a `zoom`-transformed terminal host, which left xterm's
  pointer→cell coords out of sync with the rendered grid (clicks/
  selections landed in the wrong cell). The terminal subtree now
  counter-zooms (`zoom: calc(1 / var(--ui-zoom, 1))` on `.tab-terminal`)
  and `buildTerminalOptions` / `applyTerminalSettings` multiply the
  configured `fontSize` by `zoom.level()` instead. Zoom changes run the
  full `applyTerminalSettings` pipeline (font, atlas rebuild, fit,
  PTY resize) for every open tab.
- **"Move to group" collapses into a submenu**: the tab context menu
  used to render one `Move to "<name>"` row per group, blowing up the
  top level as workspaces grew. Now a single `Move to group…` entry
  opens a submenu listing every other group.
- **Boot splash removed**: the inline `#boot-splash` overlay and its
  `dismissBootSplash()` hook were dropped from `ui/index.html` and
  `ui/src/main.ts` — first paint now goes directly to the workspace.

### Fixed

- **Claude Code idle detection**: Claude Code v2.1+ overwrites its own
  kernel `p_comm` with its version string (e.g. `2.1.143`), so
  `libproc::name()` returned the version and the idle pump never
  matched `KNOWN_AGENTS`. `crates/pty/src/fg_proc.rs` now falls back
  to argv-based logical lookup whenever comm isn't a known CLI (not
  only for `node`/`python`). `crates/session/src/idle.rs` adds an
  `INLINE_AGENTS` set for CLIs that render without alt-screen
  (`claude`, `codex`), bypasses the alt-screen gate for them while
  still requiring a prompt-text match, scans the full screen in
  `match_prompt`, and adds patterns for `> `, `bypass permissions on`,
  `for agents`, `shift+tab to cycle`, `commands · ? help`.

## v0.5.16 — Windows build fix (karl-* dep scoping)

### Fixed

- **Windows release build**: workspace crate paths (`karl-pty`, `karl-blocks`,
  `karl-session`, `karl-agent`, `karl-familiar`, `karl-capabilities`) in
  `crates/app/Cargo.toml` were declared **after** the
  `[target.'cfg(unix)'.dependencies]` table, so TOML scoped them to
  unix-only targets. macOS built fine; Windows failed with 98
  `E0433 unresolved import` errors since v0.5.11. Moved the karl-* deps
  back into the main `[dependencies]` block and pushed `libc` to the end.

## v0.5.15 — Codex executor + workspace-switch polish

### Added

- **Codex as executor agent**: OpenAI Codex CLI joins Claude, Copilot, and
  opencode as a first-class agent. New adapter in
  `crates/capabilities/src/adapters/codex.rs` scans `~/.codex/config.toml`
  (`[mcp_servers]` tables via the `toml` crate), `~/.codex/prompts/*.md`
  (treated as slash commands), and AGENTS.md memory at user
  (`~/.codex/AGENTS.md`) and project (`<repo>/AGENTS.md`) scopes. A new
  `Tool::Codex` variant flows through `crates/capabilities/src/model.rs`,
  `scaffold.rs` (prompt + MCP snippet templates), and
  `crates/app/src/capabilities_commands.rs` (detect, aggregate,
  `parse_tool`, `scaffold_target`). The Capabilities panel
  (`ui/src/capabilities/panel.ts`) gains a Codex tool tab with Prompts,
  MCPs, and Memory sections; `ui/src/api.ts` extends `CapabilitiesDetect`
  and `CapabilityListItem["kind"]` with `codex` and `memory`. Pre-existing
  wiring (executor regex, brand icon, status-bar color, idle detection,
  `LOGICAL_CLIS`) was already in place from prior work and remained
  unchanged.

### Fixed

- **Workspace-switch polish**: the right sidebar no longer dances when
  switching workspaces — `.blocks-collapsed` and the pane hide are now
  pre-applied before the switch in `ui/src/tabs/manager.ts`. The
  `workspace-switching` class is removed synchronously after the switch
  to unblock clicks (previously a `requestAnimationFrame` could pause on
  window blur, causing the double-click bug). Tab-idle badge is reordered
  before the close button so the close affordance stays on the trailing
  edge. Companion CSS lives in `ui/src/styles.css`.

## v0.5.14 — Crash logger for release-only panics

### Fixed

- **Crash diagnostics**: release builds use `panic = "abort"` plus
  `strip = true`, so the two recent crashes observed when killing a
  PTY child with `Ctrl+C` left no panic message or symbols in the
  macOS `.ips` report. `install_crash_logger` in
  `crates/app/src/lib.rs` now sets a `std::panic::set_hook` that
  appends thread name, panic location, message, app version, and a
  forced `Backtrace` to `~/.karlTerminal/crash.log` before the
  default abort handler runs. The release profile in `Cargo.toml`
  switches `strip = true` → `strip = "none"` and adds
  `debug = "line-tables-only"` so the captured backtrace carries
  `file:line` for every Rust frame without inflating the bundle.

## v0.5.13 — Familiar side panel + Apply spec button

### Added

- **Familiar side panel** (replaces full-screen roster overlay): the
  Familiar chat now lives as a 380px-wide panel on the right side of
  the window, persistent and toggleable with `⌘⇧L` or the status-bar
  Familiar dot. The body has a tab strip — **Chat / Status / Audit** —
  so the rolling summary and directives audit log are one click away
  without losing the operator. The panel re-binds to whichever tab is
  active (per-workspace), shows an empty state when no Familiar is
  bound, and persists open/closed state plus active sub-tab across
  reloads (`ui/src/familiars/panel.ts`, `ui/index.html`,
  `ui/src/styles.css`).

- **Active-session tab event**: `TabManager` now emits
  `onActiveSessionChange(sessionId | null)` alongside
  `onActiveTabChange`, used by the Familiar panel to re-bind its
  chat/status/audit when the user switches tabs
  (`ui/src/tabs/manager.ts`).

- **"Apply spec" button in the structure editor**: when a markdown
  file under a `specs/` directory is open, the editor header surfaces
  an *Apply spec* button that attaches the file to the active tab as
  its mission, reusing the existing mission/operator wiring
  (`ui/src/structure/editor.ts`, `ui/src/tabs/manager.ts`,
  `ui/src/styles.css`).

### Changed

- **Body layout switches to flex**: with the Familiar panel as a real
  sibling of `#layout`, `body` becomes a horizontal flex row. The
  panel claims 380px when `body.familiar-panel-open` is set and is
  fully removed (`display:none`) otherwise — no ghost overlay, no
  translucency leaking the underlying UI (`ui/src/styles.css`).

- **`localStorage` polyfill for tests**: this project's jsdom ships an
  empty `localStorage` object without methods, which silently broke
  `project-notes/panel.test.ts` and blocked the new panel tests. A
  small in-memory `Storage` polyfill in `vitest.setup.ts` (wired via
  `vitest.config.ts`) restores the API so every suite using
  localStorage passes (`vitest.setup.ts`, `vitest.config.ts`).

- **Roster overlay removed**: deleted `ui/src/familiars/roster.ts` and
  `ui/src/familiars/list.ts` along with the `#familiars-roster`,
  `.roster-*`, `.familiar-row*`, `.familiar-name`, and
  `.familiar-session` rules. `.familiar-dot` is preserved — it's
  shared by the status-bar indicator (`ui/src/familiars/`,
  `ui/src/styles.css`).

## v0.5.12 — Resize + executor UX polish

### Fixed

- **Selection stays put on resize**: xterm's selection is now cleared
  before `fit()` reflows the grid, so the highlight rectangle no longer
  drifts to the wrong row when the window is resized.

- **Recall suppressed under agent executors**: the Recall sidebar
  (typed input) and the ⌘P command-history palette are both disabled
  while an agent CLI (claude / copilot / codex / opencode / …) owns
  the PTY. Their TUIs don't read shell history, so the popup was just
  noise. Any open Recall view is torn down the moment an executor is
  detected.

- **Pulse "app running" dot suppressed under agents**: agent CLIs
  routinely spawn dev-tool subprocesses (node / next / npm / …) that
  briefly own the PTY foreground and slipped past the Rust busy-proc
  allowlist, double-lighting the tab with both the executor chip and
  the pulse dot. The dot is now strictly for user-initiated dev tools;
  while an executor is active the chip is the single source of truth.

## v0.5.11 — Workspaces (top-level project containers)

### Added

- **Workspaces**: a new top-level layer above the existing Group → Tab
  hierarchy. Each workspace owns its own tabs, groups, and active-tab
  state; switching kills the outgoing PTYs and respawns the incoming
  workspace from its persisted manifest (cwd, mission, operator pin,
  color, custom name all preserved). Persisted on disk in a new
  `TabManifestV2` envelope that auto-migrates existing V1 manifests
  into a single "Default" workspace on first launch.

- **Switcher in the tabbar action row**: icon-only button next to
  `+ New tab` / `+ New group`, with `⌘⇧P` keyboard shortcut. Popover
  opens upward and lists workspaces with tab count + last-used time;
  `+ New workspace` auto-names "Workspace N" and switches immediately.
  Busy pulse on the chip + info toast (`Switching to X…`) give feedback
  during PTY respawn.

- **Per-workspace actions**: right-click any row in the popover for
  inline rename (Tauri's webview suppresses `window.prompt`, so renames
  happen via an inline `<input>`), duplicate, set color, **Set root
  dir…** (final-fallback cwd for new tabs, after `tab.cwd` and
  `group.rootDir`), and delete. Deleting the active workspace switches
  to the most-recently-used remaining one; deleting the last workspace
  is refused.

- **Move group to workspace…**: the group context menu now has a
  submenu listing every workspace except the current one. Picking a
  target moves the whole group (with its tabs and all per-tab
  metadata) into the destination workspace's persisted state; PTYs in
  the current workspace are killed. If moving the last tab leaves the
  source workspace empty, a fresh tab is spawned automatically.

### Fixed

- **Manifest flush on window close**: added the `beforeunload` listener
  that was always referenced in code comments but never wired up. The
  debounced 200 ms save no longer drops late edits (e.g. setting a
  group's root dir then immediately quitting).

## v0.5.10 — Busy dot allowlist + persist across tab rebuilds

### Fixed

- **Busy dot no longer fires for interactive CLIs**: `is_busy_proc` in
  `crates/session/src/lib.rs` switched from a shell blacklist to an
  explicit allowlist of dev servers and build tools (node, npm, pnpm,
  yarn, bun, deno, vite, next, nuxt, webpack, rollup, esbuild, tsc,
  python/uvicorn/gunicorn/flask/django/pytest, go/air, cargo/rustc/trunk,
  make/cmake/ninja/bazel/gradle/mvn, docker/kubectl). Interactive agents
  like `claude`, `copilot`, `opencode`, plus editors, git, and pagers
  no longer trigger the pulse dot.

- **Busy dot persists across tab strip rebuilds**: `renderTabPill` in
  `ui/src/tabs/manager.ts` now re-attaches the `.tab-busy-dot` element
  when `tab.busyProc` is set. Previously `renderTabbar` wiped
  `innerHTML` on every activation and the dot only came back on the
  next `foreground_changed` event — so clicking another tab silently
  dropped the indicator until the foreground process next changed.

## v0.5.9 — CI lockfile sync (v0.5.8 release fix)

### Fixed

- **CI lockfile drift**: v0.5.8 added xterm ligatures/canvas npm deps
  to `package.json` without updating `package-lock.json`, so the macOS
  and Windows release workflows both failed at `npm ci`. Lockfile
  re-synced so the v0.5.9 tag actually builds and publishes installers.

## v0.5.8 — Force-kill foreground tree (⌘⇧.) + tab busy indicator

### Added

- **Force-kill foreground tree (⌘⇧.)**: pressing ⌘⇧. on the active
  tab sends SIGTERM to the PTY's foreground process group and
  escalates to SIGKILL after 500ms. Fixes the common case where
  Ctrl+C is swallowed by a parent process (`npm run dev`, `docker`,
  watchers) that doesn't propagate to children. The shell itself
  survives in its own pgrp (`crates/pty/src/fg_proc.rs`,
  `crates/session/src/lib.rs`, `crates/app/src/lib.rs`,
  `ui/src/main.ts`).

- **Tab busy indicator**: a palpitating green dot appears next to
  the tab label whenever a non-shell process occupies the PTY
  foreground, with a tooltip showing the process name (`node`,
  `cargo`, `vite`, …). Emitted on transitions only via a new
  `SessionEvent::ForegroundChanged` (`crates/familiar/src/observer.rs`,
  `ui/src/tabs/manager.ts`, `ui/src/styles.css`).

- **Ligatures + settings polish**: optional terminal ligature
  rendering wired through settings, plus capabilities-panel and
  settings-panel touch-ups (`ui/src/terminal/ligatures.ts`,
  `ui/src/settings/panel.ts`, `ui/src/capabilities/panel.ts`,
  `crates/app/src/settings.rs`).

## v0.5.7 — ⌘K action palette + SQL/XLSX editor previews

### Added

- **⌘K action palette**: redesigned the ⌘K agent invocation to return
  a structured response (explanation + proposed-command chip + risk
  badge + follow-ups) instead of free-form markdown. New `respond`
  tool schema with a streaming JSON accumulator on the Rust side
  (`crates/agent/`) plus a risk classifier that grades proposed
  commands against the safety blocklist. Frontend renders the chip
  with ⏎ insert / ⌘⏎ run keybindings (`ui/src/api.ts`,
  `ui/src/palette/*`, `ui/src/styles.css`).

- **SQL syntax highlighting**: editor now detects SQL dialect
  (SQLite/MySQL/Postgres) from file head when extension is ambiguous,
  with comment stripping and case-insensitive heuristics
  (`ui/src/editor/`, `@codemirror/lang-sql` dep).

- **XLSX preview**: spreadsheet files render as multi-sheet tabs over
  a virtualized grid via SheetJS, gated behind a size guard and
  wired through the binary read path (`ui/src/editor/XlsxPreview.ts`,
  `xlsx` dep).

### Changed

- **pnpm workspace**: committed `pnpm-workspace.yaml` and
  `pnpm-lock.yaml` so the workspace is reproducible.

### Fixed

- **Spec-detect alerts scoped to tab**: AOM spec-detection alerts
  now target only the tab that triggered them instead of broadcasting
  across all tabs (`crates/aom/`, `ui/src/aom/`).

- **Copilot plugin discovery**: capabilities drawer now parses
  `config.json` for installed plugins with an fs fallback, and the
  directory viewer renders manifest/README instead of a raw textarea
  (`crates/app/src/capabilities/copilot.rs`, `ui/src/capabilities/panel.ts`).

## v0.5.6 — Windows launch fix (pwsh help banner)

### Fixed

- **Windows startup**: v0.5.5 spawned pwsh with the zsh-only
  `--no-globalrcs` flag, which pwsh parsed as the ambiguous `-no*`
  prefix and dumped the full usage banner into the pty on every new
  tab. The flag and the matching `ZDOTDIR` env injection are now
  gated to `#[cfg(unix)]` (`crates/app/src/lib.rs`).

## v0.5.5 — Horizontal tab bar overflow scroll

### Fixed

- **Tab bar overflow**: with many groups (10+), the trailing groups
  were clipped and unreachable on the horizontal tab bar. The bar now
  scrolls horizontally with a hidden scrollbar, and vertical wheel
  input over the bar is mapped to horizontal scroll so every group
  stays reachable (`ui/src/styles.css`, `ui/src/main.ts`).

## v0.5.4 — Capabilities auto-context + tab/group drag polish

### Added

- **Capabilities drawer auto-context**: the drawer now derives its root
  directory from the active tab on open, so plugin discovery reflects
  what the user is currently working on without manual path entry
  (`ui/src/capabilities/panel.ts`, `ui/src/main.ts`,
  `crates/app/src/lib.rs`, `crates/app/capabilities/default.json`).

### Changed

- **Group drag indicators** now match the tab drag visual language:
  aligned drop bars, consistent ghost animation, and removed redundant
  sidebar tooltips for a cleaner reorder UX
  (`ui/src/tabs/manager.ts`, `ui/src/styles.css`,
  `ui/src/settings/panel.ts`).

## v0.5.3 — Windows release pipeline fix

### Fixed

- `release-windows.yml` was looking for Tauri 1.x updater artifacts
  (`*.msi.zip` + `*.msi.zip.sig`), which Tauri 2.x no longer produces.
  The Windows build itself was fine — only the post-build artifact
  locator step failed, blocking the Windows half of every release
  since v0.5.0.
- The workflow now locates `*.msi.sig` (Tauri 2.x signs the `.msi`
  directly) and the `latest.json` manifest fragment points the
  Windows updater at the raw `.msi` URL instead of a non-existent
  `.msi.zip`.

No app-code changes — pure CI fix to ship the Windows MSI + updater
signature on the GitHub release.

## v0.5.1 — UX polish + HTML preview + workspace import/export

### Added

- **HTML preview** in the Structure editor: `.html` / `.htm` files
  render inside a sandboxed iframe (`allow-scripts allow-same-origin`,
  `referrerpolicy=no-referrer`) so Tailwind CDN, FontAwesome and inline
  scripts behave like a real browser open without touching parent
  storage or navigation.
- **Workspace export / import** wired into Settings (`onExportWorkspace`
  / `onImportWorkspace`): serialize the live tab manifest to JSON and
  restore it on demand.
- **Pastel color swatches** as a second row in the tab/group color
  context menu (`COLOR_SWATCHES_PASTEL`, `pastelRow` row alignment).

### Fixed

- Selecting a tab now dismisses any fullscreen overlay panel
  (Capabilities, Settings, Release, Shortcuts, AOM report, Docs,
  Drafts, Mission, Operator, Spec chat). Activating a tab implies
  "show me this terminal" — covering it with a panel was a bug.
- AOM report panel re-wires its close handler on in-place re-render,
  so the close affordance keeps working after a report refresh.
- Sidebar chips reach the right edge and badges have breathing room
  again.
- Capabilities panel sits beside the sidebar instead of overlapping;
  hover-only scrollbars to match the rest of the chrome.

## v0.5.0 — Auto-Updater

Covenant now checks GitHub Releases at boot for new versions and offers
to install + relaunch. A "Check for updates" button in Settings exposes
the same flow manually. Updates are cryptographically signed; the
client refuses to install any artifact whose signature doesn't match
the embedded public key.

### Added

- `tauri-plugin-updater` + `tauri-plugin-process` integration.
- Silent update check at app boot (failures logged, never toasted).
- "Update available" banner with **Install now / Dismiss** actions.
- Settings → "Check for updates" button with inline status feedback.
- macOS release workflow (`release-macos.yml`) producing signed
  `.app.tar.gz` + `.sig` for the updater on a universal-apple-darwin
  bundle.
- `release-windows.yml` now signs the MSI bundle and uploads
  `.msi.zip` + `.sig` alongside the raw `.msi`.
- `release-manifest.yml` aggregates per-platform signatures into a
  single `latest.json` published to the release.

### Operator notes

See `docs/updater.md` for keypair rotation and the required GitHub
Actions secrets (`TAURI_SIGNING_PRIVATE_KEY`,
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).

## v0.4.2 — Executor Idle Notifications

Surface a native macOS notification (in addition to the existing
pulsing tab badge) when an embedded CLI agent — `claude`, `copilot`,
`opencode`, `codex`, `gemini`, or `aider` — goes idle waiting for
user input. Works independently of Operator/AOM: you get pinged on
any tab running one of those agents, even when nothing else is
supervising the session.

### Added

- New `Trigger::ExecutorIdle` notification variant with **per-session**
  30s throttle. Multiple tabs idle simultaneously each fire their own
  notification; the same tab can't re-fire within 30s.
- `executor_idle` subscriber task spawned per session: listens on the
  session event bus, formats `{agent} is waiting` + the matched prompt
  line, and fans out via the existing OS + email + Telegram dispatch.
- `notifications.on_executor_idle` setting (default **on**, back-compat
  for upgraded users via `serde(default = "default_true")`).
- Settings → Notifications → "CLI agent is waiting" toggle row so users
  can silence the OS popup while keeping the tab badge.

### Changed

- `ThrottleState` now tracks `last_fire_per_session: HashMap<(Trigger,
  SessionId), Instant>` alongside the global throttle map. Existing
  Operator/AOM triggers keep their global 30s window unchanged.

### Tests

- `notify::tests::executor_idle_throttle_is_per_session`
- `notify::tests::executor_idle_is_enabled_respects_toggle`
- `settings::tests::notification_config_default_enables_executor_idle`
- `settings::tests::notification_config_deserializes_without_executor_idle_field`
- `executor_idle::tests::format_uses_prompt_text_when_present`
- `executor_idle::tests::format_falls_back_when_no_prompt_text`
- `executor_idle::tests::format_handles_empty_prompt_text_as_missing`

## v0.4.1 — Capabilities Panel Layout Fixes

Follow-up patch to v0.4.0 that fixes layout regressions in the
Capabilities panel discovered after merging the redesign branch.

### Fixed

- Capabilities panel rebuilt 1:1 against the Settings panel pattern so
  it composes correctly inside the main layout grid (no more
  auto-shrink, no `display: contents` hack).
- Pinned `#layout` to a single column so the right pane can't be
  squeezed to zero width when the Capabilities panel mounts.
- Header and body of the Capabilities panel now append directly to
  `pageHost`, matching the Settings/Drafts mounting convention.
- Used `position: fixed` where needed to break out of the grid's
  auto-sizing for floating affordances.
- Opaque backgrounds on Capabilities surfaces so the desktop wallpaper
  no longer bleeds through translucent regions.

### Changed

- Refactored the Capabilities panel to mirror Settings/Drafts layout
  exactly — same container shape, same sticky header pattern, same
  scroll behavior. No behavior changes, layout-only.

## v0.4.0 — Capabilities Browser

Full UI for discovering and managing agent extensions across **Claude
Code, Copilot CLI, opencode** and the shared `~/.agents/` ecosystem —
skills, slash commands, hooks and MCP servers, all browseable, editable
and creatable without leaving the terminal.

### Added

- New crate `karl-capabilities` with per-tool adapters that scan the
  real on-disk locations (no unified abstraction — each tool's shape
  is preserved):
  - **Claude Code**: skills + slash commands across three scopes
    (Plugin read-only, User, Project), hooks + MCP servers from
    `settings.json`. Handles both versioned cache layout
    (`~/.claude/plugins/cache/<mkt>/<plugin>/<ver>/skills/`) and
    marketplace unversioned layout.
  - **Copilot CLI**: MCP servers from `~/.copilot/mcp-config.json`,
    installed plugins. Detects binary at `~/.copilot/`.
  - **opencode**: agents (treated as skill analogue) and MCP servers
    from `~/.config/opencode/` and `<repo>/.opencode/`.
  - **Shared `~/.agents/`**: cross-tool skills standard
    (skills.sh ecosystem, `npx skills` lockfile-aware).
- Atomic writer with `.bak.<ts>` snapshot retention and a markdown
  frontmatter builder.
- Scaffolder with templates for new skills, slash commands, hook
  snippets and MCP server snippets per supported (tool, kind) pair.
- FS watcher (`notify` + `tokio::broadcast`) that emits `Added /
  Modified / Removed` for any registered path set — wired but UI
  still uses manual Refresh in v0.4.0.
- Six Tauri commands (`capabilities_list / read / write / delete /
  scaffold / detect`) bridging the Rust crate to the frontend.
- New full-page Capabilities panel (`ui/src/capabilities/panel.ts`,
  528 LOC) with tool tabs, section filters, scope filter (user /
  project), search, in-place editor, Save / Delete / New, and a
  manual project-root picker (folder dialog).
- Keyboard shortcut **`Cmd+Shift+I`** to toggle the Capabilities
  panel.

### Changed

- Workspace gained the `karl-capabilities` member; crate exposes
  72 unit tests covering frontmatter parsing, all four adapters,
  the watcher, atomic writes and the scaffolder.

### Notes

- Plugin-scoped items are read-only in v0.4.0 — a "Fork to user
  scope" action is planned. Copilot CLI exposes no native skill /
  command surface today, so its tab shows only MCPs + plugins.
- Project root must be set manually (folder picker). Auto-derive
  from the active tab's cwd (T10) is a follow-up.

## v0.3.1 — Windows support

### Added

- **PowerShell shell integration.** `shell-integration/osc133.ps1`
  emits OSC 133 (A/B/C/D) + OSC 7 from the `prompt` function, so
  block parsing works identically on pwsh and zsh/bash.
- **ConPTY backend.** `portable-pty` resolves to ConPTY on
  Windows 10 1809+. Smoke test exercises a pwsh round-trip.
- **`ShellKind` enum** with per-platform resolution
  (`from_default_shell`): pwsh > powershell > cmd on Windows,
  zsh/bash/fish on Unix.
- **Tauri MSI bundle** with WebView2 bootstrapper config.
- **Windows release CI.** GH Actions workflow builds on
  `windows-latest`, packages the MSI, runs a smoke test, and
  auto-creates the GitHub release if missing before uploading.
- **Docs.** Windows install and first-run guide.

### Changed

- **Cross-platform paths** throughout; sqlite is now bundled
  rather than relying on a system install.
- Unix-only code paths (idle detector, signal handling) gated
  on `cfg(unix)` so the Windows build stays clean.

## v0.3.0 — Agent idle detection

### Added

- **Idle detection for nested CLI agents.** PTY foreground-process
  + vt100 screen heuristics (1 s tick, 3 s quiet window) detect
  when `claude`, `codex`, `opencode`, or `copilot` is waiting on
  user input inside a tab.
- New `SessionEvent::AgentIdleWaiting` / `AgentIdleResumed`
  events; tab chrome renders a badge while the nested agent is
  idle, so you can tell which tab is asking for attention without
  switching to it.

## v0.2.24 — Sidebar hierarchy polish

### Changed

- **Sidebar group hierarchy reworked.** Pixel-tuned to match the
  agreed mockup:
  - Group chips render as full pills with a 3px colored
    `border-left` + 10px radius — the curve produces the
    parenthesis-style "(" bracket in the group's color for free.
  - Tree-line under expanded groups is a thin 2px colored bar
    drawn via `::before` on `.tab-group-body`, hanging from
    below the chip down through the children area.
  - Children physically shift right (`margin-left: 26px`) so the
    tree-line and pill don't collide; rest-state chrome is flat
    (no border, no bg). Hover/active tint with the group color
    (28% bg, 60% border at active).
  - Group header keeps its full pill shape whether expanded or
    collapsed — fused-border style removed.
  - Inter-group gap collapsed to 4px; folded children now reset
    to `height: 0` so collapsed groups don't leave ghost space.
  - Group count badge: fixed 18×18 circle, neutral dark bg, plain
    white text — no longer stretches.
- **Sticky sidebar header & footer.** `#tabbar-brand-row` and
  `#tabbar-actions` now stick to top/bottom while the group list
  scrolls. Both use the same translucent surface as the sidebar
  (`color-mix(in srgb, var(--bg-tabbar) 92%, transparent)`) plus
  `backdrop-filter: blur(14px) saturate(140%)` so the boundary
  reads as a single glass surface, not a pasted rectangle.

### Fixed

- **Tree-line missing on expand.** `toggleGroupCollapsed` was only
  flipping `group-chip-collapsed` on the chip, not
  `tab-group-shell-collapsed` on the shell that the tree-line
  CSS keys off. Selecting a tab forced a full re-render that
  fixed it; now the class is synced inline so the line appears
  immediately on expand.

## v0.2.23 — Sidebar hierarchy & AOM border-only states

### Changed

- **Tab sidebar hierarchy.** Grouped tabs in the vertical
  sidebar now render flat (no border, no rest-state bg) and
  rely on the existing colored group stripe + 22px indent
  to convey nesting. Hover/active tint with the group color.
  Inter-sibling gap tightened (2px → 1px) and inter-group gap
  widened (6px → 14px) so each group reads as a contained
  block instead of equal-weight pills.
- **AOM tab states are now border-only.** Removed the inner
  bot/zap-off glyph (`.tab-bot-badge`) from tab pills. State
  is conveyed entirely by the pill border:
  - operator off → neutral border
  - operator on, AOM off → solid colored border
  - operator on, AOM on, driving → animated gradient ring
    (`.tab-aom-active`, unchanged)
  - operator on, AOM on, excluded → muted dashed ring with
    dimmed label (`.tab-aom-excluded`, new)
  Toggle exclusion still via ⌘⇧E or the tab context menu.
- **AOM docs.** New *Tab states* section in the in-app docs
  explaining the four border states and how to toggle
  exclusion.

### Fixed

- **AOM 400 error.** Pad `max_tokens` to
  `thinking_budget + 1024` headroom so the Anthropic API
  constraint (`max_tokens > thinking.budget_tokens`) is
  always satisfied when extended thinking is on.

## v0.2.22 — Per-group root dir

### Added

- **Per-group default cwd.** Each tab group can carry a
  `rootDir`; new tabs spawned inside the group start in that
  directory instead of `$HOME`. Set it via the group's
  context menu (right-click chip → **Set root dir…**) — opens
  the native folder picker. While set, the menu shows the
  tildified path and a **Clear root dir** entry. Persisted
  in the existing tab manifest as `root_dir` (optional, so
  older manifests load unchanged). Existing tabs keep their
  current cwd; restored tabs keep their per-tab cwd —
  fallback only kicks in when no explicit cwd is passed.

## v0.2.19 — Telegram escalation

### Added

- **Bidirectional Telegram escalation.** When the operator
  needs to escalate (blocklist refusal, budget cap, AOM loop
  detection, or other blocked decisions), Covenant pushes the
  context to your Telegram with three inline buttons —
  Approve / Reject / Snooze 10m. Tap one and the originating
  tab resumes; *or* reply with free text and that text is
  injected into the operator as a new instruction (LLM path,
  never the PTY directly — blocklist still applies).
- **Mission lifecycle pings.** `MissionCompleted` and
  `MissionFailed` events fan out as fire-and-forget Telegram
  notifications when enabled.
- **Settings → Telegram section.** Toggle, bot token (paste
  from @BotFather), chat ID (paste from @userinfobot), event
  filters (escalations / mission completed / mission failed),
  and a `Test connection` button that round-trips `getMe` +
  `sendMessage`.
- **Statusbar pill.** Tiny Telegram indicator in the status
  bar — disabled / ok / error — polled every 5s; click jumps
  to the Telegram settings section.
- **Per-tab override (backend).** `settings.telegram.per_tab_overrides[<tab_id>].enabled = false`
  silences a noisy tab without touching the global toggle.
  UI surface for the override is deferred.

### Changed

- `OutboundState` tracks both `message_id → escalation_id`
  (for resolving replies) and `escalation_id → session_id`
  (for routing free-text replies back to the right tab).
- Settings save round-trip aborts and respawns the inbound
  long-poll task when the bot token, chat id, or enabled
  toggle changes — no app restart needed.

### Security

- Strict whitelist on `chat_id` for all inbound updates —
  messages from any other chat are silently dropped.
- Free-text replies are injected into the operator as
  user-style input (the LLM decides what to do); they never
  bypass the safety blocklist or per-tab policy.
- Bot token lives in `settings.json` plain (FS perms only).
  v1 trade-off in exchange for shipping without Keychain
  integration; future migration tracked.

## v0.2.18 — Shortcuts audit + Familiars onboarding

### Added

- **Operator & AI** category in the keyboard shortcuts modal
  (⌘⇧K), grouping super-agent, operator decisions, operator
  picker (⌘⇧O), mission picker (⌘M), spec-chat (⌘N), drafts
  (⌘⇧D), and Familiar roster (⌘⇧L). Four bindings that were
  active in `main.ts` but missing from the registry are now
  discoverable.
- **Familiars settings: empty-state onboarding.** Replaces the
  single-line "(no Familiars yet)" with a card explaining what
  a Familiar is, four numbered steps to spawn one, and meta
  notes on cost (BYOK), persistence
  (`~/.karlTerminal/familiars/`), and safety.

### Fixed

- **Convergence Mode shortcut listed wrong keys.** Registry
  showed `⌘⌥O`; the real binding is `⌘⇧M`.
- **"Operator decisions" label was ambiguous** — it now reads
  "Operator decisions log for the active tab", distinguishing
  it from the new "Operator picker" entry.

## v0.2.17 — Terminal refit + convergence overlay polish

### Fixed

- **Bottom row clipped under the status bar.** The xterm fit
  addon measured glyphs against fallback font metrics on first
  mount, leaving `term.rows` one too high once the real webfont
  landed. Rows rendered under the status bar — invisible but
  selectable, and "scroll to bottom" appeared stuck one line
  short. Fits now run a second pass on `document.fonts.ready`,
  inside the ResizeObserver callback (next-frame), and on tab
  activation (double-rAF). Activation also explicitly scrolls
  to bottom after the second fit.
- **Convergence overlay grid stayed visible when empty.** The
  `cv-grid` container is now hidden alongside the empty-state
  placeholder so the empty view isn't framed by a stray grid.

## v0.2.15 — AOM liveness, offline pause, Haiku triage

The Operator now feels *alive*. Four changes targeting the
"AOM took 5 minutes to make an obvious decision" feedback:

### Added

- **Yield on user input.** Typing into a watched executor's PTY
  immediately resets the operator's WAIT/cooldown counters for
  that session. The operator no longer tries to answer a prompt
  the user already answered.
- **Liveness phase in the AOM badge.** New `OperatorPhase` enum
  (`observing` / `triaging` / `deciding` / `yielded` / `offline` /
  `idle`) drives the badge. Pulse animation while `deciding` /
  `triaging`. Cost moves to tooltip; phase + elapsed take the
  primary slot.
- **Offline detection.** `Connectivity` state listens to the
  browser's `online` / `offline` events. While offline, every
  enabled session is parked in `OperatorPhase::Offline`, model
  calls are short-circuited, and a banner pill shows "AOM
  paused — offline". Auto-resumes on reconnect.
- **Haiku triage tier.** Each candidate tick runs through Haiku
  4.5 (`max_tokens=64`) classifying `act` / `wait` / `yield`
  before any Opus/Sonnet call. Only `act && confidence > 0.6`
  escalates to the configured big model. Triage system prompt
  shares the cached prefix so cache hits are preserved. Settings:
  `triage_enabled` (default true), `triage_model`.

## v0.2.14 — Email notifications via SendGrid

- New: SendGrid email channel for Operator escalations, AOM errors (immediate)
  and AOM completions (digest). Configure via Settings → Notifications → Email.
- Email channel is gated by an API key + from/to addresses; defaults off.
- Digest window configurable 5–60 minutes; default 15.

## 0.2.12 — 2026-05-05

**Operator unstuck on spinning executors.** AOM no longer parks
indefinitely on TUIs rendering Braille spinners ("Sautéed for 14s"
forever). The idle-WAIT detector previously compared raw byte
counts, but spinner frames emit new bytes every tick — the counter
reset every check and the 5-WAIT escalation never fired. Decisions
are now keyed off a *progress signature* that strips animated
glyphs and elapsed-time tokens before hashing, so genuine no-
progress states surface within ~5 polls and the tab is parked +
notified instead of silently burning model calls.

### Fixed

- **AOM idle-WAIT detector** — new `compute_progress_signature` /
  `strip_spinner_churn` strip Braille (`U+2800-28FF`),
  block-elements (`U+2580-259F`), common spinner / dial glyphs,
  and elapsed-time tokens (`14s`, `1:23`, `00:01:42`) before
  hashing. Both the idle-WAIT counter and the general-loop hash
  use the new signature.
- **Activity feed** — consecutive WAIT cards with identical
  rationale on the same session inside a 30s window are now
  deduplicated. REPLY / ESCALATE cards are never deduped.

### Changed

- **Per-tab AOM badge** — during AOM, the per-tab badge mirrors
  the status-bar zap glyph (active) or zap-with-slash (excluded)
  so it reads as "AOM is driving this tab" instead of generic
  operator presence. Outside AOM the badge keeps the bot glyph.
- **Spec 3.4 (AFK Mode) deprecated** in favor of 3.8 (Convergence
  Mode), which absorbs the idle/screensaver role with a denser,
  more actionable surface (all sessions, cost, mission snapshots,
  inline reply on escalations). The AOM engine is unchanged —
  only the UI entry-point moved. Auto-engage-on-idle is tracked
  as a follow-up under 3.8.

### Internal

- `spec-chat`: silence unused-host warning, modernize vitest mock
  generics to vitest-1.x function-signature form.

---

## 0.2.11 — 2026-05-05

**Spec 3.18 — Agentic spec creation.** Creating a spec is no longer
a six-textarea exercise. `⌘N` (or "+ New via chat" in the Drafts
header) opens a guided chat that walks through Goal → Out of scope
→ Acceptance → File boundaries → Complexity → Open questions in
3–5 directed questions, then emits markdown matching
`_template.md`. The existing draft wizard takes over pre-populated
for review and publish. Drafts persist in
`~/.covenant/spec-drafts/<ulid>.json` so closing mid-flow lets
you resume from any session.

### Added

- **3.18 chat-first spec authoring** — `mountSpecChat` controller
  with chooser ("Resume / Start new / Blank draft"), injectable
  APIs for tests, ⌘N keybinding, "+ New via chat" button in the
  Drafts header.
- **Backend `spec_author` module** in `karl-agent` — `Dispatcher`
  trait with `AnthropicDispatcher` (Sonnet 4.6, prompt-cached
  system block), 6-phase FSM, `validate_spec_markdown` enforcing
  every required heading before transitioning to `Ready`,
  `mark_published` flow.
- **Tauri commands** — `spec_author_step`,
  `spec_author_load_draft`, `spec_author_list_drafts`,
  `spec_author_mark_published`, plus typed wrappers in
  `ui/src/api.ts`.
- **Convergence empty states** — global "Nothing to converge"
  with link2 icon and ⌘⇧M hint, "All clear" inbox empty when
  operators exist but none are blocked, "No operators match
  &lt;filter&gt;" + "Show all" reset for the roster filter chips.

### Changed

- **Drafts header buttons** — "+ New via chat" is now a secondary
  outline button with a sparkles icon; "+ New draft" stays as the
  primary CTA. Both gain Lucide icons (sparkles, plus) for
  consistency with the rest of the app.
- **Spec-chat panel design** — neutral palette aligned with
  `--bg-overlay/--bg-panel/--border/--text-primary/--muted` (no
  more saturated green/blue on Send and Publish). Lucide icons
  replace text-only buttons (arrow-right Send, x Close, refresh
  spinner, sparkles title). Empty state guides the first message;
  phase chip uses uppercase tracking with a neutral border.
- **Spec-chat copy** — UI strings translated to English to match
  the rest of the app.

### Fixed

- **`--text-primary` was undefined globally** — used in 19
  places (mission badges, drafts buttons, the spec-chat panel)
  but never declared in `:root`. Falling through to `transparent`
  killed the "+ New draft" button background. Now set to
  `#f5f6f7` matching `--tab-fg-active`.
- **Spec-chat modal alignment** — the overlay was clipped to a
  single CSS-grid cell because it mounted inside `#spec-chat-page`
  with `position: fixed` (a transformed grid ancestor was acting
  as the containing block). Now mounts on `document.body`.
- **Spec-chat "Review & publish" always visible** — `[hidden]`
  attribute was overridden by `display: flex` on
  `.spec-chat-final`. Added `[hidden] !important` guard inside
  `.spec-chat-panel`.
- **Draft wizard** accepts an optional `initialBody` that
  pre-populates the section textareas, used by the spec-chat
  hand-off.

## 0.2.10 — 2026-05-05

Three threads land together. **Spec 3.8.1 — convergence redesign**
turns the convergence view into a two-pane Inbox + Roster layout,
with the Tauri snapshot split into roster + escalations and a
multi-line reply composer in the Inbox. **Spec 3.17 — spec pending
recovery** makes the spec→mission prompt durable: if you dismiss
the toast or the tab is occupied, the candidate now lives on as a
persistent badge per tab with a popover (assign / open /
dismiss), and any `docs/specs/**/*.md` reference in terminal
output becomes ⌘+click-actionable through a contextual menu. And
**Familiars** drops the premium gate.

Familiars is BYOK — the user's own Anthropic key in Settings →
Anthropic pays for chat and summarization, so there is no premium
flag to honor-system. The gate is gone, the API key now resolves
from Settings (with `ANTHROPIC_API_KEY` env as fallback), and the
Settings panel collapses to a single *Enable Familiars* toggle.

### Added

- **3.8.1 convergence redesign** — Inbox + Roster two-pane layout,
  multi-line reply composer, filter chips, click semantics on the
  Roster column. Backend snapshot split into roster + escalations
  exposed as separate Tauri commands.
- **3.17 spec pending recovery** — persistent per-tab spec badge
  driven by a reactive `SpecPromptState`, popover with
  assign / open / dismiss actions, single-toast rendering bound to
  the active tab with target label.
- **Spec link ⌘+click menu** — `isSpecPath` matcher for
  `docs/specs/**/*.md`, contextual menu on ⌘+click in terminal
  output for spec-shaped paths.

### Changed

- **Familiars: no premium gate.** BYOK only. `is_premium` removed
  from settings; `familiars_active()` now means
  `familiars_enabled` alone. The Settings → Familiars section
  shows a single Enable toggle.
- **Familiars API key** is read from
  `settings.anthropic_api_key` first, falling back to
  `ANTHROPIC_API_KEY` env. Previously it was env-only at startup,
  so the key configured in Settings never reached the chat
  command.

### Fixed

- Single-toast spec prompt now binds to the active tab and shows
  the target label, instead of stacking duplicates.

## 0.2.9 — 2026-05-04

Spec **3.16 — auto-detect spec → propose mission** lands as the
headline. Whenever a new spec file appears in the repo (Drafts
publish into `docs/specs/`, or `superpowers:brainstorming` writes
into `docs/superpowers/specs/`), Covenant detects it and shows a
floating toast asking *"Set as mission?"* on every tab in the repo
that has no mission and an Operator assigned. Press ⌘⇧A on a tab
without a mission and a recent candidate will trigger a "last-call"
modal with `Use it / Engage without mission / Cancel` so you don't
sleep AOM without a target by mistake.

Detection is scoped to "new since the app saw it": at first launch
in a repo, every existing spec is recorded in a new `seen_specs`
SQLite table; only files that appear after that snapshot fire a
toast. Edits to known specs are silent. Dedupe is per-path, so the
toast never repeats within a session.

A behavior change to AOM auto-engage rides along: AOM no longer
auto-enables Operator on tabs you didn't already turn it on. Tabs
without Operator now stay manual when AOM starts — AOM only drives
tabs you've explicitly opted in.

Terminal links got an upgrade too: the renderer now opens schemed
URLs in the system browser via `tauri-plugin-opener`, and a custom
matcher makes bare `localhost:port` / `127.0.0.1:port` strings
clickable. The active executor (claude / copilot / opencode / …) is
also detected from the in-flight command and surfaces in the status
bar's brand chip.

### Added

- **3.16 spec auto-detect → mission** — `notify`-based FS watcher
  per repo, path-based classifier (Covenant vs Superpowers),
  `seen_specs` SQLite dedupe table, snapshot scan on first run,
  Tauri event `spec:candidate`, floating toast UI with
  Set/Dismiss + 30 s auto-dismiss, last-call modal at ⌘⇧A.
- **Clickable bare host:port links** in the terminal
  (`localhost`, `127.0.0.1`, `0.0.0.0`, `[::1]`).
- **Executor detection** per tab — surfaces the running agentic
  CLI in the status-bar brand chip.

### Changed

- **AOM start** no longer auto-enables Operator on tabs that had
  it off. AOM drives only the tabs you opted in manually
  (`OperatorWatcher::enable_all_for_aom`).
- Terminal URL handling switched to `tauri-plugin-opener` so links
  open in the system browser instead of inside the webview.

## 0.2.8 — 2026-05-04

Layout fix for the **horizontal tab group shell**. The
`.tab-group-shell` flex direction was column by default — fine for
the vertical sidebar, but in horizontal mode it stacked the group
chip and member pills vertically inside a height-constrained tab
bar, clipping everything except the colored stripe. The default is
now `flex-direction: row`, with a `body.tabbar-left` override that
restores column-flex for the sidebar layout. The group chip carries
a full radius + bottom border in horizontal mode and fuses its
right edge with the first member tab so the group reads as a
single unit.

Bundled with the **drafts page grid fix**: the topbar now lives in
its own grid wrapper and the empty state centers correctly inside
the panel instead of clinging to the top edge.

### Fixed

- Horizontal tab-group-shell clipping (default flex direction +
  `body.tabbar-left` override).
- Drafts page topbar wrapper + empty-state centering.

## 0.2.7 — 2026-05-04

Drag-and-drop reordering of tab groups now works in the **vertical
sidebar** (`tabbar-left`) layout. Previously the drop-side detection
only considered the X axis, so dragging a group chip up or down in
the sidebar produced no visible drop target. The indicator now flips
to a horizontal bar above/below the destination group so the landing
spot is unambiguous.

Bundled with two small fixes:

- **Convergence overlay** — `Esc` now reliably closes the overlay
  even when an xterm pane has focus (capture-phase handler beats
  the terminal's own keydown).
- **Mission picker "no plan" badge** — switched from `<button>` to
  `<span role="button">` so it nests legally inside the parent row
  button; keyboard activation (Enter/Space) preserved.

### Changed

- **Tab group drag-reorder** — vertical-axis drop detection + new
  horizontal drop-indicator styles for `body.tabbar-left`.

### Fixed

- Convergence overlay swallows Escape via capture-phase listener.
- Mission picker "no plan" action no longer produces invalid nested
  `<button>` HTML.

## 0.2.6 — 2026-05-04

Mission picker polish: the **Superpowers** section is no longer
overwhelming. Each entry is now a single compact row with a
humanized title (e.g. "Persona composer modal" instead of
`2026-05-04-persona-composer-modal-design.md`), a tiny `MM-DD` date
on the right, and the redundant `spec ✓ / plan ✓` badges collapsed
into one subtle check. Missing plans still surface a red `no plan`
action button. The original filename is preserved in the hover
tooltip.

### Changed

- **Superpowers list rows** — humanized title + dim date + collapsed
  status indicator; ~3× more entries fit on screen.

## 0.2.5 — 2026-05-04

Mission picker promoted to a full page, plus several quality-of-life
fixes around the terminal: Cmd+Click on path-like tokens opens the
file, Shift+Enter sends a newline without submitting in CLI agents,
the Convergence Mode reply form stops leaking keystrokes to the
terminal underneath, and runtime-version detection now works when the
app is launched from Finder.

### Added

- **Mission picker full page (spec 3.15)** — `⌘M` opens
  `#mission-page`, an overlay full-screen panel mirroring Drafts and
  Docs Hub. Sidebar with search across published specs (matches
  `id`/`title`/`goal`), Superpowers and Drafts sections, and a
  preview pane that renders the selected spec's markdown via a small
  inline renderer. Keyboard nav: `↑/↓/Enter` select+confirm, `Esc`
  cancels, `⌘F` focuses search, `Tab` jumps to the path input. The
  old "Set mission spec" modal is removed.
- **`read_spec_body` Tauri command** — lazy-reads a `.md` body for
  the preview pane with a 200 KB hard cap (anything bigger is
  truncated with a notice), via `spawn_blocking` so the async
  executor never blocks on disk I/O.
- **Cmd+Click opens path tokens in the editor** — xterm link
  provider detects path-like tokens in command output, asks the new
  `resolve_existing_path` Tauri command to canonicalize them
  relative to the active tab's `cwd`, and opens the result in the
  editor when it points to a real file. Hovering a resolvable token
  highlights it.
- **Shift+Enter sends Alt+Enter** (`\x1b\r`) inside the terminal —
  the widely-accepted "newline without submit" sequence that Claude
  Code, Codex, and other CLI agents recognize. xterm.js's default
  was identical to plain Enter, which auto-submits.
- **Keyboard activation on Convergence tiles** — pressing
  `Enter`/`Space` while a tile has focus activates that tab (same
  effect as a click). Tiles now expose `role="button"` + `tabIndex`
  for proper a11y.

### Changed

- **Runtime version detection runs through the user's login+
  interactive shell** (`$SHELL -ilc …`). GUI apps launched from
  Finder/Spotlight inherit a minimal `PATH` and miss `nvm`, `pyenv`,
  `asdf`, and Homebrew shims, so the Tier-3 fallback (`node -v`,
  `python3 --version`, `rustc --version`, `go version`,
  `ruby --version`) silently returned `None`. We now wrap the call
  through the user's rc-loaded shell with an output marker so banners
  and MOTDs from rc files don't pollute the parsed version. Slower
  on first hit per cwd, but the LRU cache absorbs subsequent calls.
- **Convergence tile is a `<div role="button">`** instead of a
  `<button>` — nesting `<input>`, `<select>`, and `<button>` inside a
  `<button>` is invalid HTML and produced erratic focus/drag
  behavior (typing into the reply input bubbled stray events to the
  terminal underneath the overlay).
- **Convergence reply form layout** — the input now spans the full
  tile width on its own row; the scope picker and Send button sit on
  a second row, right-aligned. Previously they competed for one row
  and the input got squeezed.

### Fixed

- **Convergence reply form keystrokes no longer reach the terminal
  underneath** — `keydown` and `pointerdown` are now caught with
  `stopPropagation`. Before, typing into the reply form could leak
  through to xterm and corrupt the running command.



Per-tab AOM exclusion visibility. The existing `aom_excluded` per-tab
opt-out (M-OP5) was invisible — no shortcut, no badge on the tab, no
status-bar surface — and got reset on every `aom_start` so users had
to re-mark their manual tabs each time. This release surfaces the
feature with a discoverable badge, a keyboard shortcut, an aggregated
status-bar suffix with a popover, and persistent storage across both
AOM cycles and app restarts.

### Added

- **Per-tab `bot` / `bot-off` badge** on every Operator-enabled tab
  pill. Decorative when AOM is off; click during AOM toggles
  exclusion. Slashed (`bot-off`) variant signals "AOM is running on
  the rest, this tab is staying manual".
- **`⌘⇧E` shortcut** — toggle AOM exclusion for the active tab.
  Silent no-op when AOM is off, no active tab, or active tab has
  Operator disabled.
- **AOM status-bar suffix** — when ≥1 tab is excluded, the AOM chip
  reads `· N excluded`. Click opens a popover listing each excluded
  tab (name + short cwd) with a per-tab Include button, plus an
  "Include all in AOM" bulk action when ≥2 are excluded.
- **Manifest persistence** — `aom_excluded` survives app restarts via
  an additive `aom_excluded?: boolean` field on `TabManifestV1` (no
  schema bump). Restore always calls `setAomExcluded` with the
  persisted value.
- **`clear_all_aom_excluded` Tauri command** — backs the popover's
  "Include all" action.

### Changed

- **`aom_start` no longer resets `aom_excluded`** — exclusion is now
  a persistent property of the tab, surviving AOM stop/start cycles.
- **`enable_all_for_aom` skips excluded tabs** — AOM doesn't
  auto-claim Operator on a tab the user marked manual.
- **`set_aom_excluded(true)` clears `enabled_by_aom`** — claiming a
  tab mid-AOM survives `aom_stop`'s auto-revert (the tab keeps its
  Operator state per the user's explicit choice).

### Fixed

- Stale doc comments on `Attached.aom_excluded`, `set_aom_excluded`,
  `clear_all_aom_excluded`, `Tab.aomExcluded`, the `attach()` block,
  and `setAomExcluded` (api.ts) — all referenced the removed
  per-`aom_start` reset.
- Tab rename + Operator-toggle paths now refresh the AOM popover so
  excluded-list labels stay current without waiting for the next AOM
  transition.

### Internal

- Spec at `docs/superpowers/specs/2026-05-04-aom-exclusion-visibility-design.md`,
  plan at `docs/superpowers/plans/2026-05-04-aom-exclusion-visibility.md`.
- 21 commits on `feat/aom-exclusion-visibility`. Includes one revert
  + plan correction where Task 5 misidentified its target.

## 0.2.3 — 2026-05-04

Persona composer release. Editing an operator's authorization charter
now happens in a generous fullscreen-ish modal instead of a 14-row
textarea, with six shipped templates one click away.

### Added

- **Persona composer modal** — click the new expand icon in
  `Settings → Operators` next to the persona textarea to open an
  85vw × 85vh editor. Backdrop click is intentionally inert (prevents
  accidental data loss); Esc and the `Cancel ⎋` button discard, ⌘S
  saves and closes. Save writes back through the existing textarea
  via an `input` event so dirty-tracking activates unchanged.
- **Six operator persona templates** (Cautious senior, YOLO autopilot,
  Spec-driven, Read-only auditor, Junior pair, Debugger). Loading a
  template into a non-empty editor prompts a single `confirm()` —
  no second-modal-on-modal.
- **`Icons.maximize`** — Lucide `maximize-2` SVG, used as the
  composer trigger.

### Changed

- **Convergence overlay's Exit button** uses the new shared
  `.modal-cancel-btn` + `.modal-kbd` classes (extracted from the
  former `.convergence-overlay__exit*` rules). The Persona composer's
  Cancel button reuses the same styling so future modals land
  homogenized for free.

### Internal

- New tests: `persona-templates.test.ts` (4) and `persona-composer.test.ts`
  (10) covering DOM structure, template loading with/without confirm,
  Save/Esc/⌘S keyboard paths, backdrop inertness, and listener cleanup
  on close.
- Spec: `docs/superpowers/specs/2026-05-04-persona-composer-modal-design.md`
- Plan: `docs/superpowers/plans/2026-05-04-persona-composer-modal.md`
- Phase 2 (AI compose/refine) intentionally deferred to a separate spec.

## 0.2.2 — 2026-05-04

Polish + premium-feel release. Boot now runs through a branded splash
so the cold-start beat reads "ready" instead of "blank window," the
status bar surfaces the actual runtime version of the cwd, and the
operator context menu finally lets you remove a pinned operator.

### Added

- **Boot splash screen** — branded `COVENANT` overlay with a pulsing
  accent orb, expanding rings, and a `Booting…` ellipsis. Paints on
  the first frame (inlined in `index.html`) and fades out once tabs
  finish restoring. Honors `prefers-reduced-motion`. Reuses the
  AOM-splash animation framework but in the cool/accent palette so
  it never reads as the AOM danger splash.
- **Runtime version in status bar** — the runtime segment now shows
  a real version (`node 20.11.1`, `python 3.12.4`, …) even when the
  manifest doesn't declare one. Detection chain: manifest →
  version files (`.nvmrc`, `.node-version`, `.python-version`,
  `.ruby-version`, `rust-toolchain[.toml]`, `.tool-versions`) →
  binary lookup (`node -v`, `python3 --version`, `rustc --version`,
  `go version`, `ruby --version`). Cached per-cwd so the subprocess
  only runs once per directory per cache window.

### Changed

- **Tab context menu — operator entry**:
  - "Enable operator" renamed to **Set operator**, matching the
    status-bar chip and the `⌘⇧O` picker.
  - When an operator is pinned, the entry becomes **Remove operator**
    and unpins + disables the watcher in a single action (avatar
    chip disappears, watcher stops).
  - Picking an operator from the picker now also enables the watcher
    — pinning IS the user's intent to use it.
- **Disable operator render is now optimistic** — the agent icon
  disappears from the tab immediately, before the backend round-trip
  resolves.
- **Sidebar "Covenant" brand** restyled to match the CONVERGENCE
  header: uppercase, wide letter-spacing, muted color.
- **Convergence overlay's Exit button** now shows an `Esc` kbd hint.

### Fixed

- **Collapsed tab groups no longer add phantom space** per folded
  member. Replaced `.tab-group-body` `gap` with `margin-top` so the
  existing `.tab-pill-folded` zero-margin rule actually wins.

### Internal

- Persona composer modal — design spec + implementation plan landed;
  build pending.
- Per-tab AOM exclusion visibility — implementation plan landed
  (backend, icons, tab pill, `⌘⇧E`, manifest, status-bar popover);
  build pending.

## 0.2.1 — 2026-05-04

Sidebar polish release. Tab groups get a clearer visual identity, the
color palette doubles, and a dedicated "new group" button joins the
sidebar footer.

### Added

- **New-group button** in the sidebar footer alongside `+ ⌘T` —
  creates an empty tab group via `⌘⇧G` (no member tab needed).
- **6 new color swatches** for tabs and groups: lime, teal, cyan,
  indigo, magenta, slate (palette grew from 8 to 14). Picker row
  wraps to a second line when needed.

### Changed

- **Tab group visual identity** — replaced the per-tab left-edge color
  line and the chip top-stripe with a single 3px lateral stripe per
  group. The stripe stretches over header + members when expanded and
  shrinks to header height when collapsed. Each group is wrapped in a
  `.tab-group-shell` flex container (`createGroupShell` helper) so the
  rendering is testable in isolation.
- **New-tab button** uses the terminal icon instead of a `+`, paired
  with the `⌘T` kbd hint.

### Fixed

- `.new-tab-kbd` and `.new-tab-plus` styles were scoped to `#new-tab`
  only, so the new-group button rendered an unstyled `kbd`. Unscoped
  to apply to both buttons.

### Internal

- Added `vitest.config.ts` with jsdom environment + `jsdom` dev dep so
  DOM helpers can be unit-tested. New `ui/src/tabs/group-shell.test.ts`
  covers the shell helper. Test count: 86 passing (was 30).
- Removed dead CSS: `.group-chip::before`, `.tab-grouped::after`,
  `.tab-grouped-first`, and the matching `body.tabbar-left` overrides.
- `.superpowers/` brainstorm artifacts now ignored.

## 0.2.0 — 2026-05-03

Convergence-centric release. The overlay matures into the primary
multi-session command room and gains a memory loop: when you reply to
an escalated operator from convergence, the answer is captured as a
learned decision so the operator stops asking the same question twice.

### Added

- **Operator XP & level (spec 3.12)**: each completed decision awards
  XP, operators level up linearly, and a `Lv N` badge renders on the
  tab chip and operator panel. Persisted in SQLite; AFK-friendly
  visible progress across long autonomous runs.
- **Convergence Mode 2.0 (spec 3.8)**:
  - Rebound to **⌘⇧M** (`⌘⇧O` is now the operator picker).
  - **CONVERGENCE** header at the top of the overlay.
  - **Operator avatar** on every tile (per-tab assignment).
  - **Vendor badge** per tile — heuristic detection of the foreground
    AI CLI in each tab (`claude`, `copilot`, `opencode`, `aider`,
    `codex`, with `npx` unwrap; falls back to the truncated raw
    command when unknown).
  - **Mission line** on tiles (`📍 <mission-name>`) when a mission is
    attached; hidden otherwise.
  - **Reply box** on `blocked` tiles — single-line input + scope
    selector (`one-shot` / `mission` / `global`) + Send. Submitting
    unblocks the escalated session immediately and (for non-one-shot
    scopes) persists the answer as a memory.
  - **Real per-tab AOM cost** in the footer when the tab is enrolled
    (was a `$0.00` placeholder).
  - **`operator-thinking` 5th status** — tile flips to italic blue
    while an LLM call is in flight for that session.
  - **Two-step Esc** on the reply form: first Esc blurs the input,
    second Esc closes the overlay.
- **Operator Learning (spec 3.13)**: convergence replies become
  reusable memories.
  - Local SQLite store (`operator_memories` + `operator_memory_vec`)
    with the **`sqlite-vec`** extension.
  - Local **`fastembed-rs`** embedder (BGE-small, 384-dim) — no API
    keys, no network at inference time. Model auto-downloads on first
    use.
  - Hybrid retrieval: vector cosine + tag/keyword rescore on top-20
    candidates, then top-8 injected into the operator's system prompt
    under `## Learned decisions` (empty list is byte-identical to
    pre-3.13 prompt — prefix cache stays warm).
  - When an applied memory matches, the operator replies instead of
    escalating; the decision row records `applied_memory: <id>`
    (with `(shadowed: <ids>)` audit trail when ties exist).
  - Hand-edit acceptance: edit/delete rows directly in SQLite — the
    operator picks up changes on the next decision (no in-process
    cache, no restart).
- **Escalation visibility (spec 3.14)**:
  - Pulsing red dot on the tab chip whenever that session is in the
    `blocked` state — visible without opening convergence.
  - Backed by a lightweight `get_blocked_session_ids` Tauri command
    polled at 1 Hz, independent of overlay visibility.

### Changed

- Convergence tiles update **in place** on each 1 Hz poll instead of
  rebuilding the DOM — kills avatar flicker, preserves reply-box
  focus and typed text across ticks.
- AOM cost on tiles is now a real per-tab sum from
  `operator_decisions.cost_usd` (windowed to the current AOM run).

### Performance

- Convergence reply unblock no longer waits on the embedder cold
  start; persistence runs in a detached task while the resolution
  channel sends immediately.
- Operator decision tick short-circuits the retrieval embed + vector
  search when no memories match the active scope.

### Fixed

- Convergence empty state ("No sessions") was showing alongside tiles
  when present — `display: grid` was overriding the `[hidden]`
  attribute.

### Notes

- `fastembed-rs` pulls in `ort` (ONNX Runtime). The pyke prebuilt is
  **statically linked** in our build; no extra dylibs ship in the
  bundle and standard codesign suffices for notarization. See
  `docs/superpowers/notes/fastembed-notarization.md`.

## 0.1.0 — 2026-05-03

First captured release. Snapshot of where the app is today; future
versions will list deltas.

### Added

- AI-native terminal foundation: Tauri 2 + Rust + xterm.js.
- Multi-tab sessions with drag/fold groups, color, rename, manifest
  restore on relaunch.
- OSC 133 block parser; per-block exit code, duration, command, output.
- Operator (M-OP1..M-OP6): per-session enable/live, persona, dry-run
  pipeline, safety blocklist, mission spec attach.
- Autonomous Operator Mode (AOM) with budget cap, decisions counter,
  morning report, AFK overlay (⌘⇧A).
- Status bar with git, runtime, mission, AOM chip.
- Operator decisions panel (⌘O) with action filters, tab dropdown,
  executor and mission chips, grouping of consecutive identical
  decisions, snapshot of mission/executor at decision time.
- Recall command palette (⌘P) with zsh history import.
- Global content search (⌘⇧F).
- Convergence Mode overlay (⌘⇧O) — every open session as a live tile.
- Structure file tree + minimal editor with terminal split.
- Settings (⌘,), Docs hub (⌘/), Agent panel (⌘K).
- UI zoom (⌘= / ⌘− / ⌘0).

### Fixed

- New tab opening kept the previous tab's mission/agent chip visible
  until manual switch — `createTab` now routes through `activate`.
- Operator submit (Enter) sometimes failed against Claude Code's
  TUI — body and submit byte are now sent in two PTY writes ~60 ms
  apart so the trailing CR registers as a discrete keystroke.

### Changed

- AOM lives as a chip in the status bar; the floating banner is
  headless (state still polls).
- Operator persona gained an explicit *executor-recommended path*
  directive: when the executor presents its own recommendation
  before asking, default is REPLY confirming.
