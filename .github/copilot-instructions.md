<!-- canon:start -->
# Canon context (auto-generated — do not edit inside this block)

## hyperframes-animation v0.0.0

---
name: hyperframes-animation
description: "All animation knowledge for HyperFrames — atomic motion rules, multi-phase scene blueprints, scene transitions, broader motion-design techniques, AND the seven runtime adapters (GSAP default, plus Lottie, Three.js, Anime.js, CSS keyframes, Web Animations API, TypeGPU). Use for any motion or animation task: pick 2-4 rules and compose, or load a blueprint, or look up runtime-specific API (e.g. GSAP eases / Lottie player / Three.js mixer). HyperFrames-native: single paused timeline, seek-safe, deterministic."
---

# HyperFrames Animation

All motion knowledge in one skill: **rules** (atomic recipes), **blueprints** (multi-phase scene templates), **transitions** (scene-to-scene), **techniques** (broader motion-design patterns), and **adapters** (per-runtime APIs).

For the composition contract (data attributes, sub-compositions, determinism) see `hyperframes-core`.

## Default: compose atomic rules

Pick 2-4 rules from `rules-index.md`, glue them together with a single paused GSAP timeline, done. This is faster and produces less code than starting from a blueprint.

## Load a blueprint when

- The scene matches an existing pre-designed multi-phase template (brand-reveal, social-proof, etc.) and reusing its phase pipeline saves real authoring time
- You want runnable ground-truth code for a complex 4-5 phase choreography

Blueprints live in `blueprints-index.md`. Each entry points to `blueprints/<id>.md` (recipe). Do not read it speculatively; load it when you've already decided you need scene-level orchestration.

## Routing

| Want to…                                                                       | Read                                                |
| ------------------------------------------------------------------------------ | --------------------------------------------------- |
| Pick an atomic motion pattern by trigger / tag                                 | `rules-index.md`                                    |
| Read one rule's full HTML / CSS / GSAP recipe                                  | `rules/<name>.md`                                   |
| Pick a multi-phase scene template                                              | `blueprints-index.md`                               |
| Read one blueprint's full recipe                                               | `blueprints/<id>.md`                                |
| Author a scene transition (CSS-driven, between two clips)                      | `transitions/overview.md`, `transitions/catalog.md` |
| Look up a broader motion-design technique                                      | `techniques.md`                                     |
| Analyze an existing composition's animation map                                | `scripts/animation-map.mjs`                         |
| GSAP API — timeline / tweens / position parameters                             | `adapters/gsap.md`                                  |
| GSAP — drop-in effect recipes                                                  | `rules/gsap-effects.md`                             |
| GSAP — transforms / perf                                                       | `adapters/gsap-transforms-and-perf.md`              |
| GSAP — eases / stagger                                                         | `adapters/gsap-easing-and-stagger.md`               |
| GSAP — timeline / labels                                                       | `adapters/gsap-timeline-and-labels.md`              |
| Lottie / dotLottie (After Effects exports, `window.__hfLottie`)                | `adapters/lottie.md`                                |
| Three.js / WebGL (3D scenes, `AnimationMixer`, `hf-seek`)                      | `adapters/three.md`                                 |
| Anime.js (`window.__hfAnime`)                                                  | `adapters/animejs.md`                               |
| CSS keyframes (`animation-delay` / `play-state` / `fill-mode`)                 | `adapters/css-animations.md`                        |
| Web Animations API (`element.animate()`, `currentTime` seek)                   | `adapters/waapi.md`                                 |
| TypeGPU / WebGPU (`navigator.gpu`, WGSL, compute pipelines)                    | `adapters/typegpu.md`                               |
| HTML-as-texture + WebGL/GLSL post-fx (capture live DOM via `drawElementImage`) | `adapters/html-in-canvas-patterns.md`               |
| Named text-animation effects (24 IDs via external `animate-text` skill)        | `adapters/animate-text.md`                          |

## Picking a runtime

- **GSAP** is the default for 95% of motion work — covers timeline orchestration, transforms, easing, stagger. All atomic rules in this skill are GSAP-based.
- **Lottie** when an asset has its own pre-baked timeline (typically After Effects exports).
- **Three.js** for 3D scenes, camera motion, shader-driven visuals.
- **Anime.js** for lightweight tweening when GSAP is overkill.
- **CSS** for simple repeated motifs, decoration, shimmer — no JavaScript animation cost.
- **WAAPI** for native browser keyframes without a GSAP dependency.
- **TypeGPU / WebGPU** for GPU-rendered canvases (particles, liquid glass, custom shaders).

Multiple runtimes can coexist in one composition. Each registers its instances on the runtime-specific global so HyperFrames can seek all of them in one pass.

## Critical Constraints

**Prerequisite: `hyperframes-core` → Non-Negotiable Rules** (single paused timeline, `data-duration` governs length, no `Math.random` / `Date.now` / `performance.now`, no `repeat: -1`, no `gsap.set` on later-scene clips, no `display` / `visibility` animation, no timeline construction inside `async` / `setTimeout` / `Promise`). Don't restate those here.

Animation-craft additions on top of core's contract:

- **Pre-calculated layout constants** — never derive positions from `getBoundingClientRect()` at tween time. Tween-time DOM measurements desync because the renderer samples in parallel; compute coordinates once at composition setup and reuse.
- **Spatial motion uses GSAP transform aliases only** (`x`, `y`, `scale`, `rotation`). Core's allowlist also permits `opacity` / `color` / `backgroundColor` / `borderRadius` for non-spatial property tweens — but never `width` / `height` / `top` / `left` for layout changes.

## Scripts

```bash
node skills/hyperframes-animation/scripts/animation-map.mjs <composition-dir> \
  --out <composition-dir>/.hyperframes/anim-map
```

Reads every GSAP timeline registered on `window.__timelines`, enumerates tweens, samples bboxes, computes flags, outputs `animation-map.json`. Use it to audit choreography (dead zones, stagger consistency, lifecycle warnings) after authoring.

`animation-map.mjs` resolves helper packages from the current project first, then can bootstrap the bundled HyperFrames package version. Set `HYPERFRAMES_SKILL_PKG_VERSION=<version>` only when running the skill outside the bundled CLI/skill install and you need to pin that bootstrap version explicitly.

## See Also

- `hyperframes-core` — composition structure, data attributes, sub-compositions, deterministic render contract
- `hyperframes-creative` — palettes, typography, narration, beat planning (non-animation creative direction)
- `hyperframes-cli` — `npx hyperframes lint / validate / inspect / preview / render`

## horizon v0.0.0

---
name: horizon
description: Cut a Covenant release end-to-end -> bump version, write CHANGELOG, commit, tag, and push to trigger macOS and Windows release workflows. Use when the user asks to run the horizon release ritual or cut a release.
---

# Horizon — Covenant release ritual

You are running the **horizon** release skill for Covenant. Execute the full
ritual end-to-end **without asking for confirmation**. The user wants this
fully autonomous.

## Arguments

- Skill arguments after `/skill:horizon` are the bump kind: `patch` (default),
  `minor`, or `major`.
- If no argument is supplied, or if the argument is anything else, treat it as
  `patch`.

## Steps (do them in order, in a single sequence)

### 0. Commit current WIP on main

Before the release check, take everything currently present on `main` and save
it as a normal commit so the release includes the latest work.

Run:

- `git branch --show-current` — must be `main`. If not, **STOP** and report:
  "Not on main — switch to main, then re-run /skill:horizon."
- `git status --porcelain`

If status is dirty (modified, deleted, staged, or untracked files):

1. Inspect enough context to write a useful Conventional Commit message:
   - `git diff --stat`
   - `git diff --cached --stat`
   - `git diff -- <paths>` for the changed files when needed
2. Commit all WIP:
   ```bash
   git add -A
   git commit -m "<type(scope): concise WIP summary>"
   ```

Use the most specific Conventional Commit type/scope you can infer from the
changes. Do **not** use `--no-verify`. If the commit fails, stop and report the
failed command verbatim. If status is clean, continue.

### 1. Read current release state

Run these in parallel:

- `git status --porcelain` — must be **clean** after the WIP commit step (only
  ignored files OK). If dirty remains, **STOP** and tell the user:
  "Working tree still dirty after WIP commit — fix it, then re-run /skill:horizon."
- `git tag --sort=-v:refname | head -1` — last release tag (e.g. `v0.5.6`).
- `grep '^version' Cargo.toml` — workspace version (source of truth).

### 2. Compute next version

From the workspace version `MAJOR.MINOR.PATCH`, apply the bump:

- `patch` → `MAJOR.MINOR.(PATCH+1)`
- `minor` → `MAJOR.(MINOR+1).0`
- `major` → `(MAJOR+1).0.0`

Call this `$NEXT` (e.g. `0.5.7`). The git tag will be `v$NEXT`.

### 3. Collect commits since last tag

```bash
git log <last-tag>..HEAD --pretty=format:'%h %s'
```

Skip merge commits and any commit whose subject starts with `chore(release):`.

### 4. Generate the one-line summary

From those commits, infer **what shipped** in this release. The summary
is for the CHANGELOG header and the commit message — keep it to ~6–10
words, no trailing period. Examples from prior releases:

- "Windows launch fix (pwsh help banner)"
- "Horizontal tab bar overflow scroll"
- "Capabilities auto-context + tab/group drag polish"

Focus on the most user-visible change. If there are multiple unrelated
changes, pick the highest-impact one and append "+ polish" or similar.

### 5. Generate the CHANGELOG entry

Prepend a new section to `CHANGELOG.md` directly after the line
`Removed**.` (i.e. above the current top-most version section). Format:

```markdown
## v$NEXT — <one-line summary>

### <Fixed | Added | Changed>

- **<short title>**: <1–3 sentences explaining the change and the
  affected files in backticks>.

- **<next item>**: ...
```

Group bullets by Conventional Commit type:

- `fix:` / `bug:` → **Fixed**
- `feat:` / `add:` → **Added**
- `refactor:` / `chore:` / `perf:` / `docs:` / `style:` → **Changed**

Use the section headers in the order **Added → Changed → Fixed**, omitting
any empty group.

Each bullet should be **substantive** — read the diff for the relevant
commits with `git show <hash> --stat` (or `git log -p <hash>` for small
ones) to write a meaningful description, not just echo the commit subject.
Reference file paths in backticks like prior entries do.

### 6. Bump version in all manifests

Update these files to `$NEXT`:

- `Cargo.toml` — the `[workspace.package] version = "..."` line
- `package.json` — root `"version"` field
- `crates/app/tauri.conf.json` — `"version"` field

After editing, run `cargo check -p covenant` to make sure Cargo.lock
gets refreshed. If lock changes, that's expected — it'll go in the commit.

### 7. Commit

```bash
git add CHANGELOG.md Cargo.toml Cargo.lock package.json crates/app/tauri.conf.json
git commit -m "chore(release): v$NEXT — <one-line summary>"
```

No Claude Code coauthor trailer for release commits — match prior style.

### 8. Tag

```bash
git tag v$NEXT
```

### 9. Push

```bash
git push origin main
git push origin v$NEXT
```

The tag push triggers `.github/workflows/release-macos.yml` and
`release-windows.yml` (both gated on `tags: ['v*']`).

### 10. Report back

Output a short summary to the user:

```text
Released v$NEXT — <one-line summary>

CHANGELOG: <N> bullets across <Added/Changed/Fixed>
Tag pushed: v$NEXT → macOS + Windows workflows running
Watch: gh run list --workflow=release-macos.yml --limit 1
```

## Hard rules

- **Never** push if the WIP commit step failed or if the working tree remains
  dirty after step 0.
- **Never** skip hooks (no `--no-verify`).
- **Never** force-push or amend.
- **Never** push without the tag, or the tag without main.
- If any step fails, stop and report the failure verbatim with the command
  that failed — do **not** try to "recover" by reverting the bump.

## motion-graphics v0.0.0

---
name: motion-graphics
description: >
  Use when the user wants a short, design-led motion graphic where motion is the
  message: kinetic typography, stat or number count-up, chart/data-viz hit,
  logo sting, brand lockup, lower-third, callout, social overlay, animated
  headline/tweet/news item, motion poster, or quick captured-page highlight.
  Usually under 10s and up to ~30s, with no narration arc, voice-over, or
  live-action subject. Can render to MP4 or transparent overlay. Not for longer,
  multi-scene, narrated, or brand-reel pieces (use general-video), narrated
  website videos (website-to-video), topic explainers
  (faceless-explainer), product promos (product-launch-video), PR videos
  (pr-to-video), or captions on existing footage (embedded-captions). When unsure whether it's a
  quick motion-first piece or a longer / narrated treatment, see /hyperframes.
metadata:
  {
    "tags": "orchestrator, motion-graphics, kinetic-type, data-viz, logo-reveal, lower-thirds, news, tweet, webpage, asset-fusion, short-form, overlay, no-narration",
  }
---

# motion-graphics — dispatch entry

> **Confirm the route before Step 0.** This skill makes a **short, design-led, unnarrated motion graphic** (motion is the message; ~under 10s, no voice-over). A **longer, multi-scene, or narrated** treatment → `/general-video`; a **narrated video of a website** → `/website-to-video`; a **topic explainer** → `/faceless-explainer`; a **product promo** → `/product-launch-video`; **captions on existing footage** → `/embedded-captions`. **Out of scope**: live / at-render-time data, or footage it can't capture. Unsure motion-first-vs-narrated? **Read `/hyperframes` first.**

A short design-led motion graphic. **Asset-first**: decide the asset strategy and source real material _before_ designing the shot, then design the shot around what you have, then compose by reusing catalog capabilities. All artifacts go to `PROJECT_DIR = videos/<project-name>/` (created in Step 0); all paths below are relative to it.

| Phase    | Execution                                                             | Primary artifact                                                 | Detailed flow                 |
| -------- | --------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------- |
| init     | Bash                                                                  | `hyperframes.json`                                               | Step 0                        |
| plan     | subagent — **decide search?** + classify + asset strategy             | `shot-plan.json` (draft: category, `asset_needs` queries, brief) | `agents/director.md` (Part 1) |
| source ◇ | Bash — media-use resolve (**skip if `asset_needs` is empty**)         | `assets/` + `assets/index.md`                                    | `phases/source/guide.md`      |
| design   | subagent — shot design around resolved assets                         | `shot-plan.json` (final: block(s) + layout + motion + positions) | `agents/director.md` (Part 2) |
| build    | subagent — reuse-first composition                                    | `compositions/index.html`                                        | `agents/builder.md`           |
| render   | Bash — `hyperframes render` (MP4, or `--format webm/mov` for overlay) | `renders/video.mp4`                                              | Step 5                        |
| verify   | Bash — `lint` / `inspect` -> repair subagent on failure               | (fixes in place)                                                 | `agents/finalize.md`          |

`◇ source` runs only when the chosen category declares assets. Pure code/text categories (e.g. `kinetic-type`, most `charts`/`stat`) have `asset_needs: []` and skip straight from plan to design.

## Categories — split by the search decision

`plan`'s **first decision is: does this need a search?** That fork splits the categories into two groups; then the specific category is picked — for search-driven, **by the type of content the search returns**. Each category is one `categories/<id>/module.md` (its planning + build rules); the shared motion vocabulary lives in `references/motion-vocabulary.md` (→ `hyperframes-animation` rules/blueprints + registry blocks).

**Form categories — no search; the user supplies the content:**

| Category       | Intent                                         | Leans on                                                                    |
| -------------- | ---------------------------------------------- | --------------------------------------------------------------------------- |
| `kinetic-type` | punchy line / quote / title, motion-first text | `caption-*` blocks + animation rules                                        |
| `stat`         | single hero number / count-up + ring           | `apple-money-count` / `rules/{counting-dynamic-scale, stat-bars-and-fills}` |
| `charts`       | bar / line / pie / race / % from data          | `data-chart` block                                                          |
| `logo-reveal`  | logo sting / brand lockup (user logo)          | `logo-outro` / `rules/svg-path-draw`                                        |
| `lower-thirds` | name / title bars, callouts, social overlays   | `caption-*` + registry overlay blocks                                       |

**Search-driven categories — search first, then animate by content type** (the RWA path):

| Returned content | Category       | Animation                                                      |
| ---------------- | -------------- | -------------------------------------------------------------- |
| webpage / link   | `webpage`      | webpage / UI animation (scroll, reveal, cursor, callouts)      |
| news article     | `news`         | headline reveal + source card + key-fact callouts              |
| tweet            | `tweet`        | animated tweet card                                            |
| image / entity   | `asset-fusion` | the asset's geometry _becomes_ the chart (RWA diegetic fusion) |

Build order: one at a time, coverage-first (rough is fine). `kinetic-type` ported from the prototype; the rest follow.

## Prerequisites

macOS Apple Silicon or Linux x64. System tools: `brew install node ffmpeg`. `npx hyperframes doctor` once. macOS GPU render: `export PRODUCER_BROWSER_GPU_MODE=hardware`.

Optional keys (local fallbacks if unset) — only needed by categories that source/generate assets via media-use:

| Key                                 | Used for                                                    | Fallback                        |
| ----------------------------------- | ----------------------------------------------------------- | ------------------------------- |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | image generation (media-use resolve)                        | skip generate / search-only     |
| (asset_scout / search providers)    | `webpage`/`news`/`tweet` + `asset-fusion` real-asset search | category degrades to asset-free |

## Flow

### Step 0 — Initialize

cwd is the agent workspace root; write all artifacts under `PROJECT_DIR = videos/<project-name>/`. `<project-name>`: use the dir the user gave, else a short kebab-case name from the intent (`<subject>-motion`). Not the workspace basename or a timestamp.

Only when `$PROJECT_DIR/hyperframes.json` is absent:

```bash
PROJECT_DIR="${MOTION_GRAPHICS_DIR:-videos/<project-name>}"
mkdir -p "$(dirname "$PROJECT_DIR")"
npx hyperframes init "$PROJECT_DIR" --non-interactive --example=blank
```

`init` checks the installed skills against the latest on GitHub and updates the global set if any are out of date.

**Constraints:** never `hyperframes init` in the workspace root; never nest another `hyperframes/` inside `PROJECT_DIR`; every Bash command (master + subagents) is a `(cd "$PROJECT_DIR" && ...)` subshell — never bare `cd`.

### Step 1 — Plan (subagent: Director Part 1)

Dispatch one subagent. prompt = full `agents/director.md` + `## Dispatch context` (`SKILL_DIR` / `PROJECT_DIR` / the user's request / `Schema: <SKILL_DIR>/references/shot-plan-ir.md`). It must:

1. **Decide: does this need a search?** (the first fork)
   - **No** → pick a **form category** (kinetic-type / stat / charts / logo-reveal / lower-thirds); content is user-supplied; `asset_needs: []`.
   - **Yes** → emit a **search plan** into `asset_needs[]` (news / web / tweet / image; two-pole queries). The specific **search-driven category** (webpage / news / tweet / asset-fusion) is confirmed by the content type returned in Step 2, and finalized in Step 3.
2. Write a draft `shot-plan.json` (envelope + chosen form category _or_ search intent + `asset_needs` + a one-paragraph shot brief). Schema: `references/shot-plan-ir.md`.

Validation: `[ -s "$PROJECT_DIR/shot-plan.json" ] && echo ok || echo missing`.

### Step 2 — Source ◇ (Bash: media-use, conditional)

If `shot-plan.json.asset_needs` is non-empty, resolve assets (search / generate / fetch → frozen project-local paths + ledger). See `phases/source/guide.md` (wraps `media-use resolve`; the search-driven categories use the news/web/tweet/image search). If `asset_needs` is empty, **skip to Step 3**.

```bash
# illustrative — see phases/source/guide.md
(cd "$PROJECT_DIR" && node <SKILL_DIR>/phases/source/resolve.mjs --plan ./shot-plan.json --out ./assets)
```

Degrade gracefully: if a search/provider is unavailable, the category falls back to asset-free (note it in `context.log`).

### Step 3 — Design (subagent: Director Part 2)

Dispatch a subagent (prompt = `agents/director.md` Part 2 + dispatch context including the resolved `assets/index.md` if Step 2 ran + `catalog-map.md`). It designs the shot **around the available assets**: pick the catalog block(s) + the `hyperframes-animation` rules/blueprints, the layout, the motion, beats, and (for `asset-fusion`) the `element_positions` + eyedropper palette. Finalizes `shot-plan.json` (`content.block` + `content.customize` + per-category content).

### Step 4 — Build (subagent: Builder, reuse-first)

Dispatch a subagent. prompt = full `agents/builder.md` + dispatch context (`shot-plan.json`, `catalog-map.md`, the category's `module.md`, `references/motion-vocabulary.md`, `references/builder-contract.md`). **Reuse-first**: `npx hyperframes add <block>` + customize in place; hand-author only gaps + the asset-fusion affordance. Output `compositions/index.html` honoring the HF contract (paused GSAP timeline on `window.__timelines`, `class="clip"` + stable ids, `tl.seek(0)`, deterministic).

### Step 5 — Render (Bash)

```bash
(cd "$PROJECT_DIR" && npx hyperframes render . --skill=motion-graphics -q draft -o ./renders/video.mp4)
# transparent overlay variant: --format webm  (or mov)
```

### Step 6 — Verify (Bash → repair subagent on failure)

```bash
(cd "$PROJECT_DIR" && npx hyperframes lint . && npx hyperframes inspect .)
```

exit 0 → done. On lint/inspect errors, dispatch the repair subagent (`agents/finalize.md`: snapshot QA + one in-place fix pass + re-render). Never change a fixed duration in repair.

### Report + optional preview

Report the final output (`renders/video.mp4`, or the `.webm` / `.mov` overlay variant) + duration. **Don't open a preview during the run.** Offer one only on request, started **after** render so it serves the final file:

```bash
(cd "$PROJECT_DIR" && npx hyperframes preview)   # Studio UI; or `npx hyperframes play` for a shareable link
```

Flags live in the `hyperframes-cli` skill (`references/preview-render.md`).

## Resume table

| State                                                    | Continue from            |
| -------------------------------------------------------- | ------------------------ |
| no `shot-plan.json`                                      | Step 1 (plan)            |
| `shot-plan.json` has `asset_needs`, no `assets/`         | Step 2 (source)          |
| `shot-plan.json` final, no `compositions/index.html`     | Step 3/4 (design+build)  |
| `compositions/index.html` exists, no `renders/video.mp4` | Step 5 (render) + Step 6 |
| `renders/video.mp4` exists                               | Report + stop            |

## Design notes (maintainers — execution does not read this)

- **Asset-first rationale:** sourcing is front-loaded and informs shot design (the RWA flow: analyze → search → review → compose). the search-driven categories (`webpage`/`news`/`tweet`) and `asset-fusion` both lean on media-use search (news/web/tweet/image), which is media-use's documented RWA lineage.
- **Reuse-first:** the in-ecosystem analog of LLM-generated templates is "compose catalog blocks + `hyperframes-animation` rules". HF's paused GSAP timeline ≙ Remotion's `useCurrentFrame`.
- **Category module contract:** one `categories/<id>/module.md` (planning + build), sharing `references/motion-vocabulary.md` (+ optional eval). Adding a category = drop the folder + register its classifier line in `agents/director.md` + its row in `catalog-map.md`; the phase pipeline is untouched.
- **Directory shape:**
  ```
  videos/<project-name>/
    hyperframes.json  context.log
    shot-plan.json            # the IR (Director output)
    assets/  assets/index.md  # media-use output (if sourced)
    compositions/index.html   # Builder output
    renders/video.mp4
  ```
- **Registration:** in `hyperframes` router — add the "design-led short motion graphic" intent + Workflow description; carve the motion-graphics triggers out of `/general-video`; add reverse Do-NOT-use edges. See `motion-graphics-genre.md` §5-7.

## verify v0.0.0

---
name: verify
description: Verify Covenant UI changes live in the dev app autonomously — DOM-dump recipe (boot snippet + local HTTP listener) driving the real code path from the boot scope.
---

# Covenant in-app verify (DOM dump)

Synthetic input is impossible (osascript blocked, no Accessibility). Verify by
running the dev app with a `// TEMP-VERIFY` boot snippet that exercises the
feature and POSTs DOM state to a local listener. **Always revert the snippet
(and any config change) after.**

## Recipe

1. **No identifier change needed.** `crates/app/tauri.dev.conf.json` already
   sets `com.karluiz.covenant.dev`, so `tauri-plugin-single-instance` lets the
   dev build run beside prod, with its own app-data dir. That dir is a fresh,
   unconfigured install (no API keys, no providers) — seed what your probe
   needs via the api.ts wrappers. The keychain token IS shared, so
   `canonMyOrgs()` may still succeed with the demo account's orgs.
   (Historical: before `tauri.dev.conf.json` existed, verify runs had to
   TEMP-change `identifier` in `tauri.conf.json`. Don't — it breaks the
   side-by-side guarantee.)

2. **Listener:** node HTTP server on `127.0.0.1:43117` writing the POST body to
   a file. MUST answer `OPTIONS` with CORS headers (allow-origin *,
   allow-methods POST, allow-headers content-type) — or skip preflight entirely
   by POSTing **without** a `content-type` header from the snippet (simple
   request). A 0-byte dump file = the preflight hit you and the POST never came.

3. **Snippet:** inject after `const settings = new SettingsPanel(...)` in
   `ui/src/main.ts` (that scope sees `manager`, `mountCanon`, `settings`, all
   api imports). `setTimeout(..., 5000)` after boot. `npx tsc --noEmit -p
   tsconfig.json` before launching — the snippet must type-check.

4. **Launch:** `npm run tauri:dev` in background **with sandbox disabled**
   (sandboxed GUI processes die). Fresh instance has NO active group —
   `mountCanon()` early-returns; construct `CanonPanel` / `CanonCockpitView`
   directly with fake group args instead, and `await panel.refresh()` rather
   than racing timers.

5. **HMR does NOT re-fire the snippet** — hidden/unfocused webview suspends
   timers. After every snippet edit: `pkill -f "target/debug/covenant"` and
   relaunch (incremental rebuild ~1min).

6. **Drive the real path, defang its payload.** Call the production entry point
   (a `manager.*` hook, a panel method) rather than re-implementing its logic in
   the snippet — otherwise you verified the snippet, not the feature. Private
   members are reachable at runtime through a cast, which is fine in a snippet
   you are about to delete. When the path ends in launching something expensive
   or irreversible (an executor, a push, a delete), swap the *payload* first:
   e.g. `upsertSpawn` a temp default spec running `echo` so "start agent"
   exercises every branch without spawning a real agent. Restore the prior
   state at the end of the snippet.

7. **Assert on counts + state, not screenshots.** `document.querySelectorAll(
   ".tab-pane").length` before/after, `tab.groupId`, `pane.cwd`, `pane.executor`
   — POST them as one JSON array of labelled probes. To exercise a "busy" branch,
   set the state directly (`pane.executor = "claude"`) instead of waiting for a
   real process.

8. **Clean up what the run created**, not just the snippet: worktrees and their
   `agent/*` branches (`git worktree remove --force` + `git branch -D` — the
   branch is named `agent/<slug>` while the directory is `agent-<slug>`), temp
   spawn specs, the listener process, and the dev app (`pkill -f
   "target/debug/covenant"`).

9. Org semantics gotcha for assertions: `resolveActiveOrg` falls back to
   `orgs[0]` when no personal org exists — a token with only non-personal orgs
   makes the rail/cockpit default to that org, so personal-bucket operators
   legitimately don't appear. Assign your seeded entity to the active org for
   a positive-render probe.

## hyperframes-keyframes v0.0.0

---
name: hyperframes-keyframes
description: >
  Use when a HyperFrames composition needs seek-safe 2D/3D keyframes, GSAP
  timelines, CSS keyframes, Anime.js, WAAPI, FLIP, paths, masks, SVG morph/draw,
  text trails, cursor demos, 3D depth, or `hyperframes keyframes` diagnostics.
  Don't use for broad scene strategy, brand design, media sourcing, captions, or
  general video planning.
---

# HyperFrames Keyframes

Keyframes are a pose contract: visible states, continuous subject identity, seek-safe runtime, verified pixels.

Use `hyperframes-animation` for broad scene recipes.
Use `hyperframes-cli` for full command docs.
Use `references/keyframe-patterns.md` only when choosing implementation mechanisms, not visual style.

## Procedure

1. Identify the animated subject, visible states, final state, and runtime.
2. Choose the smallest mechanism that proves the prompt. Read `references/keyframe-patterns.md` only if the mechanism is unclear.
3. Author seek-safe keyframes in the declared runtime. Build synchronously and register the runtime instance.
4. Verify with lint, validate, `hyperframes keyframes`, one focused `--shot`, and snapshots at proof times.
5. If proof fails, fix the source keyframes and rerun the smallest failing diagnostic before rendering.

## Contract

- Name the moving subject.
- Name the poses needed to prove the intended motion, including the final state.
- Keyframe visible channels, not hidden helper state.
- Preserve object identity when continuity matters.
- Crossfade only when the intended motion is replacement or dissolve.
- Hold readable or semantic states long enough to see.
- Final frame is part of the animation, not cleanup.
- Do not reset to rest unless requested.
- Do not end on black unless requested.
- If editing a starter scene, preserve layout, copy, assets, colors, and final state unless asked to redesign.

## Runtime Rules

GSAP:

- build synchronously at page load
- use `gsap.timeline({ paused: true })`
- register as `window.__timelines[compositionId]`
- registry key must match `data-composition-id`
- do not call `tl.play()` for render-critical motion
- keep repeats finite

CSS keyframes:

- finite duration and iteration count
- deterministic delay
- `animation-fill-mode: both`
- use `data-start` when timing belongs to a clip

Anime.js:

- create synchronously
- `autoplay: false`
- finite duration and loops
- push every instance to `window.__hfAnime`

WAAPI:

- finite `duration`
- `fill: "both"`
- deterministic construction
- the text surface does not list WAAPI; verify with `--shot` (it seeks WAAPI) and snapshots

Never use for render-critical motion:

- `Date.now()`
- `performance.now()`
- unseeded `Math.random()`
- hover/scroll triggers
- timers
- async-created timelines
- unregistered `requestAnimationFrame`
- infinite loops

## GSAP Skeleton

```js
const root = document.querySelector("[data-composition-id]");
const compositionId = root.dataset.compositionId;
const tl = gsap.timeline({ paused: true });

tl.addLabel("state-a", 0);
tl.to(".subject", {
  keyframes: [
    { x: 0, opacity: 1, duration: 0.2 },
    { x: 120, opacity: 1, duration: 0.4, ease: "power2.out" },
    { x: 100, opacity: 1, duration: 0.2, ease: "power2.inOut" },
  ],
  ease: "none",
});

window.__timelines = window.__timelines || {};
window.__timelines[compositionId] = tl;
```

Use labels for semantic states.
Use position parameters instead of chained delays.
Use `immediateRender: false` for later `from()`/`fromTo()` tweens touching the same property.

## Keyframe Forms

- Array keyframes: pose ladder with per-step duration/ease.
- Percentage keyframes: exact timing inside one tween.
- Property arrays: compact multi-stop changes.
- `ease: "none"` on the parent when each stop carries its own easing.
- `easeEach` when every segment should share the same feel.

Do not copy numeric distances or timing from examples. Derive them from the actual composition geometry and duration.

For one subject moving between two boxes, prefer one continuous transform tween or FLIP. Split `x/y/scale` into multiple eased keyframes only when the viewer should feel distinct beats; every segment changes velocity and can read as a hitch.

## Channels

Prefer compositor/visual channels:
`x/y/z`, `xPercent/yPercent`, `scale`, `rotationX/Y/Z`, `skew`, `transformOrigin`, `svgOrigin`, `opacity`, `autoAlpha`, `clip-path`, masks, CSS vars, SVG path/dash values, camera transforms, shader uniforms.

Avoid layout/lifecycle channels:
`top/left/right/bottom`, `width/height`, `margin/padding`, `display`, `visibility`, late DOM creation, helper overlays doing subject motion.

## Mechanism Choice

Choose the smallest mechanism that proves the prompt:

| Need                                  | Mechanism                                          |
| ------------------------------------- | -------------------------------------------------- |
| Same subject changes box or hierarchy | shared element / FLIP                              |
| Subject travels a visible route       | path travel                                        |
| Stroke grows or traces                | stroke draw                                        |
| Shape becomes another shape           | shape interpolation                                |
| Reveal boundary is visible            | clip, mask, or shader uniform                      |
| Many items move with order            | stagger / indexed delay                            |
| Text itself moves                     | line, word, character, or band subdivision         |
| Surface bends, stretches, or crops    | parent/child counter-transform                     |
| UI has states                         | explicit state machine                             |
| Scene has depth                       | DOM 3D, Three.js, or WebGL camera/object keyframes |

Mechanisms can combine, but each one must clarify the idea. Decoration is not proof.

## Timing

- Anticipation only when it clarifies cause or direction.
- Acceleration leaves rest.
- Peak proof shows the mechanism unmistakably.
- Follow-through sells energy and direction.
- Overshoot only when the subject should feel elastic or tactile.
- Constant-speed path travel usually needs `ease: "none"`.
- Discrete UI states usually need a sharp ease-out.
- Repeated elements need ordered offsets, not identical timing.
- Final lockups need longer holds than transition poses.
- Smoothness means continuous velocity on the same subject.
- Do not overlap tweens that write the same transform property unless the overlap is intentional and verified.
- Avoid animating large `clip-path`/mask changes while the same hero surface is also scaling or traveling; use nested reveals after the main move settles.

## Text

Preserve line boxes, word spacing, readability, and final fit. If text moves internally, move the glyphs or masked bands, not only decorations around the text. Snapshot readable frames.

## SVG

For stroke growth prefer `DrawSVGPlugin`, then `stroke-dasharray`/`stroke-dashoffset`.
For shape interpolation prefer `MorphSVGPlugin`; convert primitives to paths when needed and split complex silhouettes into simpler parts.

## 3D

Scale alone is fake depth.
Use perspective on a stable parent, `transform-style: preserve-3d`, z travel, rotation, camera/world motion, occlusion, and layer order when objects cross.

Use one or two diagnostic angles that expose the depth relationship. If angled proof shows no depth crossing, improve z/camera/occlusion.

## Canvas / WebGL

Keyframe camera position, camera target, object transform, material opacity, shader uniforms, and postprocess intensity through deterministic state. Render from HyperFrames time. Use `--ghost` because marker boxes cannot see internal canvas motion.

## CLI Proof

```bash
npx hyperframes lint
npx hyperframes validate
npx hyperframes keyframes .
npx hyperframes keyframes . --json
npx hyperframes keyframes . --runtime all
npx hyperframes keyframes . --selector "<selector>" --shot "<file>" --samples <n>
npx hyperframes keyframes . --selector "<selector>" --shot "<file>" --layout strip --from <t0> --to <t1>
npx hyperframes keyframes . --shot "<file>" --ghost --angle <angle>
npx hyperframes snapshot . --at <times>
```

Choose `<selector>` for the real animated subject.
Choose `<times>` for first frame, proof poses, final-minus-hold, and exact final.
Choose `<angle>` only when depth must be proven.

| Tool             | Proves                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| `keyframes`      | targets, explicit stops, paths, traces, composed parent/child motion, CSS stops, Anime registration |
| `--shot`         | ghosts, route shape, time spacing, DOM 3D projection, focused selector proof                        |
| `--layout strip` | in-place motion, overlaps, contact, subtle scale/opacity, text waves                                |
| `--ghost`        | canvas, WebGL, shader motion, rendered 3D                                                           |
| `snapshot --at`  | masks, text readability, full state, final lockup, black/reset tails                                |

If selector proof looks wrong:

1. rerun `--json`
2. find the actual animated target
3. shoot that target
4. snapshot full frames
5. trust painted pixels over logs

## Diagnostic Reading

`flat` means no explicit middle poses. `keyframes` means explicit stops exist. `motionPath` means a route exists. `trace` means multi-stroke drawing. `composed with` means child motion inherits parent motion.

Even ghost spacing means constant speed. Clustered ghosts mean slow-in or settle. Large gaps mean fast travel.

A helper-selector shot is not proof. An onion shot over a broken full frame is not proof.

## Error Handling

| Failure            | Fix                                                                                |
| ------------------ | ---------------------------------------------------------------------------------- |
| endpoint-only      | add middle poses, hold peak proof, rerun `--shot`                                  |
| identity break     | keep one element alive, use shared source/final boxes, remove substitute crossfade |
| fake 3D            | add z/camera travel, occlusion, angled proof                                       |
| wrong final        | add final hold, snapshot final-minus-hold and exact final                          |
| unseekable runtime | pause autoplay, register instance, remove timers, build synchronously              |
| unreadable text    | preserve line boxes, reduce displacement, add final hold, snapshot text frames     |

## Done

Run lint, validate, keyframes, one focused `--shot`, and snapshots. Confirm first frame, proof poses, final-minus-hold, exact final, subject-owned motion, and no debug overlays.

## Memory

- The dev build is a different macOS app than the installed one — separate identifier, separate config, starts unconfigured.
- A 403 from the `gh` CLI on this repo is almost always the wrong active account, not a missing permission.
- A component input that looks right in dark and white-on-white in light is losing to `body.theme-light input`, which is more specific than the component rule.
- CI must cache the cargo registry but never target/ — a Cargo.lock-keyed target cache always misses and hangs the release ~25 minutes on upload.
- In a linked worktree, `git add -A` stages the node_modules symlink and clobbers main's dependencies.
- Two release steps are continue-on-error — a missing HOMEBREW_TAP_TOKEN skips the cask update, and missing SSLCOM_* secrets ship Windows unsigned. Both leave a green build.
- `npm run tauri:dev` failing with exit code 101 usually means target/debug/incremental has grown past 100GB and filled the disk.
<!-- canon:end -->
