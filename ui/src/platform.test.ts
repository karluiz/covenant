import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The module caches, so each test needs a fresh copy.
async function freshModule(): Promise<typeof import("./platform")> {
  vi.resetModules();
  return import("./platform");
}

/// Stub what the plugin reads. `undefined` simulates "not inside Tauri":
/// the plugin's own accessor throws on the missing internals, which is
/// exactly what happens in tests and iframe previews.
function setInjectedPlatform(value: string | undefined): void {
  if (value === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).__TAURI_OS_PLUGIN_INTERNALS__;
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__TAURI_OS_PLUGIN_INTERNALS__ = { platform: value };
}

function setUserAgent(ua: string): void {
  Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true });
}

describe("platform", () => {
  const realUA = navigator.userAgent;

  beforeEach(() => {
    setInjectedPlatform(undefined);
  });

  afterEach(() => {
    setInjectedPlatform(undefined);
    setUserAgent(realUA);
    vi.restoreAllMocks();
  });

  it("maps what the plugin reports onto the variants the UI branches on", async () => {
    for (const [injected, expected] of [
      ["macos", "mac"],
      ["ios", "mac"],
      ["windows", "windows"],
      ["linux", "linux"],
      // We ship no BSD builds, but the chrome questions answer the same
      // there, so anything else lands on linux rather than throwing.
      ["freebsd", "linux"],
    ] as const) {
      setInjectedPlatform(injected);
      const { currentPlatform } = await freshModule();
      expect(currentPlatform()).toBe(expected);
    }
  });

  it("falls back to the user agent when the plugin isn't there", async () => {
    setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    const mac = await freshModule();
    expect(mac.currentPlatform()).toBe("mac");

    setUserAgent("Mozilla/5.0 (X11; Linux x86_64)");
    const linux = await freshModule();
    expect(linux.currentPlatform()).toBe("linux");
  });

  it("never caches the fallback, so a late plugin still wins", async () => {
    // Regression guard: this module exists because a UA guess got frozen
    // into a module-level const at import time. Asking before the webview
    // is ready must not poison the answer for the whole session.
    setUserAgent("Mozilla/5.0 (X11; Linux x86_64)");
    const { currentPlatform } = await freshModule();
    expect(currentPlatform()).toBe("linux");

    setInjectedPlatform("macos");
    expect(currentPlatform()).toBe("mac");
  });

  it("caches a real answer", async () => {
    setInjectedPlatform("linux");
    const { currentPlatform } = await freshModule();
    expect(currentPlatform()).toBe("linux");

    // Plugin gone and UA says mac — the cached real answer holds.
    setInjectedPlatform(undefined);
    setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    expect(currentPlatform()).toBe("linux");
  });

  it("names the modifier for keycaps and for inline chords", async () => {
    setInjectedPlatform("macos");
    const mac = await freshModule();
    expect(mac.modKey()).toBe("⌘");
    expect(mac.modPrefix()).toBe("⌘");

    setInjectedPlatform("linux");
    const linux = await freshModule();
    expect(linux.modKey()).toBe("Ctrl");
    // Spelled-out names need the separator; glyphs abut.
    expect(linux.modPrefix()).toBe("Ctrl+");
  });

  it("reads the chord modifier off the event per platform", async () => {
    setInjectedPlatform("macos");
    const mac = await freshModule();
    expect(mac.modHeld({ metaKey: true, ctrlKey: false })).toBe(true);
    // Ctrl on a Mac is its own modifier, not the chord one.
    expect(mac.modHeld({ metaKey: false, ctrlKey: true })).toBe(false);

    setInjectedPlatform("linux");
    const linux = await freshModule();
    expect(linux.modHeld({ metaKey: false, ctrlKey: true })).toBe(true);
    // Super/Meta belongs to the window manager off macOS.
    expect(linux.modHeld({ metaKey: true, ctrlKey: false })).toBe(false);
  });

  it("stamps the variant onto <html> for CSS to branch on", async () => {
    setInjectedPlatform("windows");
    const { applyPlatformAttribute } = await freshModule();
    const doc = document.implementation.createHTMLDocument("t");
    applyPlatformAttribute(doc);
    expect(doc.documentElement.dataset.platform).toBe("windows");
  });
});
