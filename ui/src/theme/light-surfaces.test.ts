import { describe, it, expect } from "vitest";

// Read the stylesheet off disk. Vite's `?raw` — plain import OR
// import.meta.glob — returns an EMPTY string for .css here, because the CSS
// transform intercepts it, and the guard below would then pass by scanning
// nothing. node:fs is untyped under this browser-only tsconfig (`types:
// ["vite/client"]`, no @types/node), hence the suppressions; vitest itself
// runs in Node, so the calls are real. Same idiom as vite.config.ts.
// @ts-expect-error node:fs is untyped under this tsconfig
import { readFileSync } from "node:fs";

function loadCss(): string {
  // cwd, not import.meta.url — under vitest the latter is not a file: URL.
  // `npm test` runs from the repo root (documented in AGENTS.md), and the
  // length check below catches it if that ever stops being true.
  // @ts-expect-error process is a nodejs global, untyped here
  const root: string = process.cwd();
  const css: string = readFileSync(`${root}/ui/src/styles.css`, "utf-8");
  // A stylesheet that failed to load must fail the suite, not silently
  // satisfy every rule in it. This is the check whose absence let an
  // earlier version of this guard pass while reading an empty string.
  if (css.length < 10_000 || !css.includes("body.theme-light")) {
    throw new Error(
      `styles.css did not load (${css.length} chars). The guard below would ` +
        `pass vacuously — fix the read before trusting it.`,
    );
  }
  return css;
}

const CSS = loadCss();

/// Guard against the bug class that shipped twice during Special Themes.
///
/// `body.theme-light` rules that hardcode a white or near-white background
/// are invisible under the four dark themes and look correct under plain
/// light mode — but a Special Theme derives its surfaces from the artwork's
/// ground colour, and a hardcoded literal cannot follow. Under `bunny` (the
/// one light-based theme) every such rule punched a bright slab through the
/// wallpaper.
///
/// The fix is always one of two tokens, never a literal:
///   - `var(--bg-overlay)` for opaque surfaces — `body.theme-light` already
///     defines it as #ffffff, so plain light mode renders identically.
///   - `rgb(var(--ink-rgb) / <a>)` for insets and hovers, which composes
///     against whatever is behind and flips with the theme.
///
/// If this test fails you have added a third. Use a token.

/// Selectors whose blend genuinely needs a literal. Keep this list tiny and
/// justify every entry — each one is a surface that will not follow a
/// Special Theme.
const ALLOWED = [
  // color-mix blending an accent tint into a translucent base; substituting
  // an opaque token changes the composite in plain light mode.
  "tab-op-avatar-wrap",
];

interface Offender {
  selector: string;
  decl: string;
}

function findHardcodedLightSurfaces(css: string): Offender[] {
  const out: Offender[] = [];
  const blocks = /([^{}]*body\.theme-light[^{}]*)\{([^{}]*)\}/g;

  for (const block of css.matchAll(blocks)) {
    const [, selector, body] = block;
    if (ALLOWED.some((a) => selector.includes(a))) continue;

    for (const decl of body.split(";")) {
      const d = decl.trim();
      if (!/^background(-color)?\s*:/i.test(d)) continue;
      if (isNearWhite(d)) {
        const lines = selector
          .trim()
          .split("\n")
          .filter((l) => l.includes("theme-light"));
        const last = lines.length ? lines[lines.length - 1] : selector;
        out.push({ selector: last.trim(), decl: d });
      }
    }
  }
  return out;
}

/// True when the declaration names a colour with every channel at or above
/// 0xE8 — white and the off-whites (#f5f6f8, #f8fafc, rgb(252 252 253), …)
/// that the first sweep missed precisely because they are not `#fff`.
function isNearWhite(decl: string): boolean {
  if (/:\s*white\b/i.test(decl)) return true;

  for (const m of decl.matchAll(/#([0-9a-f]{3}|[0-9a-f]{6})\b/gi)) {
    const h =
      m[1].length === 3
        ? m[1]
            .split("")
            .map((c) => c + c)
            .join("")
        : m[1];
    const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    if (Math.min(...ch) >= 0xe8) return true;
  }

  for (const m of decl.matchAll(
    /rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})/gi,
  )) {
    const ch = [m[1], m[2], m[3]].map(Number);
    if (Math.min(...ch) >= 0xe8) return true;
  }

  return false;
}

describe("body.theme-light surfaces follow Special Themes", () => {
  it("has no hardcoded white or near-white backgrounds", () => {
    const offenders = findHardcodedLightSurfaces(CSS);
    const report = offenders
      .map((o) => `  ${o.selector}\n      ${o.decl}`)
      .join("\n");
    expect(
      offenders,
      offenders.length
        ? `Hardcoded light surfaces will not follow a Special Theme:\n${report}\n\n` +
            `Use var(--bg-overlay) for opaque surfaces, or ` +
            `rgb(var(--ink-rgb) / <alpha>) for insets and hovers.`
        : "",
    ).toHaveLength(0);
  });

  it("detects the literals it is meant to catch", () => {
    // Guards the guard: if isNearWhite ever stops matching, the test above
    // passes vacuously and the whole bug class walks back in.
    const sample = `
      body.theme-light .a { background: #fff; }
      body.theme-light .b { background: #f5f6f8; }
      body.theme-light .c { background: rgb(252 252 253 / 0.99); }
      body.theme-light .d { background: rgba(255, 255, 255, 0.92); }
      body.theme-light .e { background: white; }
    `;
    expect(findHardcodedLightSurfaces(sample)).toHaveLength(5);
  });

  it("accepts the token forms", () => {
    const sample = `
      body.theme-light .a { background: var(--bg-overlay); }
      body.theme-light .b { background: rgb(var(--ink-rgb) / 0.04); }
      body.theme-light .c { background: rgba(0, 0, 0, 0.05); }
      body.theme-light .d { color: #fff; }
    `;
    expect(findHardcodedLightSurfaces(sample)).toHaveLength(0);
  });
});
