# Landing blog + customization section — design

**Date:** 2026-07-19
**Branch:** `feat/landing-blog`
**Status:** design approved, not implemented

---

## Problem

Covenant exposes roughly 25 customization knobs — four theme modes, seven wallpaper-backed Special Themes, five tab styles with eight sub-knobs of their own, four folded-rail styles, window background modes, and six typography settings. None of it is visible anywhere outside the app's Settings panel.

The landing site has exactly two routes (`/` and `/remote`) and no blog, docs, or changelog. Its "Changelog" and "Docs" footer links point off-site to GitHub. There is nowhere to write about the product.

We want two things: a blog on the landing site, and a customization section on the home page that points at its first post.

## Why a blog rather than only a section

The landing's argument today is orchestration under a contract — "not vibes, Rust functions you can grep". A themes showcase dropped into that flow dilutes it. In a post, the same material *reinforces* the brand, because the interesting part is not the artwork but the method: grounds sampled by median-cut quantisation, scrims calibrated so every composited surface lands in a 10.8–12.2:1 contrast band, and a pure-white artwork that forced the veil to become a colour plus an alpha rather than a darkening amount.

Once the post exists, the home section can be three lines and a link instead of carrying the weight alone.

## Scope

**In:** an Astro content collection for blog posts, `/blog` and `/blog/<slug>` routes, a post layout, MDX support, a `<ThemeGallery/>` component reading the app's real theme registry, a `Customization.astro` section on the home page, and a scaffolded first post with a verified inventory for the user to write into.

**Out (deliberately):** RSS, tags, author fields, pagination, search, comments, a changelog or docs section. One post does not justify any of it; revisit at ~5 posts.

**Authorship:** the user writes the prose. This project delivers working infrastructure, the post skeleton with front-matter and section headings, and the verified inventory of what is customizable — not finished copy.

---

## 1. Blog infrastructure

Astro is pinned at `^4.16.0`. **Astro 4 reads content config from `src/content/config.ts`** — the `src/content.config.ts` location is Astro 5 and will be silently ignored here.

New dependency: `@astrojs/mdx`, registered in `landing/astro.config.mjs` alongside the existing Tailwind integration. MDX is required because the post embeds components; plain Markdown cannot.

```
landing/src/content/config.ts          collection definition + zod schema
landing/src/content/blog/
  making-the-terminal-yours.mdx        the first post
landing/src/pages/blog/index.astro     → /blog
landing/src/pages/blog/[slug].astro    → /blog/<slug>
landing/src/layouts/BlogPost.astro     wraps Base.astro
landing/src/components/blog/
  ThemeGallery.astro                   the seven Special Themes, from the registry
  KnobTable.astro                      a settings-knob table
```

### Schema

```ts
// landing/src/content/config.ts
import { defineCollection, z } from "astro:content";

const blog = defineCollection({
  type: "content",
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.date(),
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog };
```

Four fields, nothing speculative. `draft: true` posts are filtered out of both the index and `getStaticPaths`, so an unfinished post can sit on `main` without publishing — which matters given the deploy model below.

### Routes

`/blog` lists non-draft posts newest first: title, description, date. With one post it is nearly empty; that is fine and honest.

`/blog/<slug>` renders the post through `BlogPost.astro`, which wraps the existing `Base.astro` (keeping the navbar, the scroll-reveal observer, and the shared `globals.css`).

### Typography

`globals.css` has no prose styles — the landing is all bespoke components. `BlogPost.astro` therefore supplies its own `.prose`-scoped rules using the existing Tailwind theme tokens (`ink`, `mist`, `moss`, `bone`, `Sansation`, `JetBrains Mono`). We do **not** add `@tailwindcss/typography`: its defaults would fight the established look, and the post needs maybe fifteen rules.

Measure stays near 68 characters. Code blocks and tables scroll inside their own `overflow-x: auto` container so the page body never scrolls sideways.

---

## 2. `<ThemeGallery/>` reads the real registry

The component imports `SPECIAL_THEMES` directly from `ui/src/theme/special.ts` and renders all seven themes with their actual artwork, calibrated scrim, sampled ground, and accent. Adding an eighth theme to the app updates the post with no edit here.

**Feasibility was spiked, not assumed:** a Vite build rooted at `landing/` resolves and bundles `ui/src/theme/special.ts` including its five `.webp` URL imports. What was *not* verified is that a full `astro build` emits those assets into `landing/dist` with correct public URLs.

**If asset emission fails**, the fallback is to copy `ui/assets/themes/*.webp` into `landing/public/themes/` from a `prebuild` script and have `ThemeGallery` resolve `id → /themes/<id>.webp`. The numbers still come from the registry; only the images are duplicated, and by a script rather than by hand. Decide this during implementation on evidence, not preference.

### The coupling, and its guard

Today `ui/src/theme/special.ts` imports nothing but its own assets, which is what makes this safe. Nothing prevents a future edit from importing an app-only module and breaking the landing build.

Because the deploy workflow runs no tests, that break would surface as a failed production deploy. So the landing gets a unit test asserting the import works and the data has the shape the component expects:

```ts
// landing/src/content/theme-registry.test.ts
import { SPECIAL_THEMES, SPECIAL_THEME_LIST } from "../../../ui/src/theme/special";

it("imports the app's theme registry", () => {
  expect(SPECIAL_THEME_LIST.length).toBeGreaterThanOrEqual(7);
  for (const t of SPECIAL_THEME_LIST) {
    expect(t.ground).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(typeof t.art).toBe("string");
    expect(t.scrim).toBeGreaterThan(0);
  }
});
```

`landing/vitest.config.ts` includes `src/**/*.test.ts`, so the file is picked up with no config change. It asserts `>= 7` rather than `=== 7` so adding a theme does not fail the landing.

**It must pass under both vitest configs.** Living in `landing/src/`, this file is also swept by the repo-root `npm test`, which runs a different config (`environment: jsdom`, a setup file the landing tests do not expect). The test is written to survive that: it imports only the registry — no `astro:content`, no DOM, no Astro runtime — and `.webp` URL imports already resolve under the root config because the app's own theme tests rely on them. Verify it green under *both* `npm test` (root) and `npm run test:unit` (in `landing/`) before merging; if it cannot satisfy both, move it to `landing/tests/` and add a vitest include rather than weakening the assertion.

---

## 3. Customization section on the home page

`landing/src/components/Customization.astro`, inserted into `index.astro` **after `DeepDive` and before `Footer`** — reinforcement, not a competing argument.

Contents: an eyebrow, a headline, one line of counts, the seven theme thumbnails, and a link to `/blog/making-the-terminal-yours`. It reuses `ThemeGallery` in a compact variant rather than duplicating the rendering.

Follows the established section conventions: `.section` wrapper, `.eyebrow`, `.fade-in-up` with a `.delay-*` class. Note those delay classes are hand-written CSS, not Tailwind utilities — dynamically constructed `delay-${n}` strings only work for that reason.

---

## 4. The scaffolded post

`making-the-terminal-yours.mdx` ships with front-matter, section headings, the embedded components in place, and the inventory below rendered through `KnobTable`. The prose between headings is the user's to write.

Verified inventory, read from `ui/src/settings/panel.ts` and `crates/app/src/settings.rs`:

| Group | Setting | Values |
|---|---|---|
| Theme | `theme` | system / dark / true_dark / light / special |
| | *special themes* | jjk, kimetsu, onepiece, haikyuu, zerotwo, bunny, steinsgate |
| | `special_scrim` | ±0.20 around each theme's calibrated default |
| Window | `window_background` | solid / vibrant / translucent |
| | `zen_icons` | on / off |
| | `status_bar_enabled` | on / off |
| | `notch_enabled` | on / off |
| Tabs | `tab_style` | classic / forge / glass / crt / custom |
| | `tab_custom_*` | bg, shape, height, gap, indicator, gradient start, gradient end, group shape, group bg |
| | `tabbar_position` | top / left |
| Rails | `folded_rail_style` | legacy / glyph / labels / spine |
| Type | `ui_font` | chrome font stack override |
| | `term_font`, `term_size`, `term_letter_spacing`, `term_line_height`, `term_ligatures` | terminal typography |

---

## 5. Testing

- **New:** the registry-import guard above.
- **Existing, at risk:** `landing/tests/landing.spec.ts` is a 22-line Playwright smoke test that hardcodes copy strings from the home page. Adding a section does not necessarily break it, but the run must be checked and the test extended to assert the new section renders and its link resolves.
- **New:** extend that smoke test with `/blog` and `/blog/making-the-terminal-yours` returning 200 and rendering their titles.

Note the landing suites are wired into neither CI nor the root `vitest.config.ts`. Running the root `npm test` sweeps `landing/src/**/*.test.ts` under the wrong config — that is the likely cause of the "landing test failures" seen earlier in this repo, and it is pre-existing. **This project does not fix that**; it is called out so the failures are not misread as regressions.

---

## 6. Deploy model — the main operational risk

`.github/workflows/deploy-landing.yml` triggers on push to `main` filtered to `landing/**`, runs `npm install && npm run build`, and publishes to GitHub Pages at `www.covenant.uno`. **There is no preview environment, no staging branch, and no test gate.** Any merge touching `landing/**` is live immediately.

Mitigations, all process rather than code:
1. All work happens on `feat/landing-blog`, never directly on `main`.
2. Before merging: `cd landing && npm run build && npm run preview`, and check `/`, `/blog`, and the post by hand.
3. `npm run test:unit` and `npx playwright test` in `landing/` before merging, since CI will not.
4. The post ships with `draft: false` only when the user's prose is final; until then `draft: true` keeps it off the index and out of `getStaticPaths` even while merged.

---

## 7. Out of scope

- RSS, tags, authors, pagination, search, comments.
- A docs or changelog section (the footer keeps pointing at GitHub).
- Fixing the root-vs-landing vitest config collision.
- Updating `landing/README.md`, which still claims "covenant.dev" and "Cloudflare Pages" — both wrong, both pre-existing, neither blocking.
- Sharing design tokens between the app and the landing. They stay independently themed; this project couples them on *theme data only*, not on styling.
