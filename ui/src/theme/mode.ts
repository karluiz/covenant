/// Theme axis — independent of `window_background`. `system` follows the
/// macOS appearance via prefers-color-scheme; the resolved value is what
/// we actually apply to the DOM and pass to the backend.
export type ThemeMode = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

const LIGHT_QUERY = "(prefers-color-scheme: light)";

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === "light") return "light";
  if (mode === "dark") return "dark";
  return window.matchMedia(LIGHT_QUERY).matches ? "light" : "dark";
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
