# Landing Blog + Customization Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Covenant landing site a blog, plus a customization section on the home page pointing at its first post.

**Architecture:** An Astro 4 content collection at `landing/src/content/blog/` with MDX support, rendered through `/blog` and `/blog/[slug]`. A `<ThemeGallery/>` component imports the desktop app's real `SPECIAL_THEMES` registry rather than duplicating it, guarded by a unit test so the coupling breaks in tests instead of in a production deploy.

**Tech Stack:** Astro 4.16, `@astrojs/mdx`, Tailwind 3.4, Vitest 2.1, Playwright 1.47.

**Spec:** `docs/superpowers/specs/2026-07-19-landing-blog-design.md`

## Global Constraints

- Worktree `.covenant/worktrees/landing-blog`, branch `feat/landing-blog`. All work happens here.
- **Astro is `^4.16.0`. Content config lives at `src/content/config.ts`.** The `src/content.config.ts` path is Astro 5 and is silently ignored — a config placed there produces an empty collection with no error.
- **Use `npm` inside `landing/`, never `pnpm`.** CI (`deploy-landing.yml`) runs `npm install && npm run build`, and `landing/package-lock.json` is the lockfile that must stay in sync. (`landing/playwright.config.ts` says `pnpm preview` — a pre-existing inconsistency. Do not "fix" it in this plan; just be aware Playwright's webServer may need `npm run preview --port 4322` run manually.)
- Brand tokens come from `landing/tailwind.config.ts`: `ink #0a0c0a`, `mist #e8efe6`, `moss.400 #7bd389` / `.500 #4fbf6a` / `.600 #3aa055`, `bone #f3efe7`; `font-sans` = Sansation, `font-mono` = JetBrains Mono; `max-w-content` = 72rem; `tracking-eyebrow` = 0.18em.
- **`font-mono` has no webfont loaded** — `globals.css` imports only Sansation, so mono falls back to `ui-monospace`. Do not add a font; the system mono is fine.
- Section conventions: `.section` wrapper, `.eyebrow` for the kicker, `.fade-in-up` plus a `.delay-N` class for scroll reveal. **`.delay-100`…`.delay-500` are hand-written CSS rules, not Tailwind utilities** — only those five values exist.
- The site is dark-only (`:root { color-scheme: dark }`). Do not add a light theme.
- Conventional Commits.
- Never run `git add -A` in this repo — a `node_modules` symlink exists in worktrees and `-A` commits it, clobbering main's dependencies. Stage explicit paths only.
- **Do not merge this branch to `main` until the user's prose is written.** Pushing to `main` with a `landing/**` change deploys to production immediately, with no test gate and no preview environment.

---

## File Structure

| File | Responsibility |
|---|---|
| `landing/astro.config.mjs` | **Modify.** Register the MDX integration. |
| `landing/package.json` | **Modify.** Add `@astrojs/mdx`. |
| `landing/src/content/config.ts` | **Create.** The `blog` collection and its zod schema. Nothing else. |
| `landing/src/layouts/BlogPost.astro` | **Create.** Post chrome + prose typography. Wraps `Base.astro`. |
| `landing/src/pages/blog/index.astro` | **Create.** The post list. |
| `landing/src/pages/blog/[slug].astro` | **Create.** One post. Owns the draft-filtering rule. |
| `landing/src/components/blog/ThemeGallery.astro` | **Create.** Renders `SPECIAL_THEMES`. The only file that knows about the app registry. |
| `landing/src/components/blog/KnobTable.astro` | **Create.** A settings-knob table. Data passed as a prop. |
| `landing/src/components/blog/registry.test.ts` | **Create.** Guards the app↔landing coupling. |
| `landing/src/content/blog/making-the-terminal-yours.mdx` | **Create.** The scaffolded post. |
| `landing/src/components/Customization.astro` | **Create.** Home-page section. |
| `landing/src/pages/index.astro` | **Modify.** Insert `Customization` after `DeepDive`. |
| `landing/src/components/Navbar.astro` | **Modify.** Add a `/blog` link. |
| `landing/tests/landing.spec.ts` | **Modify.** Cover the new section and `/blog`. |

---

## Draft handling — read before Task 1

The spec says the post stays `draft: true` until the prose is final. Taken naively that produces a contradiction: a production build would ship an **empty `/blog` index** and a **404 from the Customization section's link**.

The resolution, applied in Task 1 and depended on by every later task:

**Drafts are visible in dev, hidden in production builds.**

```ts
const posts = await getCollection("blog", ({ data }) => import.meta.env.DEV || !data.draft);
```

Consequences to design around, not fight:
- `npm run dev` → the post renders at its URL. This is how the user writes and previews prose.
- `npm run build` / `npm run preview` → the post is excluded, `/blog` is empty, the section's link 404s.
- Therefore **Playwright must not assert the post page**, only `/blog` itself (Task 5).
- Therefore **this branch is not merged until the user flips `draft: false`.** The final merge is a separate, later step outside this plan.

---

### Task 1: Blog infrastructure

Content collection, MDX, routes, layout. Deliverable: `/blog` builds and renders, and a post is reachable in dev.

**Files:**
- Modify: `landing/package.json`, `landing/astro.config.mjs`
- Create: `landing/src/content/config.ts`, `landing/src/layouts/BlogPost.astro`, `landing/src/pages/blog/index.astro`, `landing/src/pages/blog/[slug].astro`
- Create (temporary fixture): `landing/src/content/blog/hello.mdx`

**Interfaces:**
- Consumes: `landing/src/layouts/Base.astro`, whose props are exactly `{ title: string; description: string }`.
- Produces: a `blog` collection whose entries have `data: { title, description, date: Date, draft: boolean }`; `BlogPost.astro` with props `{ title: string; description: string; date: Date }`.

- [ ] **Step 1: Install the MDX integration**

```bash
cd landing
npm install @astrojs/mdx@^3.1.0
```

Expected: `package.json` gains `"@astrojs/mdx": "^3.1.0"` under dependencies (resolving to 3.1.9, the latest of that line), and `package-lock.json` updates.

**The major version matters.** Verified against the registry: every `@astrojs/mdx@3.x` declares `peerDependencies: { astro: "^4.8.0" }`, which our `astro ^4.16.0` satisfies. Every `@astrojs/mdx@4.x` declares `astro: "^5.0.0"` and will fail to resolve peers here. Do not let a `npm install @astrojs/mdx` without a version range pull v6 or v7.

- [ ] **Step 2: Register MDX in the Astro config**

Replace `landing/astro.config.mjs` with:

```js
import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";
import mdx from "@astrojs/mdx";

export default defineConfig({
  site: "https://www.covenant.uno",
  integrations: [tailwind({ applyBaseStyles: false }), mdx()],
  build: { inlineStylesheets: "auto" },
  compressHTML: true,
});
```

- [ ] **Step 3: Define the collection**

Create `landing/src/content/config.ts`:

```ts
// Astro 4 reads this path. `src/content.config.ts` is the Astro 5 location
// and is ignored here without an error — the collection would just be empty.
import { defineCollection, z } from "astro:content";

const blog = defineCollection({
  type: "content",
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.date(),
    /// Drafts render in `astro dev` and are excluded from production
    /// builds — see landing/src/pages/blog/[slug].astro.
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog };
```

- [ ] **Step 4: Add a temporary fixture post**

Create `landing/src/content/blog/hello.mdx`. This exists so the routes can be built and verified before the real post is written; Task 3 deletes it.

```mdx
---
title: "Hello"
description: "Temporary fixture — deleted in Task 3."
date: 2026-07-19
draft: false
---

Fixture body.
```

- [ ] **Step 5: Write the post layout**

Create `landing/src/layouts/BlogPost.astro`. The prose rules are hand-written against the Tailwind tokens rather than pulling in `@tailwindcss/typography`, whose defaults fight the established look and which would be ~40 KB for the fifteen rules actually needed.

```astro
---
import Base from "./Base.astro";
interface Props { title: string; description: string; date: Date }
const { title, description, date } = Astro.props;
const iso = date.toISOString().slice(0, 10);
const human = date.toLocaleDateString("en-US", {
  year: "numeric", month: "long", day: "numeric",
});
---
<Base title={`${title} — Covenant`} description={description}>
  <main class="mx-auto max-w-3xl px-6 py-16 md:py-24">
    <a href="/blog" class="eyebrow hover:text-mist/90 transition-colors">← All posts</a>
    <h1 class="mt-6 text-3xl md:text-5xl font-semibold tracking-tight">{title}</h1>
    <p class="mt-4 text-mist/70 leading-relaxed">{description}</p>
    <time datetime={iso} class="mt-6 block font-mono text-[11px] uppercase tracking-eyebrow text-mist/50">
      {human}
    </time>
    <div class="prose-covenant mt-12">
      <slot />
    </div>
  </main>
</Base>

<style is:global>
  /* Scoped to the post body. Measure stays near 68ch; wide content gets its
     own horizontal scroller so the page body never scrolls sideways. */
  .prose-covenant { line-height: 1.7; }
  .prose-covenant > * + * { margin-top: 1.25rem; }
  .prose-covenant p,
  .prose-covenant ul,
  .prose-covenant ol { max-width: 68ch; color: rgb(232 239 230 / 0.8); }
  .prose-covenant h2 {
    margin-top: 3rem; font-size: 1.5rem; font-weight: 600;
    letter-spacing: -0.02em; color: theme(colors.mist);
  }
  .prose-covenant h3 {
    margin-top: 2rem; font-size: 1.125rem; font-weight: 600;
    color: theme(colors.mist);
  }
  .prose-covenant a { color: theme(colors.moss.400); text-decoration: underline; }
  .prose-covenant a:hover { color: theme(colors.moss.500); }
  .prose-covenant strong { color: theme(colors.mist); font-weight: 600; }
  .prose-covenant ul { list-style: disc; padding-left: 1.25rem; }
  .prose-covenant ol { list-style: decimal; padding-left: 1.25rem; }
  .prose-covenant li + li { margin-top: 0.4rem; }
  .prose-covenant code {
    font-family: theme(fontFamily.mono); font-size: 0.875em;
    background: rgb(232 239 230 / 0.07); padding: 0.1em 0.35em;
  }
  .prose-covenant pre {
    background: rgb(232 239 230 / 0.05); border: 1px solid rgb(232 239 230 / 0.1);
    padding: 1rem; overflow-x: auto; font-size: 0.85rem;
  }
  .prose-covenant pre code { background: none; padding: 0; }
  .prose-covenant blockquote {
    border-left: 2px solid theme(colors.moss.600); padding-left: 1rem;
    color: rgb(232 239 230 / 0.7);
  }
  .prose-covenant table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  .prose-covenant th, .prose-covenant td {
    text-align: left; padding: 0.5rem 0.75rem;
    border-bottom: 1px solid rgb(232 239 230 / 0.1);
  }
  .prose-covenant th {
    font-family: theme(fontFamily.mono); font-size: 0.7rem;
    text-transform: uppercase; letter-spacing: 0.1em; color: rgb(232 239 230 / 0.6);
  }
</style>
```

- [ ] **Step 6: Write the post route**

Create `landing/src/pages/blog/[slug].astro`:

```astro
---
import { getCollection, type CollectionEntry } from "astro:content";
import BlogPost from "../../layouts/BlogPost.astro";

export async function getStaticPaths() {
  // Drafts render in `astro dev` so prose can be previewed while it is
  // written, and drop out of production builds so nothing half-finished
  // reaches www.covenant.uno.
  const posts = await getCollection(
    "blog",
    ({ data }) => import.meta.env.DEV || !data.draft,
  );
  return posts.map((post) => ({ params: { slug: post.slug }, props: { post } }));
}

interface Props { post: CollectionEntry<"blog"> }
const { post } = Astro.props;
const { Content } = await post.render();
---
<BlogPost title={post.data.title} description={post.data.description} date={post.data.date}>
  <Content />
</BlogPost>
```

- [ ] **Step 7: Write the index route**

Create `landing/src/pages/blog/index.astro`:

```astro
---
import { getCollection } from "astro:content";
import Base from "../../layouts/Base.astro";

const posts = (
  await getCollection("blog", ({ data }) => import.meta.env.DEV || !data.draft)
).sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
---
<Base title="Blog — Covenant" description="Notes on building Covenant.">
  <main class="section">
    <p class="eyebrow">Blog</p>
    <h1 class="mt-4 text-3xl md:text-5xl font-semibold tracking-tight">Notes on building Covenant.</h1>

    {posts.length === 0 && (
      <p class="mt-12 text-mist/60">Nothing published yet.</p>
    )}

    <ul class="mt-12 space-y-8">
      {posts.map((post) => (
        <li>
          <a href={`/blog/${post.slug}`} class="group block">
            <time
              datetime={post.data.date.toISOString().slice(0, 10)}
              class="font-mono text-[11px] uppercase tracking-eyebrow text-mist/50">
              {post.data.date.toLocaleDateString("en-US", {
                year: "numeric", month: "long", day: "numeric",
              })}
            </time>
            <h2 class="mt-2 text-xl md:text-2xl font-semibold tracking-tight group-hover:text-moss-400 transition-colors">
              {post.data.title}
            </h2>
            <p class="mt-2 max-w-2xl text-mist/70 leading-relaxed">{post.data.description}</p>
          </a>
        </li>
      ))}
    </ul>
  </main>
</Base>
```

- [ ] **Step 8: Build and verify both routes**

```bash
cd landing && npm run build
```

Expected: exit 0, and the output lists `/blog/index.html` and `/blog/hello/index.html`.

```bash
ls -R dist/blog
```

Expected: `index.html` plus a `hello/index.html`.

- [ ] **Step 9: Verify the draft filter actually filters**

Temporarily flip the fixture to `draft: true`, rebuild, and confirm the page disappears from the production build:

```bash
cd landing
sed -i '' 's/^draft: false$/draft: true/' src/content/blog/hello.mdx
npm run build && ls dist/blog
```
Expected: `index.html` only — **no `hello/` directory**. If `hello/` is still emitted, the filter is wrong; fix it before continuing, since every later task depends on it.

Restore it:
```bash
sed -i '' 's/^draft: true$/draft: false/' src/content/blog/hello.mdx
```

- [ ] **Step 10: Commit**

```bash
git add landing/package.json landing/package-lock.json landing/astro.config.mjs \
        landing/src/content/config.ts landing/src/content/blog/hello.mdx \
        landing/src/layouts/BlogPost.astro landing/src/pages/blog/index.astro \
        landing/src/pages/blog/\[slug\].astro
git commit -m "feat(landing): blog content collection with MDX

Drafts render in dev and drop out of production builds, so prose can be
previewed at its real URL without shipping half-finished posts."
```

---

### Task 2: ThemeGallery reads the app registry

The coupling, and the test that guards it.

**Files:**
- Create: `landing/src/components/blog/ThemeGallery.astro`
- Test: `landing/src/components/blog/registry.test.ts`

**Interfaces:**
- Consumes, from `ui/src/theme/special.ts` (already on `main`):
  ```ts
  type SpecialThemeId = "jjk" | "kimetsu" | "onepiece" | "haikyuu" | "bunny" | "zerotwo" | "steinsgate";
  interface SpecialTheme {
    id: SpecialThemeId; name: string; art: string;
    base: "dark" | "light"; ground: string; veil: string;
    scrim: number; accent: string; danger?: string;
    term: { background: string; foreground: string; cursor: string; cursorAccent: string; selectionBackground: string };
  }
  const SPECIAL_THEMES: Record<SpecialThemeId, SpecialTheme>;
  const SPECIAL_THEME_LIST: readonly SpecialTheme[];
  function compositeGround(t: SpecialTheme, scrim: number): [number, number, number];
  ```
- Produces: `<ThemeGallery compact={boolean} />` — `compact` defaults to `false`; `true` renders thumbnails only, for the home-page section in Task 4.

- [ ] **Step 1: Write the failing test**

Create `landing/src/components/blog/registry.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run the test — it should pass immediately**

```bash
cd landing && npm run test:unit -- src/components/blog/registry.test.ts
```

**This is deliberately not a red-green step.** The registry it guards already exists on `main`; there is nothing to implement to make it pass. It is a *characterisation* test whose job is to fail later, if someone adds an app-only import to `ui/src/theme/special.ts`.

Expected: PASS. If instead it fails with "Cannot find module", the relative depth is wrong — from `landing/src/components/blog/` the repo root is four levels up (`../../../../`).

To confirm it has teeth rather than passing vacuously, temporarily break the path (`../../../../ui/src/theme/nope`), re-run, see it fail to resolve, then restore it. Report that you did this.

- [ ] **Step 3: Verify it also passes under the repo-root config**

```bash
cd /Users/carlosgallardoarenas/Sources/karlTerminal/.covenant/worktrees/landing-blog
npm test -- landing/src/components/blog/registry.test.ts
```
Expected: PASS. The root config uses `environment: jsdom` and a setup file the landing tests do not expect; this test avoids both by importing only the registry.

If it cannot be made green under both, move the file to `landing/tests/registry.test.ts` and add `"tests/**/*.test.ts"` to `landing/vitest.config.ts`'s `include` — **do not weaken the assertions to make it pass.**

- [ ] **Step 4: Write the component**

Create `landing/src/components/blog/ThemeGallery.astro`:

```astro
---
// The only file that reaches into the desktop app. Everything it renders —
// artwork, scrim, ground, accent — is the same data the app applies at
// runtime, so adding a theme to Covenant updates this gallery with no edit
// here. Guarded by ./registry.test.ts.
import { SPECIAL_THEME_LIST, compositeGround } from "../../../../ui/src/theme/special";

interface Props { compact?: boolean }
const { compact = false } = Astro.props;

const themes = SPECIAL_THEME_LIST.map((t) => {
  const [r, g, b] = compositeGround(t, t.scrim);
  return {
    id: t.id,
    name: t.name,
    art: t.art,
    accent: t.accent,
    base: t.base,
    scrim: t.scrim.toFixed(2),
    ground: t.ground,
    composited: `rgb(${r} ${g} ${b})`,
  };
});
---
<div class={compact
  ? "grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3"
  : "grid sm:grid-cols-2 gap-5 not-prose"}>
  {themes.map((t) => (
    <figure class="border border-mist/10">
      <div class="relative aspect-[16/9] overflow-hidden" style={`background:${t.ground}`}>
        <img src={t.art} alt={`${t.name} theme wallpaper`} loading="lazy"
             class="absolute inset-0 h-full w-full object-cover object-right-bottom" />
        <div class="absolute inset-0" style={`background:${t.composited};opacity:${t.scrim}`}></div>
      </div>
      {!compact && (
        <figcaption class="flex items-center justify-between gap-3 px-3 py-2">
          <span class="text-sm text-mist/90">{t.name}</span>
          <span class="flex items-center gap-2 font-mono text-[10px] uppercase tracking-eyebrow text-mist/50">
            <span class="inline-block h-2.5 w-2.5" style={`background:${t.accent}`}></span>
            {t.base} · scrim {t.scrim}
          </span>
        </figcaption>
      )}
    </figure>
  ))}
</div>
```

- [ ] **Step 5: Verify the artwork is actually emitted**

This is the spec's flagged risk: a Vite build rooted at `landing/` was proven to *resolve* the `.webp` imports, but emission through a full `astro build` was not verified.

Temporarily add `import ThemeGallery from "../../components/blog/ThemeGallery.astro";` and `<ThemeGallery />` to `landing/src/pages/blog/index.astro`, then:

```bash
cd landing && npm run build && find dist -name "*.webp" | head
```

Expected: seven `.webp` files under `dist/`. Then confirm the emitted HTML points at them:
```bash
grep -o 'src="[^"]*\.webp"' dist/blog/index.html | head -3
```
Expected: paths that exist under `dist/`.

**If no `.webp` is emitted**, apply the spec's documented fallback: add to `landing/package.json` a `"prebuild": "node scripts/copy-theme-art.mjs"` that copies `../ui/assets/themes/*.webp` into `landing/public/themes/`, and change the component's `art` mapping to `` `/themes/${t.id}.webp` ``. The numbers still come from the registry; only the images are duplicated, and by a script rather than by hand. Record which path you took in your report.

Remove the temporary import from `index.astro` once verified.

- [ ] **Step 6: Run both test suites again**

```bash
cd landing && npm run test:unit
cd .. && npm test -- landing/src/components/blog/registry.test.ts
```
Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add landing/src/components/blog/ThemeGallery.astro \
        landing/src/components/blog/registry.test.ts
git commit -m "feat(landing): ThemeGallery reads the app's theme registry

One import is the whole coupling, guarded by a test so it fails in CI
rather than as a failed production deploy."
```

---

### Task 3: The post scaffold and KnobTable

Deliverable: the real post exists with structure, front-matter and verified data, ready for the user to write prose into.

**Files:**
- Create: `landing/src/components/blog/KnobTable.astro`
- Create: `landing/src/content/blog/making-the-terminal-yours.mdx`
- Delete: `landing/src/content/blog/hello.mdx`

**Interfaces:**
- Consumes: `<ThemeGallery/>` from Task 2.
- Produces: `<KnobTable rows={KnobRow[]} />` where `interface KnobRow { group: string; setting: string; values: string }`.

- [ ] **Step 1: Write the table component**

Create `landing/src/components/blog/KnobTable.astro`:

```astro
---
export interface KnobRow { group: string; setting: string; values: string }
interface Props { rows: KnobRow[] }
const { rows } = Astro.props;
---
<div class="not-prose overflow-x-auto border border-mist/10">
  <table class="w-full border-collapse text-sm min-w-[34rem]">
    <thead>
      <tr>
        {["Group", "Setting", "Values"].map((h) => (
          <th class="border-b border-mist/10 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-eyebrow text-mist/50">
            {h}
          </th>
        ))}
      </tr>
    </thead>
    <tbody>
      {rows.map((r) => (
        <tr>
          <td class="border-b border-mist/5 px-3 py-2 align-top text-mist/60">{r.group}</td>
          <td class="border-b border-mist/5 px-3 py-2 align-top font-mono text-[12px] text-mist/90">{r.setting}</td>
          <td class="border-b border-mist/5 px-3 py-2 align-top text-mist/70">{r.values}</td>
        </tr>
      ))}
    </tbody>
  </table>
</div>
```

- [ ] **Step 2: Write the post scaffold**

Create `landing/src/content/blog/making-the-terminal-yours.mdx`. Every value below was read from `ui/src/settings/panel.ts`, `ui/src/api.ts` and `ui/src/theme/special.ts` — do not invent additional rows.

````mdx
---
title: "Making the terminal yours"
description: "Seven wallpaper-backed themes, five tab styles, and about twenty-five other knobs — plus why the scrim on each theme is a measured value, not a taste call."
date: 2026-07-19
draft: true
---

import ThemeGallery from "../../components/blog/ThemeGallery.astro";
import KnobTable from "../../components/blog/KnobTable.astro";

{/*
  SCAFFOLD — the structure and the data are here; the prose is yours.
  Every heading below is a suggestion, not a constraint. Delete freely.

  Material worth using, all verifiable in the repo:
   - Grounds were sampled by median-cut quantisation of each artwork, not
     eyeballed. See docs/superpowers/specs/2026-07-19-special-themes-design.md
   - Scrims are calibrated so all seven composited surfaces land in a
     10.8-12.2:1 contrast band against their own terminal foreground,
     asserted in ui/src/theme/special.test.ts
   - Steins;Gate has a pure-white ground (1.000 luminance), so it ships as a
     LIGHT theme with a BLACK veil — the case that forced the scrim to be a
     veil colour plus an alpha rather than a darkening amount
   - Every artwork puts its subject in the right third, which is why the art
     is anchored `right bottom`: terminal text hugs the left
*/}

## The themes

<ThemeGallery />

## Why the scrim is measured, not chosen

## Everything else you can change

<KnobTable rows={[
  { group: "Theme",  setting: "theme",               values: "system / dark / true_dark / light / special" },
  { group: "Theme",  setting: "special_theme",       values: "jjk, kimetsu, onepiece, haikyuu, zerotwo, bunny, steinsgate" },
  { group: "Theme",  setting: "special_scrim",       values: "±0.20 around each theme's calibrated default" },
  { group: "Window", setting: "window_background",   values: "solid / vibrant / translucent" },
  { group: "Window", setting: "zen_icons",           values: "on / off" },
  { group: "Window", setting: "status_bar_enabled",  values: "on / off" },
  { group: "Window", setting: "notch_enabled",       values: "on / off" },
  { group: "Tabs",   setting: "tab_style",           values: "classic / forge / glass / crt / custom" },
  { group: "Tabs",   setting: "tab_custom_*",        values: "bg, shape, height, gap, indicator, gradient start/end, group shape, group bg" },
  { group: "Tabs",   setting: "tabbar_position",     values: "top / left" },
  { group: "Rails",  setting: "folded_rail_style",   values: "legacy / glyph / labels / spine" },
  { group: "Type",   setting: "ui_font",             values: "chrome font stack override" },
  { group: "Type",   setting: "term_font",           values: "terminal family" },
  { group: "Type",   setting: "term_size",           values: "point size" },
  { group: "Type",   setting: "term_letter_spacing", values: "-10 to 10 px, DPR-normalised" },
  { group: "Type",   setting: "term_line_height",    values: "0.8 to 2.0" },
  { group: "Type",   setting: "term_ligatures",      values: "on / off" },
]} />

## Where it all lives

Everything above persists to a single file:

```
~/Library/Application Support/com.karluiz.covenant/config.json
```
````

- [ ] **Step 3: Delete the fixture**

```bash
rm landing/src/content/blog/hello.mdx
```

- [ ] **Step 4: Verify the post renders in dev**

```bash
cd landing && npm run dev
```
Open `http://localhost:4321/blog/making-the-terminal-yours`. Expected: the post renders, the gallery shows seven themes with artwork, and the knob table shows 17 rows. Stop the dev server.

- [ ] **Step 5: Verify it is excluded from the production build**

```bash
cd landing && npm run build && ls dist/blog
```
Expected: `index.html` only — no `making-the-terminal-yours/`, because `draft: true`. `/blog` renders "Nothing published yet."

- [ ] **Step 6: Commit**

```bash
git add landing/src/components/blog/KnobTable.astro \
        landing/src/content/blog/making-the-terminal-yours.mdx
git rm landing/src/content/blog/hello.mdx
git commit -m "feat(landing): scaffold the customization post

Structure, front-matter and verified knob inventory. Ships draft:true —
visible in dev for writing, excluded from production builds."
```

---

### Task 4: Customization section and navigation

**Files:**
- Create: `landing/src/components/Customization.astro`
- Modify: `landing/src/pages/index.astro`, `landing/src/components/Navbar.astro`

**Interfaces:**
- Consumes: `<ThemeGallery compact />` from Task 2.
- Produces: a section with `id="customization"` for the navbar to link to.

**Note — a spec gap this task closes.** The spec did not mention navigation. A blog reachable only from one section link is effectively hidden, so this task adds a `/blog` link to the navbar. Flagging it because it is an addition, not a translation of the spec.

- [ ] **Step 1: Write the section**

Create `landing/src/components/Customization.astro`. Reinforcement, not argument — it stays short and hands off to the post.

```astro
---
import ThemeGallery from "./blog/ThemeGallery.astro";
import { SPECIAL_THEME_LIST } from "../../../ui/src/theme/special";
const themeCount = SPECIAL_THEME_LIST.length;
---
<section id="customization" class="section">
  <p class="eyebrow fade-in-up">Customization</p>
  <h2 class="mt-4 text-3xl md:text-5xl font-semibold tracking-tight max-w-3xl fade-in-up delay-100">
    A terminal you stare at all day should look like yours.
  </h2>
  <p class="mt-6 max-w-2xl text-mist/70 leading-relaxed fade-in-up delay-100">
    Four theme modes and {themeCount} wallpaper-backed ones. Five tab styles with nine
    knobs of their own. Four folded-rail treatments. Terminal typography down to
    letter-spacing. Every scrim measured, not guessed.
  </p>
  <div class="mt-12 fade-in-up delay-200">
    <ThemeGallery compact />
  </div>
  <a href="/blog/making-the-terminal-yours"
     class="mt-10 inline-block font-mono text-[11px] uppercase tracking-eyebrow text-moss-400 hover:text-moss-500 transition-colors fade-in-up delay-300">
    Read how the themes were built →
  </a>
</section>
```

- [ ] **Step 2: Insert it into the home page**

In `landing/src/pages/index.astro`, add the import alongside the others and place `<Customization />` between `<DeepDive />` and the closing `</main>`:

```astro
import DeepDive from "../components/DeepDive.astro";
import Customization from "../components/Customization.astro";
```

```astro
    <DeepDive />
    <Customization />
  </main>
```

- [ ] **Step 3: Add the navbar link**

`landing/src/components/Navbar.astro` drives both the desktop row and the mobile menu from one `links` array, so this is a single entry — no markup changes.

Add `Blog` between `Canon` and `Remote`:

```ts
const links = [
  { href: "#install", label: "Install" },
  { href: "#canon", label: "Canon" },
  { href: "/blog", label: "Blog" },
  { href: "/remote", label: "Remote" },
  { href: "https://forge.covenant.uno", label: "Forge" },
  { href: githubUrl, label: "GitHub" },
];
```

Note the two anchor links (`#install`, `#canon`) resolve against the current page, so from `/blog` they go nowhere. That is pre-existing — `/remote` has the same behaviour today — and is **not** in scope here.

- [ ] **Step 4: Build and check the section renders**

```bash
cd landing && npm run build && grep -c 'id="customization"' dist/index.html
```
Expected: `1`.

- [ ] **Step 5: Commit**

```bash
git add landing/src/components/Customization.astro landing/src/pages/index.astro \
        landing/src/components/Navbar.astro
git commit -m "feat(landing): customization section and blog nav link

Sits after DeepDive — reinforcement rather than a competing argument."
```

---

### Task 5: Tests and pre-merge verification

**Files:**
- Modify: `landing/tests/landing.spec.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing downstream.

- [ ] **Step 1: Extend the smoke test**

`landing/tests/landing.spec.ts` hardcodes home-page copy. Add coverage for the new section and `/blog`, keeping the existing assertions intact.

**Do not assert the post page.** Playwright runs against `npm run preview`, which serves the production build, where the draft post does not exist.

Append to `landing/tests/landing.spec.ts`:

```ts
test("renders the customization section", async ({ page }) => {
  await page.goto("/");
  await page.locator("#customization").scrollIntoViewIfNeeded();
  await expect(page.getByText("A terminal you stare at all day")).toBeVisible();
  // The gallery renders one figure per theme, straight from the app registry.
  await expect(page.locator("#customization figure")).toHaveCount(7);
});

test("serves the blog index", async ({ page }) => {
  const res = await page.goto("/blog");
  expect(res?.status()).toBe(200);
  await expect(page.locator("h1")).toContainText("Notes on building Covenant");
});
```

- [ ] **Step 2: Run the Playwright suite**

Playwright's `webServer.command` says `pnpm preview`, but this repo uses npm in `landing/`. Start the server yourself and let Playwright reuse it:

```bash
cd landing && npm run build && (npm run preview -- --port 4322 &) && sleep 3 && npx playwright test
```
Expected: all tests pass. Kill the preview server afterwards (`lsof -ti:4322 | xargs kill`).

If `landing.spec.ts`'s original assertions now fail, the new section changed page copy or layout — fix the test to match reality, not the reverse.

- [ ] **Step 3: Run both unit suites**

```bash
cd landing && npm run test:unit
cd .. && npm test 2>&1 | tail -5
```
Expected: landing's unit suite fully green. The repo-root suite has a **pre-existing** failure set — 9 files / 7 tests in `landing/` Astro loads plus `notch/store`, `spec-chat`, `tasker/board`, `teammate/task-card`, `workspaces/manager`. Your change must not add to it; verify with `git stash` before calling any failure pre-existing.

- [ ] **Step 4: Manual check of the production build**

```bash
cd landing && npm run build && npm run preview -- --port 4322
```

Visit and confirm by eye:
- `/` — the Customization section appears after the deep-dive bento and before the footer; seven thumbnails render with artwork.
- `/blog` — renders, says "Nothing published yet." (correct while the post is a draft).
- The navbar `/blog` link works.
- No horizontal scrollbar at 375 px width.

- [ ] **Step 5: Commit**

```bash
git add landing/tests/landing.spec.ts
git commit -m "test(landing): cover the customization section and blog index"
```

- [ ] **Step 6: Stop — do not merge**

The branch is complete but **must not merge to `main`**. `deploy-landing.yml` publishes any `landing/**` change on `main` straight to www.covenant.uno with no test gate and no preview.

Hand back to the user with:
1. `cd landing && npm run dev`, then `http://localhost:4321/blog/making-the-terminal-yours` — this is where they write.
2. When the prose is final, flip `draft: true` → `draft: false` in the post's front-matter.
3. Re-run Task 5 Steps 2–4, adding a Playwright assertion for the post page (it will exist in the production build once undrafted).
4. Then merge.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1 Blog infrastructure (collection, MDX, routes, layout, typography) | 1 |
| §2 ThemeGallery from the real registry + emission fallback | 2 |
| §2 Coupling guard, green under both vitest configs | 2 (Steps 1–3) |
| §3 Customization section after DeepDive | 4 |
| §4 Scaffolded post + verified inventory | 3 |
| §5 Testing — new guard, existing smoke test at risk, `/blog` coverage | 5 |
| §6 Deploy model mitigations | 5 Step 6, plus Global Constraints |
| §7 Out of scope (no RSS/tags/authors, no docs section, no vitest-config fix, no README fix) | not implemented, by design |

**Gap closed beyond the spec:** the spec never covered navigation. Task 4 Step 3 adds a navbar `/blog` link, flagged inline.

**Contradiction resolved:** the spec's `draft: true` requirement conflicts with shipping a working `/blog` and a section link. The "Draft handling" section above resolves it — drafts visible in dev, hidden in production, branch not merged until the prose lands. Task 5 Step 1 depends on this by *not* asserting the post page.

**Type consistency:** `SPECIAL_THEME_LIST`, `compositeGround`, `SpecialTheme` are used with the signatures declared in Task 2's Interfaces block. `<ThemeGallery compact />` is defined in Task 2 and consumed in Task 4 with that exact prop. `KnobRow { group, setting, values }` is defined in Task 3 Step 1 and used with those exact keys in Step 2. `BlogPost.astro`'s props `{ title, description, date }` are defined in Task 1 Step 5 and passed with those names in Step 6.
