// Global UI zoom — Cmd+= / Cmd+- / Cmd+0.
//
// Implementation: CSS `zoom` on the <html> element. WebKit (which the
// Tauri macOS bundle runs on) supports this and scales every rendered
// pixel — DOM, font sizes, padding, even canvases. xterm.js's renderer
// keeps measuring its cell metrics from the rendered DOM, so a refit
// after zoom is enough to keep the prompt aligned.
//
// State persists in localStorage so the next launch matches the last
// zoom — terminals are tools, not browser tabs; the user expects the
// chrome to stay where they left it.

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
  /// instances after the cell metrics shift.
  onChange(listener: ZoomChangeListener): void {
    this.listeners.push(listener);
  }

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
    // CSS `zoom` is non-standard but well-supported in WebKit. Setting
    // it as a string on the element style is the way to set it from JS;
    // there's no typed property on CSSStyleDeclaration in TS DOM lib.
    (document.documentElement.style as unknown as Record<string, string>).zoom =
      String(this.current);
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

export const zoom = new ZoomController();
