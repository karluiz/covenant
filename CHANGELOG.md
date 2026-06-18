# Changelog

All notable changes to Covenant.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Each version section may include any of: **Added**, **Changed**, **Fixed**,
**Removed**.

## v0.8.93 — AOM engages idle tabs latched at a stale "working" phase

### Fixed

- **Stale "working" phase no longer strands the operator**: a backgrounded
  child process (e.g. an executor's `dotnet run` dev server) keeps the notch
  phase detector latched at `Running` while the agent sits idle at its prompt.
  The detector's stale-clear only runs on byte arrival, so once the PTY goes
  silent the phase never cleared and the operator's phase gate suppressed every
  tick — 0 decisions, "AOM takes ages to respond". The gate in
  `crates/app/src/operator.rs` now cross-checks real byte activity: a working
  phase only suppresses while output is actually flowing (`idle <
  PHASE_STALE_AFTER`, 10s). Past that window of silence the phase is treated as
  stale and the operator engages.

- **AOM idle-trigger ceiling lifted**: the idle trigger only fired within a 30s
  window after going idle, so a tab idle for minutes could never trigger and
  AOM's re-poll net (gated on a decision-point pattern) couldn't save a plain
  idle prompt. Under AOM the 30s ceiling is dropped — no human will retype to
  unstick it.

- **AOM stops fabricating work past completion**: the AOM directive now
  recognises a DONE state. When the executor reports the goal is complete and
  no concrete mission step remains, the operator escalates a one-line summary
  instead of inventing follow-up work to stay busy.

## v0.8.92 — AOM operator re-engages parked decision prompts

### Fixed

- **AOM idle re-poll keyed off visible screen, not raw bytes**: under
  Always-On Mode the operator went dormant on an executor parked at a
  decision prompt (e.g. Claude Code's "Which option? 1-4"). The re-poll
  fired only when `bytes_total` was unchanged, but a TUI executor emits
  cursor-blink / status-redraw bytes while parked, so the byte counter
  never stopped advancing and the "is it parked?" check was permanently
  false. The re-poll now keys off the despinnered visible-screen
  signature (`compute_progress_signature`) being unchanged since the last
  decision; added `OperatorState.last_decision_sig` stamped at engage
  (`crates/app/src/operator.rs`). Same gating otherwise: AOM only,
  decision point only, once per 45s, behind the phase + loop/cost guards.

- **Focus terminal after launching a spawn**: a freshly launched spawn now
  takes input focus (`ui/src/main.ts`).

## v0.8.91 — Spawns store cleanup + tasker panel polish

### Changed

- **Spawns store simplification**: trimmed dead fields and indirection from the
  spawns persistence path (`crates/app/src/spawns_store.rs`, `ui/src/spawns/types.ts`,
  `ui/src/spawns/chip.ts`, `ui/src/settings/spawns.ts`) and pruned now-unused
  spawn chip styles (`ui/src/spawns/styles.css`).

- **Tasker panel polish**: refinements to the tasker panel and kanban board
  (`ui/src/tasker/panel.ts`, `ui/src/tasker/styles.css`), plus operator and
  changes diff-viewer tweaks (`crates/app/src/operator.rs`, `ui/src/changes/index.ts`,
  `ui/src/changes/changes.css`, `ui/src/styles.css`).

## v0.8.90 — Operator skill editor + card icon actions

### Added

- **Operator skill editor**: the operator creator's Skills field is now a pill
  editor instead of a comma-separated text box — type + Enter/comma to add,
  click `×` or Backspace to remove. Below it, suggestion chips draw from a
  starter vocabulary merged with the live union of every operator's tags (the
  same vocabulary `handoff_task` routes on), and a hint spells out why skills
  matter: they're how operators delegate, a successful routed handoff earns the
  Good Delegate badge, and an operator with no skills can never receive a
  handoff. Lives in `ui/src/settings/operators.ts` + `operator-creator.css`.

### Changed

- **Operator card actions**: Edit / Duplicate / Delete on each operator card are
  now icon buttons (pencil / copy / trash) with tooltips, so the controls fit a
  narrow card instead of overflowing. `ui/src/settings/operators.ts`,
  `ui/src/styles/operator_chip.css`.
- **Unified esc pill**: the Settings close affordance now uses the same
  lowercase "esc" pill as the operator creator. `ui/src/settings/panel.ts`,
  `ui/src/styles.css`.

### Fixed

- **⌘A Select All**: ⌘A now dispatches to the focused surface — terminal buffer,
  input/textarea, or CodeMirror — instead of WebKit's native `selectAll:`, which
  selected the whole page DOM and never reached CM6's selection model.
  `crates/app/src/lib.rs`, `ui/src/main.ts`, `ui/src/tabs/manager.ts`.
- **Spec entrance Esc**: the entrance's Escape-to-dismiss listener moved to the
  capture phase so it fires even while xterm (which `stopPropagation()`s Escape)
  holds focus behind the overlay. `ui/src/spec-chat/entrance.ts`.
- **Updater "latest" race**: releases are now created as prereleases and only
  promoted to "latest" once the manifest job uploads `latest.json`, closing the
  ~25min window where the in-app Updates panel 404'd. Error copy reworded from
  the raw plugin message to an actionable note. `.github/workflows/release-*.yml`,
  `ui/src/settings/panel.ts`.

## v0.8.89 — Settings search

### Added

- **Settings search**: a search field at the top of the Settings nav rail that
  filters by section *content*, not just tab titles — so "email" surfaces
  Notifications and "api key" surfaces Providers. A per-section keyword map
  covers tabs that render empty until mounted (Spawns, Telegram, Metrics) plus
  common synonyms. The active tab only auto-jumps once it stops matching, so
  content stays put while you refine; Esc clears the filter. Lives in
  `ui/src/settings/panel.ts` with styling in `ui/src/styles.css`.

## v0.8.88 — Changes git-diff viewer + handoff UI auto-spawn

### Added

- **Changes git-diff viewer**: a new full-screen surface that lists a repo's
  staged/unstaged working-tree files and renders each file's unified diff
  (line-number gutter, add/del coloring, per-line syntax highlighting, clean
  binary/too-large placeholders) with stage/unstage actions. Backend extends
  `crates/app/src/git_tools.rs` with a pure diff parser and four
  `spawn_blocking` Tauri commands (`git_changes`, `git_file_diff`, `git_stage`,
  `git_unstage`); frontend lives in `ui/src/changes/`. Opens against the
  focused tab's repo via ⌘⇧C, the status-bar git popover "View changes"
  action, or a new git-compare button on the Structure file-tree toolbar.
- **Inter-operator handoff UI auto-spawn (Plan 2)**: when a handoff is routed,
  the receiver operator's tab now auto-spawns, attaches, binds, and gets the
  task injected — attach gates injection so a failed attach never leaves an
  orphaned executor (`ui/src/operator/handoff-spawn.ts`, `ui/src/main.ts`).
- **Skill-based handoff routing**: handoffs now route by `required_skills`
  (an operator's Skills) instead of operator name, advertising a dynamic skill
  enum and resolving the receiver via `resolve_by_skills` (skill union +
  overlap + xp tie-break).

### Changed

- **Operator "Tags" relabeled "Skills"**: reframes the field as the routing
  capability it now drives.

### Fixed

- **Changes surface rendering**: the surface first shipped with invented theme
  variables (`--bg-primary`, etc.) that rendered the frame transparent, letting
  the terminal bleed through. Switched to real Covenant tokens (`--bg-overlay`,
  `--border`, `rgba(var(--ink-rgb), a)`), inset the surface below the 38px
  titlebar and above the status bar, fixed the search input's `box-sizing` so
  its focus border isn't clipped, and disabled autocapitalize/autocorrect
  (`ui/src/changes/changes.css`, `ui/src/changes/index.ts`).
- **Rename numstat + diff errors**: `git --numstat` rename paths (`old => new`)
  are normalized to the destination so renamed files keep their line counts,
  and real `git diff` errors propagate instead of being masked by the
  untracked `--no-index` fallback (`crates/app/src/git_tools.rs`).

## v0.8.87 — Inter-operator handoff backend + metrics heatmap fix

### Added

- **Inter-operator handoff backend (Plan 1 of 2)**: operators can now hand a
  task off to one another. New `Handoff` domain types and a
  `teammate_handoffs` table with CRUD, a pure safety gate (depth / cycle /
  busy / chain-cap), a `handoff_task` tool surfaced via
  `DispatchOutcome::Handoff` extraction, and a router that resolves the
  receiver, enforces the chain, persists the handoff, creates the task, and
  emits `HandoffRouted`. Autonomous handoffs route straight from dispatch, and
  on receiver completion the delegator gets a report-back plus the
  `good_delegate` achievement (gated on success, with a hardened report
  fallback). Backend only; UI wiring lands in Plan 2.

### Fixed

- **Metrics heatmap blank on True Dark**: the contribution heatmap rendered as
  an empty grid on the OLED/True Dark theme because
  `body.theme-true-dark .cov-cell` (specificity 0,2,1) outranked the
  `.cov-cell.lN` intensity ramp (0,2,0), repainting every cell neutral. The
  l1–l4 ramp is now re-asserted under `theme-true-dark` at (0,3,1) so data
  colors win while empty cells stay neutral (`ui/src/score/styles.css`).
- **By-repo / Top-branches overflow**: both lists now cap at ~10 rows and
  scroll internally with a themed thin scrollbar and overscroll containment,
  instead of growing unbounded (`ui/src/score/styles.css`).
- **Self-mention in operator threads**: `@`-mentions now exclude the thread's
  own operator (`ui/src/teammate/mentions.ts`).

## v0.8.86 — Fix startup crash from Resources sampler

### Fixed

- **Startup crash (SIGABRT) on fresh v0.8.85 launch**: the Resources panel
  sampler in `crates/app/src/resources.rs` is spawned during `setup` before
  `app.manage(AppState)` runs, and `tokio::time::interval`'s first tick fires
  immediately — so the loop called `app.state::<AppState>()` before the state
  was registered. `Manager::state` panics on a missing type, aborting the
  whole app at launch. The sampler now uses `try_state` and skips ticks until
  `AppState` is available.

## v0.8.85 — Resources panel — live per-session CPU/mem monitor

### Added

- **Resources panel**: a new right-rail panel that live-monitors the CPU and memory of Covenant's own terminal sessions, grouped Group → Session, with whole-footprint totals (CPU / Memory / RAM share) in the header. A new pure `crates/metrics` crate holds the process-subtree aggregation (sums each session's shell + all descendants, tolerant of missing pids/cycles) and snapshot math; `crates/app/src/resources.rs` samples `sysinfo` every ~1.5s while the panel is open (paused when closed) and emits `resources_update`, with `resources_set_active`/`resources_sample_now` commands. `crates/pty` + `crates/session` expose each session's child PID. The frontend panel (`ui/src/resources/panel.ts`) joins the flat per-session snapshot with the tab/group model, sorts by memory or CPU, and refreshes via a ↻ button. It docks like Project Notes — top-aligned, resizable via the shared `--right-sidebar-w` handle, and reflows the terminal rather than covering it.
- **Operator chip + settings polish**: operator chip styling and provider/settings refinements (`ui/src/styles/operator_chip.css`, `ui/src/settings/`, `ui/src/icons/index.ts`).

### Fixed

- **AOM re-engages parked executors**: the autonomous operator now re-attempts a parked prompt once per cooldown via an idle re-poll, instead of going dormant when no human is typing (`crates/app/src/operator.rs`).
- **Resources panel hardening**: session titles render via `textContent` (no HTML injection from custom tab names), and the panel's layout was corrected from a full-bleed overlay to a proper top-aligned, resizable right-rail sidebar.

## v0.8.84 — Ctrl+1..9 quick-spawn shortcuts

### Added

- **Quick-spawn keyboard shortcuts**: `Ctrl+1`…`Ctrl+9` launch the Nth executor (in `listSpawns()` order) directly in the active terminal — the same action as picking it from the titlebar dropdown. The shortcut is auto-assigned by list position (no pinning, no persistence), so reordering spawns re-maps the keys. A `⌃N` hint now renders on the first nine rows of both the executor picker popover (`ui/src/spawns/chip.ts`) and the Spawns settings rail (`ui/src/settings/spawns.ts`). The command-line builder and shortcut-label helpers were extracted into `ui/src/spawns/shortcuts.ts` (unit-tested) so the picker click and the shortcut share one path, including the Claude theme injection. The global keydown handler in `ui/src/main.ts` handles `Ctrl+1..9` (distinct from `⌘1..9` tab-switch, which requires `metaKey`), and `ui/src/tabs/manager.ts` returns `false` for these chords at the xterm key layer so no stray control character reaches the PTY.

## v0.8.83 — Spec Creator UX — editable sections, resume, marker chips

### Added

- **Editable, persisted spec sections**: each section card in the Spec Creator's SPECIFICATION panel is now editable in place. Editing a body (on blur) rebuilds the canonical spec markdown and persists it through a new backend command `spec_author_save_markdown` (`crates/agent/src/spec_author.rs`, `crates/app/src/lib.rs`, `ui/src/api.ts`), so edits survive resume and flow into the published spec. A focus guard keeps a live token stream from clobbering the body you're typing in, and `innerText` + `white-space: pre-wrap` preserve multi-line bullet lists (`ui/src/spec-chat/live-spec.ts`).
- **Publish without waiting for the agent**: "Review & publish" now enables as soon as all six sections are drafted — the full spec is composed client-side from the section cards (`## Title` + body in canonical order), so you no longer have to coax the agent into emitting a final block (`ui/src/spec-chat/stream-state.ts`).
- **Section markers render as inline chips**: the `<!--section:goal-->…<!--/section-->` markers the agent embeds in its prose now render as compact `✓ Goal drafted` chips (pending mid-stream) in the reasoning column instead of leaking raw, via a new `renderProse` util (`ui/src/spec-chat/prose.ts`, `ui/src/spec-chat/activity-stream.ts`).

### Changed

- **Single-sourced section model**: the section list/titles, markdown parsing, and marker extraction live in one shared `ui/src/spec-chat/sections.ts`, replacing the copies previously duplicated across `live-spec.ts` and `entrance.ts`.

### Fixed

- **Resume now repopulates the spec panel**: reopening a draft rebuilds the section cards and marks the nav chips done — `hydrate` seeds the section map from the persisted `partial_md` and falls back to parsing the transcript's section markers for drafts that were authored via markers but never persisted `partial_md` (`ui/src/spec-chat/stream-state.ts`). Previously the panel fell back to empty skeletons.
- **SPECIFICATION panel scrolls**: `.spec-host` now takes the same `flex`/`min-height` constraint as its left-column twin so the panel's `overflow-y` actually engages on long specs (`ui/src/spec-chat/immersive.css`).
- **Redundant heading removed from cards**: section bodies are stored header-less, dropping the agent's baked-in `## Goal` that duplicated the card title.
- **Profile card buttons**: the Copy-link / View-profile buttons are marked `type="button"` to avoid an implicit form submit (`ui/src/score/profile.ts`).

## v0.8.82 — Shareable Covenant Score profile (opt-in)

### Added

- **Shareable Covenant Score + achievements profile**: a real composite Covenant Score (0–10) now exists — 70% verified achievement reputation, 30% streak, with saturating curves so it can't be farmed — and you can **opt in** to publish a public profile at `forge.covenant.uno/u/<login>` showing the score, the six reputation dimensions, and your earned badges. New `crates/score/src/profile_card.rs` holds the pure, unit-tested score formula + an aggregates-only snapshot builder (it never copies repo names, branches, paths, or commands — a test guards against leakage); `crates/score/src/sync.rs` gains publish/unpublish transport; the opt-in flag lives in the score store (off by default) and is surfaced as a "Public profile" card in the Score/Achievements UI with a live preview and share link (`ui/src/score/profile.ts`, `ui/src/score/api.ts`). The backend (`covenant-server`) stores the snapshot, **recomputes the score server-side** so a tampered client can't inflate it, and renders the score + badges (with OpenGraph tags) on `/u/:login`.

## v0.8.81 — Titlebar buttons unified as toggles + spec-draft polish

### Added

- **Titlebar right-cluster is one uniform set of toggles**: every button in the titlebar's right cluster (Blocks/Files/Activity/Recall, Project Notes, Teammate, Tasker, and the Browser globe) now behaves as the same on/off toggle with equal visual weight, driven by a single `RightRailController` state machine (`ui/src/titlebar/right-rail.ts`) that owns the right-rail slot. The fold button at the end is the single collapse authority — folding closes whatever panel is open and clears every highlight, and clicking any toggle while folded unfolds and lights only that one. The globe became a real toggle that opens/closes a browser tab (with a double-click guard) instead of spawning a new tab on every click (`ui/src/main.ts`, `ui/src/tabs/manager.ts`). This also closes two long-standing bugs: clicking a view while a panel was open could leave the panel open, and folding the rail could leave a button highlighted while nothing was shown.
- **Project Notes drafts open in the Spec Creator**: draft cards open directly in the spec-chat overlay via an `onOpenDraft` callback that carries the draft id (`ui/src/project-notes/`, `ui/src/spec-chat/`, `ui/src/main.ts`).
- **Landing footer + navbar links**: the landing footer logo links to karluiz.com and the navbar gains Forge/Remote links (`landing/src/components/`).

### Fixed

- **Spec Creator resume rendering**: resuming a spec session rebuilds tool chips from the persisted transcript and streams activity incrementally instead of dumping tool output as walls of text (`ui/src/spec-chat/transcript.ts`, `ui/src/spec-chat/activity-stream.ts`, `crates/agent/src/spec_author/`).
- **Landing mobile layout**: mobile navbar hamburger menu plus tightened section spacing, and a horizontal-overflow fix with a responsive mobile footer (`landing/src/components/Navbar.astro`, `landing/src/styles/globals.css`).

## v0.8.80 — Achievements earn from real activity + True Dark metrics

### Added

- **Achievement emitters wired to real activity**: the badge engine's nine previously-dormant achievements now fire from actual operator/system events. Live emitters: **finisher**, **clean_run**, and **recovery_artist** fire on task completion (`crates/app/src/teammate/commands.rs`) gated on new sticky per-task flags the supervisor tracks (`saw_failed_block`/`ever_blocked` on `TaskCtx`, read via `TaskSupervisor::task_flags`); **build_steward** fires on a passing build/test/lint command via a pure classifier (`crates/app/src/teammate/build_classify.rs`); **guardian** fires when the safety blocklist refuses an action (`crates/app/src/operator.rs`, `crates/app/src/rc_agent.rs`); **secret_keeper** fires when operator-mind masking redacts a secret; and **spec_keeper** fires when a spec is read or created before the first code edit in a task, via a new per-session state machine fed from `NotchHub::set_phase` that uses `ExecutorPhase::Reading/Writing { file }` (`crates/app/src/teammate/spec_edit_tracker.rs`). The emitter layer is pure `*_fact()` builders plus thin `record_*()` wrappers (`crates/score/src/achievements.rs`, `crates/score/src/lib.rs`). `good_delegate` and `command_librarian` ship as dormant builders pending their trigger sources.
- **Mission chip truncate + hover-revealed remove**: the status-bar mission chip truncates long text and reveals a remove (×) control on hover (`ui/src/status/bar.ts`).

### Changed

- **True Dark for the whole metrics page**: the Score/Metrics page gains a page-wide `body.theme-true-dark` block — neutral near-black surface steps and a calmed brand teal — replacing the hardcoded blue-gray surfaces that read as a harsh island on OLED (`ui/src/score/styles.css`).
- **Achievements card homologated to the app theme**: the achievements card is driven from app theme tokens and unified onto the page teal via a card-local `--ach-accent`, instead of bespoke hardcoded colors (`ui/src/score/`).
- **Stable dedupe hashing**: achievement dedupe keys use a deterministic FNV-1a hash rather than `DefaultHasher`, so persisted keys stay stable across Rust versions (`crates/score/src/achievements.rs`).

### Fixed

- **spec_keeper repo attribution**: the `spec_keeper` award is attributed to the edited file's git-root repo rather than the process-global current-context, avoiding wrong or dropped attribution when a task is completed from the teammate panel (`crates/app/src/teammate/spec_edit_tracker.rs`, `crates/app/src/teammate/commands.rs`).

## v0.8.79 — Per-operator GitHub tools + Score multi-repo scanners

### Added

- **Per-operator GitHub access + `gh_*` tools**: operators gain a `GithubAccess` level (`Off`/`ReadOnly`/`ReadWrite`) stored in the registry with a SQLite migration (`crates/app/src/operator_registry.rs`); a new access-gated GitHub tools module (`crates/app/src/teammate/github_tools.rs`) registers `gh_*` tool definitions in both LLM dispatch paths, and the keychain GitHub token is attached to the operator's `ToolEnv` according to its level. The device-flow sign-in now requests `repo` scope and persists the granted scope, and the operator creator gets a GitHub access control plus a re-connect CTA when the stored token lacks `repo` scope (`ui/src/settings/operators.ts`).
- **Score scans every repo, not just the cwd**: the context resolver registers every git toplevel it sees into a persisted registry, and the periodic commit scanner iterates that registry with per-repo cursors, dedupe, full-history backfill, and self-healing (`crates/score/`). LLM token usage is now attributed to the owning repo/branch, and a new spec scanner walks the same registry for `**/specs/**/*.md` so "Specs created" stops reading 0 (`crates/app/src/score/spec_scanner.rs`).
- **Spec Creator constellation entrance**: opening the Spec Creator lands on a full-bleed particle-sky surface where the constellation assembles from the corners, with draft cards and a hero CTA (`ui/src/spec-chat/entrance.ts`).
- **Task cleanup affordances**: finished (done/cancelled) task cards in the teammate panel show a per-task Delete button and the filter row gains a bulk "Clean (N)" action — the commands existed but were never passed to the panel (`ui/src/main.ts`, `ui/src/teammate/panel.ts`).
- **Spawns master-detail editor**: the settings Spawns section is now a brand-colored rail plus a single-spawn editor with labeled fields, scoped arg chips, and a live composed-command preview; set-default is exclusive (`ui/src/settings/`).
- **Operator cards show tags**: settings cards render the operator's tags and switcher rows show the first tag; the hard-constraints field gains an explainer with one-click example rules (`ui/src/settings/operators.ts`).

### Changed

- **Debug probe removed**: the temporary on-screen red contextmenu probe banner ("window capture: …") added to diagnose the mission-chip right-click is reverted from production builds (`ui/src/main.ts`, `ui/src/status/bar.ts`).

### Fixed

- **`gh_*` hardening**: path segments are validated, the token is redacted from `Debug` output, and HTTP calls get a timeout (`crates/app/src/teammate/github_tools.rs`). GitHub access survives duplicating an operator, and the re-connect CTA no longer duplicates on rapid re-render (`ui/src/settings/operators.ts`).
- **Stuck tooltips**: tooltips hide when the content under a stationary cursor moves away (`ui/src/tooltip/tooltip.ts`).
- **Spec Creator repo grounding**: the research agent is grounded at the git root with an honest no-repo fallback instead of silently jailing to `~/.covenant` (`crates/app/src/spec_agent.rs`).
- **Score range heading**: the By-repo card heading reflects the active time range (`ui/src/score/`).

## v0.8.78 — Custom tab styling + brainstorm preview design fix

### Added

- **Custom tab/group styling**: the settings panel gains controls for tab group appearance — `group_shape` and `group_bg` are now persisted in the backend tab-style config (`crates/app/src/settings.rs`), wired through `ui/src/settings/panel.ts`, `ui/src/tabs/custom-style.ts`, and `ui/src/styles/tab-themes/custom.css`. Configs saved before these fields existed load with sane defaults.

### Fixed

- **Brainstorm HTML previews render with design**: superpowers brainstorm screens (`.superpowers/brainstorm/*/content/*.html`) are body-only fragments whose design lives in the brainstorm server's frame template. The structure preview tried to load the designed page from that server at `/<file>.html`, but the server only serves `/` (newest screen, wrapped) and `/files/<name>` (raw), so the per-file URL 404'd — and the `no-cors` liveness probe couldn't detect the 404, swapping the iframe to a blank "Not found" page. The cross-origin probe is gone; fragments are now wrapped locally with a vendored copy of the frame template (`ui/src/structure/brainstorm-frame.ts`, `ui/src/structure/preview.ts`) so any file renders with design, offline.
- **Remote presence-dot polish**: refinements to the titlebar web-presence indicator (`ui/src/remote/presence-dot.ts`).

## v0.8.77 — Teammate tasks can be marked done + operator release fixes

### Added

- **Mark done on task rows**: active/blocked tasks in the teammate Tasks tab
  now have a "Mark done" button next to Stop. It flips the task to `done`
  (stamping `completed_at`), posts a "Task completed." lifecycle message, and
  releases the operator so it can immediately take the next task — the tab
  stays open. New `teammate_complete_task` command + `complete_task_inner` in
  `crates/app/src/teammate/commands.rs`, `teammate_mark_task_done` in
  `crates/app/src/storage.rs`, button wiring in `ui/src/teammate/panel.ts`.
  Previously nothing in the app ever wrote `TaskStatus::Done`, so operators
  stayed "on task" forever once they confirmed anything.

### Fixed

- **Stop now frees the operator**: `teammate_cancel_active_task` never
  released the in-memory runtime claim, so after stopping a task every later
  confirm failed with "operator is already working on another task" until an
  app restart. Cancel goes through the new `cancel_active_task_inner`, which
  calls `runtime.finish_task` (`crates/app/src/teammate/commands.rs`).

- **Confirm is atomic**: `confirm_task_inner` persisted the task row and
  marked the proposal confirmed *before* claiming the operator runtime. A
  busy-operator rejection left behind an orphaned Active task and a proposal
  stuck answering "this proposal was already confirmed" to every retry. The
  runtime is now claimed first and rolled back if the storage writes fail.

- **Confirm errors resync the chat**: a failed confirm now repaints the
  thread from storage instead of leaving the stale proposal card interactive,
  which invited retry-spam against an already-settled proposal
  (`ui/src/teammate/panel.ts`).

## v0.8.76 — Workspace rename/delete prompts + tab-switch flicker fix

### Added

- **Delete current workspace from the command palette**: new "Delete current workspace" action (⌘⇧P), gated behind a centered confirm card in the palette language ("Delete 'X'? Its tabs will be closed." — Enter confirms, Esc cancels). The chip context-menu Delete routes through the same confirm instead of deleting instantly. Deleting the active workspace switches to the most-recently-used one first; the last workspace can't be deleted (`ui/src/workspaces/confirm-prompt.ts`, `ui/src/workspaces/actions.ts`, `ui/src/workspaces/switcher.ts`).
- **Remote dashboard master-detail redesign**: armed-first compact tab list with an auto-mirroring detail pane — the live mirror follows the selected tab (one at a time, only while the pane is visible and the desktop is online). Mobile gets list→detail navigation, the pairing-token row collapses once paired, and status distinguishes relay-connected from desktop-online (`landing/src/islands/RemoteDashboard.ts`, `landing/src/remote/view-model.ts`).
- **Titlebar presence dot**: the fixed top-right web-presence pill covered the titlebar view buttons; it's now a pulsing dot beside the COVENANT brand with a hover popover (remote count, allow-new-tabs toggle, Disable all). Click pins; Esc/outside click closes (`ui/src/remote/presence-dot.ts`, `ui/src/main.ts`).
- **Score sync drains the full backlog**: `push_once` sent one 500-event batch per 5-minute tick, so a large first sign-in backlog (~38k events) took hours; `sync::push_drain` now loops batches with 250ms pacing until a partial batch, in both the periodic loop and manual sync (`crates/score/src/sync.rs`).

### Fixed

- **Workspace rename prompt**: the command-palette refactor left rename as a bare unstyled `<input>` floated at fixed coordinates after the palette closed — an orphaned box in the dark. It's now a centered prompt card reusing the palette overlay/card language, prefilled and selected, Enter saves / Esc cancels; used by both the palette action and the chip context menu (`ui/src/workspaces/rename-prompt.ts`, `ui/src/workspaces/switcher.ts`).
- **Spec Creator chooser giant buttons**: "Start a new one" and "Blank draft (no chat)" are direct children of the fullscreen column-flex chooser and inherited `flex: 1`, so they grew to split the leftover viewport height as huge cards. Pinned to auto height and the same 480px width as the resume rows (`ui/src/styles.css`).
- **Tab-switch flicker/jump**: tab activation painted a stale WebGL canvas, cleared it on `fit()`, forced a second reflow via an unconditional resize nudge, and jumped the viewport with `scrollToBottom()` even when scrolled up. `activate()` now keeps the outgoing pane on screen as the visual frame while the incoming pane lays out invisibly, and the resize nudges are gated (`ui/src/tabs/manager.ts`).

## v0.8.75 — Tasker inline project rename (double-click header)

### Added

- **Rename Tasker projects inline**: double-click a project name in the Tasker panel header to edit it in place — Enter or clicking away commits, Escape cancels, an empty name is a no-op, and the built-in Inbox stays non-renameable (matching the delete affordance). The input mirrors the header's uppercase styling with an accent underline (`ui/src/tasker/panel.ts`, `ui/src/tasker/styles.css`).

### Fixed

- **Task title inline edit commits on change**: the task title input only committed on `blur`, so `change`-driven commits were dropped; it now commits on `change` as well, with a guard against double-commits when both events fire (`ui/src/tasker/panel.ts`).

## v0.8.74 — Auth persistence fix (Keychain backend)

### Fixed

- **Sync auth now actually persists**: `keyring` v3 makes the OS-keychain backends opt-in, and the dependency was declared as `keyring = "3"` with no features — so it silently fell back to an in-memory `mock` store. The GitHub token and backend JWT never reached the real Keychain and vanished on every restart, so the sync panel showed "Synced as @user" (read from SQLite, which does persist) while every sync failed with "not signed in". Enabled the `apple-native` + `windows-native` features so credentials hit the real macOS/Windows keychain (`crates/score/Cargo.toml`).
- **Tasker board add-task cancel**: the inline add-task form gains an explicit × discard button and cancels on Escape (`ui/src/tasker/board.ts`, `ui/src/tasker/board.css`).

## v0.8.73 — Sign-out fix + full-width sync panel

### Fixed

- **Disconnect now actually signs out**: the score-sync panel cached the current user in memory (`getCurrentUser`) and never invalidated it on sign-out, so clicking Disconnect left the panel still showing "Synced as @…". The handler now clears the cache (`setCurrentUser(null)`) before re-rendering (`ui/src/score/page.ts`).
- **Sync panel layout**: the score-sync card now spans the full width of its container (`width: 100%; box-sizing: border-box`) instead of sitting short (`ui/src/score/styles.css`).

### Added

- **Dev JWT escape hatch (debug builds only)**: unsigned `tauri dev` binaries can't reliably read the macOS Keychain, which blocked local end-to-end testing of remote control. `load_jwt()` now honours a `COVENANT_DEV_JWT` env var in debug builds; it is `#[cfg(debug_assertions)]`-gated so it is compiled out of release builds entirely (`crates/score/src/auth.rs`).

## v0.8.72 — Remote pairing token copy fix

### Fixed

- **Copy Remote Pairing Token**: the File-menu action now copies via `pbcopy`
  from Rust (`crates/app/src/lib.rs`) instead of the webview clipboard, which
  rejected with "Document is not focused" when fired from a native menu click —
  so nothing was copied. Emits `menu://pairing-token-copied` with a
  `copied`/`signed-out`/`error` status the UI (`ui/src/main.ts`) toasts.

- **Tasker kanban selection**: disabled text selection on the board
  (`.kb-columns` in `ui/src/tasker/board.css`) so dragging or select-all no
  longer highlights every card, header, and date; the inline add-task input
  stays selectable.

## v0.8.71 — Tab collapse-all toggle + custom tab styles

### Added

- **Custom tab styles**: a new `tab_styles` experimental flag unlocks a "Custom tab style" section in Settings → Appearance where tab shape, background mode, active indicator, height, and gap are composed independently (Discord-style) instead of being locked to monolithic presets. Changes apply live and persist to `config.json` (`ui/src/tabs/custom-style.ts`, `ui/src/styles/tab-themes/custom.css`, `ui/src/settings/panel.ts`, `crates/app/src/settings.rs`; spec in `docs/specs/3.24-tab-styles.md`).

### Changed

- **Collapse-all is now a toggle**: the topbar collapse-all button flips between collapse and expand, swapping its glyph (`chevronsDownUp` ⇄ `chevronsUpDown`) and tooltip to match the current state, with a quick spring-scale animation on each click. Backed by new `TabManager.expandAllGroups()` / `areAllGroupsCollapsed()` and synced after manager init to avoid a boot-time reference error (`ui/src/main.ts`, `ui/src/tabs/manager.ts`, `ui/src/icons/index.ts`, `ui/src/styles.css`).

## v0.8.70 — Score sign-in button fix

### Fixed

- **Score sign-in / sync buttons**: the "Sync now", "Disconnect", and "Sign in with GitHub" buttons in the score-sync panel were missing `type="button"`, so a click submitted the enclosing settings form — closing the panel and aborting the action mid-flight. Disconnect silently failed to sign out (the cached profile kept reappearing) and sign-in could be interrupted. All three are now `type="button"` (`ui/src/score/page.ts`).

### Changed

- **Spec-chat polish**: refinements to the immersive spec-chat flow and surrounding UI (`ui/src/spec-chat/`, `crates/agent/src/spec_author.rs`, plus minor browser-pane and zoom tweaks).

## v0.8.69 — Command palette glassmorphism

### Changed

- **Frosted command palette**: the command palette scrim and card now use layered `backdrop-filter` blur/saturate with theme-aware surface tokens (`--cp-scrim`, `--cp-card-bg`, `--cp-card-border`, `--cp-card-sheen`) tuned for light and True Dark, plus softened multi-layer shadows and a larger corner radius (`ui/src/styles.css`).

## v0.8.68 — Tasker board switcher + notes polish

### Added

- **Non-native project switcher (Board)**: the board's project picker is no longer a native `<select>` — it's a custom listbox dropdown (button + popup menu) styled to match the app, with hover states, an accent check on the current project, and click-outside dismissal (`ui/src/tasker/panel.ts`, `ui/src/tasker/board.css`).

### Changed

- **Icon-only view toggle**: the TASKER `List | Board` toggle now renders glyphs (list lines / columns) instead of text labels, via new `listView` / `boardView` icons (`ui/src/icons/index.ts`, `ui/src/tasker/panel.ts`, `ui/src/styles.css`).
- **Board notes fill the dock**: the Notes textarea flex-grows to fill the board detail dock instead of leaving a large empty void below it; the inline list sheet keeps a modest 88px floor with content autosize (`ui/src/tasker/board.css`, `ui/src/tasker/styles.css`, `ui/src/tasker/panel.ts`).

## v0.8.67 — Command palette + Tasker kanban board

### Added

- **Unified command palette**: a centered overlay that searches and acts across workspaces, tabs, and actions in one place, with grouped sections and a flat keyboard cursor. New `CommandPalette` built from a pure section builder plus an action registry (new/rename workspace, close tab); the workspace switcher now delegates to it instead of its old bespoke popover (command-palette module under `ui/src/`, switcher refactor, `ui/src/main.ts` keybinding).
- **Tasker kanban Board view**: a `List | Board` toggle in the TASKER header; switching to Board expands the panel to fullscreen, mirroring Project Notes' `.pn-fullscreen` via a new `body.tasker-board` rule. Columns are task statuses (To Do / In Progress / Done) for one project at a time with a project switcher; drag a card between columns to change its status, add tasks inline per column, toggle done from the card checkbox, and click a card to open the existing details sheet docked on the right. New `ui/src/tasker/board.ts` + `ui/src/tasker/board.css`, integrated through `ui/src/tasker/panel.ts`. Frontend-only — no backend or storage migration.

### Changed

- **Switcher delegates to the palette**: the workspace switcher hands off to `CommandPalette`, dropping its old popover and tier-finder code; command-palette overlay styles were added and dead popover CSS removed (`ui/src/styles.css`).

### Fixed

- **Switcher chip right-click**: right-clicking a workspace chip now opens the workspace context menu for the active workspace.
- **Board drag, theming, and stale project**: reset `suppressClick` at drag start so a card click immediately after a cross-column drop is no longer swallowed; board column/card surfaces use `var(--ink-rgb)` so they invert correctly under the light theme; and the board self-heals when its current project was deleted from the list view (`ui/src/tasker/board.ts`, `board.css`, `panel.ts`).

## v0.8.66 — Live tab mirror (RC-3) + pairing token

### Added

- **Live tab mirror (RC-3)**: stream an armed tab's screen to the `/remote` web dashboard byte-for-byte. The desktop tees raw PTY bytes onto a broadcast (`crates/session/src/lib.rs` `Session::subscribe_raw_bytes`, additive — the existing UI byte path is untouched), and the rc-agent forwards them, gated on arming, as an initial `mirror_screen` snapshot followed by base64 `mirror_data` frames (`crates/app/src/rc_agent.rs`; `run_once` restructured to fan read-loop replies and per-mirror tasks through one outbound channel). The dashboard mounts an `xterm.js` panel that renders them live, one mirror at a time, with a "Mirror" button per armed tab (`landing/src/islands/RemoteDashboard.ts`, `landing/src/remote/protocol.ts`, new `@xterm/xterm` dep).
- **Copy Remote Pairing Token**: a File-menu item + `rc_pairing_token` command that copies the desktop's JWT to the clipboard, so the `/remote` dashboard can be paired without minting a token by hand (`crates/app/src/lib.rs`, `ui/src/main.ts`).

### Fixed

- **Backend URL default**: the desktop client defaulted to the dead `covenant.uno` apex; it now defaults to `forge.covenant.uno` so login and sync reach the live backend (`crates/score/src/auth.rs`).

## v0.8.65 — Remote open-tab (RC-2) + spec-chat resume fix

### Added

- **Remote tab lifecycle (RC-2a/2b)**: armed tabs can now be closed and focused, and new tabs opened, from a web client over the relay. Close/focus frames drive the `TabManager` via `rc://tab` events; open is gated behind a global `allow_remote_open` flag (default off) toggled from the corner pill, with rejected opens surfaced as `open_not_allowed`. Adds frame builders, gated command handlers, frontend `rc://tab/open` listeners, and a "New Tab" button (`crates/app`, `ui/src/...`).
- **OpenCode usage tracking**: the score/metrics page now tracks OpenCode as an external usage source (`crates/...`, `ui/src/...`).

### Fixed

- **Spec Creator loses chat on resume**: the immersive Spec Creator mounted with an empty `StreamState`, so resuming a draft rendered a blank conversation column even though the full transcript was persisted on disk. Added `StreamState.hydrate()` and wired it from the immersive mount via `specAuthorLoadDraft`; completed drafts also restore their final markdown so publish is immediately available (`ui/src/spec-chat/immersive.ts`, `stream-state.ts`).
- **Metrics page blanking on query failure**: added an error boundary around the score refresh so a single failed query can no longer blank the entire metrics page (`ui/src/...`).

## v0.8.64 — Remote tab control (RC-1) + Tasker redesign

### Added

- **Remote tab control (RC-1)**: a web client can now drive desktop tabs over the github_id-keyed WS relay, gated behind explicit per-tab arming. A per-session armed flag (default off) is toggled from the tab context menu; only armed tabs accept a relayed `send_input`, and rejected commands surface back to the web client. Backend commands `rc_set_armed` / `rc_get_armed` / `rc_disarm_all`, an `AtomicBool` armed flag in the tabs frame, and `send_input` / rejection state on the web side (`crates/app`, `ui/src/...`, rc-agent emits `rc://web-presence`).
- **Remote-active corner pill + kill-switch**: when a web client is present and controlling, the desktop shows a corner pill with a one-click kill-switch to disarm all tabs; mounted at startup and guarded against double-mount.
- **Delete projects in Tasker**: project headers now have a hover trash button (Inbox protected) wired to `storage.deleteProject`, removing the project and its tasks (`ui/src/tasker/panel.ts`).
- **Full-width auto-grow notes**: task notes use a full-width textarea that grows with content instead of the cramped single-line field (`ui/src/tasker/panel.ts`, `styles.css`).

### Changed

- **Tasker visual redesign**: square full-width task cards, borders-only expanded card with a warm hairline under True Dark (no fill), light-stroke project chevrons with a rotate animation, and a dashed-border "Add task" button matching project notes (`ui/src/tasker/styles.css`).
- **Remote control internals**: `inject_to_session` is now `pub(crate)`, reject reasons are typed, and message helpers are tested (`crates/app`).

### Fixed

- **Settings pane collapse with Tasker open**: opening Settings while the Tasker sidebar was active left `#layout` in a multi-column grid, collapsing the provider detail pane (background bled through). Full-page routes now collapse the right rail column in both default and `tabbar-left` modes (`ui/src/styles.css`).
- **Provider header overlap**: the provider detail title, status pill, and subtitle overlapped in a narrow pane — added ellipsis + `flex-shrink` so they lay out cleanly (`ui/src/styles.css`).
- **Remote control edge cases**: rejections persist across a tabs-frame refresh, and rendering is deferred during IME composition so it doesn't drop in-progress input (`ui/src/...`).
- **Title edit dismiss**: editing a task title now commits on blur and discards on Escape, instead of leaving the input stuck open (`ui/src/tasker/panel.ts`).

## v0.8.63 — WYSIWYG markdown editors + immersive operator creator

### Added

- **WYSIWYG markdown editor (`MarkdownEditor`)**: a reusable, lazy-loaded Milkdown-based editor replacing raw textareas, with markdown input-rules (`## `, `- `, `**…**`, `> `, `` `code` ``) and ⌘B/⌘I — no toolbar. Lives in `ui/src/ui/markdown-editor.ts` (+ token-based skin `markdown-editor.css`) and is wired into the operator SOUL body, Project Notes → docs (`ui/src/project-notes/docs-tab.ts`), hard constraints, and the Spec Creator composer (`ui/src/spec-chat/immersive.ts`, Enter=send / Shift+Enter=newline). ProseMirror loads only on first use, so the initial bundle is unaffected.
- **Immersive full-screen operator creator**: the operator editor is now a full-window takeover (scrim / rail / stage / footer) with per-section middle controls, an always-live SOUL preview, and a header identity chip (`ui/src/settings/operators.ts`, `ui/src/settings/operator-creator.css`).
- **"Run selection in new tab"**: pane context-menu action to run the selected text in a fresh tab (`ui/src/tabs/manager.ts`).

### Changed

- **VOICE uses the custom select**: the operator VOICE dropdown now uses `CustomSelect` (matching MODEL) instead of the native browser `<select>`, and follows the active theme including True Dark.
- **SOUL.md source pane**: always-visible (no collapsible chevron), read-only, and fills the full pane height — the WYSIWYG body + structured controls are the source of truth (`ui/src/settings/operators.ts`, `ui/src/styles/operator_chip.css`).
- **Theme-aware overlays + True Dark**: spawns popover, tooltips, the notch activity-filter dropdown, and the immersive spec-creator / operator-creator surfaces derive from theme tokens (`--bg-overlay` / `--border` / `--ink-rgb`) so they go neutral black under True Dark and invert under Light. The `ui-select` popover now out-ranks full-window modals (z-index fix).
- **Native context menu suppressed** except in editable fields (`ui/src/...`); operator modal close/teardown animations and listener cleanup tightened.

### Fixed

- **`api.ts` ThemeMode missing `true_dark`**: the `ThemeMode` union in `ui/src/api.ts` omitted `true_dark`, breaking `tsc`. Added it.
- **MarkdownEditor robustness**: boot failures are logged; programmatic body sets are `finally`-guarded so a throw can't wedge the change-suppression flag; placeholder is propagated onto the ProseMirror root; dead `op-soul-body`/`op-soul-preview` CSS pruned.

## v0.8.62 — Tasker linear redesign + spec-prompt tab targeting

### Added

- **Tasker linear/dense redesign**: the expanded task is now a key:value sheet — an inline segmented **Status** switch, selectable **Priority** dots, a **Due** pill, a Notes field, and a muted Delete action — replacing the old chip+popover menus. Each row carries a priority-colored left spine and reveals its `start` action on hover (`ui/src/tasker/panel.ts`, `ui/src/tasker/styles.css`).
- **Custom date picker**: the Due date opens a themed calendar (Mon-first grid, month nav, Today, Clear date) instead of the native control, portaled to `document.body` so it floats free of the panel's clipping (`ui/src/tasker/panel.ts`).

### Changed

- **Spec-prompt tab targeting**: when several open tabs share the deepest cwd matching a new spec's path (the common multi-tab-in-one-repo case), the toast now binds to the *active* tab rather than an arbitrary match (`ui/src/aom/spec-prompt.ts`, test in `spec-prompt.test.ts`).
- **Tasker cleanup**: dropped the dead outside-click handler and orphaned menu/priority CSS; the row spine is the single priority indicator (`ui/src/tasker/`).

### Fixed

- **Tasker selected-card contrast**: the expanded task used an accent tint that read as a harsh jump on the True Dark theme; switched to a subtle neutral lift. Also removed bare `.tasker-priority-*` background rules that were painting the entire task card amber (`ui/src/tasker/styles.css`).

## v0.8.61 — True Dark theme + /remote dashboard

### Added

- **True Dark (OLED) theme**: a fourth Appearance mode rendering neutral pure-black, fully-opaque chrome — no blue tint, no wallpaper bleed-through regardless of the window-background setting. Wired end-to-end: `ThemeMode::TrueDark` in `crates/app/src/settings.rs`, `body.theme-true-dark` tokens in `ui/src/styles.css`, `resolveTheme` in `ui/src/theme/mode.ts`, applied on boot and in `applyTheme` (`ui/src/main.ts`), and a new radio in `ui/src/settings/panel.ts`.
- **`/remote` web dashboard**: a remote tab-control dashboard island with a WebSocket client (reconnect, backoff, token persistence), a pure protocol module (parse/url/reducer) with unit tests, and a Playwright render test. The desktop RC agent spawns at startup, collects tabs, and connects over a github_id-keyed relay (`crates/.../rc_agent`).

### Changed

- **Theme-aware popovers, tooltips & dropdowns**: the spawns executor picker, `ck-tooltip`, and the notch activity-filter dropdown now derive their surfaces from theme tokens (`--bg-overlay` / `--border` / `--ink-rgb`) instead of hardcoded blue-tinted values, so they go truly black under True Dark and invert under Light (`ui/src/spawns/styles.css`, `ui/src/styles.css`). The notch dropdown previously fell back to a nonexistent `--bg-panel-2`.
- **Project Notes docs toggle**: replaced the chunky pill edit/preview toggle with minimalist line icons (pencil / eye) carrying tooltips (`ui/src/project-notes/docs-tab.ts`, `ui/src/project-notes/styles.css`).
- **Agent-occupied tab titles**: tabs running an agent are now titled off the live screen (`ui/src/tabs/manager.ts`).

### Fixed

- **Tasker date picker clipping**: the due-date picker is portaled to `<body>` so it isn't clipped by the panel, and its outside-click listener is torn down on close (`ui/src/tasker/panel.ts`).

## v0.8.60 — Immersive Spec Creator + Tasker redesign

### Added

- **Immersive streaming Spec Creator**: the spec chat routes into a full immersive surface (entrance, composer, publish, Esc) backed by a real Anthropic SSE streaming dispatcher. An agentic, exploration-first tool-loop (grep / read_file / list_dir, repo-jailed and read-only) drives `spec://` events with live per-section fills, surfacing thinking and tool calls as they happen (`crates/agent/src/spec_author/{stream,tools}.rs`, `crates/app/src/lib.rs`, `ui/src/spec-chat/*`). Secrets are masked, secret files denied, and tool tests isolated.
- **Tasker inline editing**: tasks edit in place — title, status, priority, and due date via popovers — with an inline list composer replacing the native `prompt()`. Checkboxes complete any state, reopening clears `completedAt`, and the start affordance flips pending tasks to active.

### Changed

- **Tasker Covenant styling**: flat rows, Covenant tokens, popovers, and uppercase lists for a homogeneous panel; popovers close on outside click.

### Fixed

- **Activity event drawer**: clicking an event opens an opaque detail drawer (no longer bleeds the list through), shows a human origin (executor/mission) instead of a raw ULID short, and traces operator decisions to their source tab with a race-guard for disabled operators (`ui/src/spec-chat/activity-stream.ts`).
- **Spec chat listener leak**: the Tauri event listener is disposed on immersive close (`ui/src/spec-chat/immersive.ts`).

## v0.8.59 — Per-operator Stop in Mission Control + Pi scroll fix

### Added

- **Per-operator Stop in Mission Control**: each operator tile now exposes its own Stop control so a single runaway operator can be halted without touching the others (`ui/src/convergence/tile.ts`, `ui/src/convergence/overlay.ts`, `ui/src/styles.css`).

### Changed

- **Killed floating operator toasts**: removed the free-floating operator toast notifications in favor of surfacing operator status inline in the activity feed (`ui/src/aom/activity-feed.ts`).

### Fixed

- **Pi chat no longer snaps to the top while scrolled up**: Pi's streaming renderer calls `replaceChildren()` on every `text_delta`, which makes WKWebView snap the scroll container's `scrollTop` to 0 — yanking the view to the top on each delta whenever the reader had scrolled up to read earlier output. The view now records the reader's parked offset and restores it after each render instead of bailing out (`ui/src/executors/pi/view.ts`).

## v0.8.58 — AI-generated tab titles

### Added

- **AI-generated tab titles**: shell tabs now name themselves with a ≤2-word activity label (e.g. `release prep`, `debugging auth`) instead of the meaningless `zsh N` counter. The label is produced for free by the existing per-session summarizer — it returns a `TITLE:` sentinel line alongside the rolling summary (`crates/app/src/summarizer.rs`), which is persisted in the `summaries` table (`crates/app/src/storage.rs`) and published as a new `SessionEvent::TitleSuggested` on the bus (`crates/session/src/lib.rs`). The frontend applies it to a tab's auto-title, never overriding a manual rename (`ui/src/tabs/manager.ts`, `ui/src/api.ts`).

- **CWD-basename cold start**: a brand-new tab is born named after its working directory (e.g. `covenant`) and upgrades to an activity label once work begins, killing `zsh N` immediately (`crates/app/src/world.rs`, `ui/src/tabs/manager.ts`).

### Fixed

- **Summary preservation on title-only responses**: a degenerate `TITLE:`-only model response no longer clobbers the stored rolling summary with an empty string (`crates/app/src/summarizer.rs`).

## v0.8.57 — Operator conversational comms + solo AOM + Mission Control

### Added

- **Operator conversational Telegram comms**: the channel is now quiet and conversational. The operator gates on the executor's live phase (`crates/app/src/operator.rs` reading `notch.rs`) so it never types into or escalates a *working* executor — killing the false "stuck/Whirlpooling" escalation floods. Duplicate escalations of the same `(session, kind)` coalesce into one edited message instead of spamming, and an inbound "what's going on?" now gets an English, threaded, cross-tab status reply (`crates/app/src/telegram/{mod,inbound,status,outbound,types}.rs`).

- **Solo autonomous mode**: run AOM scoped to a single tab via a per-session ephemeral `solo_aom` flag, surfaced through `Cmd+Shift+S` and an operator chip menu item (`crates/app/src/operator.rs`, `ui/src/api.ts`). `effective_aom` gates global vs solo; `queue_aom_startup_actions_for(session)` scopes startup; `ensure_autonomy_pot` is shared by both paths.

- **Convergence Mission Control**: a card-grid view of operator state across panes — pure view model (status priority, sort, escalation join), single/multi/blocked card renderers, header strip, and resilient refresh (`ui/src/convergence/*`).

- **Richer Activity feed**: escalation text + in-flight command are persisted (`crates/app/src/storage.rs`) and surfaced as expandable rows (`ui/src/teammate/activity-view.ts`).

### Changed

- **Operator excerpt hygiene**: TUI spinner/timer/token chrome (e.g. `✱ Whirlpooling… (27m · ↓19k tokens)`, `esc to interrupt`, `Tip:` lines, ghost `Try "…"` placeholders) is stripped from the LLM excerpt and the spinner-framing prompt corrected, so the model reads executor state correctly (`crates/app/src/operator.rs`). Only repeat-reply loops escalate; generic/idle loops now cool the tab silently.

### Fixed

- **Notch fullscreen overlay**: an authoritative `inline_mode` flag set by the Resized hook (re-polled to defeat macOS's late flag flip) keeps the notch overlay from popping over a fullscreen Space when a phase event arrives mid-transition (`crates/app/src/notch.rs`, `crates/app/src/lib.rs`). Browser favorites rail re-asserts its grid column 4 against the global collapse rules (`ui/src/styles.css`).

- **Convergence robustness**: recover a poisoned operator-state lock instead of panicking, and send valid per-pane session ids to the snapshot (`crates/app/src/convergence.rs`).

- **English-first copy**: removed the hardcoded Spanish inbound reply and the Spanish familiar summary headers (`crates/app/src/lib.rs`, `crates/familiar/src/{prompts,agent}.rs`).

## v0.8.56 — Revert v0.8.55 (operator-awareness startup crash)

### Fixed

- **Startup crash hotfix**: v0.8.55 ("operator awareness") crashed on launch for
  existing installs. This release reverts that feature in full, restoring v0.8.54
  behavior, while the crash is diagnosed and the feature is re-landed with proper
  runtime verification. The v0.8.55 release was pulled so the auto-updater never
  serves it.

## v0.8.54 — Pane context-menu position fix under UI zoom

### Fixed

- **Pane right-click menu drifted under UI zoom**: the pane context menu
  set its fixed `left`/`top` from raw `clientX`/`clientY`, but the app's CSS
  `zoom` on `<html>` scales those local coordinates by the zoom factor, so
  the menu appeared `clientX × zoom` to the right/down of the cursor when
  zoomed in. It now divides by `zoom.level()` for both initial placement and
  the viewport clamp, matching the correction the shared `ContextMenu`
  already applied (`ui/src/tabs/manager.ts`).

## v0.8.53 — File explorer colored per-type icons + browser WIP

### Added

- **VSCode-style colored file/folder icons**: the structure tree no longer
  renders a single generic page glyph for every file. A new pure, data-driven
  resolver maps a filename (or folder name + open state) to `{ svg, color }`
  with muted/desaturated tints per type — TS/JS/Rust/JSON/CSS/Markdown/Python
  and more, plus special glyphs for `package.json`, lockfiles, dotfile config
  (`.gitignore`, `.eslintignore`, …), and well-known folders (`.github`,
  `src`, `public`, `docs`, `node_modules`). Folders swap to an open-folder
  glyph on expand. Icon-only tinting via `el.style.color` leaves label and
  active-row styling untouched. New `ui/src/structure/file-icons.ts` (with
  unit tests), 11 new glyphs in `ui/src/icons/index.ts`, wired at all three
  call sites in `ui/src/structure/tree.ts`.

- **Internal browser pane (in progress)**: additional plumbing for the
  native-webview browser pane and its tab/context-menu integration.
  `crates/app/src/browser.rs`, `crates/app/src/lib.rs`, `ui/src/browser/pane.ts`,
  `ui/src/menu/context-menu.ts`, `ui/src/tabs/manager.ts`, `ui/src/api.ts`,
  plus Telegram outbound additions in `crates/app/src/telegram/outbound.rs`.

## v0.8.52 — Browser tabs no longer read as terminals; notch hides in fullscreen

### Fixed

- **Browser tabs disguised as terminals**: internal-browser tabs share the
  `tabs[]` array with terminal sessions and were rendered identically, so
  they looked like shells and the operator/mission context-menu items
  silently no-op'd on them (a browser tab has no PTY `sessionId`). The
  terminal-only mission + operator block is now skipped for `kind:"browser"`
  tabs, browser pills carry a leading globe glyph (`tab-btn-browser`), and
  the collapsed rail draws them as a hollow ring instead of the solid
  terminal bar. `ui/src/tabs/manager.ts`, `ui/src/tabs/collapsed-rail.ts`,
  `ui/src/styles.css`.

- **Notch overlay lingering in fullscreen**: the floating notch could stay
  pinned on top of a fullscreen Space and "wouldn't go away". The only hide
  path read `is_fullscreen()` synchronously inside the `Resized` handler,
  but macOS flips that flag a beat late during the transition, so it usually
  read `false` and never hid. The handler now re-polls fullscreen state at
  0/250/500/800ms against a shared baseline (catching both enter and exit),
  and the notch bridge hides an already-visible overlay on the next executor
  event while the main window is fullscreen. `crates/app/src/lib.rs`,
  `crates/app/src/notch.rs`.

## v0.8.51 — x86_64 macOS release build fix

### Fixed

- **Intel macOS release build**: v0.8.50's `x86_64` leg failed because the
  Tauri CLI rejects `--no-default-features` passed as its own flag — cargo
  args must follow a second `--`. Forward them correctly (`-- --no-default-features`)
  so the Intel bundle builds, the cask gets both arches, and the hard-gated
  updater manifest can publish all three platform keys.
  `.github/workflows/release-macos.yml`.

## v0.8.50 — Intel macOS builds + updater fix, ⌘W, By-group leaderboard

### Added

- **Intel + Apple Silicon macOS builds**: the release now ships separate
  `aarch64` and `x86_64` macOS bundles instead of a universal binary that
  could not build — `ort`/ONNX Runtime (via `fastembed`) has no
  `x86_64-apple-darwin` prebuilt. `fastembed` is now an optional `embeddings`
  feature: Apple Silicon builds with it; the Intel slice builds
  `--no-default-features` so `ort` leaves the dependency graph (Intel loses
  semantic search only — `Embedder` is stubbed and every call site already
  degrades gracefully). `crates/app/Cargo.toml`, `crates/app/src/embedder.rs`,
  `.github/workflows/release-macos.yml`; the Homebrew cask is now a
  two-installer `on_arm`/`on_intel`.
- **Ranked Leaderboard for the "By group" stats card**: bars encode
  share-of-total scaled to the leader, with an average reference line, explicit
  rank, and a cumulative Pareto %. Client-side sort / Top-N / search; clicking a
  row drills the page into that group. The workspace moved to a fixed swatch
  column + legend so it can no longer overflow the name into the bar.
  `ui/src/score/leaderboard.ts`, `ui/src/score/breakdowns.ts`,
  `ui/src/score/page.ts`.
- **Spec Creator launcher in Set mission**: the mission picker can open the AI
  Spec Creator directly (`ui/src/mission/page.ts`).
- **Root context menu for the file tree**: New File / New Folder / Reveal in
  Finder from empty space (`ui/src/structure/tree.ts`).
- **Windows download buttons on the landing site**
  (`landing/src/components/Hero.astro`, `Install.astro`).

### Changed

- **Updater manifest is hard-gated**: `latest.json` is now assembled from the
  release assets and published only when all three platform keys
  (`darwin-aarch64`, `darwin-x86_64`, `windows-x86_64`) are present, so a failed
  platform can never ship a partial manifest that breaks auto-update (the bug
  that left v0.8.49 Windows-only). `.github/workflows/release-manifest.yml`.

### Fixed

- **⌘W closes the active tab/pane, not the whole app**: a custom macOS app menu
  routes ⌘W to tab close instead of the default Close Window accelerator (which
  quit the app). `crates/app/src/lib.rs`, `ui/src/main.ts`.
- **Spec Creator was unstyled in light mode**: added `body.theme-light`
  overrides for the chooser/panel — header text was dark-on-dark and the buttons
  were borderless white with an invisible hover. `ui/src/styles.css`.

## v0.8.49 — Browser favorites sidebar (folders + drag)

### Added

- **Browser favorites sidebar**: the previously-empty rail next to the
  internal browser (grid column 4 of browser panes) now holds a shared
  favorites tree — arbitrary-depth folders, a star button in the browser
  chrome to bookmark the current page, and click-to-open in a new browser
  tab. Backed by a new `crates/store` SQLite store (adjacency-list tree
  with fractional `position` indexing for single-row reorders, cascade
  delete for folders). Real favicons via the DuckDuckGo proxy with a
  colored-monogram fallback. Drag to reorder and re-nest is pointer-based
  (HTML5 drag is swallowed in the webview). New files under
  `ui/src/browser/favorites/`, commands in
  `crates/app/src/favorites_commands.rs`.

### Changed

- **Universal macOS build**: `release-macos.yml` now compiles a universal
  binary (Intel + Apple Silicon) instead of `aarch64`-only, so the `.dmg`
  runs on both architectures.

- **Landing page**: redesigned the DeepDive bento grid, added a
  `PerspectiveGrid` to the footer, and added icons in the Companion and
  Footer sections (`landing/src/components/`).

## v0.8.48 — Experimental internal browser + Retina drag-drop fix

### Added

- **Experimental internal browser**: open web pages in a Covenant tab via a
  real native child webview (Tauri multi-webview, `unstable` feature), so any
  site loads — `localhost:PORT` dev servers and general browsing alike. Gated
  behind a new **Experimental → Internal browser** setting
  (`experimental.internal_browser`, off by default). When enabled, a globe
  icon appears in the top bar and **⌘B** opens a browser tab focused on the
  address bar; the address bar navigates URLs / `localhost:PORT` or falls back
  to a DuckDuckGo search, and clicking a terminal link opens it in-app instead
  of the system browser. New `crates/app/src/browser.rs` (webview lifecycle +
  nav commands + per-tab history), `ui/src/browser/` (`url.ts`, `nav-state.ts`,
  `pane.ts`), and a `"browser"` tab kind in `ui/src/tabs/manager.ts`. v1 shows
  the page host as the tab label and does not track in-page back/forward.

- **Hourly background update check**: after startup, Covenant silently checks
  for updates every hour and surfaces the existing update banner when one is
  found; failures stay silent (`ui/src/updater/periodical.ts`).

### Changed

- **Operator notification title**: paused-operator notifications now use a
  cleaner `🟢 Covenant` title (`crates/app/src/operator.rs`).

### Fixed

- **Finder drop ignored on Retina displays**: the file-tree drop hit-test
  divided the pointer position by `devicePixelRatio`, but Tauri's
  `onDragDropEvent` already reports logical (CSS) pixels — so on `dpr>1`
  displays every drop landed in the wrong element and was silently ignored.
  Now uses the position directly (`ui/src/structure/file-drop.ts`).

- **Spec-detector watches worktrees without pre-existing spec dirs**: the
  watcher now registers worktree spec directories even when they don't exist
  yet.

- **Landing DeepDive images**: render real images in the DeepDive section.

## v0.8.47 — File-tree drag-and-drop: Finder import + folder moves

### Added

- **Drag files from Finder into the file tree**: drop OS files/folders onto
  the structure sidebar to copy them in. Folder-aware target (drop on a
  folder → into it; on a file → into its parent; on empty space → into the
  cwd), recursive directory copy, and collision auto-rename (`name (2).ext`).
  Uses Tauri's native `onDragDropEvent` (`ui/src/structure/file-drop.ts`,
  `structure::copy_into` in `crates/app/src/structure.rs`).

- **Drag-to-move files between folders in the tree**: press-drag a row onto
  another folder to move it there, with a floating ghost label and live
  target highlight. Moving the open file reroutes the editor; the destination
  auto-expands. Backed by `structure::move_into` (rename, with a copy+delete
  fallback across filesystems; no-op into the folder it already lives in).
  Implemented with pointer events rather than HTML5 DnD, which the webview
  swallows while `dragDropEnabled` is on for the native Finder drop.

### Fixed

- **CRT tab style: single-tab grab ghost was invisible**: the picked-up drag
  card cloned the `.tab-btn`, so CRT's `background/border: transparent`
  overrides erased it. The ghost is now a wrapper element, so its card chrome
  survives every tab theme (`ui/src/tabs/manager.ts`).

- **Release CI: Homebrew cask-update guard**: the `if`-guard couldn't read the
  step env, so the cask auto-update could be skipped on tagged releases
  (`.github/workflows/`).

## v0.8.46 — Real Homebrew install command on landing

### Changed

- **Landing install command**: replaced the placeholder `brew install covenant` with the actual tap-prefixed `brew install --cask karluiz/covenant/covenant` pointing at `karluiz/homebrew-covenant`, in `landing/src/components/Install.astro`.

## v0.8.45 — Signed macOS releases + Homebrew tap

### Added

- **Apple Developer ID signing + notarization**: `release-macos.yml` now signs the bundled `Covenant.app` with the Developer ID Application certificate and notarizes via `notarytool` inline during `tauri build`. Users no longer get the "unidentified developer" Gatekeeper prompt. Wires `APPLE_CERTIFICATE`, `APPLE_SIGNING_IDENTITY`, `APPLE_TEAM_ID`, `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_CONTENT` secrets.

- **Homebrew tap**: new repo `karluiz/homebrew-covenant` with `Casks/covenant.rb`. Install with `brew install --cask karluiz/covenant/covenant`. The release workflow auto-rewrites the cask (version + dmg sha256) and pushes on every tagged release via `HOMEBREW_TAP_TOKEN`. Tap-update step is gated and `continue-on-error: true` so a missing token never breaks the release.

- **Pi: clickable URLs + file paths in transcript**: streaming output now linkifies URLs and absolute / relative file paths. Paths open in an inline `StructureEditor` overlay lazy-mounted over the chat host; the Pi session cwd flows from `TabManager` → `PiPanel` → `PiChatView` so relative paths resolve. New `ui/src/executors/pi/linkify.ts` + test.

### Changed

- **`release-macos.yml`**: locates the signed `.dmg` after bundling, uploads it to the GitHub Release, and emits `dmg_sha256` for the cask step. Workflow now produces three artifacts per release (`.dmg`, `.app.tar.gz`, `.sig`).

- **Project notes — drafts empty state**: replaced the inline empty variant with the canonical centered `.pn-empty` layout (icon + title + hint pointing at the **+ New spec** button). Restyled `.pn-drafts-new` to the dashed mono-font convention with accent hover.

### Fixed

- **Pi streaming scroll snap**: disabled `overflow-anchor` on the messages container — browser scroll-anchoring was losing its anchor each delta (linkify rebuilds the message subtree wholesale) and snapping the viewport to the top. Replaced with manual stick-to-bottom: tracks whether the user is parked near the bottom, only auto-scrolls when they are.

## v0.8.44 — Landing redesign + GitHub Pages deploy

### Added

- **Landing redesign + new branding**: reworked the marketing hero with an
  image slider, animations, and refreshed Covenant brand assets (logotipos,
  favicon, hero laptops, OG image) under `landing/public/`. New `Companion.astro`
  and `Covenant.astro` components.

- **GitHub Pages deploy**: the landing now ships automatically to GitHub Pages
  via `.github/workflows/deploy-landing.yml` (Astro build → Pages artifact) on
  any push under `landing/**`. Served from `www.covenant.uno` (`landing/public/CNAME`,
  Astro `site` in `astro.config.mjs`); the apex `covenant.uno` stays reserved for
  the metrics backend.

- **Default spawn executor in task injection**: teammate task injection now honors
  the configured default spawn executor instead of hardcoding one
  (`ui/src/teammate/panel.ts`).

### Changed

- **Regenerated app icons**: rebuilt all platform launcher icons from the new
  Covenant mark across `crates/app/icons/` (macOS, Windows tiles, Android mipmaps).

### Fixed

- **Tree context menu positioning**: the file-tree context menu now lands under
  the cursor at any zoom level, and a stray second hit from a double-click is
  ignored (`ui/src/structure/tree.ts`).

## v0.8.43 — Operator threads — ChatGPT-style conversations + message cards

### Added

- **Operator threads**: each operator now holds multiple separate, ChatGPT-style
  conversations instead of one flat history. New `teammate_threads` table plus a
  `thread_id` column on `teammate_messages`, with an idempotent backfill migration
  that moves every operator's existing history into a "General" thread (nothing is
  lost). Persona, XP, sentiment, and the live terminal world-model stay global;
  only the chat history is thread-scoped. Backend in `crates/app/src/storage.rs`,
  `crates/app/src/teammate/{types.rs,commands.rs}`.

- **Thread switcher UI**: a thread row under the operator name opens a dropdown to
  switch, create (`+ New thread`), rename (double-click), and archive threads; the
  trash icon now archives the active thread rather than wiping all history. New
  threads auto-title from their first message via a cheap one-shot LLM call. UI in
  `ui/src/teammate/panel.ts`, bindings in `ui/src/api.ts`.

- **Operator message cards**: operators can emit structured card blocks that render
  as rich cards inside chat messages. Card markup parser and HTML builder, with the
  operator taught to emit card blocks. `crates/app/src/teammate` + the message
  renderer.

### Fixed

- **Opaque thread dropdown**: the thread switcher dropdown used a translucent
  surface and bled the tabs/content behind it; switched to `--bg-overlay` so it
  paints solid in both themes (`ui/src/styles.css`).

- **Pane context menu background**: now uses `--bg-overlay` for a solid backdrop
  instead of the vibrancy-translucent `--bg` (`ui/src/styles.css`).

## v0.8.42 — Paste submit race fix + project notes border-top

### Fixed

- **Bracketed-paste submit race**: Sending a prompt to a tab no longer glues
  the submitting carriage return onto the paste-end marker in one atomic PTY
  write. That combined write delivered `accept-line` before zsh-autosuggestions'
  async bracketed-paste zle hook settled, racing it — the line was re-emitted
  (appeared twice) with a stale suggestion fragment merged mid-line. The submit
  CR is now a separate write delivered ~40ms after the paste block, mirroring
  human paste-then-Enter timing. `wrapForSend` is replaced by `pasteBlock` +
  `sendPromptToSession` (`ui/src/project-notes/paste.ts`), with call sites
  updated in `ui/src/tabs/manager.ts`.

- **Project notes panel border-top**: The Covenant project-notes rail
  (`.pn-panel`) only drew a `border-left` and a left accent bar, leaving its
  top edge butting against the tab bar with no seam like the other sidebars.
  Added a matching `border-top` (plus the light-theme override and a
  `border-top: none` in fullscreen) in `ui/src/project-notes/styles.css`.

## v0.8.41 — SOUL.md operator persona + Glass/CRT tab themes

### Added

- **Operator persona as a living SOUL.md document**: An operator's persona
  is no longer a SQLite string — it's a real `SOUL.md` file per operator at
  `<app_config_dir>/operators/<slug>/SOUL.md` (YAML frontmatter for
  name/avatar/color/model/voice/escalate_threshold/tags/hard_constraints +
  an Origin-Letter markdown body). The file is the source of truth; the DB
  row keeps a denormalized cache plus runtime state (`xp`, `is_default`,
  timestamps). New `crates/app/src/soul.rs` parses/serializes/validates the
  format; the registry writes the file on create/update and hydrates the
  in-memory operator from it on load (`crates/app/src/operator_registry.rs`,
  `crates/app/src/storage.rs`). Per-operator `hard_constraints` stay
  structured frontmatter so they still compile into deny-regexes
  (`crates/app/src/operator.rs`). Legacy DB personas migrate to files on
  boot, and external edits hot-reload on the operator tick.

- **SOUL.md drawer editor + archetype gallery**: The operator editor is now
  a 75vw right-side drawer. Create starts from an archetype gallery (Guardian,
  Scout, Surgeon, Diplomat, Archivist — bundled `operator-souls/*.md`), then
  drops into a split editor: structured Identity/Behaviour controls on the
  left (name, avatar grid with hover-cycling emotional poses, colour swatches,
  tags, voice, model, escalate threshold, hard constraints) synced to the
  frontmatter, with the soul prose, a live markdown preview, and the raw
  SOUL.md source on the right (`ui/src/settings/operators.ts`,
  `ui/src/settings/soul_frontmatter.ts`, `ui/src/styles/operator_chip.css`,
  Tauri commands in `crates/app/src/operator_registry.rs`).

- **Glass and CRT tab styles**: Two new cosmetic tab styles alongside
  Classic/Forge in Settings → Appearance — Glass (capsules, sliding
  indicator, breathing AOM) and CRT (scanline glow, ASCII groups, flicker).
  Pure CSS gated on body classes, extracted per-theme under
  `ui/src/styles/tab-themes/` (`glass.css`, `crt.css`, `forge.css`);
  `TabStyle` union + `applyTabStyle` extended (`ui/src/api.ts`,
  `crates/app/src/settings.rs`).

- **Teammate executive-read of the active tab**: The teammate can read a
  live, rendered snapshot of the active tab's screen via a new
  `read_terminal_screen` tool. The session pump tracks PTY size and
  publishes a tidied headless capture; secrets are masked before the LLM
  sees them (`crates/app/src/session/*`, `crates/app/src/teammate/*`).

- **Global prompt library + run saved prompts/commands from menus**: A
  prompt library in the right panel, plus running saved commands/prompts
  directly from the tab and pane right-click menus
  (`ui/src/prompts/*`, tab/pane context menus).

- **Side-rail mention picker**: The mention picker moved into a vertical
  side rail, replacing the horizontal tab row (`ui/src/mentions/*`).

### Changed

- **Achievements card relocated** from the Metrics tab to the Operators tab
  in Settings (`acba11d`).
- **Score attribution** now rolls group breakdowns up to the workspace and
  collapses casing-duplicate group names (`c491ca9`).
- **Capability buttons + structure-editor chrome** polished (`c468a6f`).

### Fixed

- **Light-mode surfaces**: structure menu, rename input, confirm dialog, and
  the inline-notch agent-filter dropdown now use theme tokens instead of
  painting dark on light (`8f293a2`, `006dc8b`).
- **Vertical tab rendering**: border-box pills + chips to stop right-edge
  clipping, decluttered Glass groups with a legible count badge, and a
  restored active rail for Forge/CRT on non-operator rows (`5444db9`,
  `60d75c3`, `be16a9f`).
- **Operator drawer**: square corners flush to the viewport edge
  (`ui/src/styles/operator_chip.css`).
- **Split panes** inherit the live font and mirror Settings font changes
  (`431b302`).
- **Project-notes** title inputs no longer trigger autofill/autocapitalize
  (`424e95a`).

## v0.8.40 — Forge tab style + teammate task lifecycle

### Added

- **Forge tab style**: New cosmetic "Tab style" selector in
  Settings → Appearance (Classic | Forge), persisted as `window.tab_style`
  (`crates/app/src/settings.rs`). Forge reskins the tab pills + group chips
  into an angled, mechanical look — interlocking trapezoid tabs that rise
  on select in the top tabbar, and sharp rows with a glowing left rail in
  the vertical sidebar. Pure CSS gated on a `body.tab-style-forge` class
  toggled at boot and on save (`ui/src/main.ts`, `ui/src/settings/panel.ts`,
  `ui/src/styles.css`); the markup in `tabs/manager.ts` is untouched.

- **Teammate task reactivation on re-attach**: Reopening a cancelled or
  done task from the chat pill now flips its persisted status back to
  `Active` and emits a `TaskUpdate(Resumed)`, so the teammate's working
  indicator relights instead of the tab silently restarting work the panel
  still believes is cancelled (`crates/app/src/teammate/commands.rs`,
  `ui/src/teammate/task-card.ts`, `ui/src/teammate/panel.ts`).

### Changed

- **Tab-style design mockups**: Standalone HTML mockups exploring three
  candidate tab/group styles (Forge / Glass / CRT) across both horizontal
  and vertical layouts, captured during design (`design-previews/`).
  Reference only — not wired into the app.

### Fixed

- **Forge light-theme + operator avatar**: Forge now uses theme tokens
  (`--tab-bg-active`, `--bg-tabbar`, `--tab-stripe`) so it renders correctly
  in light mode rather than painting dark tabs on light chrome. The vertical
  chamfer `clip-path` was dropped because it clipped the subtree and sliced
  off the operator avatar + level badge, and active operator rows no longer
  slide (the slide shoved the absolutely-positioned avatar sideways on
  select) (`ui/src/styles.css`).

- **Forge collapsed-group gaps**: Folded group members are zero-width again
  under Forge. A specificity clash with the Forge `.tab-btn` rule had left
  each folded member ~32px wide, opening large empty gaps between collapsed
  groups proportional to their member count (`ui/src/styles.css`).

- **Split-pane swap layout**: Unbinding an operator from a tab now cancels
  the active task it was driving (`cancelTaskForUnboundSession`), and the
  pane-swap remount positions its three children relatively instead of via
  absolute moves — fixing a swap that left the splitter at index 0 and
  collapsed the layout into one blank pane (`ui/src/tabs/manager.ts`).

## v0.8.39 — Achievements MVP + .env support + teammate polish

### Added

- **Achievements layer (MVP A)**: a full reputation/badge system from spec 3.23. New `crates/score/src/achievements.rs` defines the types, a 10-badge static catalog (clean_run, finisher, guardian, secret_keeper, spec_keeper, build_steward, cartographer, command_librarian, recovery_artist, good_delegate) and the tier/rarity/reputation model. `store.rs` adds schema **v4** (`achievement_facts`, `achievement_progress`, `achievement_awards` with `subject_key`/`scope_key` for NULL-safe PKs) plus a transactional `record_achievement_fact` with dedupe and tier-crossing award emission, recompute, and summary rollup. Six Tauri commands (catalog, summary, progress, awards, mark_seen, recompute) are wired in `score_commands.rs`/`lib.rs`, and the Metrics page gains a reputation-bar / in-progress / recently-earned / catalog-grid UI with rarity-aware styling. `crates/score/src/achievements.rs`, `crates/score/src/store.rs`, `crates/score/src/lib.rs`, `crates/app/src/score_commands.rs`, `ui/src/score/`.

- **Cartographer achievement wired to spec creation**: `record_spec` now emits a `project_note_created` fact on first insert so the Cartographer badge advances in production. Emitted *after* releasing the `slot()` lock to avoid a nested-mutex deadlock with `record_achievement_fact`. `crates/score/src/lib.rs`.

- **`.env` syntax highlighting**: a custom dotenv `StreamParser` (comments, optional `export`, KEY, `=`, value) plus an `isDotenvPath` predicate matching `.env`, `.env.<stage>`, and `*.env`. Wired into `languageForPath` ahead of the extension lookup — the bare `.env` basename has no usable extension and previously fell through to plain text. Tokens route through the shared `HighlightStyle`, so dark and light themes both work. `ui/src/structure/languages.ts`.

- **`.env` dotfiles surfaced in the file finder**: a two-pass walker — pass 1 honors `.gitignore`; a second pass deliberately re-includes `.env`/`.env.*` basenames so they stay openable from the palette even when gitignored. Results are deduped by rel-path across passes. `crates/app/src/structure.rs`.

### Changed

- **Task cards show only relevant actions**: a done/cancelled task used to leave a dead, disabled "Stop" (and sometimes "Open tab") button on the card. The action row now renders the Open/Continue button only when there's a live or respawnable session, and the Stop button only while the task is still running; an empty action grid collapses instead of leaving a lopsided row. `ui/src/teammate/panel.ts`, `ui/src/teammate/panel.test.ts`.

### Fixed

- **Composer placeholder vanished after type-then-delete**: the teammate composer placeholder was driven by CSS `:empty::before`, which only matches when the contenteditable has zero child nodes. WebKit leaves a bogus `<br>` behind after you type a character then delete it, so the element was never `:empty` again and the placeholder disappeared permanently. The composer now toggles an explicit `is-empty` class from the serialized value (which strips the bogus `<br>`/whitespace) and the placeholder keys off that class instead. `ui/src/teammate/composer-input.ts`, `ui/src/styles.css`.

## v0.8.38 — Review-archetype enforcement + operator/teammate polish

### Changed

- **Sentiment badge relocated out of the avatar**: the mood badge used to sit above the operator avatar in the teammate panel header, occluding the v2 character art. It now lives in the title row next to the level pill, so the avatar reads cleanly while the badge still updates in lockstep. `ui/src/teammate/panel.ts`, `ui/src/styles.css`.

- **English copy in the mind-loss modal**: the "delete tab and its operator memory?" dialog was the last Spanish-language surface in the UI. Translated headers, body, dt/dd labels, action buttons, and relative-time strings to English to match the English-first UI policy. `ui/src/operator/mind-loss-modal.ts`.

- **Activity view rework**: large visual + structural pass on the teammate activity feed. `ui/src/teammate/activity-view.ts`, `ui/src/styles.css`.

- **SVG split-tab glyph**: replaced the `▣` Unicode glyph for the split-tab chip with an inline SVG (rounded rect + vertical divider) so it renders consistently across fonts and animates opacity on hover. `ui/src/tabs/manager.ts`, `ui/src/styles.css`.

- **README: macOS Gatekeeper workaround documented**: until App Store / notarized signing lands, the unsigned `.app` triggers "Covenant is damaged". The Install section now documents `xattr -cr /Applications/Covenant.app` with an explanation of what each flag does and why it's safe. `README.md`.

### Fixed

- **Review-archetype enforcement + operator auto-stop**: the operator had no notion of task archetype, so a Review task could emit mutating REPLYs ("merge it", "push it"), and `tick_loop` ran forever with no termination criterion. `TaskArchetype` is now plumbed from the teammate Task into `Attached` via a new `set_task_archetype` setter called from `teammate_attach_session_to_task`. `build_system_prompt` injects a REVIEW TASK CONTRACT block when the attached archetype is Review (read-only auditor, no mutating REPLY). `parse_response` runs a `reply_is_mutating` classifier on Review turns; mutating REPLYs convert to ESCALATE with a declined-reason notification + `tracing::warn`. Whole-token match for short verbs (merge/push/commit/rm/sudo), substring for multi-word phrases ("git push", "npm install", "reset --hard"). Mission plan reaching 100% sets `enabled=false` on the session, gated by `Settings.operator.auto_stop_on_mission_completed` (default true), emitting `operator-disabled` alongside `operator-mission-completed`. New `OperatorWatcher::disable_for_session`; `teammate_cancel_active_task` calls it after `forget_task` so cancel terminates the operator too. 10 new unit tests; 71 operator + 56 teammate tests pass. `crates/app/src/operator.rs`, `crates/app/src/operator_mind.rs`, `crates/app/src/settings.rs`, `crates/app/src/teammate/commands.rs`.

- **Operator avatar persisted after delete**: deleting an operator cleared the backend registry but left stale references in the frontend — `TabsManager.operatorCache`, the status bar's `currentOperatorEntity`, and `pane.operator` pointers all kept the deleted id alive until the next tab switch or XP tick. A window-level `operator:deleted` CustomEvent now fires after `operatorDelete` succeeds; `TabsManager` drops the cache entry, nulls every `pane.operator` that matched, and re-renders. Status bar listens and nulls `currentOperatorEntity` + re-renders if the deleted id was the active one. `ui/src/settings/operators.ts`, `ui/src/status/bar.ts`, `ui/src/tabs/manager.ts`.

- **Teammate leaked machine session ids in chat**: the model replied "Focus on `MWA8BF`" because the world-snapshot rendered the short SessionId ulid indistinguishably from a human-facing label. The snapshot now tells the model the id is machine-only and never to surface it, and relabels the rendered line accordingly. `crates/app/src/teammate/world_snapshot.rs`.

- **Empty-state chips grounded in workspace scope**: two chip prompts referenced state the teammate didn't have. "Review my code" → "Audit this workspace" (scope = cwd). "Explain this file" → "Summarize recent changes" (scope = git log of cwd). `ui/src/teammate/panel.ts`.

- **SENTIMENT tag matching tightened**: restrict tag detection to line-lead occurrences (with bullet/quote prefix tolerance) or an inline tag at end-of-text. Prevents prose mentions of "sentiment:" from being treated as a tag, and fixes a body-concatenation bug where content following a mid-text tag was glued to the head with no separator. `crates/app/src/teammate/llm.rs`.

## v0.8.37 — Single-row status bar opt-out (experimental)

### Added

- **Single-row status bar (experimental opt-out)**: the two-row status bar shipped in v0.8.36 isn't for everyone — some users prefer the denser pre-0.8.36 single-row layout for muscle memory or screen real estate. New `experimental.statusbar_two_row` setting in Settings → Experimental (default on) toggles the bar back to the original `grid-template-columns: auto auto 1fr auto` flat layout. Toggling is live, no respawn needed. CSS introduces a `--statusbar-h` custom property and a `body.statusbar-single-row` class so dependent panels (project-notes, etc.) reflow automatically when the user flips between layouts — no more hardcoded 50/51px offsets. `crates/app/src/settings.rs`, `ui/src/api.ts`, `ui/src/settings/panel.ts`, `ui/src/status/bar.ts`, `ui/src/status/bar.test.ts`, `ui/src/tabs/manager.ts`, `ui/src/main.ts`, `ui/src/styles.css`, `ui/src/project-notes/styles.css`.

## v0.8.36 — Split panes (experimental) + statusbar two-row + tree active reveal

### Added

- **Split panes (experimental, behind flag)**: a tab can now host two PTY-bearing panes side-by-side or stacked, each with its own session, mission, and operator. Ships behind `experimental.split_panes` in Settings → Terminal (default off). Shortcuts: `⌘D` split right, `⌘\` split down, `⌘[`/`⌘]` focus prev/next, `⌘⇧]` swap. `⌘W` closes the active pane in split tabs and the tab in single-pane tabs; `⌘⇧W` always closes the tab. Pane-host right-click surfaces split/swap/convert-to-pi/close. Splits persist across restart via a new `panes[]` + `layout` manifest schema, with `liftLegacyTab` providing two-way back-compat with the legacy single-pane shape. Refactor introduces `Pane` and `TabLayout` as first-class types (`ui/src/tabs/pane.ts`, `ui/src/tabs/split-actions.ts`, `ui/src/tabs/pane-splitter.ts`, `crates/app/src/pane.rs`, `crates/app/src/split_commands.rs`). 1500+ LOC across 6 phases (data shape → read renames → write renames → split UI → persistence → Pi panes + polish).

- **Statusbar two-row layout**: the status bar now splits identity + vitals on the top row and ephemeral state (operator/mission/AOM) + executor/telegram chrome on a dimmer 22px bottom row, so a long mission filename can't crowd the runtime telemetry off-screen. `ui/src/status/bar.ts`, `ui/src/styles.css`.

- **File-tree active-row highlight + auto-reveal**: the structure sidebar now marks the editor's currently-open file with `.is-active` (accent-tinted background + 2px left stripe) and on first open auto-expands collapsed ancestor folders and scrolls the row into view. `StructureTree.setActivePath(path|null)` is pushed from `manager.ts::openEditor` and cleared from the editor's `onClose`. `ui/src/structure/tree.ts`, `ui/src/structure/tree.test.ts`, `ui/src/styles.css`.

- **Multi-agent activity picker (teammate panel)**: the activity view was hard-locked to the panel's current operator, hiding the rest of the fleet. New combined-by-default feed with a multi-select picker pinned on top — switch focus, add observers, see everyone at once. `ui/src/teammate/panel.ts`.

- **Multi-agent picker on the right-rail inline notch**: same adaptation of proposal C on the right-rail activity panel — multiple running agents no longer collapse to one with no way to inspect the others.

- **Per-action token deltas on notch activity rows**: each activity row now shows the token delta (↑/↓) for the specific action, not just the cumulative session total. `ui/src/inline-notch/`.

- **Undo-toast for reset chats & tasks**: replaces the two-step "trash → Confirm pill" pattern with a Gmail-style 6s undo toast — clearing locally is immediate, the backend wipe is deferred, and any subsequent send / panel close commits the pending clear early so a freshly-typed message can't be lost.

- **Atomic spawned-tab priming**: spawned executor tabs originating from a Mibli chat with an `@spec` chip now reliably inherit the mission badge AND `/rename` — previously rename was missed entirely and mission was a fire-and-forget race against prompt injection. `crates/app/src/teammate/commands.rs`.

- **Spec path prepended to spawned-task prompt**: when a task is spawned from a chat with an `@spec` chip, the spec path is now prepended to the prompt so the executor has explicit scope from the first turn. `crates/app/src/teammate/`.

### Changed

- **Operator triage skipped when screen unchanged**: idle executor sessions (spinner phase, stable prompt waiting, etc.) were paying ~$0.018 per tick for triage Haiku calls to repeatedly conclude "nothing to do" — a single Mibli session racked up ~$0.81 over 30 minutes. Triage now short-circuits when the screen content hash hasn't moved since the previous WAIT. `crates/app/src/operator.rs`.

### Fixed

- **Long file paths in xterm are now cmd-clickable when they wrap**: the link provider walked one buffer line at a time, so a path that overflowed the column width was split between rows and neither half resolved. Now stitches `isWrapped` continuation rows into a single logical line, runs the regex against the whole path, and maps match offsets back to per-row link ranges so both halves highlight and click correctly. `ui/src/tabs/manager.ts`.

- **macOS native context menu suppressed on terminal right-click**: a stray native menu appeared on top of the in-app context UI when right-clicking inside xterm. `ui/src/tabs/manager.ts`.

- **Single-tab AOM stops when its operator is removed**: previously the AOM loop kept polling a tab after `setTabOperator(null)`, even though there was no operator to ask. `ui/src/tabs/manager.ts`.

- **Teammate `@file` chips treated as read-first targets**: aligns @file with @spec semantics so the executor reads the referenced file before responding instead of treating it as a hint. `crates/app/src/teammate/commands.rs`.

- **Teammate strips chat-only `@tokens` from `propose_task` drafts before dispatch**: chat-flavored `@chat`, `@op` tokens were leaking into the spawned task prompt and confusing the executor. `crates/app/src/teammate/`.

- **Teammate backfills `task_id` on confirmed Propose row**: a propose row that was confirmed before its task_id arrived asynchronously lost the link forever. `ui/src/teammate/panel.ts`.

- **Teammate roster push after async load**: the activity view rendered before the operator roster finished loading, so the picker was empty on first open until refresh. `ui/src/teammate/panel.ts`.

- **Agent API errors tag the originating provider**: previously a 429 from any provider looked identical in logs. `crates/agent/src/error.rs`.

- **File-tree context menu flips when it would overflow**: a context menu opened near the right edge of the structure sidebar used to render off-screen. `ui/src/structure/tree.ts`.

- **Notch head avatar color matches the per-agent picker + row dots**: avatar tint was hardcoded to the default accent and clashed with the picker's per-agent color. `ui/src/inline-notch/`.

## v0.8.35 — Inline PDF + DOCX preview

### Added

- **Inline PDF preview**: selecting a `.pdf` in the file tree now renders the document inline using PDF.js — full multi-page scroll, devicePixelRatio-aware canvases, lazy-imported worker so the ~1MB bundle stays off the cold-start path. Replaces WKWebView's built-in static single-page renderer, which only painted the first page on a black void. `ui/src/structure/preview.ts`, `ui/src/structure/editor.ts`, `ui/src/styles.css`.

- **Inline DOCX preview**: `.docx` files now render to a typography surface using mammoth.js (docx → HTML in-browser), styled as a centered white paper card with prose typography for headings, tables, links, and lists. Lazy-imported, 25 MB ceiling, read-only (docx round-trips are lossy). `ui/src/structure/preview.ts`, `ui/src/structure/editor.ts`, `ui/src/styles.css`.

### Changed

- **Editor toast routing**: `StructureEditor`'s `toast()` callback in `ui/src/tabs/manager.ts` now flows through `pushInfoToast` instead of the prior console-only stub, so editor messages surface in the notification system like the rest of the app.

- **Light-mode project-notes panel**: explicit `border-left` and `box-shadow: none` on `.pn-panel` under `body.theme-light` in `ui/src/project-notes/styles.css` — the panel had no visible edge against the light surface.

## v0.8.33 — Autonomous operator sentiment + light-mode install polish

### Added

- **Autonomous operator sentiment**: the operator avatar now reacts to spawned-task activity, not just to chat replies. A new `task_supervisor` background task subscribes to the session bus and synthesizes `TaskUpdate` rows with `sentiment` set when the executor's PTY emits failed `BlockFinished` events: first failure → `duda` (status flips to Blocked), three consecutive same-command failures → `enojo`, success after Blocked → `feliz` (Resumed). A 30s tick layers time-based escalation: ≥5 min Blocked → `incomodidad`, ≥15 min or retry_count ≥3 → `triste`. Confirmed tasks now ship with `expectacion`; cancelled tasks emit a `triste` system note. Debounced via a per-(operator,task) `SentimentResolver` so the avatar never flickers. `crates/app/src/teammate/{sentiment_resolver,task_supervisor}.rs`, `crates/app/src/teammate/commands.rs`, `crates/app/src/lib.rs`.

### Changed

- **Task card layout stability**: reserved a two-line min-height on `.task-item__head > .task-item__title` and pinned `.task-item__meta` to a single line in `ui/src/styles.css` so cards with short titles no longer shrink and the "tab XXXXX" chip stops wrapping onto a second row.

### Fixed

- **Update banner install button readable in light mode**: the install pill used a translucent `rgba(122, 162, 255, 0.18)` background that collapsed into the light titlebar, making the "Install" label nearly invisible. Switched the base rule in `ui/src/styles.css` to a solid `var(--accent)` fill with white text so the button stays high-contrast in both themes; hover now uses `filter: brightness(1.1)` instead of swapping the background.

## v0.8.32 — Light-mode banner contrast + trackpad scroll flicker fix

### Fixed

- **Update banner unreadable in light mode**: the inline update chip mounted into the titlebar used a dark-mode palette (`#dbe6ff` text on translucent blue) that collapsed to near-invisibility on the light titlebar — the Install button in particular looked disabled. Added `body.theme-light` overrides in `ui/src/styles.css` so the chip re-anchors to readable blues (`#1d2b4d` text, `#2a4ad0` solid Install button on white), with matching label/version/whatsnew/dismiss tweaks.
- **Terminal flicker on slow trackpad scrolling**: the wheel "rescue" handler in `ui/src/tabs/manager.ts` injected `term.scrollLines(±n)` whenever it thought xterm had missed a delta. On slow trackpad scrolls macOS emits sub-line deltas at ~120Hz that xterm accumulates internally and only flushes once a full line is crossed — the injection raced with xterm's own flush a frame later and produced a visible double-step jump. Dropped the proactive injection entirely; the debounced geometry-rebuild fallback (with its 750ms cooldown) still catches the genuinely-stuck cases this handler was originally added for.

## v0.8.31 — Calmer idle tab indicator

### Changed

- **Idle tab indicator**: replaced the 1.5px amber comet that swept across the bottom edge of idle tabs with a small fading "…" rendered inline next to the tab label. The old animation drew the eye every 2.2s across every idle tab simultaneously; the ellipsis reads semantically as "waiting" with a much gentler 2.4s opacity fade and no moving geometry. `ui/src/styles.css` (`.tab-idle-badge`). DOM mounting in `ui/src/tabs/manager.ts` is unchanged — the badge is still inserted before the close button.

## v0.8.30 — Fix release build (composer-input TS error)

### Fixed

- **Release build TypeScript error**: `npm run build` failed in CI with `TS2339: Property 'remove' does not exist on type 'Node'` at `ui/src/teammate/composer-input.ts:221`, breaking both v0.8.28 and v0.8.29 macOS + Windows release workflows so no installers were produced. Cast the node to `ChildNode` (which is what actually carries `.remove()`) before calling it. No behavior change — same nodes were already filtered by `n.parentNode` guard.

## v0.8.29 — Operator sentiment v2 — alive avatars + LLM mood tags

### Added

- **Sentiment v2 foundation**: new `pack2:<character>` avatar format backed by `ui/operatorsv2/` with 18 characters × 9 emotional poses (neutral, feliz, triste, enojo, sorpresa, duda, expectacion, incomodidad, ver). `renderAvatarHtml` gains an optional emotion arg; v1 `pack:<id>` avatars keep working untouched. Rust side adds a `Sentiment` enum (lowercase Spanish tokens mirroring the PNG filenames) and an optional `sentiment` field on `TaskMessage`, plus an idempotent migration adding a nullable `sentiment` column to `teammate_messages`. `ui/src/operator/avatars.ts`, `crates/app/src/teammate/types.rs`, `crates/app/src/storage.rs`.
- **End-to-end LLM mood tagging**: every operator system prompt gets a `SENTIMENT_DIRECTIVE` explaining the 9 tokens with Spanish + English glosses. `extract_sentiment()` parses replies tolerantly (case-insensitive, trailing punctuation, vergüenza/verguenza aliasing, English fallbacks); unparseable tags leave text untouched. `DispatchOutcome::Text` now carries `Option<Sentiment>` for Anthropic, OpenAI, and oneshot paths. Teammate panel tracks `currentMoodByOperator`, backfills from history on reconnect, and drives both the v2 PNG pose and a small English mood badge on the header avatar. Untagged messages preserve the last real mood. `crates/app/src/teammate/llm.rs`, `crates/app/src/teammate/commands.rs`, `ui/src/api.ts`, `ui/src/teammate/panel.ts`, `ui/src/styles.css`.
- **Settings grids ship v2 pack with hover cycle**: both the New Operator wizard and the Edit Operator modal now render the 18 v2 characters; hovering a tile cycles its available poses at 250ms so you can preview the operator's emotional range before committing. `mouseleave` snaps back to neutral with no leaked intervals. `DEFAULT_DRAFT.emoji` bumped to `pack2:bella` so new operators participate in sentiment from turn one. `ui/src/settings/operators.ts`, `ui/src/settings/operator_chip.ts`.

### Changed

- **Operator list cards bleed `--operator-color`**: list rows now tint the card with the per-operator accent (Mibli purple, Karluiz blue) instead of staying neutral. New Operator modal palette aligned with the release-log card for visual consistency. Avatar tiles drop their native `title` tooltips in favor of `aria-label` (per project convention). `ui/src/settings/operators.ts`.
- **Teammate panel header layout**: level pill moved out of the avatar wrap and now sits next to the operator name, leaving the avatar ring uncluttered for the sentiment badge anchored opposite. `ui/src/teammate/panel.ts`, `ui/src/teammate/panel.test.ts`.

## v0.8.28 — Workspaces V2, multi-source @mentions, task Stop/Continue

### Added

- **Workspaces V2**: tab manifest now ships in a V2 envelope with per-workspace `root_dir`, group ownership, and a `beforeunload` flush so layout survives crashes. Existing V1 manifests migrate transparently on first load. `crates/app/src/storage.rs`, `ui/src/tabs/manager.ts`, `ui/src/workspaces/*`, plus regression coverage in `ui/src/workspaces/manager.test.ts` for migration, switching, and delete edge cases.
- **Workspace switcher**: title-bar chip + popover with `Cmd+Shift+P` to open and `Cmd+Opt+N` to create. Right-clicking a group reveals "Move to workspace…". New shell tabs fall back to the workspace `root_dir` when no group/project cwd is set. `ui/src/workspaces/switcher.ts`, `ui/src/tabs/group-context-menu.ts`, `ui/src/main.ts`.
- **Multi-source @mention picker**: composer is now a `ComposerInput` with atomic, deletable mention chips and a `MentionPopup` with tabbed sources (files, sessions, recent commands, teammates, specs). Backed by a client-side fuzzy scorer, a per-session file walker cache (`search_session_files`), per-block `find_recent_commands`, and a published-specs index. `crates/file-search/`, `crates/app/src/storage.rs`, `ui/src/mentions/*`, `ui/src/teammate/composer-input.ts`, `ui/src/teammate/mention-sources.ts`.
- **Spec mentions auto-prime the mission**: `@spec`-ing a markdown plan when confirming a task sets the spec as the spawned tab's mission, and chips carry a `spec-path` data attribute so the file re-opens cleanly after a restart. `ui/src/teammate/panel.ts`.
- **Observer bindings**: a single operator can now drive one tab and *watch* several others at once. Chat header surfaces every bound tab with a per-tab detach popover. `crates/app/src/teammate/runtime.rs`, `ui/src/teammate/panel.ts`.
- **Task pill UX**: confirmed-task pill on the chat row links to the task-detail panel, exposes Stop and Continue, and the inline "open tab" action also respawns the executor when the previous tab is gone. `ui/src/teammate/task-card.ts`, `ui/src/teammate/panel.ts`.
- **Activity tab**: dedicated sidebar inside the teammate panel that streams startup, reply, escalate, and wait actions as compact cards (icon · title · time · cost, body below). Toast versions are suppressible to avoid duplication. `ui/src/teammate/activity-view.ts`.
- **Empty-state chips**: first-open teammate panel ships four canned prompts ("What's happening in my tabs?", "Review my code", …) so new users have a way in. `ui/src/teammate/panel.ts`.
- **Recall sidebar + quick-run**: standalone Recall view in the sidebar and a play button on the spawns chip for one-click re-runs. `ui/src/recall/*`.
- **Updater banner redesign**: install row collapses into a single banner with a release-notes modal driven from `CHANGELOG.md`. `ui/src/updater/*`.

### Fixed

- **Trackpad scroll flicker**: terminal viewport no longer re-fits or geometry-rebuilds on every wheel tick at scrollback boundaries. The handler now bails out at viewport edges and only falls back to refit when `scrollLines` can't consume the delta. `ui/src/tabs/manager.ts`.
- **Stop actually stops**: cancelling an active task now unbinds the operator, disables AOM on the spawned tab, *and* closes the tab itself instead of just flipping the task row to cancelled. `ui/src/teammate/panel.ts`, `ui/src/main.ts`.
- **Continue respawn**: re-opening a dead task respawns the tab in the correct group + project cwd and re-injects the original task prompt into the new executor. `ui/src/teammate/panel.ts`, `ui/src/tabs/manager.ts`.
- **Mention chip editing**: single backspace deletes a chip whole; caret stays usable after inserting a chip in WebKit; `@` in an empty composer reliably opens the picker; composer survives `send` without losing focus. `ui/src/teammate/composer-input.ts`.
- **AOM spec routing**: spec toasts route to the tab whose cwd contains the spec, not the active tab. `crates/app/src/aom/mod.rs`.
- **Level badge alignment**: tab-bar level pill now sits in front of the avatar with the digit visually centered. `ui/src/tabs/manager.ts`, `ui/src/styles.css`.
- **Light-mode polish**: mention chips, mission preview headings, and selection backgrounds are readable in light theme. `ui/src/styles.css`.

### Changed

- **Activity cards**: compact layout — icon + title + time + cost on one row, body wraps below at full width. Escalations get a dedicated alert-triangle icon. `ui/src/teammate/activity-view.ts`, `ui/src/icons/index.ts`.

## v0.8.27 — Teammate @file mentions + scrollback wheel fix

### Added

- **`@file` mentions in teammate chat**: typing `@` in the teammate composer opens a fuzzy file picker scoped to the active tab's cwd (`structureFindFiles`, debounced 120 ms, 20 hits). Arrow keys navigate, Enter/Tab insert as `@<relpath> `, Esc dismisses, and Enter is swallowed while the popup is open so the form doesn't submit. On send, every recognized mention token is inlined as a fenced ` ``` ### relpath ` block via the new pure `expandMentions` helper, with per-file (256 KB) and total (512 KB) caps and skip notices for binary/oversized files. New `ui/src/teammate/mentions.ts` + `mentions.test.ts` (12 tests, end-to-end coverage including the popup and `TeammatePanel.send` integration); wired through `ui/src/teammate/panel.ts`, `ui/src/main.ts` (`getActiveSessionCwd`), and styled in `ui/src/styles.css`.

### Fixed

- **Scrollback wheel-stuck refit no longer flickers at boundaries**: the wheel recovery in `ui/src/tabs/manager.ts` used to call `fit()` + `resize(rows-1, rows)` whenever the viewport's `scrollTop` didn't change after a wheel event, which fires naturally at the top/bottom of a large scrollback and made the terminal look like it was re-rendering on every tick. The handler now skips when the viewport is already at a boundary in the wheel direction, first tries `term.scrollLines()` to consume the missed delta, and only falls back to the geometry-rebuild path when the viewport is still immovable — restoring the user's `scrollTop` afterwards so they don't get teleported.

## v0.8.26 — File tree and Pi tab blank-state fixes

### Fixed

- **Files rail visibility**: shell tabs now seed their cwd from the launch, group, or workspace context before the first OSC cwd event arrives, and `StructureTree` renders an explicit waiting state while the terminal reports its directory. This prevents the Files view from looking like an empty sidebar in `ui/src/tabs/manager.ts` and `ui/src/structure/tree.ts`.
- **Pi and teammate blank-state polish**: Pi RPC tabs now keep `PiChatView` on its flex layout instead of being overridden by generic tab-pane grid CSS, and Blocks/Files titlebar actions show a toast when the active tab has no terminal rail. The release also refreshes teammate header working state after operator reset via `ui/src/main.ts`, `ui/src/styles.css`, and `ui/src/teammate/panel.ts`.

## v0.8.25 — Autonomous teammate task dispatch + Tasks tab

### Added

- **Autonomous task pipeline (YOLO mode)**: confirmed `propose_task` messages with `archetype="do"` now dispatch immediately on arrival — no Confirm click required. `ui/src/teammate/panel.ts` runs `handleConfirm` from `onIncomingMessage`, attaches the task to the currently active tab, pins the operator with `sessionSetOperator` + `setOperatorEnabled` + `setOperatorLive` (single-tab AOM), and injects the prompt — raw text + newline when an executor CLI is already running in the target tab, shell-quoted `<exec> '<prompt>'` fallback otherwise. Opt out via `localStorage.covenant.teammate.yolo=off` or `confirm-target=spawn`.
- **Executor routing**: operators now pick which agent CLI should drive a `do` task. `TaskDraft.executor` flows from `propose_task` through storage to confirm time; `crates/app/src/teammate/tools.rs` exposes the `executor` enum (`claude` / `codex` / `copilot` / `pi` / `hermes`) on the tool schema; `crates/app/src/teammate/llm.rs` describes each in the system prompt and biases the operator hard toward action over clarifying questions.
- **Tasks tab + details panel**: new Tasks view inside the teammate panel with filter chips (All / Active / Proposed / Done) and per-task expand-on-click. Expanded rows show an executor strip, a 3-up stats grid (decisions count + breakdown, total cost, age), a compact lifecycle timeline (proposed → started → active → done), and the last decisions feed driven by the new `teammate_list_decisions_for_session` query (`crates/app/src/storage.rs`, `crates/app/src/teammate/commands.rs`).
- **Header working state**: when the operator has any active/blocked task, the panel header grows a second concentric ring around the avatar (rainbow conic gradient, outside the existing XP ring) and the model-name subtitle swaps to `● <task title>`. Reverts automatically when no task is active. `ui/src/teammate/panel.ts` + `ui/src/styles.css`.
- **Single-tab AOM indicator**: `ui/src/tabs/manager.ts` now lights the animated `tab-aom-active` gradient ring on any tab whose operator is `live`, not just when global AOM is on. Confirmed teammate tasks become visually distinct without forcing the global toggle.
- **Reset operator affordance**: trash icon in the teammate panel tabs-bar with inline two-step confirm wipes all messages + tasks for the current operator and resets its runtime state back to Idle. New `teammate_clear_for_operator` storage + Tauri command (`crates/app/src/storage.rs`, `crates/app/src/teammate/commands.rs`, `crates/app/src/teammate/runtime.rs`).

### Changed

- **Updates settings card**: `ui/src/settings/panel.ts` replaces the bare "Check for updates" row with a card showing installed vs latest versions, last-check metadata, and a dedicated action button with a refresh icon. `ui/src/styles.css` adds matching styles.
- **Confirmed proposals collapse to a pill**: `ui/src/teammate/task-card.ts` renders confirmed `propose` messages as a single-line pill (badge · title · `tab "<title…>"` link) instead of keeping the full deliverable/scope card forever; cancelled proposals render as a dimmed pill with a `cancelled` tag. Edit / Cancel became icon buttons (pencil / x) so all three actions fit the rail width.
- **Friendly backend errors**: `handleConfirm` / `handleCancel` translate known backend strings (`operator already on task`, `proposal already confirmed`, `not found`, …) into English error cards instead of rendering raw `"failed:"` system rows; unknowns fall back to `"Couldn't <verb> the task."` with the original message attached.
- **UI copy normalized to English**: all chat chrome (buttons, tooltips, system rows, status labels, error cards, placeholders) is English-first. See `feedback_english_first_copy` memory.

### Fixed

- **Task-item layout regression**: `ui/src/styles.css` resets `.task-item` from grid to block and pins every child of `.task-item__head` to an explicit `grid-column` / `grid-row`. The meta row (badge · status · age · tab id) now lays out on a single line instead of wrapping word-by-word.

## v0.8.24 — Teammate workspace tools + Hermes phase detection

### Added

- **Teammate workspace tools**: the teammate tool-use loop now exposes `list_directory`, `search_files`, `git_status`, `git_diff`, and `run_command` alongside the existing `read_file` and `propose_task`, for both the Anthropic and OpenAI dispatch paths. `crates/app/src/teammate/tools.rs` implements sandboxed execution with a hard blocklist for destructive commands; `crates/app/src/teammate/llm.rs` wires the new tools, refreshes the system prompt to describe them, and bumps `MAX_TOOL_ITERATIONS` from 8 to 12.
- **Hermes tool-call phase detection**: `crates/blocks/src/executor_phase.rs` recognises Hermes' kaomoji thinking lines (`(¬_¬) mulling…`), `preparing <tool>…` prefixes, and the completed `<verb>  <target>  <duration>` form, mapping each tool to `Reading` / `Writing` / `Running` phases so the Activity feed reflects what Hermes is doing. New tests cover mulling, preparing for `read_file`/`write_file`/`search_files`/`terminal`/`vision_analyze`, and completed `read`/`find` lines.
- **TERM_PROGRAM=Covenant**: `crates/pty/src/lib.rs` exports `TERM_PROGRAM=Covenant` in every spawned PTY environment so embedded CLIs (prompt_toolkit, Hermes, etc.) can detect they're running inside Covenant's terminal.

### Fixed

- **CustomSelect clipped options**: `ui/src/ui/select.ts` now estimates the popover's natural height from option count and flips to drop-up whenever the full list would be clipped below the button and there's more space above, instead of only flipping when fewer than 160px remain below. Prevents long executor / operator selects from silently scrolling.

## v0.8.23 — OpenAI teammate tool-use and activity polish

### Added

- **OpenAI-compatible teammate tool-use**: teammate dispatch now keeps tool-capable conversations on OpenAI Chat Completions providers and Azure Foundry instead of falling back to text-only replies. `crates/app/src/teammate/llm.rs` adds the OpenAI `tool_calls` loop for `read_file` and `propose_task`, while `crates/app/src/teammate/openai_http.rs` handles OpenAI/Azure request shaping, auth headers, tool-schema conversion, and tool-call argument parsing.

### Fixed

- **Azure OpenAI deployment probing**: `crates/app/src/providers_cmd.rs` now pins the deployment-list probe to `2023-03-15-preview`, the data-plane API version that still serves `/openai/deployments`, instead of reusing chat-completion API versions that 404 on deployment listing.
- **Hermes Activity feed detection**: `crates/pty/src/fg_proc.rs` maps Hermes' Python virtualenv entrypoint back to logical CLI name `hermes`, so macOS foreground-process detection lets the notch/activity pipeline ingest Hermes output and spawn Activity rows.
- **Activity stream scroll anchoring**: `ui/src/inline-notch.ts` assigns stable row IDs and restores the first visible row after each render, preventing frequent notch updates from snapping the Activity sidebar back to the newest rows while the user scrolls older events. `ui/src/inline-notch.test.ts` covers the regression by simulating browser scroll reset during `innerHTML` replacement.

## v0.8.22 — Azure Foundry model picker fix + Hermes executor

### Fixed

- **Azure Foundry model list 404**: Settings model picker now dispatches `azure_foundry` providers to `listModelsAzureFoundry` instead of falling through to the OpenAI-compat probe (which hit `{base}/models` and 404'd against Azure hostnames). `ui/src/settings/model_routes.ts` branches on `entry.kind === "azure_foundry"` and forwards endpoint, api-key, `azure_mode`, and `azure_api_version` (defaulting to `2024-10-21` for Azure OpenAI, `2024-05-01-preview` for AI Inference).
- **Azure OpenAI probe lists deployments**: `crates/app/src/providers_cmd.rs` switched the `AzureMode::AzureOpenAi` probe URL from `/openai/models` (base models — not callable) to `/openai/deployments?api-version=...` so the dropdown surfaces the deployment names actually used in `/openai/deployments/{name}/chat/completions`.

### Added

- **Hermes (Nous Research) executor**: registered as a known + inline agent in `crates/session/src/idle.rs`, with brand glyph (winged-staff path in `ui/src/icons/brands.ts`), display label in `ui/src/inline-notch.ts`, and amber/gold brand color in `ui/src/status/bar.ts`.

## v0.8.21 — CustomSelect click fix + xterm viewport scroll drift fix

### Changed

- **AOM spec-badge restyle**: badge icon switched from the 📎 emoji to `Icons.target`, with tooltip + aria-label refreshed to "New mission spec detected" / "N new specs ready to set as missions" (`ui/src/aom/spec-badge.ts`, `ui/src/aom/spec-prompt.ts`).
- **Spec detector path normalization**: `crates/app/src/spec_detector.rs` grew a `canonical_or_self` helper and pulls in `std::process::Command` (~221 added lines) so detection survives symlinked workspaces and shells out to git when needed.

### Fixed

- **CustomSelect dropdown clicks were silently failing**: `ui/src/ui/select.ts` now skips `renderPopover()` on `mouseenter` when the highlighted index hasn't changed. Without this, an infinite async re-render loop kept calling `replaceChildren()` between `pointerdown` and `pointerup`, swapping the button out from under the click and dropping the event.
- **xterm viewport scroll froze after tab switching**: when bytes were written while a pane was `display: none`, xterm's internal scroll-area height went stale; if `fit.fit()` resolved to the same cols/rows the resize was a no-op and the viewport stayed frozen. `ui/src/tabs/manager.ts` now forces a `rows-1 → rows` cycle on tab activation, runs a second `ResizeObserver` pass, and adds a debounced `onWheelStuck` detector (any wheel event where `scrollTop` doesn't move triggers a re-fit). Replaces the old `onWheelAtBottom` handler which only caught scroll-down-at-bottom.

## v0.8.20 — Telegram approve-propagation design + plan docs

### Changed

- **Docs preserved**: cherry-picked `docs/superpowers/specs/2026-05-13-telegram-approve-propagation-design.md` (173 lines) and `docs/superpowers/plans/2026-05-14-telegram-approve-propagation.md` (738 lines) onto main from the now-retired `feat/telegram-approve-propagation` branch. These describe the design + implementation plan for the named-confirmation pathway that already shipped in code via `1a5fdde` (`feat(telegram): named confirmation via OperatorRegistry plumbed into Notifier`) and `80ecbd7` (`feat(telegram): typed inbound dispatch + named confirmation`). Keeping them in tree as historical record for that subsystem.

## v0.8.19 — Hermes executor support

### Added

- **Hermes (Nous Research) recognized as an executor**: launching `hermes` (or `/usr/local/bin/hermes`, `env … hermes`, `hermes setup`, …) in any tab now lights the status-bar chip as `🤖 hermes`. Detection regex lives next to the other executor patterns in `ui/src/executor.ts`. The wider integration plan is captured in `docs/specs/3.21-hermes-executor.md`.
- **"Hermes" spawn preset**: ships as a default in `crates/app/src/spawns_store.rs` (command `hermes`, no args, no model field — Hermes manages its own model via `hermes model` / `hermes setup`). Existing installs are backfilled via a narrow `BACKFILL_IDS` migration on next app launch — only the Hermes row is added, anything the user has previously removed stays removed, and a malformed `spawns.json` still falls back to an empty list instead of being silently overwritten.
- **Hermes Thinking-phase detection**: `crates/blocks/src/executor_phase.rs` now flips the per-session `ExecutorPhase` to `Thinking` on either `Initializing agent...` or the boxed assistant-panel top line `╭─ ⚕ Hermes …╮`. The U+2695 STAFF OF AESCULAPIUS glyph immediately followed by the literal word `Hermes` is the discriminator; the welcome banner (`╭─ Hermes Agent v…╮`, no ⚕) and the per-turn status footer (`⚕ <model> │ … │ ⏲ 5s`, no `Hermes`) are explicitly tested as non-matches so the operator engine doesn't see phantom turns.

## v0.8.18 — Light splash polish + settings-over-notes + ungroup reflow

### Changed

- **Boot splash, light mode**: dropped the card frame (border, gradient background, layered shadows) so the light splash matches dark — just the orb sitting on the page gradient. Removed from both the `@media (prefers-color-scheme: light)` first-paint block and the persisted `body.theme-light` rules in `ui/src/styles.css`.
- **Project Notes — command editor buttons**: restyled Save/Cancel in `ui/src/project-notes/styles.css`. Save is now white-on-accent with a brightness hover; Cancel is an outlined ghost button matching the app's `wiz-modal` action pattern. Padding/radius bumped to 6×14 / 6 px to feel less cramped.

### Fixed

- **Settings hidden under Project Notes**: the floating `.pn-panel` (position:fixed, z-index 30) used to sit on top of full-page routes. Added a rule in `ui/src/styles.css` that hides the panel whenever Settings, Docs, Drafts, Mission, Operator, or Capabilities is open.
- **Tabbar — stale layout after ungroup**: ungrouping a group (or removing a tab from a group) sometimes left the resulting tabs styled with the previous group's row layout until a window resize forced a reflow. `ui/src/tabs/manager.ts` now flushes layout (`offsetHeight` read + synthetic `resize` event) after `ungroup` and `removeTabFromGroup`.
- **Pi overlay shortcut removed**: ⌘⌥P used to toggle a transient Pi RPC overlay that no longer exists. The handler in `ui/src/main.ts` and the entry in `ui/src/shortcuts/registry.ts` are gone; only ⌘⌥⇧P (create a permanent Pi tab) remains.

## v0.8.17 — Git popover redesign + providers overhaul + Sansation UI font

### Added

- **Git branch popover redesign**: filter input at the top (auto-focus, Esc clears) that filters both Branches and Worktrees lists in place. Rows are compact (single-line meta, fixed 32 px height) with flat hairline dividers drawn via `::before` so focused/current rows render with full border-radius. Current branch is pinned to the top of the Branches list and branches checked out in another worktree are removed from Branches entirely — they only appear in the Worktrees section below. Popover bottom corners are flat so it sits flush against the statusbar, and `z-index` was raised from `170` → `1450` so higher-stacked overlays no longer eat clicks (`ui/src/status/bar.ts`, `ui/src/styles.css`).
- **Providers settings overhaul**: large rewrite of `ui/src/settings/providers.ts` (~860 lines) with new backing commands in `crates/app/src/providers_cmd.rs` and typed wrappers in `ui/src/api.ts`. Three exploratory layout mockups (master-detail / tiles / table) shipped under `docs/mockups/`.
- **Sansation UI font**: loaded from Google Fonts via `@import` and inserted at the head of the `--ui-font` stack so the chrome picks it up while preserving the existing system fallback chain (`ui/src/styles.css`).

### Changed

- **Project-notes styles tweak**: minor adjustments in `ui/src/project-notes/styles.css`.

## v0.8.16 — CustomSelect rollout + right-panel polish + tooltip stability

### Added

- **CustomSelect component**: new accessible dropdown (`ui/src/ui/select.ts`) replacing native `<select>` across settings/providers, settings/operators, settings/model_routes, settings/spawns, capabilities, convergence/tile, familiars settings, operator panel, structure editor, and the provider preset chooser. Buttons render with the current chrome tokens; the option list pops in a positioned floating panel so the look is consistent in dark and light themes.
- **Minimal right-panel chrome**: introduces `--sidebar-bg` as a single flat material for `#activity-sidebar`, `#teammate-panel`, `.familiar-panel`, `.settings-nav`, `.docs-sidebar`, `.capabilities-nav`, `.structure-host`, and `.pn-panel`. Inner headers, composers, and tab strips render with transparent backgrounds and no borders so each rail reads as one continuous surface. Hover tint for titlebar icons, sidebar nav items, and familiar tabs is unified at `rgba(var(--ink-rgb), 0.055)`. The LEFT tabbar (`#tabbar-host`) is intentionally excluded so the group/connector/avatar treatment from v0.8.14 is preserved.
- **Teammate composer polish**: input gets a flat `#090b0f` background, 46 px min-height, no border or shadow, lowercase placeholder, and `autocomplete=off / autocapitalize=off / autocorrect=off / spellcheck=false` so the operator name isn't auto-mangled by the OS (`ui/src/teammate/panel.ts`).
- **Project-notes slide-in**: project-notes panel now reuses the 160 ms `right-rail-panel-in` animation introduced for Activity/Teammate in v0.8.13, with `prefers-reduced-motion` honored (`ui/src/project-notes/styles.css`).

### Fixed

- **Tooltip no longer dies on micro cursor moves**: dropped the cursor-rect watchdog that hid the tooltip whenever the pointer was even a couple of pixels outside the target rect. Normal `mouseleave` still handles the "cursor actually left" case, and the DOM-detach branch still hides orphaned tooltips when a streaming UI re-renders the hovered row. Removed the unused window-level `pointermove` listener (`ui/src/tooltip/tooltip.ts`).
- **Active/hover X on left-mode tabs**: restored `body.tabbar-left .tab-btn .tab-close { opacity: 0 }` baseline with `:hover` / `.active` → `0.82` (`ui/src/styles.css`). The X shows on the currently selected tab and on any tab you hover, but stays hidden otherwise — the avatar and group connector line are no longer competing with always-visible close glyphs.

## v0.8.15 — Copilot CLI phase detection + activity notch polish

### Added

- **GitHub Copilot CLI executor phase detection**: The phase detector now recognizes Copilot's tool plan lines (`● <Title> (<kind>)` where kind is one of `shell`/`write`/`edit`/`create`/`read`/`search`) and routes them to `Writing`/`Reading`/`Running` accordingly, plus its live status footer (gerund + `esc cancel`) which now maps to `Thinking`. This brings Copilot in line with the existing Claude Code / Codex / Pi detection so the Activity sidebar reflects what Copilot is actually doing (`crates/blocks/src/executor_phase.rs`).

### Changed

- **Activity notch header is fixed-height and no longer grows**: The inline-notch agent card is now locked to 64px (`height` + `min-height` + `max-height` + `flex: 0 0 64px`) with `14px 12px` padding, and the sub line (`▸ <phase>`) uses single-line `text-overflow: ellipsis` instead of `-webkit-line-clamp: 2`. Long process descriptors truncate cleanly instead of expanding the card and pushing the activity stream down (`ui/src/styles.css`).
- **Spawns chip is borderless by default**: Removed the always-on `1px solid rgba(255,255,255,.14)` border and faint `rgba(255,255,255,.02)` background from `.spawns-chip`; the chip now sits flush in the titlebar and only picks up its hover treatment when hovered. The popover background also shifted from the opaque `rgba(14,18,24,.96)` to the lighter glass `rgba(20,24,30,.85)` used elsewhere (`ui/src/spawns/styles.css`).

### Fixed

- **Activity notch header no longer flashes a hover background**: Both dark and light theme rules for `.inline-notch .inline-notch-head:hover` are now `background: transparent`, removing the `color-mix(... var(--text) 6%)` / `var(--text-primary) 5%` wash that appeared whenever the cursor crossed the agent card at the top of the Activity sidebar (`ui/src/styles.css`).
- **Light-theme terminal background is opaque again**: `TERMINAL_THEME_LIGHT.background` was `rgba(0,0,0,0)`, which let whatever was behind the xterm canvas bleed through in light mode. Restored to `rgba(255,255,255,0.97)` so the terminal sits on a proper light surface (`ui/src/tabs/manager.ts`).

## v0.8.14 — Provider field focus fix + terminal font typeahead

### Added

- **Monospace font typeahead in Terminal settings**: New `list_monospace_fonts` Tauri command enumerates installed monospace families via `fontdb` and feeds them into the Terminal settings font input as a `<datalist>`, so the font field now offers an autocomplete dropdown of what's actually installed instead of forcing users to guess exact family names (`crates/app/src/lib.rs`, `ui/src/api.ts`, `ui/src/settings/panel.ts`).

### Fixed

- **Provider field inputs no longer steal focus on every keystroke**: Every keystroke in the Anthropic key, OpenAI-compat URL, or any of the four Azure Foundry fields (endpoint, key, api version, deployment) was calling `onChange`, which made the settings panel re-render the whole providers tab via `root.innerHTML = ""`, destroying the input the user was typing into. Field inputs now mutate the entry object in place and skip the re-render entirely; persistence still works because `settings` is the same reference as `panel.current` and the Save submit serializes it as-is. The Mode dropdown still triggers a re-render (renamed `restructure()`) because flipping to Azure OpenAI shows/hides the Deployment field. This was also the proximate cause of the 401 on Test connection for Azure Foundry — focus loss made it impossible to paste/type the full 88-char key cleanly, so the persisted/sent value was truncated; with focus preserved the live DOM value reaches the Tauri command intact (`ui/src/settings/providers.ts`).
- **Settings tabs render with uniform vertical padding**: Tab switching toggles section visibility via `display:none`, so `.settings-section:first-of-type`/`:last-of-type` always matched the DOM-first/last sections (Providers/Workspace) regardless of which tab was active, giving those two tabs a different vertical offset than the rest. Removed both pseudo-class paddings; every tab section now lines up the same way (`ui/src/styles.css`).
- **Sidebar resizer no longer paints over full-page routes**: The absolutely-positioned `.sidebar-resizer` at z-index 45 was painting a faint vertical line over Settings, Docs, Drafts, Mission, Operator, and Capabilities pages on hover, even though the right rail underneath was `display:none`. The resizer handles are now hidden whenever any of those pages is open (`ui/src/styles.css`).

## v0.8.13 — Spec Creator chooser polish + project-notes slide-in

### Added

- **Spec Creator branded chooser header**: The spec-chat chooser overlay now renders a centered "Spec Creator" brand (sparkles icon in `--accent` + a lowercased lead line) instead of the bare "What do you want to do?" title. The wizard panel title also shifts from "New spec" → "Spec Creator" so the two surfaces share a name (`ui/src/spec-chat/index.ts`, `ui/src/spec-chat/panel.ts`, `ui/src/styles.css`). A reference mockup lives at `docs/mockups/spec-chooser-titles.html`.
- **Project-notes panel slide-in animation**: The right-rail project-notes panel reuses the same 160ms `right-rail-panel-in` animation introduced for Activity/Teammate in v0.8.12, with `prefers-reduced-motion` honored (`ui/src/project-notes/styles.css`).
- **Operatorsv2 portrait set tracked**: 162 PNG portraits (18 operators × 9 expressions: duda/enojo/expectacion/feliz/incomodidad/neutral/sorpresa/triste/ver) under `ui/operatorsv2/` are now version-controlled. Not yet referenced by any operator/familiar code — wiring lands in a later change.

### Changed

- **Spec-chat overlay dismiss UX**: Both the chooser overlay and the wizard panel now dismiss on `Escape` and on backdrop click. Key handlers are registered on open and removed on close so nothing leaks. Vitest coverage added for Esc dismiss and backdrop click in `ui/src/spec-chat/index.test.ts`.

### Fixed

- **Reopening spec-chat after the panel-X close**: When the user closed the wizard via its own X button (bypassing `controller.close()`), the controller's `panelMounted` flag stayed `true` and `host.hidden` stayed `false`, so reopening did nothing visible. The panel now exposes an `onClose` callback; the controller hooks it to reset state and hide the host. Test in `ui/src/spec-chat/index.test.ts` verifies a fresh panel mounts on the next open (`ui/src/spec-chat/panel.ts`, `ui/src/spec-chat/index.ts`).

## v0.8.12 — Azure Foundry provider + workspace-switch orb polish

### Added

- **Azure Foundry provider (AzureOpenAi + AiInference modes)**: New `ProviderKind::AzureFoundry` variant with a full `AzureFoundryProvider` implementation that speaks both Azure OpenAI's deployment-based endpoints and the Azure AI Inference catalog. Mode is chosen per-provider entry; the provider builds the right URL shape, headers (`api-key` for AOAI, `Authorization: Bearer …` for AI Inference), and request body for each. Streaming uses the shared OpenAI-compatible SSE parser (`crates/agent/src/provider/azure_foundry.rs`, `crates/agent/src/provider/mod.rs`).
- **Foundry routing through `resolve_route`**: The provider resolver now validates and dispatches Foundry providers — checks endpoint, key, mode-specific fields (deployment name for AOAI, model name for AI Inference) before constructing the client, returning structured errors instead of panicking downstream (`crates/app/src/provider_resolve.rs`).
- **`list_models_azure_foundry` Tauri command**: New command lets the settings UI query a Foundry endpoint for available deployments/models so the user can pick from a dropdown instead of typing names by hand (`crates/app/src/providers_cmd.rs`, `crates/app/src/lib.rs`).
- **Provider entry settings + UI card**: `ProviderEntry` gains Azure Foundry fields (endpoint, key, mode, deployment, model, api version) with sensible defaults. The settings panel renders a dedicated Foundry card whose visible fields swap based on the mode toggle, mirroring the data model (`crates/app/src/settings.rs`, `ui/src/settings/providers.ts`, `ui/src/settings/panel.ts`).
- **Typed API wrapper**: `ui/src/api.ts` adds Foundry types and a wrapper around `list_models_azure_foundry` for the settings card.
- **Wiremock coverage**: New `crates/agent/tests/provider_azure_foundry.rs` exercises both modes end-to-end against a mock server — request shape, auth header, streaming SSE, and error paths.

### Changed

- **Shared OpenAI SSE parsing**: Extracted SSE chunk decoding out of `openai_compat.rs` into a new `crates/agent/src/provider/openai_sse.rs` so both the existing OpenAI-compatible provider and the new Foundry provider reuse one parser instead of duplicating delta logic.
- **Workspace-switch overlay reuses the boot-splash orb**: The loader that appears during PTY teardown/respawn no longer uses the tiny spinner + label; it now renders the same orb/headline vocabulary as first boot, with the target workspace name as the headline and a "Switching" meta label. The overlay also hides the titlebar, activity sidebar, teammate panel, status bar, and familiar panel so the orb is the only visible surface (`ui/index.html`, `ui/src/styles.css`, `ui/src/tabs/manager.ts`, `ui/src/workspaces/manager.ts`).
- **Titlebar reorder + lighter count badges**: Moved the project-notes button to the right of the view-button group with a separator so the blocks/files/activity trio reads as a single cluster. Tab and group count badges lost their dark filled circles in favor of transparent backgrounds and dimmer ink in both themes, so they no longer compete with primary chrome (`ui/index.html`, `ui/src/styles.css`).
- **Right-rail panel slide-in**: Added a subtle 160ms slide-in animation for the Activity and Teammate side panels, respecting `prefers-reduced-motion` (`ui/src/styles.css`).
- **Redundant switch toast dropped**: `WorkspaceSwitcher.runSwitch` no longer pushes a "Switching to X…" info toast since the new overlay already covers it (`ui/src/workspaces/switcher.ts`).

## v0.8.11 — Teammate task cards in DM (operators take tasks)

### Added

- **`propose_task` LLM tool**: Operators get a new structured-output tool so when the user asks for actionable work ("Mibli, revisa la migración de auth…"), the model emits a `MessageContent::Propose` payload instead of free text. Tool description steers it away from chitchat. Defined in `crates/app/src/teammate/tools.rs`; the dispatcher (`crates/app/src/teammate/llm.rs`) returns a new `DispatchOutcome::{Text, Propose}` so propose calls short-circuit the tool-use loop.
- **Task lifecycle commands**: Four new Tauri commands wire the chat to the existing `Task` types — `teammate_confirm_task` creates the row + transitions operator state + inserts a `TaskUpdate::Started`; `teammate_cancel_task_proposal` marks the propose dismissed; `teammate_edit_task_proposal` rewrites the draft; `teammate_attach_session_to_task` binds the spawned tab's SessionId. `teammate_list_tasks` stops returning an empty stub. Tests cover confirm/twice/cancel paths (`crates/app/src/teammate/commands.rs`, `crates/app/src/lib.rs`).
- **Task card component in the DM rail**: New `ui/src/teammate/task-card.ts` renders Propose messages as a card with archetype badge (Do/Review/Watch), title, deliverable, scope, and Confirmar/Editar/Cancelar buttons. Disabled/confirmed/cancelled states match the mockup. CSS scoped to `.task-card*` in `ui/src/styles.css`.
- **Panel switches on `content.kind`**: `ui/src/teammate/panel.ts` now dispatches per message kind — text bubble, propose card, system line for `task_update`. Confirmar handler calls `teammateConfirmTask` → spawns a new tab via the injected `spawnTabForTask` (wired to `tabsManager.createTab` in `ui/src/main.ts`) → `teammateAttachSessionToTask` to bind the SessionId. Editar opens a prompt-based inline edit for the title.
- **Tagged `TeammateContent` API**: `ui/src/api.ts` replaced the loose `kind: ... data: unknown` shape with a discriminated union covering `text | task_draft | task_update | propose | report`. Added `Task`, `TaskDraft`, `ProposeTask`, `TaskReport`, `TaskArchetype`, `TaskStatus`, `UpdateKind` interfaces and wrappers for the new commands plus an `onTeammateTask` event listener.
- **Schema: confirm/dismiss timestamps**: `teammate_messages` gets `confirmed_at_unix_ms` and `dismissed_at_unix_ms` (idempotent ALTERs for existing DBs). Six new storage helpers (`teammate_get_message`, `teammate_mark_message_confirmed`/`_dismissed`, `teammate_update_message_content`, `teammate_list_tasks_for_operator`, `teammate_update_task_spawned_session`) expose proposal + task state to the commands layer (`crates/app/src/storage.rs`, `crates/app/src/teammate/types.rs`).

### Changed

- **Workspace keep-alive (LivePool) attempt reverted**: The keep-alive series (PR #2) shipped LivePool with LRU hibernation, activity badges, and detach/attach/dispose on `TabManager`. It introduced a workspace-switch hang because the new `TabManager.detach()` removed the global tabbar/workspace elements from the DOM while the factory then constructed fresh managers pointing at those same (now-orphan) elements, so xterm.js never resolved layout. Reverted the whole merge until the design is reworked to give each manager its own internal containers under the shared parents (not the parents themselves).



First tagged release of the operators-as-teammate cut (v0.7.12 → v0.8.10). The full cycle is documented section-by-section in **v0.8.0 → v0.8.9** below — DM rail foundation, conversational operator, world-model context, multi-turn tool-use with `read_file`, plus light-mode contrast fix, header/avatar/XP-ring polish, and right-rail toggle exclusivity.

### Changed

- **Info toasts get a softer border**: dropped the bright green `border-left` accent on `.toast.toast-info` and lowered the outer border alpha so info toasts read as ambient hints, not notifications (`ui/src/styles.css`).

## v0.8.9 — Teammate composer breathing room (focus halo no longer clips)

### Fixed

- **3px focus halo on the chat input no longer cuts against the panel border**: The teammate rail uses `overflow: hidden`, which was clipping the input's translucent focus halo at the left/right/bottom edges. Bumped the composer's horizontal padding from 10→14 px and bottom padding from 8→12 px so the halo sits inside the safe area. Added `box-sizing: border-box` to the input and tightened its inner padding to keep the overall height visually identical to before (`ui/src/styles.css`).

## v0.8.8 — Operators can read files (tool-use loop with `read_file`)

### Added

- **`read_file` tool, sandboxed to the active tab's cwd**: New `crates/app/src/teammate/tools.rs` with a pure `read_file` function gated by a `ToolEnv` (canonicalized root + 200KB per-file cap). Rejects absolute paths outside root, `..` traversal, oversized files, missing files, and non-UTF-8 binaries. 9 unit tests cover the sandbox edges.
- **Multi-turn tool-use dispatch**: New `dispatch_reply_with_tools` in `crates/app/src/teammate/llm.rs` loops up to 8 turns: assistant emits `tool_use` blocks → backend executes each call via the tools module → user reply carries `tool_result` blocks → repeat until the model emits final text. Powered by a thin reqwest helper (`crates/app/src/teammate/anthropic_http.rs`) since `karl_agent::AskRequest` only supports single-turn forced-tool calls.
- **System prompt announces the tool**: Operators are told to invoke `read_file` instead of guessing file contents and that paths are relative to the active tab's cwd.
- **`teammate-tool-call` Tauri events** stream each tool execution to the rail. The panel renders a small monospaced audit line per call (`📖 read_file · src/main.rs`); errors render with a `⚠` icon and danger tint. The line sits above the typing indicator so the order reads: history → reads → typing → final bubble (`ui/src/api.ts`, `ui/src/teammate/panel.ts`, `ui/src/styles.css`).

### Changed

- **Send command picks the dispatch path** based on whether the active session has a known cwd. With cwd: tool-use loop with `ToolEnv` rooted there. Without: plain `dispatch_reply` (no tools). Non-Anthropic providers always fall back to the plain path (`crates/app/src/teammate/commands.rs`).

### Notes

- Only `read_file` ships in this release. `grep`, `git_log`, `git_diff` follow the same pattern and can be added incrementally without touching the loop.
- Tool calls are NOT persisted in the thread (`teammate_messages`). Only the final operator text is. Progress lines render live from events and live as DOM history within the open session, not across reopens.
- Iteration cap is 8 turns; over that, the dispatch errors out with a system bubble explaining the loop exceeded budget.

## v0.8.7 — All five right-toolbar buttons share the same toggle visuals

### Fixed

- **Project Notes button now mutes when inactive and lights when active**, matching the four sibling buttons (Blocks / Files / Activity / Teammate). Cause: the button had `titlebar-icon-btn` but was missing `titlebar-view-btn`, so the muted-default + tinted-active rules in `.titlebar-view-btn` skipped it. Adding the class makes its visual lifecycle identical to the others; removed the now-redundant per-id active rule from CSS (`ui/index.html`, `ui/src/styles.css`).
- **Project Notes claims the right rail from every entry point**, not just the toolbar click: `openProjectNotes` now dispatches `teammate:close` and clears the teammate button's active class, so opening Notes from drafts, group chips, or anywhere else still closes any competing rail (`ui/src/main.ts`).

### Notes

- No behavior change to Teammate or `pickView`; those already closed competitors via the events introduced in v0.8.6.

## v0.8.6 — Right-rail toggles are mutually exclusive + level pill moves next to the name

### Fixed

- **Right-rail toggles no longer stack**: Opening the teammate rail now dispatches `project-notes:close` and clears the activity-view class first, and conversely the activity/blocks/files (`pickView`) and project-notes button handlers now dispatch `teammate:close` before opening. The right rail is a single slot and only one panel renders at a time. Symptom was the teammate panel rendering on top of activity (or vice versa) when the user toggled between views without closing the previous one first (`ui/src/main.ts`).
- **Stale `titlebar-view-active` highlight** on the chat icon is now cleared by the shared `closeTeammateIfOpen` path, including when teammate is closed from outside via the new `teammate:close` event (`ui/src/main.ts`).

### Changed

- **Level pill lives next to the name, not over the avatar**: The badge was crowding the 32px avatar at its bottom-right corner. It moved into a new `.teammate-panel-title-row` alongside the operator name (e.g., `Mibli  [LV 2]`), styled as a small tinted pill in the operator's color. The XP ring around the avatar stays as the per-level progress indicator (`ui/src/teammate/panel.ts`, `ui/src/styles.css`).

### Notes

- The level test moved to assert the pill is in `.teammate-panel-title-row` and absent from the avatar wrap. `getActiveSessionId` resolver, sendText, message handling — all unchanged.

## v0.8.5 — Teammate header: XP ring + thin chevron at the right

### Added

- **XP ring around the panel avatar**, matching the tab-bar treatment. Driven by the operator's `xp` field via a `--xp-progress` CSS variable; the arc fills clockwise and resets at each level-up. Stroke uses the operator's color so it doubles as identity. A small level badge sits on the avatar's bottom-right corner — same gamification cue as on the tabs (`ui/src/teammate/panel.ts`, `ui/src/styles.css`).

### Changed

- **Chevron is now an inline SVG at the far right of the header**, not a thick `▾` text glyph next to the name. 1.25px stroke, muted color, rotates 180° when the switcher popover is open. Name + model subtitle have the whole left side to themselves (`ui/src/teammate/panel.ts`, `ui/src/styles.css`).
- **Avatar outline removed**: the XP ring now handles the operator-color accent, so the extra outline is redundant.

### Notes

- 2 new vitest cases assert the ring renders with the right `--xp-progress` value (`0.420` for `xp=142`) and level badge text (`2`), and that the chevron is the last child of the header.

## v0.8.4 — Teammate bubbles + header polish

### Changed

- **Operator bubbles tinted with the operator's color**: Each operator's `color` is set as a `--operator-color` CSS variable on the panel root and used as the bubble background (`color-mix` with `--bg-panel`). Mibli's bubbles look distinct from Karluiz's; reinforces identity (`ui/src/teammate/panel.ts`, `ui/src/styles.css`).
- **Operator bubbles grouped with a 22px inline avatar**: First bubble in a same-role run shows the avatar to its left; subsequent bubbles in the same run get an invisible spacer so they align. iMessage-style grouping. User bubbles stay solo on the right (`ui/src/teammate/panel.ts`, `ui/src/styles.css`).
- **Header makes the switcher affordance obvious**: Caret moved from the far-right corner to sit right after the operator name. Model id rendered as a small monospaced subtitle below the name. Avatar gets a subtle outline in the operator's color. Caret rotates 180° when the switcher popover is open. The popover top offset adjusts for the taller header (`ui/src/teammate/panel.ts`, `ui/src/styles.css`).
- **Inline code rendering in bubbles**: Text wrapped in backticks (`` `path/to/file` ``) renders as a monospace pill. Mibli already produces this in replies; it now surfaces correctly (`ui/src/teammate/panel.ts`).
- **Bubble typography**: 13px / line-height 1.45 / 7×11 padding / 14px radius. Slightly larger, more breathing room, better readability in the narrow rail.
- **System-role bubble** gets a "⚠" prefix and a danger-tinted background so dispatch errors look like errors, not chat.

### Notes

- 3 new vitest cases cover avatar/title/subtitle layout, operator-row grouping, and `<code>` rendering. Existing tests adapted to the new DOM shape.
- The typing indicator is wrapped in the same row structure as a real operator bubble (avatar + bubble) so the dots animate in the spot the reply will land.

## v0.8.3 — Mibli sees your tabs (world-model in DM context)

### Added

- **World-model snapshot in every DM dispatch**: Before each reply, the backend projects every open session's `SessionWorldModel` (cwd, rolling summary, last few blocks, in-flight command) into a `# Terminal context` section that lands at the top of the user message. The active tab gets the full render; others get one-liners. The operator now answers "¿qué pasó en tab 2?" or "¿en qué directorio estoy?" from real context (`crates/app/src/teammate/world_snapshot.rs`, `crates/app/src/teammate/commands.rs`).
- **System prompt describes the context shape**: Cached portion of the prompt now explains what tabs the operator can see and when to ignore the section, so the model stops inventing context (`crates/app/src/teammate/llm.rs`).
- **`active_session_id` plumbed end-to-end**: `teammateSendText` carries the current active tab id from the frontend through the Tauri command so the backend can mark which session is "active" in the snapshot (`ui/src/api.ts`, `ui/src/teammate/panel.ts`, `ui/src/main.ts`).

### Notes

- Snapshot is regenerated per call (state changes per call anyway); the system prompt stays stable so prompt caching still hits.
- Tab labels in the snapshot are session-id last-6-chars + cwd. Human tab names from the manifest land in a later polish.

## v0.8.2 — Conversational operator (Mibli actually replies)

### Added

- **Operator replies via LLM dispatch**: Text sent to the DM rail now triggers a background task that loads the thread, builds a system prompt from the operator's persona, resolves the configured Operator-role provider, overrides the model with the operator's own field, and calls `collect_oneshot`. The reply persists and surfaces in the rail via a new `teammate-message` Tauri event (`crates/app/src/teammate/llm.rs`, `crates/app/src/teammate/commands.rs`, `ui/src/teammate/panel.ts`).
- **Typing indicator**: While the dispatch is in flight, a three-dot bouncing bubble sits where the reply will land (`ui/src/styles.css`).
- **System-role error surfacing**: If dispatch fails (no provider configured, API error, empty reply), a `System` role message is persisted and emitted into the thread so the user can see what went wrong.

### Notes

- Conversation window is the last 20 messages, sent as a single user-side string. Phase 3 will introduce rolling summary compaction once threads grow long enough to matter.
- The operator does not see PTY blocks yet — world-model integration lands in Phase 3 (Review/Do tasks need it anyway).

## v0.8.1 — Teammate rail polish (avatar + switcher + composer)

### Added

- **Teammate switcher**: The DM rail header is now a button that opens a popover listing every operator in the roster with their avatar; click any of them to swap the thread. Default operator is tagged, the active one is highlighted. Esc or click-outside dismisses. (`ui/src/teammate/panel.ts`).

- **Operator avatar in the rail header**: The Phase 1 placeholder showed only the name, which read as a label instead of a person. The header now renders the operator's avatar via the shared `renderAvatarHtml` helper, alongside the name and a caret hinting at the switcher (`ui/src/teammate/panel.ts`, `ui/src/styles.css`).

### Changed

- **Bubbles anchor to the composer when the thread is sparse**: `.teammate-panel-thread` now uses `justify-content: flex-end`, so a single message sits next to the input instead of floating at the top of a sea of empty space. The empty-state placeholder uses `margin: auto 0` to stay vertically centered (`ui/src/styles.css`).

- **Composer focus state matches the rest of Covenant**: The input swaps from a raw `border-color: var(--accent)` swap to a soft accent border plus a 3px translucent accent halo, consistent with how settings inputs draw focus elsewhere (`ui/src/styles.css`).

- **`TeammatePanel.openFor` accepts an `Operator` instead of `(id, name)`**: The panel now needs the full operator (for the avatar) and the roster (for the switcher). Internal API change only; the single caller in `ui/src/main.ts` was updated.

### Fixed

- **Dead `.teammate-panel-empty` rule removed**: A stale earlier-iteration block at `ui/src/styles.css` line ~13832 (monospace font + different padding) duplicated the canonical empty-state styling and only confused readers — it was already losing the cascade to the rule near the rest of the teammate styles. Cleaned up.

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
