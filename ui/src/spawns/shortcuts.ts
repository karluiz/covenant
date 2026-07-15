import type { SpawnSpec } from "./types";
import type { AcpExecutor } from "../api";
import { detectExecutor } from "../executor";

/// How many spawns get an auto-assigned Ctrl+N shortcut. Bound to the
/// digit row 1..9 — the 10th+ executor in list order gets none.
export const SPAWN_SHORTCUT_MAX = 9;

/// Ctrl+N hint for the spawn at `index` (0-based, in listSpawns order).
/// Returns null past the cap. Uses the macOS Control glyph (⌃).
export function spawnShortcutLabel(index: number): string | null {
  return index < SPAWN_SHORTCUT_MAX ? `⌃${index + 1}` : null;
}

/// Build the command line that launches a spawn. Shared by the active-tab
/// quick-run and the Ctrl+N new-tab path so both produce identical input.
/// Returns the line WITHOUT a trailing newline — callers add it (or rely
/// on createTab's initialCommand, which appends one itself).
///
/// `claudeTheme` injects `--settings '{"theme":...}'` so Claude Code matches
/// Covenant's theme, but only for the claude executor and only when the user
/// hasn't already pinned a theme via --settings/--theme. Pass null to skip.
export function buildSpawnCmdline(
  spec: SpawnSpec,
  claudeTheme: string | null,
): string {
  const args = [...spec.args];
  if (
    claudeTheme &&
    detectExecutor(spec.command) === "claude" &&
    !args.some((a) => a === "--settings" || a === "--theme")
  ) {
    args.push("--settings", `'{"theme":"${claudeTheme}"}'`);
  }
  return [spec.command, ...args].join(" ");
}

/// Global "quick-call uses ACP" preference. When ON, the ▷ play button
/// (and dropdown quick-run) opens an ACP chat tab for any ACP-eligible
/// executor, regardless of the spawn's own `acp` flag. ponytail: UI-only
/// pref, localStorage — no Rust settings round-trip.
const QUICK_CALL_ACP_KEY = "covenant.quickCallAcp";
export const quickCallAcp = (): boolean =>
  localStorage.getItem(QUICK_CALL_ACP_KEY) === "1";
export const setQuickCallAcp = (on: boolean): void => {
  localStorage.setItem(QUICK_CALL_ACP_KEY, on ? "1" : "0");
};

/// ACP executor a spawn maps to, or null when it can't drive an ACP tab.
/// Runs the full cmdline through detectExecutor so `gh copilot` (command
/// "gh", args ["copilot"]) resolves like it does everywhere else.
export function acpExecutorFor(
  spec: Pick<SpawnSpec, "command" | "args">,
): AcpExecutor | null {
  const name = detectExecutor([spec.command, ...spec.args].join(" "));
  return name === "claude" || name === "copilot" || name === "pi" ? name : null;
}
