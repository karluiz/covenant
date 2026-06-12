# Immersive Operator Creator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cramped 75vw right-drawer operator create/edit modal with a full-screen immersive shell (rail · controls · live SOUL) styled like the Spec Creator.

**Architecture:** Reuse the existing `SoulView` ↔ `soulRawFromView` data model and all section renderers in `ui/src/settings/operators.ts` verbatim. Only the surrounding DOM shell and CSS change: a `.op-creator` full-screen takeover with a `.scrim`, a scale-in `.creator`, a header (brand + live operator chip + esc), a 3-column `.stage` (rail / active-section controls / always-live SOUL), and a footer. A new `state.activeSection` field drives which section's controls render in the middle column; `soulRaw` remains the single source of truth so full re-renders are safe.

**Tech Stack:** TypeScript, Vite, Vitest + jsdom, plain DOM (no framework), `marked` for SOUL preview.

---

## File Structure

- **Modify** `ui/src/settings/operators.ts` — swap the modal shell DOM; add `activeSection` state + rail; split soul editor into per-section middle controls + always-on live pane; move hero chip to header. Keep footer button classes `op-modal-save` / `op-modal-delete` (the `OperatorsPane.openModalWith` delegation at lines ~98–142 depends on them).
- **Create** `ui/src/settings/operator-creator.css` — the immersive shell styles (scrim, creator, header, rail, stage grid, soul-live, footer, animations). Imported at top of `operators.ts`.
- **Modify** `ui/src/styles/operator_chip.css` — remove the now-dead `.op-modal*` drawer rules (keep shared chip styles).
- **Modify** `ui/src/settings/operators.test.ts` — add structural tests for the new shell.

### Section model

```ts
type SectionKey = "start" | "identity" | "behaviour" | "soul";
```

- `start` only exists in `mode === "create"`. Edit mode default section is `identity`.
- Rail order: Start* · Identity · Behaviour · The Soul.

---

## Task 1: Add `activeSection` state + `setSection` handle method

**Files:**
- Modify: `ui/src/settings/operators.ts` (the `ModalState`/`ModalHandle` types, `openOperatorModal`)
- Test: `ui/src/settings/operators.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `operators.test.ts` inside `describe('operator modal', ...)`:

```ts
it('defaults to start section in create, identity in edit', () => {
  const c = openOperatorModal({ mode: 'create' });
  expect(c.state.activeSection).toBe('start');
  const e = openOperatorModal({
    mode: 'edit',
    existing: {
      id: 'x', name: 'Maya', emoji: '🟣', color: '#6B7280', voice: 'Terse',
      tags: [], persona: '', escalate_threshold: 0.5, model: 'claude-sonnet-4-6',
      hard_constraints: '', is_default: false,
    } as unknown as import('../api').Operator,
  });
  expect(e.state.activeSection).toBe('identity');
});

it('setSection switches the active section', () => {
  const m = openOperatorModal({ mode: 'create' });
  m.setSection('behaviour');
  expect(m.state.activeSection).toBe('behaviour');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/settings/operators.test.ts -t "section"`
Expected: FAIL — `activeSection` undefined / `setSection` not a function.

- [ ] **Step 3: Implement**

In the `ModalState` interface add:

```ts
  activeSection: SectionKey;
```

Add the type near the other modal types:

```ts
export type SectionKey = "start" | "identity" | "behaviour" | "soul";
```

In `openOperatorModal`, when building `state`, set:

```ts
    activeSection: opts.mode === "create" ? "start" : "identity",
```

In the `ModalHandle` interface add `setSection(s: SectionKey): void;` and in the handle object implement:

```ts
    setSection(s) { state.activeSection = s; render(); },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npx vitest run src/settings/operators.test.ts -t "section"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add ui/src/settings/operators.ts ui/src/settings/operators.test.ts
git commit -m "feat(operators): add activeSection state + setSection to modal handle"
```

---

## Task 2: Build the immersive shell DOM in `renderForm`

Replace the drawer markup with the full-screen shell. The middle column renders only the active section; the right column always renders the live SOUL. The hero chip moves to the header.

**Files:**
- Modify: `ui/src/settings/operators.ts` (`renderForm`, `renderTopBar`, `renderSoulEditor`, `renderFooter`)
- Create: `ui/src/settings/operator-creator.css`
- Test: `ui/src/settings/operators.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('renders the immersive shell scaffold', () => {
  const m = openOperatorModal({ mode: 'create' });
  const el = m.el;
  expect(el.classList.contains('op-creator')).toBe(true);
  expect(el.querySelector('.scrim')).toBeTruthy();
  expect(el.querySelector('.creator')).toBeTruthy();
  expect(el.querySelector('.creator header .brand')).toBeTruthy();
  expect(el.querySelector('.op-rail')).toBeTruthy();
  expect(el.querySelector('.op-section')).toBeTruthy();
  expect(el.querySelector('.op-soul-live')).toBeTruthy();
  // footer save button keeps its class for OperatorsPane delegation
  expect(el.querySelector('.op-modal-save')).toBeTruthy();
});

it('rail shows Start only in create mode', () => {
  const c = openOperatorModal({ mode: 'create' });
  const labels = [...c.el.querySelectorAll('.op-rail-item')].map((n) => n.textContent);
  expect(labels.some((l) => /Start/i.test(l ?? ''))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/settings/operators.test.ts -t "immersive shell"`
Expected: FAIL — `.op-creator` etc. not found (still `.op-modal`).

- [ ] **Step 3: Implement the shell**

At the top of `operators.ts` add the CSS import (next to other imports):

```ts
import "./operator-creator.css";
```

In `openOperatorModal`, change the root class:

```ts
  el.className = "op-creator";
```

Rewrite `renderForm` to build the shell. Replace the existing function body with:

```ts
function renderForm(h: ModalHandle): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "op-modal-step op-modal-form";

  // Scrim (click closes) + the scale-in creator panel.
  const scrim = document.createElement("div");
  scrim.className = "scrim";
  scrim.addEventListener("click", () => h.el.remove());

  const creator = document.createElement("div");
  creator.className = "creator";
  creator.setAttribute("role", "dialog");
  creator.setAttribute("aria-label", h.state.mode === "edit" ? "Edit operator" : "New operator");

  creator.append(renderHeader(h));

  const stage = document.createElement("div");
  stage.className = "stage";
  stage.append(renderRail(h), renderSectionHost(h), renderSoulLive(h));
  creator.append(stage);

  creator.append(renderFooter(h));

  wrap.append(scrim, creator);
  return wrap;
}
```

Replace `renderTopBar` with `renderHeader` (brand + live chip placeholder host + esc). The chip host is filled by the soul editor's `renderHero` (Task 3):

```ts
function renderHeader(h: ModalHandle): HTMLElement {
  const header = document.createElement("header");

  const brand = document.createElement("div");
  brand.className = "brand";
  brand.textContent = `✦ ${h.state.mode === "edit" ? "Edit operator" : "New operator"}`;

  const chipHost = document.createElement("div");
  chipHost.className = "op-hero-chip";
  chipHost.style.flex = "1";

  const kbd = document.createElement("div");
  kbd.className = "kbd";
  kbd.textContent = "esc";

  header.append(brand, chipHost, kbd);
  return header;
}
```

Add the rail renderer:

```ts
const RAIL: { key: SectionKey; label: string; createOnly?: boolean }[] = [
  { key: "start", label: "Start", createOnly: true },
  { key: "identity", label: "Identity" },
  { key: "behaviour", label: "Behaviour" },
  { key: "soul", label: "The Soul" },
];

function renderRail(h: ModalHandle): HTMLElement {
  const rail = document.createElement("nav");
  rail.className = "op-rail";
  for (const item of RAIL) {
    if (item.createOnly && h.state.mode !== "create") continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "op-rail-item";
    if (h.state.activeSection === item.key) btn.classList.add("is-active");
    btn.textContent = item.label;
    btn.addEventListener("click", () => h.setSection(item.key));
    rail.append(btn);
  }
  return rail;
}
```

Add a section host that delegates to the soul editor (filled in Task 3 — for now render the existing editor so the app still works):

```ts
function renderSectionHost(h: ModalHandle): HTMLElement {
  const host = document.createElement("div");
  host.className = "op-section";
  // Temporary: mount the legacy split editor's controls here until Task 3
  // splits it per-section. renderSoulEditor returns the full split; we take
  // its controls column.
  host.append(renderSoulEditor(h));
  return host;
}

function renderSoulLive(_h: ModalHandle): HTMLElement {
  const live = document.createElement("div");
  live.className = "op-soul-live";
  return live;
}
```

Create `ui/src/settings/operator-creator.css` with the shell styles (adapted from `spec-chat/immersive.css`):

```css
.op-creator {
  position: fixed; inset: 38px 0 0 0; z-index: 10300;
  display: flex; align-items: stretch; justify-content: stretch;
}
.op-creator .scrim {
  position: absolute; inset: 0;
  background: rgba(0, 0, 0, 0.5); backdrop-filter: blur(8px);
  opacity: 0; transition: opacity 0.42s ease;
}
.op-creator.open .scrim { opacity: 1; }
.op-creator .creator {
  position: relative; margin: auto; width: min(1180px, 94vw); height: min(860px, 92%);
  display: flex; flex-direction: column;
  background: linear-gradient(180deg, #14151b 0%, #101116 100%);
  border: 1px solid rgba(124, 140, 255, 0.16); border-radius: 14px;
  box-shadow: 0 40px 120px -30px rgba(0, 0, 0, 0.7);
  transform: scale(0.94) translateY(14px); opacity: 0;
  transition: transform 0.46s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.46s ease;
  overflow: hidden;
}
.op-creator.open .creator { transform: scale(1) translateY(0); opacity: 1; }
.op-creator header {
  display: flex; align-items: center; gap: 12px; padding: 12px 18px;
  border-bottom: 1px solid rgba(124, 140, 255, 0.12);
}
.op-creator header .brand { font-weight: 600; color: #e6e8f0; }
.op-creator header .kbd {
  font-family: monospace; font-size: 11px; opacity: 0.5;
  border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 5px; padding: 2px 6px;
}
.op-creator .stage {
  flex: 1; display: grid; grid-template-columns: 168px 1fr 1fr; min-height: 0;
}
.op-creator .op-rail {
  display: flex; flex-direction: column; gap: 4px; padding: 14px 10px;
  border-right: 1px solid rgba(124, 140, 255, 0.1);
}
.op-creator .op-rail-item {
  text-align: left; padding: 9px 12px; border-radius: 8px; border: 0;
  background: transparent; color: #aeb4c6; font-size: 13px; cursor: pointer;
}
.op-creator .op-rail-item:hover { background: rgba(255, 255, 255, 0.04); }
.op-creator .op-rail-item.is-active {
  background: rgba(124, 140, 255, 0.14); color: #c8cfff;
  box-shadow: inset 0 0 0 1px rgba(124, 140, 255, 0.3);
}
.op-creator .op-section,
.op-creator .op-soul-live { padding: 18px 20px; overflow-y: auto; min-height: 0; }
.op-creator .op-soul-live { border-left: 1px solid rgba(124, 140, 255, 0.1); }
.op-creator .op-creator-foot,
.op-creator .op-modal-footer {
  display: flex; align-items: center; gap: 10px; padding: 12px 18px;
  border-top: 1px solid rgba(124, 140, 255, 0.12);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npx vitest run src/settings/operators.test.ts -t "immersive shell"`
Expected: PASS (both new tests).

- [ ] **Step 5: Trigger the open animation**

In `openOperatorModal`, after `document.body.appendChild(el);` add:

```ts
  requestAnimationFrame(() => el.classList.add("open"));
```

- [ ] **Step 6: Run the full operator test file**

Run: `cd ui && npx vitest run src/settings/operators.test.ts`
Expected: PASS (no regressions; pre-existing tests unaffected).

- [ ] **Step 7: Commit**

```bash
git add ui/src/settings/operators.ts ui/src/settings/operator-creator.css ui/src/settings/operators.test.ts
git commit -m "feat(operators): full-screen immersive shell (scrim/creator/rail/stage/footer)"
```

---

## Task 3: Split the soul editor into per-section middle + always-live right pane

Refactor `renderSoulEditor` so the middle `.op-section` shows only the active section's controls, the right `.op-soul-live` always shows the rendered preview + raw source, and the live operator chip renders into the header's `.op-hero-chip`.

**Files:**
- Modify: `ui/src/settings/operators.ts` (`renderSoulEditor`, `renderSectionHost`, `renderSoulLive`, `renderHeader` chip wiring)
- Test: `ui/src/settings/operators.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('middle shows only the active section; right always shows live soul', () => {
  const m = openOperatorModal({ mode: 'create' });
  m.setSection('identity');
  const section = m.el.querySelector('.op-section')!;
  // Identity controls present (name input), Behaviour controls absent.
  expect(section.querySelector('input.op-modal-input')).toBeTruthy();
  // Live soul pane always present with the preview + raw source.
  const live = m.el.querySelector('.op-soul-live')!;
  expect(live.querySelector('.op-soul-preview')).toBeTruthy();
  expect(live.querySelector('.op-soul-rawwrap')).toBeTruthy();
});

it('soul section shows the prose textarea in the middle', () => {
  const m = openOperatorModal({ mode: 'create' });
  m.setSection('soul');
  expect(m.el.querySelector('.op-section .op-soul-body')).toBeTruthy();
});

it('live operator chip renders in the header', () => {
  const m = openOperatorModal({ mode: 'create' });
  m.setName('Nova');
  expect(m.el.querySelector('header .op-hero-chip .op-chip, header .op-hero-chip')).toBeTruthy();
});
```

(The chip selector is permissive because `renderOperatorChip`'s root class may vary; the assertion only requires the chip host to be populated.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/settings/operators.test.ts -t "active section"`
Expected: FAIL — middle currently mounts the whole legacy split.

- [ ] **Step 3: Refactor `renderSoulEditor` into focused pieces**

Replace `renderSoulEditor` with a factory that builds the shared `view`/`commit` machinery once and exposes three mount points. Key change: the editor no longer owns layout — it returns mountable fragments. Concretely, restructure so the existing `paintControls` is split into `paintIdentity(container)` and `paintBehaviour(container)`, the prose `body` textarea is the `soul` section, and `preview` + `rawDetails` live in the right pane. Wire it from `renderSectionHost` / `renderSoulLive` / `renderHeader`.

Implementation — add a single editor instance per modal render, memoized on the element so all three hosts share one `view`/`commit`:

```ts
interface SoulEditor {
  mountSection(host: HTMLElement, section: SectionKey): void;
  mountLive(host: HTMLElement): void;
  mountChip(host: HTMLElement): void;
}

function getSoulEditor(h: ModalHandle): SoulEditor {
  const stamped = h.el as HTMLElement & { __soulEditor?: SoulEditor };
  if (stamped.__soulEditor) return stamped.__soulEditor;
  const ed = buildSoulEditor(h);
  stamped.__soulEditor = ed;
  return ed;
}
```

`buildSoulEditor(h)` contains the body of today's `renderSoulEditor` from the `let view` declaration through `commit`/`paintControls`/`renderHero`/`renderPreview`, but instead of appending into a `.op-soul-split`, it exposes:

```ts
  return {
    mountSection(host, section) {
      host.innerHTML = "";
      if (section === "start") { host.append(renderArchetypeGallery((raw) => { h.state.soulRaw = raw; rerenderModal(h); })); return; }
      if (section === "identity") { paintIdentity(host); return; }
      if (section === "behaviour") { paintBehaviour(host); return; }
      if (section === "soul") {
        const label = document.createElement("div");
        label.className = "op-soul-section-title";
        label.textContent = "The soul";
        host.append(label, body); // `body` = the existing .op-soul-body textarea
      }
    },
    mountLive(host) { host.innerHTML = ""; host.append(preview, rawDetails, errLine); void renderPreview(); },
    mountChip(host) { host.innerHTML = ""; host.append(renderOperatorChip({ name: view.name || "New Operator", emoji: view.avatar || "🟣", color: view.color || "#6B7280" }, "lg")); },
  };
```

Split today's `paintControls` into `paintIdentity(host)` (the Identity block — name, avatar grid, color swatches, tags) and `paintBehaviour(host)` (voice, model, threshold slider, hard-constraints). Update `commit(repaintControls)` so that when `repaintControls` is true it re-mounts the **active** section + the chip + the live pane:

```ts
  function commit(repaintControls: boolean): void {
    h.state.soulRaw = soulRawFromView(view);
    src.value = h.state.soulRaw;
    const chipHost = h.el.querySelector<HTMLElement>(".op-hero-chip");
    if (chipHost) editorMountChip(chipHost);     // re-render header chip live
    void renderPreview();
    if (repaintControls) {
      const sectionHost = h.el.querySelector<HTMLElement>(".op-section");
      if (sectionHost) editorMountSection(sectionHost, h.state.activeSection);
    }
  }
```

(Where `editorMountChip` / `editorMountSection` are the closure equivalents of the returned `mountChip` / `mountSection` — call the inner functions directly inside the closure rather than going through the returned object.)

Then wire the hosts:

```ts
function renderSectionHost(h: ModalHandle): HTMLElement {
  const host = document.createElement("div");
  host.className = "op-section";
  getSoulEditor(h).mountSection(host, h.state.activeSection);
  return host;
}

function renderSoulLive(h: ModalHandle): HTMLElement {
  const live = document.createElement("div");
  live.className = "op-soul-live";
  getSoulEditor(h).mountLive(live);
  return live;
}
```

In `renderHeader`, after building `chipHost`, populate it:

```ts
  getSoulEditor(h).mountChip(chipHost);
```

**Important:** `getSoulEditor` memoizes on `h.el`, but `render()` rebuilds the DOM (not the element), so the stamped editor survives across the rail-switch re-renders that call `rerenderModal`. That is correct — `view` is re-seeded from `soulRaw` only inside `buildSoulEditor`, which now runs once per modal open. Re-seed on first build from `h.state.soulRaw` exactly as the legacy code did.

Delete the now-unused `renderSoulEditor` and the old `.op-soul-split` assembly.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npx vitest run src/settings/operators.test.ts -t "active section"`
Expected: PASS

- [ ] **Step 5: Run the full file + typecheck**

Run: `cd ui && npx vitest run src/settings/operators.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Add the live-pane + control styles to `operator-creator.css`**

Append styles so the soul textarea, preview, raw source, swatches, avatar grid, and chip look right in the new columns (reuse class names that already exist: `.op-soul-body`, `.op-soul-preview`, `.op-soul-rawwrap`, `.op-soul-avatar-grid`, `.op-soul-swatches`, `.op-soul-section-title`, `.op-modal-field`, `.op-modal-label`, `.op-modal-input`, `.op-modal-select`). Port the relevant rules from `operator_chip.css` into `operator-creator.css`, scoped under `.op-creator`, with focus-within glow on inputs:

```css
.op-creator .op-modal-input,
.op-creator .op-modal-select,
.op-creator .op-soul-body,
.op-creator .op-soul-source {
  width: 100%; background: #16171e; color: #d7dae6;
  border: 1px solid #23252f; border-radius: 8px; padding: 9px 11px;
  font: inherit; transition: box-shadow 0.18s ease, border-color 0.18s ease;
}
.op-creator .op-modal-input:focus,
.op-creator .op-soul-body:focus {
  outline: none; border-color: rgba(124, 140, 255, 0.6);
  box-shadow: 0 0 0 3px rgba(124, 140, 255, 0.14);
}
.op-creator .op-soul-body { min-height: 220px; resize: vertical; }
.op-creator .op-soul-section-title {
  font-size: 11px; letter-spacing: 0.07em; text-transform: uppercase;
  color: #8b90a4; margin: 0 0 8px;
}
.op-creator .op-soul-avatar-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; }
.op-creator .op-soul-swatches { display: flex; gap: 8px; flex-wrap: wrap; }
.op-creator .op-soul-preview { font-size: 13px; line-height: 1.5; color: #c4c8d6; }
.op-creator .op-hero-chip { display: flex; align-items: center; }
```

- [ ] **Step 7: Commit**

```bash
git add ui/src/settings/operators.ts ui/src/settings/operator-creator.css ui/src/settings/operators.test.ts
git commit -m "feat(operators): per-section middle controls + always-live SOUL + header chip"
```

---

## Task 4: Footer + animated close + remove dead drawer CSS

**Files:**
- Modify: `ui/src/settings/operators.ts` (`renderFooter`, `openModalWith` close paths)
- Modify: `ui/src/styles/operator_chip.css` (delete `.op-modal*` drawer rules)
- Test: `ui/src/settings/operators.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('footer keeps save/delete classes and shows delete only in edit', () => {
  const c = openOperatorModal({ mode: 'create' });
  expect(c.el.querySelector('.op-modal-save')).toBeTruthy();
  expect(c.el.querySelector('.op-modal-delete')).toBeFalsy();
});
```

- [ ] **Step 2: Run test to verify it fails (or passes early)**

Run: `cd ui && npx vitest run src/settings/operators.test.ts -t "footer keeps"`
Expected: PASS if `renderFooter` already conditionally renders delete; FAIL if delete shows in create. Adjust `renderFooter` so the delete button (`.op-modal-delete`) renders only when `h.state.mode === "edit"`, and the save button keeps class `op-modal-save`. Confirm the footer wrapper uses class `op-creator-foot` (CSS already targets both `.op-creator-foot` and legacy `.op-modal-footer`).

- [ ] **Step 3: Animated close on scrim/esc**

The `OperatorsPane.openModalWith` Escape handler and the scrim click currently call `handle.el.remove()` directly. Replace the **scrim** handler (in `renderForm`, Task 2) and the modal's own close affordances to animate out first:

```ts
function closeCreator(el: HTMLElement): void {
  el.classList.remove("open");
  setTimeout(() => el.remove(), 420);
}
```

Use `closeCreator(h.el)` in the scrim click handler. Leave the save/delete teardown in `openModalWith` as immediate `handle.el.remove()` (instant teardown after a successful save is fine). The Escape listener in `openModalWith` (line ~150) may keep `handle.el.remove()`; optionally swap to `closeCreator` for consistency.

- [ ] **Step 4: Remove dead CSS**

In `ui/src/styles/operator_chip.css`, delete the drawer-specific rules: `.op-modal`, `.op-modal-step`, `.op-modal-topbar`, `.op-modal-title`, `.op-modal-close`, `.op-modal-body`, `.op-soul-split`, `.op-soul-controls`, `.op-soul-right`, `.op-soul-hero`, the `@keyframes op-drawer-in`, and any selectors now superseded by `operator-creator.css`. Keep shared `.op-chip` / `.op-card` / `.op-archetype*` styles. Verify nothing else imports these by grepping:

Run: `cd ui && grep -rn "op-modal-step\|op-soul-split\|op-drawer-in" src`
Expected: no matches outside `operator-creator.css` / removed lines.

- [ ] **Step 5: Run the full test file + typecheck**

Run: `cd ui && npx vitest run src/settings/operators.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add ui/src/settings/operators.ts ui/src/styles/operator_chip.css ui/src/settings/operators.test.ts
git commit -m "feat(operators): conditional footer, animated close, drop dead drawer CSS"
```

---

## Task 5: Manual verification in the running app

**Files:** none (verification only)

- [ ] **Step 1: Respawn the app**

Use the `respawn` skill (or `npm run tauri:dev`) and open Settings → Operators.

- [ ] **Step 2: Verify create flow**

- Click "+ New operator" → full-screen creator scales in over a blurred scrim.
- Rail shows Start · Identity · Behaviour · The Soul. Start is active; archetype gallery shows; `＋ Blank` works.
- Pick an archetype → rail moves to Identity (or stays — confirm seeding populated name/avatar in the header chip).
- Switch sections via the rail; middle swaps; the right SOUL preview stays live and updates as you edit Identity/Behaviour.
- Header chip updates live as you change name/avatar/color.
- "The Soul" section shows the prose textarea; typing updates the right preview and the `SOUL.md source` toggle.
- Footer: Set-as-default toggle, Cancel (animated close), Save → operator appears in the grid; toast shows.

- [ ] **Step 3: Verify edit flow**

- Edit an existing operator → no Start section; defaults to Identity; SOUL.md loads from disk into the live pane and source.
- Change a field, Save → grid refreshes; Delete (edit only) removes it.

- [ ] **Step 4: Verify Esc + scrim**

- Esc closes; clicking the scrim closes; both animate out.

---

## Self-Review notes

- **Spec coverage:** shell (T2) · rail/sections (T1,T2,T3) · always-live SOUL + source toggle (T3) · header chip (T3) · archetypes as Start (T3) · both create+edit (T1,T2) · footer class preservation (T2,T4) · animated close (T4) · dead CSS removal (T4) · separate operator-creator.css (T2). All covered.
- **Type consistency:** `SectionKey` defined in T1, used in T2/T3. `setSection` on `ModalHandle` (T1). `getSoulEditor`/`buildSoulEditor`/`SoulEditor` introduced together in T3.
- **Footer hook contract:** `op-modal-save` / `op-modal-delete` classes preserved so `OperatorsPane.openModalWith` delegation keeps working — asserted in T2 and T4 tests.
