// Which OS we're running on — one answer, asked once.
//
// This used to be four hand-rolled UA regexes (main, welcome-hint,
// persona-composer, onboarding) with three different predicates and two
// different sources, one of them `navigator.platform`, which is deprecated.
// They all guessed at the same fact the Rust side already knows for certain.
//
// tauri-plugin-os injects that fact into the webview at startup, so
// `platform()` is a synchronous property read: no IPC, no permission, no
// guessing. Everything platform-conditional in the frontend goes through
// here.

import { platform as tauriPlatform } from "@tauri-apps/plugin-os";

/// The variants the UI actually branches on. Anything Unix-but-not-macOS
/// is `linux` — we don't ship BSD builds, and if we ever do, the chrome
/// questions have the same answers there.
export type Platform = "mac" | "windows" | "linux";

/// Ask the plugin. Null when its internals aren't injected — i.e. we're
/// not inside Tauri (unit tests, iframe mockups), or we asked before the
/// webview was ready.
function fromPlugin(): Platform | null {
  try {
    const p = tauriPlatform();
    if (p === "macos" || p === "ios") return "mac";
    if (p === "windows") return "windows";
    return "linux";
  } catch {
    return null;
  }
}

let cached: Platform | null = null;

/// The current platform.
///
/// Only a real answer is cached. A UA sniff at module-eval time — before
/// the plugin's internals land — would otherwise freeze a guess in for the
/// whole session, which is exactly the class of bug this module exists to
/// kill. So the fallback is recomputed until the plugin can speak.
export function currentPlatform(): Platform {
  if (cached) return cached;
  const p = fromPlugin();
  if (p) {
    cached = p;
    return p;
  }
  return /Mac|iPod|iPhone|iPad/i.test(navigator.userAgent) ? "mac" : "linux";
}

export function isMac(): boolean {
  return currentPlatform() === "mac";
}

/// Display name of the chord modifier on its own, for keycap chips that
/// render one key per box: `⌘` `K` / `Ctrl` `K`.
export function modKey(): string {
  return isMac() ? "⌘" : "Ctrl";
}

/// The same modifier as an inline prefix: `⌘T` / `Ctrl+T`. macOS glyphs
/// abut the key they modify; a spelled-out name needs the separator. Both
/// forms exist because both readings are correct in their own context —
/// don't collapse them.
export function modPrefix(): string {
  return isMac() ? "⌘" : "Ctrl+";
}

/// A key in a chord. The modifiers are placeholders resolved per platform;
/// anything else is a literal cap ("T", "G", ","). `mod` is the primary
/// chord modifier — Command on macOS, Ctrl elsewhere. `ctrl` is the actual
/// Control key, which on macOS is a *different* key from `mod`.
/// A key in a chord.
///
/// `mod` is the app modifier: Command on macOS, Ctrl elsewhere. Use it for
/// chords whose key the shell doesn't want (`mod`+`,` for Settings).
///
/// `appmod` is the same intent for chords that land on a key readline owns.
/// It resolves to plain Command on macOS but to **Ctrl+Shift** everywhere
/// else, because in a terminal Ctrl is a content key: `Ctrl+T` is
/// transpose-chars, `Ctrl+W` is unix-word-rubout, `Ctrl+G` is abort. Taking
/// those for tab management would break the shell to deliver a tab. GNOME
/// Terminal, Kitty and Alacritty all land on Ctrl+Shift for the same reason
/// — it's the terminal convention, not a workaround.
///
/// `ctrl` is the literal Control key, which on macOS is NOT `mod`.
export type ChordKey =
  | "mod"
  | "appmod"
  | "shift"
  | "alt"
  | "ctrl"
  | "enter"
  | "tab"
  | (string & {});

/// A token may expand to more than one cap — `appmod` is two keys off macOS.
const MAC_KEYS: Record<string, string[]> = {
  mod: ["⌘"],
  appmod: ["⌘"],
  shift: ["⇧"],
  alt: ["⌥"],
  ctrl: ["⌃"],
  enter: ["⏎"],
  tab: ["⇥"],
};

const SPELLED_KEYS: Record<string, string[]> = {
  mod: ["Ctrl"],
  appmod: ["Ctrl", "Shift"],
  shift: ["Shift"],
  alt: ["Alt"],
  ctrl: ["Ctrl"],
  enter: ["Enter"],
  tab: ["Tab"],
};

/// Render a chord for display.
///
/// macOS gives every modifier a single glyph, so they abut: ⌘⇧G. Nowhere
/// else does — GTK and Windows both spell them out and join with '+', and
/// that's what those users read: Ctrl+Shift+G. Mixing the two conventions
/// is how we ended up rendering "Ctrl+⇧G", which is neither.
///
/// Pass chords as tokens, never as pre-baked strings. A hardcoded "⌘⇧G"
/// can't be translated, and a half-migrated one leaks Apple glyphs onto
/// keyboards that don't have those keys.
export function formatChord(keys: readonly ChordKey[]): string {
  return chordKeys(keys).join(isMac() ? "" : "+");
}

/// The same resolution, one cap per key, for surfaces that box each key in
/// its own <kbd> instead of printing the chord as a string.
export function chordKeys(keys: readonly ChordKey[]): string[] {
  const map = isMac() ? MAC_KEYS : SPELLED_KEYS;
  return keys.flatMap((k) => map[k] ?? [k]);
}

/// A chord whose *shape* differs per platform, not just its spelling.
///
/// macOS has two modifier spaces — ⌘ and ⌘⇧ — that collapse into one off
/// macOS, where Ctrl belongs to the shell and app chords live on Ctrl+Shift.
/// So ⌘W and ⌘⇧W both want Ctrl+Shift+W and one of them has to give. There
/// is no mechanical mapping; each chord is a decision. Spell both sides.
///
/// Whatever you pass here MUST match what the handler accepts. A label is a
/// promise — printing a chord nothing listens for is worse than printing
/// none, which is how ⌘, ended up advertised on keyboards without a ⌘.
export function chordFor(mac: readonly ChordKey[], other: readonly ChordKey[]): string {
  return formatChord(isMac() ? mac : other);
}

/// True when the app-modifier for a terminal-conflicting chord is held:
/// Command on macOS, Ctrl+Shift elsewhere. The counterpart to `appmod` —
/// a handler MUST agree with the label its surface prints, or we advertise
/// a chord that does nothing.
export function appModHeld(e: {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}): boolean {
  return isMac() ? e.metaKey : e.ctrlKey && e.shiftKey;
}

/// True when the platform's primary chord modifier is held: Command on
/// macOS, Ctrl everywhere else.
///
/// Adopt this per shortcut, deliberately — never as a blanket sweep over
/// every `e.metaKey`. Covenant is a terminal, and off macOS the modifier
/// it maps to is a *content* key: Ctrl+C/D/Z belong to the shell, and a
/// chord that is safe to intercept under Command is not automatically
/// safe under Ctrl. Each site has to be judged on the letter it binds.
export function modHeld(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMac() ? e.metaKey : e.ctrlKey;
}

/// Stamp the platform onto <html> so CSS can branch too:
/// `:root[data-platform="windows"]`, `:root:not([data-platform="mac"])`.
/// Call once, as early in boot as possible — chrome rules depend on it,
/// and a late call means a frame of macOS-shaped layout on other systems.
export function applyPlatformAttribute(doc: Document = document): void {
  doc.documentElement.dataset.platform = currentPlatform();
}
