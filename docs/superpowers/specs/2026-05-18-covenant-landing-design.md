# Covenant Landing Page — Design

**Status:** Approved (brainstorm)
**Date:** 2026-05-18
**Owner:** karluiz
**Location in repo:** `landing/`

---

## 1. Positioning

**Tagline:** *The terminal that turns you into an AI orchestrator.*

**One-liner:** Covenant is an open-source terminal that lets you run, observe, and intervene on swarms of autonomous operators in parallel — under a code-enforced safety contract — and is the first surface that can honestly measure the new SDLC.

**Audience:** Engineers and engineering leaders running autonomous operators (Claude Code, Codex, custom agents) as a real part of their software lifecycle. They orchestrate, they don't type.

**Anti-positioning (what we explicitly are NOT):**
- "AI in your terminal" / sidebar assistant
- A Warp/iTerm UX replacement
- A chat product
- A closed SaaS

**Open source is the proof, not the pitch.** The covenant guarantees only mean something because the code is auditable. License: MIT + Apache 2.0. No telemetry, no lock-in.

---

## 2. Page Spine — companion first, score as receipt

Eight sections, top to bottom. Each ~one screen tall on desktop.

### §1 · Hero — the companion pitch

- Eyebrow: `COVENANT · OPEN SOURCE`
- Headline: **The terminal that turns you into an AI orchestrator.**
- Sub: *Run swarms of autonomous operators in parallel sessions. See every byte they emit. Intervene at any moment. Ship more, with a contract that makes autonomy survivable.*
- Primary CTA: **Download for macOS**
- Secondary CTA: **★ GitHub**
- Hero visual: real screenshot of Covenant with 4 operator tabs running, agent panel open, Covenant Score chip in the titlebar.

### §2 · The Companion — what it actually gives you

Four pillars, equal weight:

1. **Parallel operators, one surface** — each tab is an isolated PTY. Claude Code, Codex, custom agents run side-by-side, no context bleed.
2. **Cross-session world-model** — the super-agent sees every block in every tab. Connects edits in tab 1 to test failures in tab 2.
3. **Intervene at any moment** — ⌘K to ask "what's going on?" Inline suggestions on non-zero exit. Take the wheel back without breaking the session.
4. **GitHub-native** — commits, PRs, CI signals stream back. Operators are first-class authors on your graph.

### §3 · The Covenant — autonomy with a contract

Sub: *Three code-enforced guarantees. Not vibes, not prompts — Rust functions you can grep.*

1. **Hard blocklist** — `rm -rf`, `sudo`, `curl | sh`, force-pushes to protected branches, writes to `~/.ssh`, fork bombs. Removing entries requires code review.
2. **Secrets masked** — API keys, JWTs, SSH keys, GitHub/AWS tokens, never reach the model.
3. **Cost caps** — per-minute and per-day token ceilings. Single `agent::dispatch()`, no bypass.

Each pillar links to the actual source file in the repo (`crates/agent/src/safety.rs`, etc.) — the "read the code" promise made literal.

### §4 · The Receipt — Covenant Score

Header: **When you can see everything, you can finally measure it.**

Argument: DORA was designed for humans typing. A single orchestrator now ships hundreds of PRs a day; deploy frequency, lead time, and change failure rate stop being signal.

The score has **six dimensions**, displayed in the **D · combo** layout (big number on top, funnel beneath):

```
COVENANT SCORE
   8.4
SPC 12 → PLN 38 → TSK 214 → TOK 4.1M → CMT 412 → PR 27
```

| Dimension | Definition |
|---|---|
| **Specs** | Intent declared. Written by humans, never inferred. |
| **Plans** | Specs decomposed into reviewable steps. |
| **Tasks** | Plan items operators actually executed. |
| **Tokens** | Computational effort spent — the real unit cost. |
| **Commits** | Work produced, with operator attribution. |
| **PRs** | Work integrated. The only outcome that matters. |

Sub-line: *Six dimensions. One number. Compatible with — and an honest replacement for — DORA in the autonomous era.*

### §5 · Deep Dive — see the orchestrator in action

A screenshot grid (or short looping mp4): tabs view, agent panel, score dashboard, PR list annotated with operator attribution and score deltas.

### §6 · Open Source — the proof

Header: **Read the covenant. Read the code.**

Body: *MIT + Apache 2.0. Every safety guarantee is a function you can grep. No telemetry, no SaaS lock-in.*

CTA: **★ Star on GitHub**

### §7 · Install / Footer

```bash
brew install covenant
```

Sub: *macOS today · Windows soon · Linux community*

Links: GitHub, Docs, Changelog, License.

---

## 3. Visual Identity

- **Vibe:** terminal-native, monospaced eyebrow labels, minimal chrome. Closer to Linear/Vercel than to a SaaS landing.
- **Palette:** dark by default (matches the app). Single accent (TBD — likely the Covenant green already used in `ui/`). No gradients except in the Score badge.
- **Typography:** display = a tight geometric sans (Inter Tight / Geist); body = same family; code = the app's terminal font (Berkeley Mono / JetBrains Mono fallback).
- **Motion:** the Score funnel animates once on scroll into §4 (SPC counter ticks up → PLN → ... → PR). Otherwise no scroll-jacking.

---

## 4. Architecture

**Stack:** Astro (static, fast, first-class MDX, zero JS by default) + Tailwind CSS + a couple of small interactive islands (Score animation, copy-to-clipboard for `brew install`).

**Why Astro:**
- Static HTML output → trivially hostable (GitHub Pages, Cloudflare Pages, Vercel)
- Component model without shipping a runtime
- Plays nicely with our existing repo (vanilla TS + Vite for the app; Astro is a sibling, not a sibling-killer)

**Directory layout (under `landing/`):**

```
landing/
├── astro.config.mjs
├── package.json
├── tailwind.config.ts
├── tsconfig.json
├── public/
│   ├── og.png                  # social card
│   ├── favicon.svg
│   └── screenshots/            # hero + deep-dive captures
├── src/
│   ├── pages/
│   │   └── index.astro         # the one page
│   ├── components/
│   │   ├── Hero.astro
│   │   ├── Companion.astro
│   │   ├── Covenant.astro
│   │   ├── Score.astro         # § 4, includes the funnel island
│   │   ├── DeepDive.astro
│   │   ├── OpenSource.astro
│   │   ├── Install.astro
│   │   └── Footer.astro
│   ├── islands/
│   │   └── ScoreFunnel.ts      # the one bit of JS
│   ├── layouts/
│   │   └── Base.astro
│   └── styles/
│       └── globals.css
└── README.md
```

**Build:** `pnpm --filter landing build` → static files in `landing/dist/`.

**Deploy target:** Cloudflare Pages (already familiar from the updater story); GitHub Pages as backup. Domain TBD — assume `covenant.dev` or subdomain of an existing one until the user picks.

**Hosting cost:** zero (Cloudflare Pages free tier).

---

## 5. Content Sources

All copy lives in the section components — no CMS, no MDX-per-section split yet (overkill for a v1 single-pager). The Score numbers in the hero are **hard-coded representative figures** for v1, NOT live data. A future iteration can wire them to a public Covenant instance.

Screenshots are committed to `public/screenshots/` and captured from the actual app (no Figma renders).

---

## 6. SEO / Social

- `<title>`: `Covenant — The terminal for AI orchestrators`
- Meta description: the one-liner from §1.
- OG image: `og.png` — the Covenant Score block on the brand background, plus the tagline.
- Twitter card: `summary_large_image`.
- JSON-LD: `SoftwareApplication` with the GitHub URL as `sameAs`.

---

## 7. Accessibility & Performance Budgets

- Lighthouse: ≥ 95 on Performance, Accessibility, Best Practices, SEO.
- Total page weight: ≤ 300 KB (HTML + CSS + JS, excluding images).
- Largest screenshot: ≤ 200 KB, served as AVIF with WebP fallback.
- No tracking scripts. (If analytics is wanted later, Plausible self-hosted only.)
- Respect `prefers-reduced-motion` — disables the Score funnel animation.

---

## 8. Out of Scope (v1)

- Blog / changelog page (we have `CHANGELOG.md` in repo; link to it).
- Docs site (use README + `docs/` on GitHub for now).
- Pricing / teams page (pure OSS).
- Sign-up / waitlist.
- I18n.
- Dashboards backed by live data.
- Compare-to-Warp/Cursor/Claude-Code page.

These are explicitly deferred. None of them are required to ship a credible v1 landing.

---

## 9. Success Criteria

A v1 ship is successful if:

1. `pnpm --filter landing dev` renders all 7 sections with real copy and at least placeholder screenshots.
2. `pnpm --filter landing build` produces a static bundle ≤ 300 KB (excluding images) that scores ≥ 95 on Lighthouse.
3. The page reads as **companion-first**, with measurement positioned as a consequence — verified by reading §1 and §2 aloud without the Score appearing.
4. Every safety claim in §3 links to the actual source file in the repo.
5. The `brew install covenant` block is the only install instruction on the page.

---

## 10. Open Questions (parking lot)

- Final domain.
- Final accent color (likely the existing Covenant green — confirm against `ui/` tokens).
- Exact screenshots — needs a fresh capture session once Covenant has the score chip in titlebar.
- Whether `brew install covenant` actually resolves at ship time, or if v1 ships with the download `.dmg` only.

These do not block writing the implementation plan; they block the *final* ship.
