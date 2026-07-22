# Tab Chassis Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the tab/group base chrome ("chassis": monochrome rest, color follows focus, dense rows) and shrink each of the 5 tab styles to a single signature move on top of it.

**Architecture:** All group/badge/spine noise lives in `ui/src/styles.css` (the base sheet); theme files fight it with specificity wars. We rewrite the base once, then each theme file becomes a small overlay that only touches the active tab. One tiny TS change (render the group dot + empty-group hook); everything else is CSS. Spec: `docs/superpowers/specs/2026-07-22-tab-chassis-redesign-design.md`.

**Tech Stack:** CSS (design tokens in `:root` of `ui/src/styles.css`), TypeScript (Vitest, jsdom), no new deps.

## Global Constraints

- All fills/hairlines compose from ink: `rgb(var(--ink-rgb) / 0.04)` slash syntax — the comma form is INVALID and silently drops (DESIGN.md rule 13).
- Group color always via `color-mix(in srgb, var(--group-color, var(--accent)) N%, …)` — never the raw color as a fill.
- No new font families (mono stack is `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace`), no emoji, no native tooltips.
- Uppercase via CSS `text-transform`, never string mutation.
- `prefers-reduced-motion: reduce` disables every new animation.
- Existing class names and DOM structure stay (`.tab-btn`, `.group-chip`, `.tab-grouped`, `.tab-group-shell`, `.tab-group-body`, `.tab-lead`, `.tab-caret`) — only their styling changes, plus one new class (`group-chip-empty`) and one newly-rendered span (`.group-chip-dot`).
- Tests: `npm test` runs from repo ROOT (never `ui/`). TS type-check via `npm run build`.
- Commits: Conventional Commits, one per task. Stage files explicitly — never `git add -A` (worktree has a `node_modules` symlink).
- Operator-chip rows: any left-edge active indicator must be suppressed on rows containing `.tab-op-chip-leading` (the avatar sits on that edge) via `:not(:has(.tab-op-chip-leading))`.

---

### Task 1: TS groundwork — render the group dot + empty-group hook

The chassis needs two DOM facts CSS can't derive: a dot element (`.group-chip-dot` is styled today but never created) and a "this group has 0 tabs" marker.

**Files:**
- Modify: `ui/src/tabs/manager.ts:7269-7340` (`renderGroupChip`) and `ui/src/tabs/manager.ts:6761-6781` (in-place count update)
- Test: `ui/src/tabs/manager.test.ts` (append to existing file — it already has the `makeManager()` harness at the top)

**Interfaces:**
- Produces: `.group-chip` DOM now contains `<span class="group-chip-dot">` between the chevron and the label; chips of groups with 0 members carry class `group-chip-empty`. Later CSS tasks rely on exactly these names.

- [ ] **Step 1: Write the failing test**

Append to `ui/src/tabs/manager.test.ts`:

```typescript
describe("group chip chassis hooks", () => {
  it("renders a dot span and marks empty groups with group-chip-empty", () => {
    const m = makeManager();
    m.createEmptyGroup();
    const chip = document.querySelector<HTMLElement>(".group-chip");
    expect(chip).not.toBeNull();
    expect(chip!.querySelector(".group-chip-dot")).not.toBeNull();
    // dot sits after the chevron, before the label
    const children = Array.from(chip!.children).map((c) => c.className);
    expect(children.indexOf("group-chip-dot")).toBeGreaterThan(
      children.findIndex((c) => c.includes("group-chip-chev")),
    );
    expect(chip!.classList.contains("group-chip-empty")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- manager.test`
Expected: FAIL — `.group-chip-dot` query returns null.

- [ ] **Step 3: Implement**

In `renderGroupChip` (manager.ts, right after `chip.appendChild(chevron);` at line ~7297):

```typescript
    // Group identity dot — the ONLY color the chip carries at rest.
    const dot = document.createElement("span");
    dot.className = "group-chip-dot";
    chip.appendChild(dot);
```

In the same function, wherever the chip element's classes are assembled (the `chip` creation near the top of `renderGroupChip`), add:

```typescript
    chip.classList.toggle("group-chip-empty", memberCount === 0);
```

In the in-place update site (manager.ts ~6761-6781, where `countEl.textContent` is refreshed), add beside it:

```typescript
      chip.classList.toggle("group-chip-empty", memberCount === 0);
```

(`chip` there is the element the count/chevron queries run against — match the local variable name in that scope.)

- [ ] **Step 4: Run tests**

Run: `npm test -- manager.test`
Expected: PASS (new test + all pre-existing manager tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/tabs/manager.ts ui/src/tabs/manager.test.ts
git commit -m "feat(tabs): render group-chip dot + group-chip-empty hook for the chassis"
```

---

### Task 2: Chassis — group chip, both layouts

Monochrome rest: label gray, bare mono count, dot carries the color, empty groups dim, the focused group (contains the active tab) lifts its label. Deletes the light-theme `!important` chip overrides and the dark-sidebar "project card" treatment.

**Files:**
- Modify: `ui/src/styles.css` — blocks at :239-260 (theme-light chip), :1411-1456 (`.group-chip` base), :1538-1575 (dot/label/count), :10759-10790 (vertical chip), :10796-10848 (dark-sidebar card block)

**Interfaces:**
- Consumes: `.group-chip-dot` span + `group-chip-empty` class from Task 1.
- Produces: the rest-state chip look every theme inherits. Theme files (Tasks 6-9) must NOT re-style `.group-chip` backgrounds/borders/labels except CRT's font swap.

- [ ] **Step 1: Replace the `.group-chip` base block (styles.css:1411-1456)**

```css
.group-chip {
    position: relative;
    display: flex;
    align-items: center;
    gap: 7px;
    height: 28px;
    padding: 0 10px 0 4px;
    background: transparent;
    border: none;
    border-radius: 0;
    color: var(--tab-fg-rest);
    font-family: var(--ui-font);
    font-size: 10.5px;
    font-weight: 500;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    -webkit-user-drag: none;
    user-select: none;
    cursor: grab;
    transition:
        background 0.12s ease-out,
        color 0.12s ease-out;
}

.group-chip:hover {
    background: rgb(var(--ink-rgb) / 0.04);
    color: var(--text-primary);
}

.group-chip:active {
    cursor: grabbing;
}

/* Color follows focus: the group holding the active tab lifts its label. */
.tab-group-shell:has(.tab-btn.active) .group-chip-label {
    color: var(--text-primary);
}

/* Empty groups recede one more tier. */
.group-chip-empty .group-chip-label,
.group-chip-empty .group-chip-count {
    color: var(--text-tertiary);
}
.group-chip-empty .group-chip-dot {
    opacity: 0.35;
}
```

- [ ] **Step 2: Replace dot/label/count rules (styles.css:1538-1575)**

```css
.group-chip-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--group-color, var(--muted));
    flex-shrink: 0;
}

.group-chip-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 140px;
}

.group-chip-count {
    margin-left: auto;
    font-family:
        ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 10px;
    font-weight: 400;
    letter-spacing: 0;
    text-transform: none;
    font-variant-numeric: tabular-nums;
    color: var(--text-tertiary);
    flex-shrink: 0;
}

.group-chip:not(.group-chip-collapsed) .group-chip-count {
    display: none;
}
```

- [ ] **Step 3: Delete the theme-light chip overrides (styles.css:239-260)**

Remove both `body.theme-light .group-chip` and `body.theme-light .group-chip:hover` blocks entirely — the chassis is ink-composed, light mode needs no `!important` patch. Leave a one-line comment: `/* Group chips are ink-composed — no light-mode override needed. */`

- [ ] **Step 4: Replace the vertical chip + dark-sidebar card blocks**

Replace styles.css:10759-10790 (`body.tabbar-left .group-chip`, shell margin, `group-chip-has-members`) with:

```css
body.tabbar-left .group-chip {
    width: 100%;
    box-sizing: border-box;
    height: 28px;
    min-height: 28px;
    padding: 0 12px 0 6px;
    margin-top: 2px;
}

body.tabbar-left .tab-group-shell {
    margin-right: 12px;
}

body.tabbar-left .group-chip-has-members {
    border-radius: 0;
    margin-bottom: 0;
}
```

Replace styles.css:10796-10848 (the `body.tabbar-left:not(.theme-light)` card block) with only:

```css
body.tabbar-left:not(.theme-light) #tabbar-host {
    background: var(--sidebar-bg);
}
```

(The chip card fill, hover, count, and tree-line-offset rules in that block are deleted — chassis owns them.)

Also delete the base horizontal fused-corner rules at styles.css:1667-1676 (`.group-chip-has-members` + its `body.tabbar-left` override) — chips no longer have borders to fuse. Keep the class on the DOM (renderer still sets it); it just carries no styling outside the vertical block above.

- [ ] **Step 5: Verify**

Run: `npm test` → all green (group-shell/manager/custom-style suites untouched by class renames — none happened).
Run: `npm run build` → type-check + bundle OK.

- [ ] **Step 6: Commit**

```bash
git add ui/src/styles.css
git commit -m "feat(tabs): chassis group chip — monochrome rest, dot-only color, focused lift"
```

---

### Task 3: Chassis — vertical tab rows

26px flat rows; active = ink 0.06 fill + 2px group-color left spine (suppressed on operator rows); hover ink 0.04; the colored tree-line becomes a 1px ink hairline; the ribbon-gradient and dark card active states die.

**Files:**
- Modify: `ui/src/styles.css` — :10613-10641 (vertical `.tab-btn`), :10666-10716 (active states), :10725-10754 (stripe/tree-line), :10850-10867 (dark active card)

**Interfaces:**
- Consumes: nothing new. Produces: `body.tabbar-left .tab-btn.active::before` is the vertical spine slot themes may re-skin (Forge/CRT re-color it; Glass hides it).

- [ ] **Step 1: Replace vertical `.tab-btn` (styles.css:10613-10641)** — same block, changed lines only shown in context; keep the fold-transition list as-is:

```css
body.tabbar-left .tab-btn {
    width: 100%;
    box-sizing: border-box;
    max-width: none;
    min-width: 0;
    height: 26px;
    padding: 0 24px 0 10px;
    border-radius: 0;
    --tab-radius: 0px;
    border: none;
    background: transparent;
    /* Switch the fold animation axis from width → height. */
    transition:
        background 0.12s ease-out,
        color 0.12s ease-out,
        border-color 0.12s ease-out,
        max-height 0.3s cubic-bezier(0.4, 0, 0.2, 1),
        padding-top 0.3s cubic-bezier(0.4, 0, 0.2, 1),
        padding-bottom 0.3s cubic-bezier(0.4, 0, 0.2, 1),
        margin-top 0.3s cubic-bezier(0.4, 0, 0.2, 1),
        margin-bottom 0.3s cubic-bezier(0.4, 0, 0.2, 1),
        border-width 0.3s cubic-bezier(0.4, 0, 0.2, 1),
        opacity 0.22s ease-out;
}

body.tabbar-left .tab-btn:hover:not(.active) {
    background: rgb(var(--ink-rgb) / 0.04);
    border-color: transparent;
    color: var(--text-primary);
}

body.tabbar-left .tab-btn.active {
    background: rgb(var(--ink-rgb) / 0.06);
    border-color: transparent;
    color: var(--tab-fg-active);
}
```

(Note: the `.tab-pill-folded` vertical block at 10643-10660 keeps working — it zeroes heights/margins; border-width resets become no-ops with `border: none`, which is fine. Do not touch it.)

- [ ] **Step 2: Replace the vertical active-::before suppression (styles.css:10666-10668) with the spine**

```css
/* Vertical spine: 2px group/tab color on the active row's left edge.
   Suppressed on operator rows — the avatar owns that edge. */
body.tabbar-left .tab-btn.active::before {
    display: none;
}
body.tabbar-left .tab-btn.active:not(:has(.tab-op-chip-leading))::before {
    display: block;
    top: 0;
    bottom: 0;
    left: 0;
    right: auto;
    width: 2px;
    height: auto;
    border-radius: 0;
    background: var(--tab-stripe, var(--accent));
}
```

- [ ] **Step 3: Replace grouped-member styling (styles.css:10676-10716)**

```css
body.tabbar-left .tab-group-body > .tab-grouped {
    margin-left: 22px;
    width: calc(100% - 26px);
    padding-left: 12px;
    height: 26px;
    min-height: 26px;
    border-radius: 0;
    background: transparent;
    border-color: transparent;
    color: var(--tab-fg-rest);
}
body.tabbar-left .tab-grouped:hover:not(.active) {
    background: rgb(var(--ink-rgb) / 0.04);
    border-color: transparent;
    color: var(--text-primary);
}
body.tabbar-left .tab-grouped.active {
    background: rgb(var(--ink-rgb) / 0.06);
    border-color: transparent;
    color: var(--tab-fg-active);
}
/* Grouped rows inherit the same spine as ungrouped (delete the old
   display:none override at 10714-10716 so the shared rule applies). */
```

Delete `body.tabbar-left .tab-grouped.active::before { display: none; }` (10714-10716) and the dark-mode active card block `body.tabbar-left:not(.theme-light) .tab-grouped.active` + its `.tab-close` sibling (10850-10867).

- [ ] **Step 4: Tree-line → ink hairline (styles.css:10734-10751)**

In the `body.tabbar-left .tab-group-shell:not(.tab-group-shell-collapsed) .tab-group-body::before` rule, change only:

```css
    left: 11px;
    top: 32px; /* chip margin-top (2) + height (28) + 2 breathing room */
    width: 1px;
    background: rgb(var(--ink-rgb) / 0.08);
```

- [ ] **Step 5: Verify**

Run: `npm test` and `npm run build`
Expected: green. (Fold/collapse suites exercise class toggling, not pixel values.)

- [ ] **Step 6: Commit**

```bash
git add ui/src/styles.css
git commit -m "feat(tabs): chassis vertical rows — 26px flat, ink fills, group-color spine"
```

---

### Task 4: Chassis — horizontal tabs + group segments

Flat text tabs (no card borders), active = ink fill + 2px **bottom** underline in group/tab color, groups read as segments separated by an ink hairline.

**Files:**
- Modify: `ui/src/styles.css` — :551-629 (`.tab-btn` base + active ::before), :1463-1495 (group shell/stripe), :1629-1657 (`.tab-grouped` tints)

**Interfaces:**
- Produces: `.tab-btn.active::before` is now the bottom underline in horizontal (themes re-skin it). `.tab-group-stripe` is display:none in the base — themes must not resurrect it.

- [ ] **Step 1: Flatten the horizontal `.tab-btn` (styles.css:551-582)** — change only these declarations inside the existing block (keep layout/transition/font lines):

```css
    background: transparent;
    border: none;
    border-radius: 0;
```

(Remove `border-bottom: none;` — there is no border anymore.) Then:

```css
.tab-btn:hover:not(.active) {
    background: rgb(var(--ink-rgb) / 0.04);
    color: var(--text-primary);
}

.tab-btn.active {
    background: rgb(var(--ink-rgb) / 0.06);
    color: var(--tab-fg-active);
    font-weight: 500;
}

/* Active underline — the tab connects to the terminal below it. */
.tab-btn.active::before {
    content: "";
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    top: auto;
    height: 2px;
    background: var(--tab-stripe, var(--accent));
    border-radius: 0;
}
```

Also check `--tab-bg-rest/--tab-border-rest/--tab-bg-hover/--tab-border-hover/--tab-bg-active/--tab-border-active` token usages that remain (grep them): `.tab-colored` (:712-719) keeps its tint via `color-mix(... 5%, transparent)` — change its base mix target from `var(--tab-bg-rest)` to `transparent` so it composes with the flat chassis; delete its `border-color` line.

- [ ] **Step 2: Group segments (styles.css:1463-1495)**

```css
.tab-group-shell {
    display: flex;
    flex-direction: row;
    align-items: stretch;
    gap: 2px;
    margin: 0 6px 0 0;
    padding-left: 8px;
    border-left: 1px solid rgb(var(--ink-rgb) / 0.07);
}

.tab-group-stripe {
    display: none;
}

.tab-group-body {
    display: flex;
    flex-direction: row;
    align-items: center;
    flex: 0 1 auto;
    min-width: 0;
    gap: 0;
}
```

(Keep `.tab-group-body > * + * { margin-left: 0; }`. The vertical block at 10725-10727 already sets `display:none` for the stripe — now redundant but harmless; delete it.)

- [ ] **Step 3: Neutralize `.tab-grouped` tints (styles.css:1629-1657)**

```css
/* Grouped tabs: the group's color reaches them only through the active
   underline (--tab-stripe). Rest/hover/active fills are the chassis inks. */
.tab-grouped {
    --tab-stripe: var(--group-color, var(--accent));
}
```

Delete the `.tab-grouped:hover:not(.active)` and `.tab-grouped.active` tinted blocks (the base `.tab-btn` states now apply), and the `.tab-grouped.active::before` block that follows at :1659-1661 if it only tweaked the old stripe.

- [ ] **Step 4: Verify**

Run: `npm test` and `npm run build` → green.

- [ ] **Step 5: Commit**

```bash
git add ui/src/styles.css
git commit -m "feat(tabs): chassis horizontal — flat segments, hairline group separators, active underline"
```

---

### Task 5: Chassis AOM — one pulsing dot, all themes

Replace the conic-gradient ring (+ @property + fallback) with a 6px `--accent` dot that breathes; excluded = hollow dot. Delete every per-theme AOM override.

**Files:**
- Modify: `ui/src/styles.css:631-708` (AOM blocks)
- Modify: `ui/src/styles/tab-themes/glass.css`, `forge.css`, `crt.css`, `custom.css` — delete their AOM rules (Tasks 6-9 rewrite those files anyway; this task only does the base)

**Interfaces:**
- Produces: `.tab-btn.tab-aom-active::after` = the dot; themes must NOT restyle it.

- [ ] **Step 1: Replace styles.css:631-708 (both AOM blocks + @property + keyframes + @supports fallback) with:**

```css
/* AOM "driving this tab" — a breathing accent dot near the right edge.
   Chassis-owned: identical across all tab styles. Sits left of the
   close-× slot so hover-reveal doesn't collide. */
.tab-btn.tab-aom-active::after {
    content: "";
    position: absolute;
    right: 24px;
    top: 50%;
    width: 6px;
    height: 6px;
    margin-top: -3px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent);
    animation: tab-aom-breathe 2.4s ease-in-out infinite;
    pointer-events: none;
    z-index: 2;
}
@keyframes tab-aom-breathe {
    50% {
        box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 12%, transparent);
        opacity: 0.75;
    }
}
@media (prefers-reduced-motion: reduce) {
    .tab-btn.tab-aom-active::after { animation: none; }
}

/* AOM excluded — hollow dot, dimmed row. */
.tab-btn.tab-aom-excluded {
    opacity: 0.78;
}
.tab-btn.tab-aom-excluded::after {
    content: "";
    position: absolute;
    right: 24px;
    top: 50%;
    width: 6px;
    height: 6px;
    margin-top: -3px;
    border-radius: 50%;
    background: transparent;
    border: 1px solid rgb(var(--ink-rgb) / 0.35);
    box-sizing: border-box;
    pointer-events: none;
    z-index: 2;
}
.tab-btn.tab-aom-excluded .tab-label {
    color: color-mix(in srgb, var(--fg) 65%, transparent);
}
```

- [ ] **Step 2: Verify + commit**

Run: `npm test` && `npm run build` → green.

```bash
git add ui/src/styles.css
git commit -m "feat(tabs): chassis AOM — breathing accent dot replaces per-theme auras"
```

---

### Task 6: Forge — the hot seam

**Files:**
- Rewrite: `ui/src/styles/tab-themes/forge.css` (220 lines → ~45)

**Interfaces:**
- Consumes: chassis `::before` spine (vertical) / underline (horizontal) slots.

- [ ] **Step 1: Replace the entire file with:**

```css
/* ═══ TAB STYLE: FORGE (body.tab-style-forge) ═══
   One signature on the chassis: the active edge is a heated seam —
   ember gradient bleeding into the group color, minimal halo, and a
   heat tint fading across the active fill. Everything else (groups,
   rows, AOM) is chassis. */

/* VERTICAL: left seam. */
body.tab-style-forge.tabbar-left .tab-btn.active:not(:has(.tab-op-chip-leading))::before {
    background: linear-gradient(
        180deg,
        #ffd9a0,
        #ff8f5e 45%,
        var(--tab-stripe, var(--accent))
    );
    box-shadow: 2px 0 10px -2px rgba(255, 143, 94, 0.55);
}
body.tab-style-forge.tabbar-left .tab-btn.active {
    background: linear-gradient(
        90deg,
        color-mix(in srgb, #ff8f5e 10%, transparent),
        rgb(var(--ink-rgb) / 0.06) 55%
    );
}

/* HORIZONTAL: bottom seam, heat rising. */
body.tab-style-forge:not(.tabbar-left) .tab-btn.active::before {
    background: linear-gradient(
        90deg,
        #ffd9a0,
        #ff8f5e 45%,
        var(--tab-stripe, var(--accent))
    );
    box-shadow: 0 -2px 10px -2px rgba(255, 143, 94, 0.55);
}
body.tab-style-forge:not(.tabbar-left) .tab-btn.active {
    background: linear-gradient(
        0deg,
        color-mix(in srgb, #ff8f5e 10%, transparent),
        rgb(var(--ink-rgb) / 0.06) 60%
    );
}
```

(The ember literals `#ffd9a0`/`#ff8f5e` are the theme's identity — deliberate, like CRT's phosphor. They read on light backgrounds too since they only paint a 2px seam + a ≤10% tint.)

- [ ] **Step 2: Verify + commit**

Run: `npm test` && `npm run build` → green.

```bash
git add ui/src/styles/tab-themes/forge.css
git commit -m "feat(tabs): forge = hot seam on the chassis"
```

---

### Task 7: Glass — the traveling hairline capsule

**Files:**
- Rewrite: `ui/src/styles/tab-themes/glass.css` (133 lines → ~40)
- Unchanged: `ui/src/tabs/glass-indicator.ts` (positioning JS) and `ui/src/tabs/manager.glass-indicator.test.ts`

**Interfaces:**
- Consumes: `positionGlassIndicator()` sets inline `top/left/width/height` + `--gi-color` on `.tab-glass-indicator`.

- [ ] **Step 1: Replace the entire file with:**

```css
/* ═══ TAB STYLE: GLASS (body.tab-style-glass) ═══
   One signature on the chassis: a hairline glass capsule that springs
   between tabs (positioned by tabs/glass-indicator.ts). The motion is
   the signature — the capsule itself is quiet: ink fill + hairline +
   a faint top bevel tinted by the tab's color. */

.tab-glass-indicator {
    position: absolute;
    border-radius: 7px;
    background: rgb(var(--ink-rgb) / 0.06);
    box-shadow:
        inset 0 0 0 1px rgb(var(--ink-rgb) / 0.09),
        inset 0 1px 0 color-mix(in srgb, var(--gi-color, var(--accent)) 18%, rgb(var(--ink-rgb) / 0.07));
    pointer-events: none;
    z-index: 0;
    opacity: 0;
    transition:
        top 0.42s cubic-bezier(0.22, 1.2, 0.36, 1),
        left 0.42s cubic-bezier(0.22, 1.2, 0.36, 1),
        width 0.42s cubic-bezier(0.22, 1.2, 0.36, 1),
        height 0.42s cubic-bezier(0.22, 1.2, 0.36, 1),
        opacity 0.2s;
}
@media (prefers-reduced-motion: reduce) {
    .tab-glass-indicator { transition: opacity 0.1s; }
}

/* The capsule replaces the chassis fill + edge on the active tab. */
body.tab-style-glass .tab-btn {
    position: relative;
    z-index: 1;
}
body.tab-style-glass .tab-btn.active {
    background: transparent;
}
body.tab-style-glass .tab-btn.active::before {
    display: none;
}
```

- [ ] **Step 2: Verify + commit**

Run: `npm test -- glass` (glass-indicator suite) then full `npm test` && `npm run build` → green.

```bash
git add ui/src/styles/tab-themes/glass.css
git commit -m "feat(tabs): glass = quiet hairline capsule, motion as the signature"
```

---

### Task 8: CRT — caret + scanlines, all-mono

**Files:**
- Rewrite: `ui/src/styles/tab-themes/crt.css` (146 lines → ~75). Keeps `.tab-lead`/`.tab-caret` (renderer already emits them; the global `display:none` default MUST survive the rewrite).

- [ ] **Step 1: Replace the entire file with:**

```css
/* ═══ TAB STYLE: CRT (body.tab-style-crt) ═══
   One signature on the chassis: blinking caret + scanlines on the
   active row; the whole tabbar drops to the mono stack. $ prompt leads
   and ASCII tree connectors survive. Groups/AOM stay chassis. */

body.tab-style-crt #tabs,
body.tab-style-crt .group-chip {
    font-family:
        ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    letter-spacing: 0.05em;
}

/* Active row: faint phosphor tint + scanlines; the chassis edge
   (spine/underline) stays and blinks like a caret-rail. */
body.tab-style-crt .tab-btn.active {
    background:
        linear-gradient(
            90deg,
            color-mix(in srgb, var(--tab-stripe, var(--accent)) 12%, transparent),
            transparent 78%
        ),
        repeating-linear-gradient(
            0deg,
            rgb(var(--ink-rgb) / 0.05) 0 1px,
            transparent 1px 3px
        );
}
body.tab-style-crt .tab-btn.active::before {
    animation: crt-caret 1.06s steps(2, jump-none) infinite;
}
@keyframes crt-caret { 50% { opacity: 0.25; } }
@media (prefers-reduced-motion: reduce) {
    body.tab-style-crt .tab-btn.active::before { animation: none; }
}

/* ── Terminal prompt · tree connectors · blinking caret ──
   Light the theme-agnostic .tab-lead / .tab-caret slots the renderer
   emits. Hidden globally by default (only CRT shows them). */
.tab-lead,
.tab-caret {
    display: none;
}

body.tab-style-crt .tab-lead {
    display: inline-block;
    margin-right: 6px;
    font-weight: 700;
    color: color-mix(in srgb, var(--accent) 50%, var(--tab-fg-rest));
    opacity: 0.6;
}
body.tab-style-crt .tab-lead::before { content: "$"; }
body.tab-style-crt .tab-btn.active .tab-lead {
    color: var(--tab-stripe, var(--accent));
    opacity: 1;
}
body.tab-style-crt.tabbar-left .tab-group-shell .tab-btn .tab-lead::before { content: "├─"; }
body.tab-style-crt.tabbar-left .tab-group-shell .tab-btn:last-child .tab-lead::before { content: "└─"; }

/* Blinking block caret trailing the active label. */
body.tab-style-crt .tab-btn.active .tab-caret {
    display: inline-block;
    width: 7px;
    height: 1.05em;
    margin-left: 4px;
    vertical-align: text-bottom;
    background: var(--tab-stripe, var(--accent));
    animation: crt-caret 1.06s steps(2, jump-none) infinite;
}
@media (prefers-reduced-motion: reduce) {
    body.tab-style-crt .tab-btn.active .tab-caret { animation: none; }
}
```

(Dropped vs today: the `"JetBrains Mono"` literal — not in the repo's font set; text-shadow glows on labels and group chips; the flicker AOM; per-theme group styling.)

- [ ] **Step 2: Verify + commit**

Run: `npm test` && `npm run build` → green.

```bash
git add ui/src/styles/tab-themes/crt.css
git commit -m "feat(tabs): crt = caret + scanlines on the chassis, mono stack"
```

---

### Task 9: Custom — knobs on the new chassis

Knob schema and TS mapper (`ui/src/tabs/custom-style.ts`) stay **unchanged** — same enums, same CSS vars, same data attributes, so saved configs keep working with zero migration. Only the CSS underneath moves to the chassis.

**Files:**
- Modify: `ui/src/styles/tab-themes/custom.css`
- Unchanged: `ui/src/tabs/custom-style.ts`, `ui/src/tabs/__tests__/custom-style.test.ts`

- [ ] **Step 1: Adjust custom.css to the chassis.** Keep the file's structure; make these edits:

1. The base knob rule (:8-12) stays, but since the chassis `.tab-btn` no longer has a border, drop the border-related bg-off rule (:30-32) — replace with a comment `/* chassis has no rest border — off mode needs no border reset */`.
2. `stripe` indicator (:48-58): keep as-is (a top stripe is now a deliberate Custom variant, distinct from the chassis underline).
3. `underline` (:61-78) and `left-bar` (:81-99): keep; these now mirror chassis defaults which is fine (the knobs are explicit).
4. Delete the group-header block (:196-210) — the chassis chip has no card to customize; `--tab-custom-group-radius` may still arrive from TS, unused by CSS. Replace with comment `/* group chips are chassis-owned — group knobs are inert on the new base */`.
5. Delete the AOM block (:212-216) — chassis AOM is theme-proof.
6. The layout-specific height overrides (:167-184): update the hardcoded fallbacks `30px` → keep (that's the knob default), but the vertical chassis row is 26px — change the vertical rule's fallback to `26px`:

```css
body.tabbar-left.tab-style-custom .tab-btn:not(.tab-pill-folded) {
  height: var(--tab-custom-h, 26px);
  border-radius: var(--tab-custom-radius, 0px);
  --tab-radius: var(--tab-custom-radius, 0px);
}
body.tab-style-custom .tab-group-body > .tab-btn.tab-grouped:not(.tab-pill-folded) {
  height: var(--tab-custom-h, 26px);
  min-height: var(--tab-custom-h, 26px);
  border-radius: var(--tab-custom-radius, 0px);
  --tab-radius: var(--tab-custom-radius, 0px);
}
```

- [ ] **Step 2: Run the custom-style suite**

Run: `npm test -- custom-style`
Expected: PASS unchanged (TS contract untouched).

- [ ] **Step 3: Commit**

```bash
git add ui/src/styles/tab-themes/custom.css
git commit -m "feat(tabs): custom knobs sit on the chassis; group/AOM knobs retired"
```

---

### Task 10: Settings copy + DESIGN.md + final verification

**Files:**
- Modify: `ui/src/settings/panel.ts:746,753,760,767,774` (radio hints)
- Modify: `docs/DESIGN.md` (Layout & chrome → tabs bullet; add chassis note)

- [ ] **Step 1: Update the five radio hints in panel.ts**

```
classic → "The chassis pure — flat rows, monochrome groups, a 2px group-color edge on the active tab."
forge   → "The active edge becomes a heated seam — ember gradient with a minimal glow. Both layouts."
glass   → "A hairline glass capsule springs between tabs. The motion is the signature. Both layouts."
crt     → "Blinking caret + scanlines on the active row; everything monospace. The screenshot magnet."
custom  → "Compose your own from atomic knobs — shape, background, indicator, height, gap. Selecting this reveals the controls below."
```

- [ ] **Step 2: Update DESIGN.md**

In "Layout & chrome", replace the tabs bullet with:

```markdown
- **Tabs are square** (`--tab-radius: 0`). Horizontal rows are 30px; vertical sidebar rows are 26px (28px group chips). The tab chassis is monochrome at rest — group identity lives in a 6px dot; the group color appears only on the active tab's 2px edge (left in vertical, bottom underline in horizontal) and the focused group's lifted label. Tab styles (Forge/Glass/CRT/Custom) are single-signature overlays on this chassis; the AOM indicator (breathing accent dot) is chassis-owned and theme-proof.
```

- [ ] **Step 3: Full verification**

Run: `npm test` (root) → all green.
Run: `npm run build` → clean.
Run: `cargo test --workspace` → untouched, green (only if fast in this env; otherwise note the skip — no Rust files changed).

- [ ] **Step 4: Visual verification (respawn)**

Use the `respawn` skill, then check with 14+ groups incl. one empty, in EVERY cell of: {top, left} × {classic, forge, glass, crt, custom} × {dark, light, true-dark}:
- rest state is monochrome (only dots colored); empty group dimmed
- active tab shows fill + correct edge; operator-chip rows show no left spine
- focused group label lifted; AOM dot breathes on an AOM tab; collapsed group count visible
- light theme: no white-alpha leaks; True Dark: no accent-tinted elevation

- [ ] **Step 5: Commit**

```bash
git add ui/src/settings/panel.ts docs/DESIGN.md
git commit -m "docs(tabs): settings hints + DESIGN.md chassis grammar"
```
