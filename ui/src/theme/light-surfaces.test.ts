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

/// Strip comments before any selector parsing — comment prose otherwise
/// reads as a selector and produces phantom findings.
const CSS_NC = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

interface Rule {
  selector: string;
  body: string;
}

function rules(css: string): Rule[] {
  const out: Rule[] = [];
  const re = /(^|[\n};])\s*([^{}@][^{}]{0,400}?)\{([^{}]*)\}/g;
  for (const m of css.matchAll(re)) {
    out.push({ selector: m[2].trim(), body: m[3] });
  }
  return out;
}

const setsBackground = (body: string): boolean =>
  /(^|;)\s*background(-color)?\s*:/i.test(body);

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

/// Guard against the specificity trap that silently kills modifier states.
///
/// `body.theme-light .btn` scores (0,2,1). A modifier rule like
/// `.btn--primary` scores (0,1,0), and even `.btn--primary:hover` only
/// (0,2,0) — both LOSE. So a light-theme override on a base class quietly
/// replaces the background of every modifier and state built on it: the
/// primary button's accent fill, the active dot, the selected tab.
///
/// It stays invisible for a long time because the dark themes have no such
/// overrides, and in plain light mode the stolen colour is usually white on
/// white. `bunny` (the light-based Special Theme) is what exposed it, but
/// the bug was always there.
///
/// Fix: restate the modifier's background at `body.theme-light .base--mod`
/// specificity, right next to the rule that steals it.

interface Theft {
  derived: string;
  thief: string;
}

function findStolenModifierBackgrounds(css: string): Theft[] {
  const all = rules(css);

  // Base classes whose background body.theme-light overrides, and the
  // derived selectors that a theme-light rule already restores.
  const bases = new Map<string, string>();
  const restored = new Set<string>();
  for (const { selector, body } of all) {
    if (!selector.includes("body.theme-light") || !setsBackground(body)) continue;
    for (const raw of selector.split(",")) {
      const part = raw.trim();
      if (!part.includes("body.theme-light")) continue;
      const base = /^body\.theme-light\s+(\.[A-Za-z0-9_-]+)$/.exec(part);
      if (base) bases.set(base[1], part);
      const der =
        /body\.theme-light\s+(\.[A-Za-z0-9_-]+(?:--[A-Za-z0-9_-]+|\.[A-Za-z0-9_-]+))/.exec(
          part,
        );
      if (der) restored.add(der[1]);
    }
  }

  const found = new Map<string, string>();
  for (const { selector, body } of all) {
    if (selector.includes("theme-light") || !setsBackground(body)) continue;
    for (const raw of selector.split(",")) {
      const part = raw.trim();
      for (const [base, thief] of bases) {
        const m = new RegExp(
          base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
            "(--[A-Za-z0-9_-]+|\\.[A-Za-z0-9_-]+)",
        ).exec(part);
        if (!m) continue;
        const derived = base + m[1];
        // A descendant target (`.base--mod .child`) is not the element the
        // base override applies to, so it is not a victim.
        const tail = part.slice(part.indexOf(m[0]) + m[0].length);
        if (/\s+\S/.test(tail)) continue;
        // Specificity: 3+ classes/pseudo-classes would beat (0,2,1).
        const weight =
          (part.match(/[.:][A-Za-z-]/g) ?? []).length -
          2 * (part.match(/::/g) ?? []).length;
        if (weight < 3 && !restored.has(derived)) found.set(derived, thief);
      }
    }
  }
  return [...found].map(([derived, thief]) => ({ derived, thief }));
}

describe("body.theme-light overrides do not steal modifier backgrounds", () => {
  it("leaves every modifier's own background intact", () => {
    const thefts = findStolenModifierBackgrounds(CSS_NC);
    const report = thefts
      .map((t) => `  ${t.derived}\n      stolen by:  ${t.thief}`)
      .join("\n");
    expect(
      thefts,
      thefts.length
        ? `These modifiers lose their background to a less-specific-looking ` +
            `but higher-specificity light-theme rule:\n${report}\n\n` +
            `Restate each one as \`body.theme-light <modifier> { background: … }\`.`
        : "",
    ).toHaveLength(0);
  });

  it("detects a theft it is meant to catch", () => {
    // Guards the guard — see the empty-stylesheet lesson in loadCss above.
    const sample = `
      .btn--primary { background: var(--accent); }
      body.theme-light .btn { background: #fff; }
    `;
    expect(findStolenModifierBackgrounds(sample)).toEqual([
      { derived: ".btn--primary", thief: "body.theme-light .btn" },
    ]);
  });

  it("accepts a modifier that is restated under theme-light", () => {
    const sample = `
      .btn--primary { background: var(--accent); }
      body.theme-light .btn { background: #fff; }
      body.theme-light .btn--primary { background: var(--accent); }
    `;
    expect(findStolenModifierBackgrounds(sample)).toHaveLength(0);
  });

  it("ignores descendant targets, which the base override never reaches", () => {
    const sample = `
      .item--active .item__status { background: var(--ok); }
      body.theme-light .item { background: #fff; }
    `;
    expect(findStolenModifierBackgrounds(sample)).toHaveLength(0);
  });
});
