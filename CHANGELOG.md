# Changelog

All notable changes to Covenant.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Each version section may include any of: **Added**, **Changed**, **Fixed**,
**Removed**.

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
