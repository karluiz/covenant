# Worktree Prompt Compaction — Design

**Date:** 2026-07-26
**Status:** Approved (scope + default confirmed by Karluiz)

## Problem

Covenant launches executors inside `.covenant/worktrees/<slug>` worktrees. The
user's shell prompt then shows the full path —
`~/Sources/groowcity/.covenant/worktrees/agent-claude-0722-df6/` — a ~60-char
line where the only informative parts are the repo name and the slug (and the
git branch already shown beside it). Users on stock prompts eat this on every
line. Covenant created these paths, so Covenant should make them readable.

## Scope

Worktree paths only. No general prompt editor, no path truncation outside
`.covenant/worktrees/`. Starship/p10k users are unaffected (they build their
own path segment and already truncate).

## Approach

Extend the existing per-shell integration snippets (`shell-integration/`),
which Covenant already sources **after** the user's rc in every tab (ZDOTDIR /
`--rcfile`). Native mechanisms per shell — no PS1 rewriting:

### zsh (`osc133.zsh`)

Define the `zsh_directory_name` hook. Any prompt using `%~` (zsh default and
most oh-my-zsh themes) renders `~[groowcity ⌥agent-claude-0722-df6]` instead of
the full path:

- On `d` (path → name) calls: match `(#b)(*)/.covenant/worktrees/([^/]##)` and
  reply with `${repo:t} ⌥$slug` plus the matched prefix length.
- If the user already defined `zsh_directory_name` (or the
  `zsh_directory_name_functions` array), chain instead of clobbering: append to
  `zsh_directory_name_functions`, which zsh consults natively.
- No-op for the `n` (name → path) direction — return 1 so `~[...]` names are
  display-only.

### bash (`osc133.bash`)

In the PROMPT_COMMAND hook the snippet already installs: when `$PWD` matches
`*/.covenant/worktrees/*`, set `PROMPT_DIRTRIM=2` (prompt shows
`.../worktrees/agent-claude-0722-df6`); otherwise restore the user's prior
value (saved once at snippet load).

### PowerShell (`osc133.ps1`)

The wrapper already captures the inner prompt's rendered string
(`$rendered = & $Global:_CovenantPrevPrompt`) before appending the `133;B`
marker. When the gate env is set, apply a display-only regex replace on
`$rendered`: `(?<repo>[^\\/]+)[\\/]\.covenant[\\/]worktrees[\\/](?<slug>[^\\/> ]+)`
→ `repo ⌥slug`. Covers the default prompt and any string-returning framework
(oh-my-posh, starship on pwsh). Prompts that write via `Write-Host` bypass the
string and are left untouched — acceptable no-op.

### fish

No change — `prompt_pwd` already truncates.

## Gate

- New field `TerminalConfig.compact_worktree_prompt: bool`, **default `true`**
  (`#[serde(default = "default_true")]`), persisted in `config.json` alongside
  font/ligature settings.
- At PTY spawn (`crates/app/src/lib.rs`, next to the `COVENANT_CLAUDE_THEME`
  export), export `COVENANT_COMPACT_WORKTREE=1` when enabled. Snippets check
  the variable and no-op when unset — mid-session toggles apply to new tabs,
  same lifetime semantics as the Claude theme env.
- Settings → Terminal gains one toggle: "Compact worktree paths in prompt"
  with sublabel "Show `repo ⌥slug` instead of the full `.covenant/worktrees/…`
  path (zsh/bash/pwsh)". Standard toggle chrome, sharp corners, `attachTooltip`.

Default-on rationale: display-only (never changes `$PWD` or shell behavior),
consistent with autosuggestions auto-loading in Covenant tabs, and the toggle
provides the exit.

## Error handling

- Older zsh without `zsh_directory_name_functions` support: guard with
  `typeset -ga` + feature check; on failure, skip silently — prompt stays long,
  nothing breaks.
- Paths not under a worktree: hooks return no-match; zero behavior change.

## Testing

- `crates/session` e2e (existing pattern: real zsh + snippet under tmp
  ZDOTDIR): cd into a fake `<repo>/.covenant/worktrees/<slug>`, assert the
  rendered prompt contains `⌥<slug>` and not `.covenant/worktrees`.
- Same test with `COVENANT_COMPACT_WORKTREE` unset asserts the full path
  (gate respected).
- bash: assert `PROMPT_DIRTRIM` set inside a worktree path and restored
  outside.
- pwsh: pure-function unit test on the replace regex (no PTY needed) —
  worktree path collapses, non-worktree strings pass through byte-identical.
  Runs on macOS CI via `pwsh` if present, else skipped (real e2e belongs to
  the M8 Windows pipeline).
