// Global UI zoom — Cmd+= / Cmd+- / Cmd+0.
//
// Implementation: the webview's NATIVE page zoom (WKWebView pageZoom via
// Tauri). This used to be CSS `zoom` on <html>, which WebKit applies to
// painting but NOT to `getBoundingClientRect()` — rects come back in
// layout px while MouseEvent client coords are visual px. Every floating
// surface then needed a `/ zoom` fudge, and xterm.js was unfixable: a
// counter-zoom on the terminal host corrected the cell size but not the
// host's origin, so selections landed a constant few rows off (worse the
// further down the pane started). Native zoom scales the whole CSS pixel
// grid, so every coordinate space agrees again and all of that goes away.
//
// State persists in localStorage so the next launch matches the last
// zoom — terminals are tools, not browser tabs; the user expects the
// chrome to stay where they left it.

import { getCurrentWebview } from "@tauri-apps/api/webview";

const KEY = "covenant.ui-zoom";
const MIN = 0.6;
const MAX = 2.0;
const STEP = 0.1;
const DEFAULT = 1.0;

export type ZoomChangeListener = (zoom: number) => void;

class ZoomController {
  private current = DEFAULT;
  private listeners: ZoomChangeListener[] = [];

  /// Read persisted zoom + apply it to the document. Call once on boot
  /// before the first paint so we don't flash the default scale.
  init(): void {
    this.current = readPersisted() ?? DEFAULT;
    this.apply();
  }

  /// Step zoom up by STEP, clamped at MAX.
  zoomIn(): void {
    this.set(round(this.current + STEP));
  }

  /// Step zoom down by STEP, clamped at MIN.
  zoomOut(): void {
    this.set(round(this.current - STEP));
  }

  /// Reset to 1.0.
  reset(): void {
    this.set(DEFAULT);
  }

  /// Current zoom (1.0 = 100%).
  level(): number {
    return this.current;
  }

  /// Subscribe to zoom changes — used by TabManager to refit xterm
  /// instances after the cell metrics shift. Returns an unsubscribe fn.
  onChange(listener: ZoomChangeListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  /// Set zoom directly (1.0 = 100%). Clamped to [MIN, MAX].
  setLevel(value: number): void {
    this.set(round(value));
  }

  /// Allowed range, as percentages — for UI controls.
  static readonly RANGE = { min: MIN * 100, max: MAX * 100, step: STEP * 100 };

  private set(value: number): void {
    const clamped = Math.max(MIN, Math.min(MAX, value));
    if (Math.abs(clamped - this.current) < 0.001) return;
    this.current = clamped;
    this.apply();
    persist(clamped);
    for (const l of this.listeners) {
      try {
        l(clamped);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("zoom listener failed", err);
      }
    }
  }

  private apply(): void {
    // Async IPC — a boot at zoom != 1 paints one frame at 100% before it
    // lands. The splash covers it; not worth plumbing the value through
    // Rust window setup to save a frame.
    void getCurrentWebview()
      .setZoom(this.current)
      .catch((err) => console.error("setZoom failed", err));
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function readPersisted(): number | null {
  try {
    const v = localStorage.getItem(KEY);
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= MIN && n <= MAX ? n : null;
  } catch {
    return null;
  }
}

function persist(value: number): void {
  try {
    localStorage.setItem(KEY, String(value));
  } catch {
    // ignore — preference simply won't persist
  }
}

export type ZoomIntent = "in" | "out" | "reset" | null;

/// Pure mapping from a keydown to a zoom action. `mod` = the platform's
/// zoom modifier is held (Cmd on macOS, Ctrl elsewhere — see modHeld).
/// Matches on the resolved key char, so shifted `+` counts as "in" while
/// shifted `-`/`0` (`_`/`)`) are ignored — no separate shift bookkeeping.
export function zoomIntent(key: string, mod: boolean): ZoomIntent {
  if (!mod) return null;
  switch (key) {
    case "=":
    case "+":
      return "in";
    case "-":
      return "out";
    case "0":
      return "reset";
    default:
      return null;
  }
}

export const zoom = new ZoomController();
