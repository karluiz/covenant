// Custom font-ligatures pipeline for xterm.js.
//
// xterm's own @xterm/addon-ligatures requires Node fs access to read
// the user's font file from disk — which Tauri WebKit does not have.
// Instead we ask the Rust side for the font bytes (via the
// `read_font_bytes` Tauri command), parse them with the pure-JS
// `font-ligatures` package, and register a character joiner on the
// terminal. The joiner is exactly the same hook `LigaturesAddon` uses
// internally — but driven by the *real* ligature table of the user's
// font, not a hardcoded fallback set.
//
// Requires the canvas (or webgl) renderer; the DOM renderer ignores
// joiners.

import { loadBuffer, type Font } from "font-ligatures";
import type { Terminal } from "@xterm/xterm";

import { readFontBytes } from "../api";

const FONT_CACHE = new Map<string, Promise<Font>>();

function getFont(familyStack: string): Promise<Font> {
  const cached = FONT_CACHE.get(familyStack);
  if (cached) return cached;
  const p = readFontBytes(familyStack).then((bytes) => {
    // loadBuffer takes ArrayBuffer; Uint8Array's underlying buffer may
    // be a SharedArrayBuffer view, so slice to detach a fresh copy.
    const ab = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    return loadBuffer(ab, { cacheSize: 1000 });
  });
  FONT_CACHE.set(familyStack, p);
  // If the load fails, evict so the next attempt re-tries.
  p.catch(() => FONT_CACHE.delete(familyStack));
  return p;
}

export interface LigatureHandle {
  dispose(): void;
}

/// Attach a ligature-shaping joiner to `term` driven by the system
/// font matched against the CSS `font-family` stack. Resolves to a
/// handle whose `dispose()` removes the joiner.
///
/// Returns `null` if the font cannot be located or parsed — caller
/// should silently fall back to no-ligatures rendering.
export async function attachLigatures(
  term: Terminal,
  familyStack: string,
): Promise<LigatureHandle | null> {
  let font: Font;
  try {
    font = await getFont(familyStack);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("ligatures: font lookup failed", err);
    return null;
  }
  const joinerId = term.registerCharacterJoiner((text) => {
    if (!text) return [];
    try {
      return font.findLigatureRanges(text) as [number, number][];
    } catch {
      return [];
    }
  });
  return {
    dispose: () => {
      try {
        term.deregisterCharacterJoiner(joinerId);
      } catch {
        /* ignore */
      }
    },
  };
}
