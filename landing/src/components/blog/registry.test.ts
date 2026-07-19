import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  SPECIAL_THEME_LIST,
  compositeGround,
} from "../../../../ui/src/theme/special";

/// Guards the one place the landing depends on desktop-app code.
///
/// `ui/src/theme/special.ts` currently imports nothing but its own .webp
/// assets, which is what makes importing it from a static site safe. If a
/// future edit adds an app-only import, the landing build breaks — and
/// because deploy-landing.yml runs no tests, that break would first appear
/// as a failed production deploy. This test moves the failure earlier.
///
/// Must pass under BOTH vitest configs: landing's (`src/**/*.test.ts`) and
/// the repo-root one that also sweeps this path. It therefore imports only
/// the registry — no astro:content, no DOM, no Astro runtime.
describe("app theme registry import", () => {
  it("resolves from the landing package", () => {
    expect(SPECIAL_THEME_LIST.length).toBeGreaterThanOrEqual(7);
  });

  it("gives every theme the fields ThemeGallery renders", () => {
    for (const t of SPECIAL_THEME_LIST) {
      expect(t.id, `${t.id}.id`).toMatch(/^[a-z]+$/);
      expect(t.name.length, `${t.id}.name`).toBeGreaterThan(0);
      expect(typeof t.art, `${t.id}.art`).toBe("string");
      expect(t.art.length, `${t.id}.art`).toBeGreaterThan(0);
      expect(t.ground, `${t.id}.ground`).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(t.accent, `${t.id}.accent`).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(t.veil, `${t.id}.veil`).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(t.scrim, `${t.id}.scrim`).toBeGreaterThan(0);
      expect(t.scrim, `${t.id}.scrim`).toBeLessThan(1);
      expect(["dark", "light"]).toContain(t.base);
    }
  });

  it("exposes compositeGround for the swatches", () => {
    const [r, g, b] = compositeGround(SPECIAL_THEME_LIST[0], 0.5);
    for (const c of [r, g, b]) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(255);
    }
  });

  it("has an artwork file named after every theme id", () => {
    // ThemeGallery resolves images as `/themes/${t.id}.webp` because Astro's
    // build turns the registry's .webp imports into ImageMetadata objects
    // rather than URL strings. That makes the id↔filename match load-bearing
    // and otherwise unguarded: the app builds, this suite passes, and the copy
    // script succeeds even when they diverge — only the rendered page breaks.
    //
    // Not `new URL("../../ui/...", import.meta.url)`: under the repo-root
    // vitest config (jsdom environment), the global `URL` constructor
    // resolves relative paths against `window.location`, not the `base`
    // argument, silently landing on `http://localhost:3000/...` and throwing
    // "must be of scheme file" on readdirSync. fileURLToPath + node:path
    // sidesteps that shadowed global (verified: fails under the root config
    // with `new URL`, passes with this). It's also cwd-independent, unlike a
    // `process.cwd()`-based path — cwd differs between `test:unit` (run from
    // landing/) and the root `npm test` (run from the worktree root).
    const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../../ui/assets/themes");
    const files = new Set(readdirSync(dir));
    for (const t of SPECIAL_THEME_LIST) {
      expect(files, `theme "${t.id}" needs ui/assets/themes/${t.id}.webp`)
        .toContain(`${t.id}.webp`);
    }
  });
});
