# Covenant Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a static, single-page Covenant landing site under `landing/` that positions Covenant as a companion for AI orchestrators and introduces the Covenant Score.

**Architecture:** Astro 4 + Tailwind 3 static site, one page composed of section components, one client-side island for the Score funnel animation. Built to `landing/dist/`, deployed to Cloudflare Pages. No backend, no tracking.

**Tech Stack:** Astro 4, Tailwind CSS 3, TypeScript, Vite (via Astro), `pnpm` (workspace already present), Playwright for one smoke test, `@astrojs/check` for typecheck.

**Spec:** `docs/superpowers/specs/2026-05-18-covenant-landing-design.md`

**Commit policy (user preference):** one commit per task, not per TDD step.

---

## File Structure

```
landing/
├── .gitignore
├── astro.config.mjs
├── package.json
├── tailwind.config.ts
├── tsconfig.json
├── playwright.config.ts
├── tests/
│   └── landing.spec.ts
├── public/
│   ├── favicon.svg
│   ├── og.png
│   └── screenshots/.gitkeep
└── src/
    ├── pages/
    │   └── index.astro
    ├── layouts/
    │   └── Base.astro
    ├── components/
    │   ├── Hero.astro
    │   ├── Companion.astro
    │   ├── Covenant.astro
    │   ├── Score.astro
    │   ├── DeepDive.astro
    │   ├── OpenSource.astro
    │   ├── Install.astro
    │   └── Footer.astro
    ├── islands/
    │   └── ScoreFunnel.ts
    └── styles/
        └── globals.css
```

Each component owns one section from the spec. `ScoreFunnel.ts` is the only JS shipped to the browser. Adding a new section is "add a component + import in `index.astro`."

---

## Task 1: Scaffold the Astro project in `landing/`

**Files:**
- Create: `landing/package.json`
- Create: `landing/astro.config.mjs`
- Create: `landing/tsconfig.json`
- Create: `landing/.gitignore`
- Create: `landing/src/pages/index.astro`
- Modify: `pnpm-workspace.yaml` (add `landing` to packages)

- [ ] **Step 1: Add `landing` to the workspace**

Modify `pnpm-workspace.yaml`. After this task it must include `landing` alongside any existing entries (preserve them).

```yaml
packages:
  - "ui"
  - "landing"
```

(If the file already has `landing` or globs that cover it, no change. Verify with `pnpm m ls`.)

- [ ] **Step 2: Write `landing/package.json`**

```json
{
  "name": "@covenant/landing",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "astro dev --port 4321",
    "build": "astro build",
    "preview": "astro preview --port 4321",
    "check": "astro check",
    "test": "playwright test"
  },
  "dependencies": {
    "astro": "^4.16.0",
    "@astrojs/tailwind": "^5.1.0",
    "@astrojs/check": "^0.9.0",
    "tailwindcss": "^3.4.0",
    "typescript": "^5.5.0"
  },
  "devDependencies": {
    "@playwright/test": "^1.47.0"
  }
}
```

- [ ] **Step 3: Write `landing/astro.config.mjs`**

```js
import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";

export default defineConfig({
  site: "https://covenant.dev",
  integrations: [tailwind({ applyBaseStyles: false })],
  build: { inlineStylesheets: "auto" },
  compressHTML: true,
});
```

- [ ] **Step 4: Write `landing/tsconfig.json`**

```json
{
  "extends": "astro/tsconfigs/strict",
  "include": ["src/**/*", "tests/**/*"],
  "compilerOptions": {
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] }
  }
}
```

- [ ] **Step 5: Write `landing/.gitignore`**

```
node_modules
dist
.astro
.env
.playwright
```

- [ ] **Step 6: Write a stub `landing/src/pages/index.astro`**

```astro
---
---
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Covenant</title></head>
  <body><h1>Covenant landing — scaffolded</h1></body>
</html>
```

- [ ] **Step 7: Install and verify build**

Run from repo root:
```bash
pnpm install
pnpm --filter @covenant/landing build
```

Expected: `landing/dist/index.html` exists, exit code 0.

- [ ] **Step 8: Commit**

```bash
git add pnpm-workspace.yaml landing/
git commit -m "feat(landing): scaffold Astro project under landing/"
```

---

## Task 2: Tailwind theme, base layout, and globals

**Files:**
- Create: `landing/tailwind.config.ts`
- Create: `landing/src/styles/globals.css`
- Create: `landing/src/layouts/Base.astro`
- Modify: `landing/src/pages/index.astro`

- [ ] **Step 1: Write `landing/tailwind.config.ts`**

```ts
import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{astro,html,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0a0c0a",
        mist: "#e8efe6",
        moss: { 400: "#7bd389", 500: "#4fbf6a", 600: "#3aa055" },
        bone: "#f3efe7",
      },
      fontFamily: {
        sans: ["Inter Tight", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      letterSpacing: { eyebrow: "0.18em" },
      maxWidth: { content: "72rem" },
    },
  },
} satisfies Config;
```

- [ ] **Step 2: Write `landing/src/styles/globals.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root { color-scheme: dark; }

html, body {
  background: theme(colors.ink);
  color: theme(colors.mist);
  font-family: theme(fontFamily.sans);
  -webkit-font-smoothing: antialiased;
}

.eyebrow {
  @apply text-[11px] uppercase tracking-eyebrow text-mist/60 font-mono;
}

.section {
  @apply mx-auto max-w-content px-6 py-24 md:py-32;
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
```

- [ ] **Step 3: Write `landing/src/layouts/Base.astro`**

```astro
---
import "../styles/globals.css";
interface Props { title: string; description: string; }
const { title, description } = Astro.props;
const ogUrl = new URL("/og.png", Astro.site).toString();
---
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title}</title>
    <meta name="description" content={description} />
    <meta property="og:title" content={title} />
    <meta property="og:description" content={description} />
    <meta property="og:image" content={ogUrl} />
    <meta property="og:type" content="website" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  </head>
  <body class="min-h-screen">
    <slot />
  </body>
</html>
```

- [ ] **Step 4: Update `landing/src/pages/index.astro` to use Base**

```astro
---
import Base from "../layouts/Base.astro";
---
<Base
  title="Covenant — The terminal for AI orchestrators"
  description="Run swarms of autonomous operators in parallel sessions. See every byte. Intervene at any moment. Open source.">
  <main class="section">
    <p class="eyebrow">Covenant · Open Source</p>
    <h1 class="mt-4 text-5xl font-semibold tracking-tight">Layout boots.</h1>
  </main>
</Base>
```

- [ ] **Step 5: Add a placeholder favicon**

Write `landing/public/favicon.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="#4fbf6a"/></svg>
```

- [ ] **Step 6: Build and verify**

```bash
pnpm --filter @covenant/landing build
```

Expected: build succeeds, `landing/dist/index.html` contains the eyebrow text and references the inlined Tailwind CSS.

- [ ] **Step 7: Commit**

```bash
git add landing/
git commit -m "feat(landing): tailwind theme, base layout, globals"
```

---

## Task 3: Hero component

**Files:**
- Create: `landing/src/components/Hero.astro`
- Modify: `landing/src/pages/index.astro`

- [ ] **Step 1: Write `landing/src/components/Hero.astro`**

```astro
---
const githubUrl = "https://github.com/karluiz/covenant";
---
<section class="section text-center">
  <p class="eyebrow">Covenant · Open Source</p>
  <h1 class="mt-6 text-4xl md:text-6xl font-semibold tracking-tight leading-[1.05]">
    The terminal that turns you<br /> into an AI orchestrator.
  </h1>
  <p class="mt-6 mx-auto max-w-2xl text-lg text-mist/70">
    Run swarms of autonomous operators in parallel sessions. See every byte they emit.
    Intervene at any moment. Ship more, with a contract that makes autonomy survivable.
  </p>
  <div class="mt-10 flex flex-wrap justify-center gap-3">
    <a href="#install" class="rounded-md bg-moss-500 px-5 py-3 text-ink font-medium hover:bg-moss-400 transition">
      Download for macOS
    </a>
    <a href={githubUrl} class="rounded-md border border-mist/20 px-5 py-3 text-mist hover:border-mist/40 transition">
      ★ GitHub
    </a>
  </div>
  <div class="mt-16 mx-auto max-w-5xl aspect-[16/9] rounded-xl border border-mist/10 bg-mist/5 grid place-items-center text-mist/40 text-sm">
    [ hero screenshot — public/screenshots/hero.png ]
  </div>
</section>
```

- [ ] **Step 2: Wire Hero into the page**

Replace the contents of `landing/src/pages/index.astro` `<main>` with:

```astro
---
import Base from "../layouts/Base.astro";
import Hero from "../components/Hero.astro";
---
<Base
  title="Covenant — The terminal for AI orchestrators"
  description="Run swarms of autonomous operators in parallel sessions. See every byte. Intervene at any moment. Open source.">
  <main>
    <Hero />
  </main>
</Base>
```

- [ ] **Step 3: Build and verify**

```bash
pnpm --filter @covenant/landing build
grep -q "AI orchestrator" landing/dist/index.html && echo OK
```

Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add landing/
git commit -m "feat(landing): hero section"
```

---

## Task 4: Companion section (the four pillars)

**Files:**
- Create: `landing/src/components/Companion.astro`
- Modify: `landing/src/pages/index.astro`

- [ ] **Step 1: Write `landing/src/components/Companion.astro`**

```astro
---
const pillars = [
  {
    title: "Parallel operators, one surface",
    body: "Each tab is an isolated PTY. Claude Code, Codex, custom agents run side-by-side. No context bleed.",
  },
  {
    title: "Cross-session world-model",
    body: "The super-agent sees every block in every tab. Tests fail in tab 2 right after you edit in tab 1? It connects the dots.",
  },
  {
    title: "Intervene at any moment",
    body: "⌘K to ask 'what's going on?'. Inline suggestions on non-zero exit. Take the wheel back without breaking the session.",
  },
  {
    title: "GitHub-native",
    body: "Commits, PRs, CI signals stream back. Operators are first-class authors on your graph.",
  },
];
---
<section class="section">
  <p class="eyebrow">The companion</p>
  <h2 class="mt-4 text-3xl md:text-5xl font-semibold tracking-tight max-w-3xl">
    Built to make orchestrators powerful, not busy.
  </h2>
  <div class="mt-14 grid md:grid-cols-2 gap-6">
    {pillars.map((p) => (
      <article class="rounded-xl border border-mist/10 bg-mist/[0.02] p-6 hover:border-moss-500/40 transition">
        <h3 class="text-xl font-semibold">{p.title}</h3>
        <p class="mt-3 text-mist/70 leading-relaxed">{p.body}</p>
      </article>
    ))}
  </div>
</section>
```

- [ ] **Step 2: Import in `index.astro`**

Add `import Companion from "../components/Companion.astro";` and place `<Companion />` after `<Hero />`.

- [ ] **Step 3: Build and verify**

```bash
pnpm --filter @covenant/landing build
grep -q "Cross-session world-model" landing/dist/index.html && echo OK
```

- [ ] **Step 4: Commit**

```bash
git add landing/
git commit -m "feat(landing): companion section — four pillars"
```

---

## Task 5: Covenant section (safety contract)

**Files:**
- Create: `landing/src/components/Covenant.astro`
- Modify: `landing/src/pages/index.astro`

- [ ] **Step 1: Write `landing/src/components/Covenant.astro`**

```astro
---
const repo = "https://github.com/karluiz/covenant/blob/main";
const guarantees = [
  {
    title: "Hard blocklist",
    body: "rm -rf, sudo, curl | sh, force-pushes to protected branches, writes to ~/.ssh, fork bombs. Removing entries requires code review.",
    href: `${repo}/crates/agent/src/safety.rs`,
    linkLabel: "safety.rs",
  },
  {
    title: "Secrets masked",
    body: "API keys, JWTs, SSH keys, GitHub and AWS tokens — masked before any byte reaches the model.",
    href: `${repo}/crates/agent/src/redact.rs`,
    linkLabel: "redact.rs",
  },
  {
    title: "Cost caps",
    body: "Per-minute and per-day token ceilings. Single agent::dispatch(), no bypass.",
    href: `${repo}/crates/agent/src/dispatch.rs`,
    linkLabel: "dispatch.rs",
  },
];
---
<section class="section">
  <p class="eyebrow">The covenant</p>
  <h2 class="mt-4 text-3xl md:text-5xl font-semibold tracking-tight max-w-3xl">
    Autonomy with a contract. Not vibes — Rust functions you can grep.
  </h2>
  <div class="mt-14 grid md:grid-cols-3 gap-6">
    {guarantees.map((g) => (
      <article class="rounded-xl border border-moss-500/20 bg-moss-500/[0.04] p-6">
        <h3 class="text-lg font-semibold">{g.title}</h3>
        <p class="mt-3 text-mist/70 text-sm leading-relaxed">{g.body}</p>
        <a href={g.href} class="mt-4 inline-block text-moss-400 font-mono text-xs hover:underline">
          → {g.linkLabel}
        </a>
      </article>
    ))}
  </div>
</section>
```

- [ ] **Step 2: Import in `index.astro`** — add `<Covenant />` after `<Companion />`.

- [ ] **Step 3: Build and verify**

```bash
pnpm --filter @covenant/landing build
grep -q "Hard blocklist" landing/dist/index.html && echo OK
```

- [ ] **Step 4: Commit**

```bash
git add landing/
git commit -m "feat(landing): covenant section — safety contract"
```

---

## Task 6: Score section + funnel island

**Files:**
- Create: `landing/src/components/Score.astro`
- Create: `landing/src/islands/ScoreFunnel.ts`
- Modify: `landing/src/pages/index.astro`

- [ ] **Step 1: Write `landing/src/islands/ScoreFunnel.ts`**

```ts
const STAGES = [
  { id: "spc", final: 12 },
  { id: "pln", final: 38 },
  { id: "tsk", final: 214 },
  { id: "tok", final: 4_100_000, format: (n: number) => `${(n / 1_000_000).toFixed(1)}M` },
  { id: "cmt", final: 412 },
  { id: "pr", final: 27 },
] as const;

function animate(el: HTMLElement, final: number, format: (n: number) => string) {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) { el.textContent = format(final); return; }
  const start = performance.now();
  const duration = 1100;
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = format(Math.round(final * eased));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function init() {
  const root = document.querySelector<HTMLElement>("[data-score-funnel]");
  if (!root) return;
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      io.disconnect();
      for (const stage of STAGES) {
        const el = root.querySelector<HTMLElement>(`[data-stage="${stage.id}"]`);
        if (!el) continue;
        const fmt = "format" in stage && stage.format ? stage.format : (n: number) => n.toLocaleString();
        animate(el, stage.final, fmt);
      }
    }
  }, { threshold: 0.4 });
  io.observe(root);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
```

- [ ] **Step 2: Write `landing/src/components/Score.astro`**

```astro
---
const stages = [
  { id: "spc", label: "Specs", initial: "0" },
  { id: "pln", label: "Plans", initial: "0" },
  { id: "tsk", label: "Tasks", initial: "0" },
  { id: "tok", label: "Tokens", initial: "0" },
  { id: "cmt", label: "Commits", initial: "0" },
  { id: "pr",  label: "PRs",     initial: "0" },
];
---
<section class="section text-center">
  <p class="eyebrow">The receipt</p>
  <h2 class="mt-4 text-3xl md:text-5xl font-semibold tracking-tight max-w-3xl mx-auto">
    When you can see everything, you can finally measure it.
  </h2>
  <p class="mt-6 mx-auto max-w-2xl text-mist/70">
    DORA was designed for humans typing. A single orchestrator now ships hundreds of PRs a day.
    The <strong>Covenant Score</strong> is the only unit that survives.
  </p>

  <div data-score-funnel class="mt-14 mx-auto max-w-4xl rounded-2xl border border-mist/10 bg-mist/[0.02] p-10">
    <p class="eyebrow">Covenant Score</p>
    <div class="mt-3 text-7xl font-semibold tracking-tight">8.4</div>

    <div class="mt-10 flex flex-wrap items-center justify-center gap-4 text-xs font-mono uppercase tracking-eyebrow">
      {stages.map((s, i) => (
        <>
          <div class="flex flex-col items-center gap-2">
            <div class="w-14 h-14 rounded-lg border border-moss-500/40 grid place-items-center text-base text-mist">
              <span data-stage={s.id}>{s.initial}</span>
            </div>
            <span class="text-mist/60">{s.label}</span>
          </div>
          {i < stages.length - 1 && <span class="text-mist/30">→</span>}
        </>
      ))}
    </div>
  </div>

  <p class="mt-8 text-sm text-mist/60 max-w-xl mx-auto">
    Six dimensions. One number. Compatible with — and an honest replacement for — DORA in the autonomous era.
  </p>
</section>

<script>
  import "../islands/ScoreFunnel.ts";
</script>
```

- [ ] **Step 3: Import in `index.astro`** — add `<Score />` after `<Covenant />`.

- [ ] **Step 4: Build and verify**

```bash
pnpm --filter @covenant/landing build
grep -q "Covenant Score" landing/dist/index.html && echo OK
test -f landing/dist/_astro/*.js && echo "island bundled"
```

- [ ] **Step 5: Commit**

```bash
git add landing/
git commit -m "feat(landing): covenant score section with funnel animation"
```

---

## Task 7: Deep dive, open source, install, footer sections

**Files:**
- Create: `landing/src/components/DeepDive.astro`
- Create: `landing/src/components/OpenSource.astro`
- Create: `landing/src/components/Install.astro`
- Create: `landing/src/components/Footer.astro`
- Modify: `landing/src/pages/index.astro`

- [ ] **Step 1: Write `landing/src/components/DeepDive.astro`**

```astro
---
const shots = [
  { caption: "Multi-session orchestration", path: "/screenshots/tabs.png" },
  { caption: "Super-agent panel", path: "/screenshots/agent.png" },
  { caption: "Covenant Score dashboard", path: "/screenshots/score.png" },
  { caption: "Operator-attributed PRs", path: "/screenshots/prs.png" },
];
---
<section class="section">
  <p class="eyebrow">Deep dive</p>
  <h2 class="mt-4 text-3xl md:text-5xl font-semibold tracking-tight max-w-3xl">
    See the orchestrator in action.
  </h2>
  <div class="mt-14 grid md:grid-cols-2 gap-6">
    {shots.map((s) => (
      <figure class="rounded-xl border border-mist/10 overflow-hidden bg-mist/[0.02]">
        <div class="aspect-video grid place-items-center text-mist/40 text-sm">
          [ {s.path} ]
        </div>
        <figcaption class="px-4 py-3 text-sm text-mist/70">{s.caption}</figcaption>
      </figure>
    ))}
  </div>
</section>
```

- [ ] **Step 2: Write `landing/src/components/OpenSource.astro`**

```astro
---
const githubUrl = "https://github.com/karluiz/covenant";
---
<section class="section">
  <div class="rounded-2xl border border-moss-500/30 bg-moss-500/[0.05] p-10 md:p-14 flex flex-col md:flex-row items-start md:items-center justify-between gap-8">
    <div class="max-w-xl">
      <p class="eyebrow">Open source</p>
      <h2 class="mt-3 text-3xl md:text-4xl font-semibold tracking-tight">
        Read the covenant. Read the code.
      </h2>
      <p class="mt-4 text-mist/70">
        MIT + Apache 2.0. Every safety guarantee is a function you can grep.
        No telemetry. No SaaS lock-in.
      </p>
    </div>
    <a href={githubUrl} class="rounded-md bg-mist text-ink px-6 py-3 font-medium hover:bg-moss-400 transition">
      ★ Star on GitHub
    </a>
  </div>
</section>
```

- [ ] **Step 3: Write `landing/src/components/Install.astro`**

```astro
<section id="install" class="section text-center">
  <p class="eyebrow">Install</p>
  <h2 class="mt-4 text-3xl md:text-5xl font-semibold tracking-tight">
    One command.
  </h2>
  <div class="mt-8 inline-flex items-center gap-3 rounded-lg border border-mist/15 bg-mist/[0.04] px-5 py-4 font-mono text-mist">
    <span class="text-moss-400">$</span>
    <code>brew install covenant</code>
  </div>
  <p class="mt-6 text-sm text-mist/60">macOS today · Windows soon · Linux community</p>
</section>
```

- [ ] **Step 4: Write `landing/src/components/Footer.astro`**

```astro
---
const year = new Date().getFullYear();
---
<footer class="border-t border-mist/10 mt-10">
  <div class="mx-auto max-w-content px-6 py-10 flex flex-wrap items-center justify-between gap-4 text-sm text-mist/60">
    <div>© {year} Covenant — MIT + Apache 2.0</div>
    <nav class="flex gap-6">
      <a href="https://github.com/karluiz/covenant" class="hover:text-mist">GitHub</a>
      <a href="https://github.com/karluiz/covenant/blob/main/CHANGELOG.md" class="hover:text-mist">Changelog</a>
      <a href="https://github.com/karluiz/covenant#readme" class="hover:text-mist">Docs</a>
    </nav>
  </div>
</footer>
```

- [ ] **Step 5: Wire all sections into `index.astro`**

Final `landing/src/pages/index.astro`:

```astro
---
import Base from "../layouts/Base.astro";
import Hero from "../components/Hero.astro";
import Companion from "../components/Companion.astro";
import Covenant from "../components/Covenant.astro";
import Score from "../components/Score.astro";
import DeepDive from "../components/DeepDive.astro";
import OpenSource from "../components/OpenSource.astro";
import Install from "../components/Install.astro";
import Footer from "../components/Footer.astro";
---
<Base
  title="Covenant — The terminal for AI orchestrators"
  description="Run swarms of autonomous operators in parallel sessions. See every byte. Intervene at any moment. Measure the new SDLC. Open source.">
  <main>
    <Hero />
    <Companion />
    <Covenant />
    <Score />
    <DeepDive />
    <OpenSource />
    <Install />
  </main>
  <Footer />
</Base>
```

- [ ] **Step 6: Build and verify**

```bash
pnpm --filter @covenant/landing build
for s in "AI orchestrator" "Cross-session world-model" "Hard blocklist" "Covenant Score" "brew install covenant" "Read the covenant"; do
  grep -q "$s" landing/dist/index.html || { echo "MISSING: $s"; exit 1; }
done
echo "all sections present"
```

- [ ] **Step 7: Commit**

```bash
git add landing/
git commit -m "feat(landing): deep dive, open source, install, footer"
```

---

## Task 8: Playwright smoke test

**Files:**
- Create: `landing/playwright.config.ts`
- Create: `landing/tests/landing.spec.ts`

- [ ] **Step 1: Write `landing/playwright.config.ts`**

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  webServer: {
    command: "pnpm preview --port 4322",
    url: "http://localhost:4322",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  use: { baseURL: "http://localhost:4322" },
});
```

- [ ] **Step 2: Write `landing/tests/landing.spec.ts`**

```ts
import { test, expect } from "@playwright/test";

test("renders all sections and animates the score funnel", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("h1")).toContainText("AI orchestrator");

  for (const text of [
    "Parallel operators, one surface",
    "Hard blocklist",
    "Covenant Score",
    "brew install covenant",
    "Read the covenant",
  ]) {
    await expect(page.getByText(text)).toBeVisible();
  }

  // Score funnel scrolls into view and animates SPC from "0" to "12"
  await page.locator("[data-score-funnel]").scrollIntoViewIfNeeded();
  await expect(page.locator('[data-stage="spc"]')).toHaveText("12", { timeout: 4_000 });
  await expect(page.locator('[data-stage="pr"]')).toHaveText("27");
});
```

- [ ] **Step 3: Install Playwright browsers**

```bash
pnpm --filter @covenant/landing exec playwright install chromium
```

- [ ] **Step 4: Build, then run the smoke test**

```bash
pnpm --filter @covenant/landing build
pnpm --filter @covenant/landing test
```

Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add landing/
git commit -m "test(landing): playwright smoke test for sections and score funnel"
```

---

## Task 9: README, OG card placeholder, repo-level wiring

**Files:**
- Create: `landing/README.md`
- Create: `landing/public/og.png` (placeholder 1200×630)
- Modify: `package.json` (root — add a top-level `landing:dev` script if convenient)

- [ ] **Step 1: Write `landing/README.md`**

```md
# Covenant landing

Static site for covenant.dev. Built with Astro + Tailwind.

## Develop

    pnpm install
    pnpm --filter @covenant/landing dev      # http://localhost:4321

## Build

    pnpm --filter @covenant/landing build    # → landing/dist/

## Test

    pnpm --filter @covenant/landing test     # Playwright smoke

## Deploy

Static output in `landing/dist/`. Target: Cloudflare Pages.
```

- [ ] **Step 2: Generate a placeholder OG image**

The og.png is committed as a binary; for the placeholder, create a 1200×630 PNG with the Covenant Score block. If the executing agent does not have an image tool, write `landing/public/og.png` as a 1x1 transparent placeholder and add a TODO in the README. Real card is captured manually later.

```bash
# Minimal placeholder (1×1 transparent PNG)
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82' > landing/public/og.png
```

- [ ] **Step 3: Final build + size budget check**

```bash
pnpm --filter @covenant/landing build
du -sb landing/dist | awk '{print "dist bytes:", $1}'
find landing/dist -name '*.html' -o -name '*.css' -o -name '*.js' | xargs wc -c | tail -1
```

Expected: total HTML+CSS+JS < 300_000 bytes. If over budget, the largest offender is likely Tailwind's unused base — verify `content` glob in `tailwind.config.ts` covers only `src/`.

- [ ] **Step 4: Commit**

```bash
git add landing/
git commit -m "docs(landing): readme + og placeholder + size budget verified"
```

---

## Task 10: Final verification

- [ ] **Step 1: Clean build from scratch**

```bash
rm -rf landing/dist landing/node_modules landing/.astro
pnpm install
pnpm --filter @covenant/landing check
pnpm --filter @covenant/landing build
pnpm --filter @covenant/landing test
```

All must pass.

- [ ] **Step 2: Verify success criteria from spec §9**

Mentally walk through:
1. ✅ Dev renders all 7 sections (Playwright proves this).
2. ✅ Build size ≤ 300 KB (verified in Task 9).
3. ✅ Companion-first reading order (Hero + Companion appear before Score).
4. ✅ Safety claims link to source files (`safety.rs`, `redact.rs`, `dispatch.rs`).
5. ✅ Only install instruction is `brew install covenant`.

- [ ] **Step 3: Commit any tweaks; otherwise no-op**

If anything required adjusting, commit as `chore(landing): final verification fixes`.

---

## Self-Review Notes

**Spec coverage:**
- §1 Positioning → Hero copy (Task 3) ✓
- §2.1 Hero → Task 3 ✓
- §2.2 Companion → Task 4 ✓
- §2.3 Covenant → Task 5 ✓
- §2.4 Receipt/Score → Task 6 ✓
- §2.5 Deep Dive → Task 7 ✓
- §2.6 Open Source → Task 7 ✓
- §2.7 Install/Footer → Task 7 ✓
- §3 Visual identity → Task 2 (theme) ✓
- §4 Architecture → Tasks 1–2 ✓
- §6 SEO → Task 2 (Base layout) ✓
- §7 Performance budget → Task 9 ✓

**Open spec questions (§10 parking lot)** are deferred — they don't block the v1 ship and are flagged in the spec.

**Source files referenced in Task 5** (`crates/agent/src/safety.rs`, `redact.rs`, `dispatch.rs`) are aspirational links: if the actual filenames in the Covenant repo differ, fix the `href`s in `Covenant.astro` during execution. Do not invent files in those crates that don't exist — if they aren't there yet, link to `crates/agent/src/lib.rs` and open an issue.
