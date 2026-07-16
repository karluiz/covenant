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

/// Stamp the platform onto <html> so CSS can branch too:
/// `:root[data-platform="windows"]`, `:root:not([data-platform="mac"])`.
/// Call once, as early in boot as possible — chrome rules depend on it,
/// and a late call means a frame of macOS-shaped layout on other systems.
export function applyPlatformAttribute(doc: Document = document): void {
  doc.documentElement.dataset.platform = currentPlatform();
}
