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

  it("abuts glyphs on macOS and spells modifiers out elsewhere", async () => {
    setInjectedPlatform("macos");
    const mac = await freshModule();
    expect(mac.formatChord(["mod", "T"])).toBe("⌘T");
    expect(mac.formatChord(["mod", "shift", "G"])).toBe("⌘⇧G");
    expect(mac.formatChord(["mod", "enter"])).toBe("⌘⏎");
    // Control is its own key on a Mac, distinct from the chord modifier.
    expect(mac.formatChord(["ctrl", "alt", "K"])).toBe("⌃⌥K");

    setInjectedPlatform("linux");
    const linux = await freshModule();
    expect(linux.formatChord(["mod", "T"])).toBe("Ctrl+T");
    expect(linux.formatChord(["mod", "shift", "G"])).toBe("Ctrl+Shift+G");
    expect(linux.formatChord(["mod", "enter"])).toBe("Ctrl+Enter");
  });

  it("never mixes a spelled-out modifier with an Apple glyph", async () => {
    // Regression guard: the sidebar shipped "Ctrl+⇧G" — modPrefix() had
    // resolved the mod key while ⇧ stayed hardcoded next to it. Neither
    // convention, and ⇧ names a key the keyboard doesn't print.
    setInjectedPlatform("linux");
    const { formatChord } = await freshModule();
    for (const chord of [
      formatChord(["mod", "shift", "G"]),
      formatChord(["mod", "shift", "P"]),
      formatChord(["mod", "alt", "K"]),
      formatChord(["mod", "enter"]),
    ]) {
      expect(chord).not.toMatch(/[⌘⇧⌥⌃⏎]/);
    }
  });

  it("puts app chords on Ctrl+Shift off macOS, where Ctrl is the shell's", async () => {
    // In a terminal Ctrl is a content key — Ctrl+T is transpose-chars,
    // Ctrl+W is unix-word-rubout, Ctrl+G is abort. Binding tab management
    // there breaks the shell to deliver a tab, so app chords go to
    // Ctrl+Shift, same as GNOME Terminal / Kitty / Alacritty.
    setInjectedPlatform("macos");
    const mac = await freshModule();
    expect(mac.formatChord(["appmod", "T"])).toBe("⌘T");
    expect(mac.appModHeld({ metaKey: true, ctrlKey: false, shiftKey: false })).toBe(true);

    setInjectedPlatform("linux");
    const linux = await freshModule();
    expect(linux.formatChord(["appmod", "T"])).toBe("Ctrl+Shift+T");
    expect(linux.appModHeld({ metaKey: false, ctrlKey: true, shiftKey: true })).toBe(true);
    // Plain Ctrl is NOT the app modifier here — it belongs to readline.
    expect(linux.appModHeld({ metaKey: false, ctrlKey: true, shiftKey: false })).toBe(false);
  });

  it("lets a chord have a different shape per platform", async () => {
    // ⌘ and ⌘⇧ are two modifier spaces on a Mac and collapse into one off
    // it, so some chords aren't the same chord: ⌘W and ⌘⇧W both want
    // Ctrl+Shift+W. chordFor() exists to state both sides rather than
    // pretend one derives from the other.
    setInjectedPlatform("macos");
    const mac = await freshModule();
    expect(mac.chordFor(["mod", "T"], ["ctrl", "shift", "T"])).toBe("⌘T");
    expect(mac.chordFor(["mod", "shift", "G"], ["ctrl", "shift", "G"])).toBe("⌘⇧G");

    setInjectedPlatform("linux");
    const linux = await freshModule();
    expect(linux.chordFor(["mod", "T"], ["ctrl", "shift", "T"])).toBe("Ctrl+Shift+T");
    expect(linux.chordFor(["mod", "shift", "G"], ["ctrl", "shift", "G"])).toBe("Ctrl+Shift+G");
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

  it("no source file resolves a chord at module scope", () => {
    // The whole reason this module exists: the platform isn't known until
    // the webview has the plugin's internals, so a chord resolved while a
    // module is being evaluated bakes in whatever the UA fallback guessed
    // and never corrects. It renders ⌘ on Linux and no test catches it,
    // because the value is right in whichever environment you ran.
    //
    // Resolve inside the function, render, or getter that prints the chord.
    // This is a source-level rule with no runtime signal, so it's checked
    // here rather than left to review — three separate passes over this
    // codebase each had to be told it by hand.
    const moduleScopeCall =
      /^(?:export\s+)?(?:const|let|var)\s+\w+(?:\s*:[^=]+)?\s*=\s*(?:formatChord|chordKeys|modPrefix|modKey)\s*\(/m;

    // Vite's glob, not node:fs — this tsconfig is browser-only (`types:
    // ["vite/client"]`, no @types/node) and the tests share it.
    const sources = import.meta.glob("./**/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;

    const offenders = Object.entries(sources)
      .filter(([path]) => !path.endsWith(".test.ts") && !path.endsWith("platform.ts"))
      .filter(([, src]) => moduleScopeCall.test(src))
      .map(([path]) => path);

    // Sanity: the sweep must actually see the tree. An empty glob would
    // make this test pass by looking at nothing.
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });

  it("stamps the variant onto <html> for CSS to branch on", async () => {
    setInjectedPlatform("windows");
    const { applyPlatformAttribute } = await freshModule();
    const doc = document.implementation.createHTMLDocument("t");
    applyPlatformAttribute(doc);
    expect(doc.documentElement.dataset.platform).toBe("windows");
  });
});
