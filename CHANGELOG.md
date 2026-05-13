# Changelog

All notable changes to Covenant.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Each version section may include any of: **Added**, **Changed**, **Fixed**,
**Removed**.

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
