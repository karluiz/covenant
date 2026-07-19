/// Theme axis — independent of `window_background`. `system` follows the
/// macOS appearance via prefers-color-scheme; the resolved value is what
/// we actually apply to the DOM and pass to the backend.
///
/// `special` is a wallpaper-backed Special Theme; which one is a separate
/// setting (`window.special_theme`), so resolving it needs that id.
import { SPECIAL_THEMES, isSpecialThemeId } from "./special";

export type ThemeMode = "dark" | "light" | "system" | "true_dark" | "special";
export type ResolvedTheme = "dark" | "light";

const LIGHT_QUERY = "(prefers-color-scheme: light)";

export function resolveTheme(
  mode: ThemeMode,
  specialId?: string | null,
): ResolvedTheme {
  if (mode === "special") {
    // An unknown id means a hand-edited config.json. Fall back rather
    // than render a broken theme.
    return isSpecialThemeId(specialId) ? SPECIAL_THEMES[specialId].base : "dark";
  }
  if (mode === "light") return "light";
  if (mode === "dark" || mode === "true_dark") return "dark";
  return window.matchMedia(LIGHT_QUERY).matches ? "light" : "dark";
}

/// Claude Code theme name matching a resolved Covenant appearance. We use
/// the colorblind-friendly (daltonized) variants to match the palette
/// Covenant ships. Passed to `claude --settings '{"theme":"…"}'` so a
/// session launched from the spawns chip matches Covenant. Mirrors the
/// backend mapping in `theme.rs` (COVENANT_CLAUDE_THEME).
export function claudeThemeFor(resolved: ResolvedTheme): string {
  return resolved === "light" ? "light-daltonized" : "dark-daltonized";
}

/// Subscribe to OS appearance changes. Only relevant while mode === "system".
/// Returns an unsubscribe function the caller invokes when mode changes or
/// the app shuts down.
export function watchSystemTheme(onChange: (t: ResolvedTheme) => void): () => void {
  const mq = window.matchMedia(LIGHT_QUERY);
  const handler = (e: MediaQueryListEvent) => onChange(e.matches ? "light" : "dark");
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}
