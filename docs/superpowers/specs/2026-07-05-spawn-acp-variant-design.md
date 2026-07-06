# Spawn ACP variant

Date: 2026-07-05. Status: approved.

## Goal

A spawn can be flagged as ACP. Running it opens an ACP chat tab (`createAcpTab`)
with the matching executor instead of writing its command line into the PTY.

## Model

- `SpawnSpec.acp?: boolean` (TS, optional) / `#[serde(default)] pub acp: bool`
  (Rust). Existing `spawns.json` deserializes unchanged.
- Eligibility: `acpExecutorFor(spec)` maps `command + args` through the existing
  `detectExecutor()` and returns an `AcpExecutor` (`"claude" | "copilot" | "pi"`)
  or `null`. Only eligible spawns can be ACP. `gh copilot` maps to `copilot`.

## Settings (Spawns editor)

- "Launch as ACP tab" checkbox in the detail pane, rendered only when the
  current command/args map to an AcpExecutor. Editing the command to a non-ACP
  executor drops the flag on the next persist (collect() re-validates).

## Execution

- `runSpawn` (main.ts): if `spec.acp` and eligible → `createAcpTab({ executor,
  cwd: activeCwd() })`; otherwise current PTY write. ACP always opens a new tab —
  there is no in-terminal ACP mode. Covers picker, chip play button, Ctrl+N and
  pane context menu "Start agent" (runDefaultAgent routes through runSpawn).
- `defaultAgentCmdline` returns `null` for an ACP default spawn (cannot preload
  an ACP session into a shell tab); caller falls back to a plain tab.

## Chip

- Popover items of ACP spawns show a small "ACP" badge.

## Skipped

Mode enum, per-spawn ACP config (model/resume), acp_enabled gating (the ⌘⌥⇧C
ACP tab is ungated; per-operator acp_enabled is a different concern).
