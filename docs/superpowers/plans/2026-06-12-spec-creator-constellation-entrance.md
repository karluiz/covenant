# Spec Creator Constellation Entrance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat Spec Creator chooser modal with a full-bleed "Constellation" entrance — canvas particle sky, rich draft cards with section-progress dots, hero CTA — preserving the exact behavior contract of the old chooser.

**Architecture:** New self-contained module `ui/src/spec-chat/entrance.ts` (+ `entrance.css`) exposing `mountSpecEntrance(host, drafts, callbacks)`. `index.ts` delegates its `renderChooser()` to it via callbacks; controller logic, draft listing, and the no-drafts→immersive path are untouched. Old `.spec-chat-chooser*` CSS in `styles.css` is deleted.

**Tech Stack:** Plain DOM/TypeScript (no framework), canvas 2D, hand-written CSS, vitest + jsdom. Spec: `docs/superpowers/specs/2026-06-12-spec-creator-constellation-entrance-design.md`.

**Worktree:** `/Users/carlosgallardoarenas/Sources/karlTerminal/.claude/worktrees/spec-entrance-constellation` — already created, deps installed, baseline green (42 spec-chat tests). All commands run from the worktree root.

**Commit policy (user preference):** ONE commit for the whole feature at the end (Task 6). Do NOT commit per task.

**Key codebase facts the engineer needs:**
- Vitest config lives at the **repo root** (`vitest.config.ts`, `vitest.setup.ts`). Run tests from the worktree root: `npx vitest run ui/src/spec-chat/`. Running from `ui/` fails.
- jsdom's `canvas.getContext('2d')` returns `null` (no canvas package installed) — the sky must no-op in that case.
- Light theme selector is `body.theme-light`; OLED is `body.theme-true-dark`. On True Dark, elevated/hover surfaces must use **neutral** lifts, never accent tints.
- Icons come from `ui/src/icons/index.ts`: `Icons.sparkles({ size })` / `Icons.trash({ size })` return SVG strings (assign via `innerHTML`).
- Native tooltips are forbidden in this codebase (`element.title = …` is banned). The entrance does not need tooltips — do not add any.
- All UI copy must be English.
- `tsconfig` is `strict: true`; no `as any` without a justifying comment.

---

### Task 1: `sectionProgress()` — pure progress derivation (TDD)

**Files:**
- Create: `ui/src/spec-chat/entrance.ts` (just this function for now, plus its CSS import target)
- Create: `ui/src/spec-chat/entrance.css` (empty placeholder so the import resolves)
- Create: `ui/src/spec-chat/entrance.test.ts`

- [ ] **Step 1: Create the empty CSS placeholder**

Create `ui/src/spec-chat/entrance.css` with only:

```css
/* spec-chat/entrance.css — Constellation entrance. Populated in Task 3. */
```

- [ ] **Step 2: Write the failing tests**

Create `ui/src/spec-chat/entrance.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sectionProgress, mountSpecEntrance } from "./entrance";
import type { EntranceCallbacks } from "./entrance";
import type { SpecDraftSummary, SpecDraftStatus } from "../api";

// ---------------------------------------------------------------------------
// sectionProgress
// ---------------------------------------------------------------------------

describe("sectionProgress", () => {
  it("returns all-false for null partial_md", () => {
    expect(sectionProgress(null)).toEqual([false, false, false, false, false, false]);
  });

  it("fills dots for present ## section headers", () => {
    const md = "## Goal\nDo the thing.\n\n## Acceptance criteria\n- works\n";
    expect(sectionProgress(md)).toEqual([true, false, true, false, false, false]);
  });

  it("matches headers case-insensitively and ignores ### subheadings", () => {
    const md = "## goal\nx\n### File boundaries\nnot a top-level section\n";
    expect(sectionProgress(md)).toEqual([true, false, false, false, false, false]);
  });

  it("fills all six for a complete spec", () => {
    const md = [
      "## Goal", "## Out of scope", "## Acceptance criteria",
      "## File boundaries", "## Complexity", "## Open questions",
    ].join("\nbody\n");
    expect(sectionProgress(md)).toEqual([true, true, true, true, true, true]);
  });
});
```

(The `mountSpecEntrance` / `EntranceCallbacks` imports will be exercised in Task 2 — they may be unused-import errors right now; that is fine, Task 2 adds their tests. If `tsc` noise bothers you mid-task, comment those two imports until Task 2.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run ui/src/spec-chat/entrance.test.ts`
Expected: FAIL — `entrance.ts` does not exist / `sectionProgress` not exported.

- [ ] **Step 4: Write the implementation**

Create `ui/src/spec-chat/entrance.ts`:

```typescript
/**
 * spec-chat/entrance.ts — the Constellation entrance.
 *
 * Full-bleed "lobby" for the immersive Spec Creator: canvas particle sky,
 * draft cards with section-progress dots, hero CTA. Replaces the old flat
 * chooser. Behavior contract is identical to the old chooser:
 *   - click a draft card       → cb.onResume(id)
 *   - "Start a new spec"       → cb.onNew()
 *   - "blank draft (no chat)"  → cb.onBlank()
 *   - Esc / backdrop click     → cb.onDismiss()
 *   - trash on a card          → cb.deleteDraft(id); last card gone → cb.onEmptied()
 */
import "./entrance.css";
import type { SpecDraftSummary } from "../api";
import { Icons } from "../icons";

export interface EntranceCallbacks {
  onResume: (draftId: string) => void;
  onNew: () => void;
  onBlank: () => void;
  onDismiss: () => void;
  deleteDraft: (id: string) => Promise<void>;
  onEmptied: () => void;
}

export interface EntranceInstance {
  /** Synchronously detaches listeners, starts the exit fade, removes DOM after it. */
  dismiss: () => void;
}

/** Must stay in sync with SECTIONS titles in live-spec.ts. */
const SECTION_TITLES = [
  "Goal",
  "Out of scope",
  "Acceptance criteria",
  "File boundaries",
  "Complexity",
  "Open questions",
] as const;

export function sectionProgress(partialMd: string | null): boolean[] {
  if (!partialMd) return SECTION_TITLES.map(() => false);
  return SECTION_TITLES.map((t) =>
    new RegExp(`^##\\s+${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "mi").test(partialMd),
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run ui/src/spec-chat/entrance.test.ts`
Expected: 4 tests PASS (the `mountSpecEntrance` import will fail to resolve — if so, comment that import + the `EntranceCallbacks` type import until Task 2, then re-run: PASS).

---

### Task 2: `mountSpecEntrance()` — DOM, behavior, sky guards (TDD)

**Files:**
- Modify: `ui/src/spec-chat/entrance.ts` (append below `sectionProgress`)
- Modify: `ui/src/spec-chat/entrance.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `ui/src/spec-chat/entrance.test.ts` (and restore/uncomment the `mountSpecEntrance` + `EntranceCallbacks` imports from Task 1):

```typescript
// ---------------------------------------------------------------------------
// mountSpecEntrance
// ---------------------------------------------------------------------------

function makeDraft(overrides: Partial<SpecDraftSummary> = {}): SpecDraftSummary {
  return {
    id: "draft-1",
    messages: [{ role: "User", content: "First user message for testing" }],
    partial_md: null,
    last_updated: new Date(Date.now() - 5 * 60_000).toISOString(),
    status: { InProgress: { phase: "goal" } } as SpecDraftStatus,
    ...overrides,
  };
}

function makeCallbacks(): EntranceCallbacks & {
  onResume: ReturnType<typeof vi.fn>;
  onNew: ReturnType<typeof vi.fn>;
  onBlank: ReturnType<typeof vi.fn>;
  onDismiss: ReturnType<typeof vi.fn>;
  deleteDraft: ReturnType<typeof vi.fn>;
  onEmptied: ReturnType<typeof vi.fn>;
} {
  return {
    onResume: vi.fn(),
    onNew: vi.fn(),
    onBlank: vi.fn(),
    onDismiss: vi.fn(),
    deleteDraft: vi.fn().mockResolvedValue(undefined),
    onEmptied: vi.fn(),
  };
}

describe("mountSpecEntrance", () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("renders brand, draft cards (max 3), CTA, and blank link", () => {
    const drafts = [1, 2, 3, 4, 5].map((n) =>
      makeDraft({ id: `d${n}`, messages: [{ role: "User", content: `Draft ${n}` }] }),
    );
    mountSpecEntrance(host, drafts, makeCallbacks());

    const root = host.querySelector(".spec-entrance");
    expect(root).not.toBeNull();
    expect(root!.querySelector(".spec-entrance-title")!.textContent).toBe("Spec Creator");
    expect(root!.querySelectorAll(".spec-entrance-card").length).toBe(3);
    expect(root!.querySelector(".spec-entrance-cta")!.textContent).toContain("Start a new spec");
    expect(root!.querySelector(".spec-entrance-blank")!.textContent).toContain("blank draft");
  });

  it("renders summary, meta, and progress dots on a card", () => {
    const draft = makeDraft({
      messages: [
        { role: "User", content: "Build the thing" },
        { role: "Assistant", content: "ok" },
      ],
      partial_md: "## Goal\nx\n## Out of scope\ny\n",
    });
    mountSpecEntrance(host, [draft], makeCallbacks());

    const card = host.querySelector(".spec-entrance-card")!;
    expect(card.querySelector(".spec-entrance-card-summary")!.textContent).toBe("Build the thing");
    expect(card.querySelector(".spec-entrance-card-meta")!.textContent).toContain("2 messages");
    const dots = card.querySelectorAll(".spec-entrance-card-dots .dot");
    expect(dots.length).toBe(6);
    expect(card.querySelectorAll(".spec-entrance-card-dots .dot.filled").length).toBe(2);
  });

  it("clicking a card fires onResume with the draft id", () => {
    const cb = makeCallbacks();
    mountSpecEntrance(host, [makeDraft({ id: "resume-me" })], cb);
    (host.querySelector(".spec-entrance-card") as HTMLElement).click();
    expect(cb.onResume).toHaveBeenCalledWith("resume-me");
  });

  it("CTA fires onNew; blank link fires onBlank", () => {
    const cb = makeCallbacks();
    mountSpecEntrance(host, [makeDraft()], cb);
    (host.querySelector(".spec-entrance-cta") as HTMLElement).click();
    expect(cb.onNew).toHaveBeenCalledOnce();
    (host.querySelector(".spec-entrance-blank") as HTMLElement).click();
    expect(cb.onBlank).toHaveBeenCalledOnce();
  });

  it("Escape fires onDismiss; after dismiss() the listener is gone", () => {
    const cb = makeCallbacks();
    const inst = mountSpecEntrance(host, [makeDraft()], cb);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(cb.onDismiss).toHaveBeenCalledTimes(1);

    inst.dismiss();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(cb.onDismiss).toHaveBeenCalledTimes(1);
  });

  it("backdrop click fires onDismiss; clicks inside content do not", () => {
    const cb = makeCallbacks();
    mountSpecEntrance(host, [makeDraft()], cb);
    (host.querySelector(".spec-entrance") as HTMLElement).click();
    expect(cb.onDismiss).toHaveBeenCalledTimes(1);
    (host.querySelector(".spec-entrance-content") as HTMLElement).click();
    expect(cb.onDismiss).toHaveBeenCalledTimes(1);
  });

  it("delete removes the card without resuming; deleting the last card fires onEmptied", async () => {
    const cb = makeCallbacks();
    mountSpecEntrance(
      host,
      [makeDraft({ id: "d1" }), makeDraft({ id: "d2" })],
      cb,
    );

    const delBtns = host.querySelectorAll<HTMLButtonElement>(".spec-entrance-card-del");
    delBtns[0]!.click();
    await vi.waitFor(() => expect(cb.deleteDraft).toHaveBeenCalledWith("d1"));
    expect(cb.onResume).not.toHaveBeenCalled();
    expect(host.querySelectorAll(".spec-entrance-card").length).toBe(1);
    expect(cb.onEmptied).not.toHaveBeenCalled();

    (host.querySelector(".spec-entrance-card-del") as HTMLElement).click();
    await vi.waitFor(() => expect(cb.onEmptied).toHaveBeenCalledOnce());
  });

  it("dismiss() removes the root after the exit fade", () => {
    vi.useFakeTimers();
    const inst = mountSpecEntrance(host, [makeDraft()], makeCallbacks());
    inst.dismiss();
    expect(host.querySelector(".spec-entrance")).not.toBeNull(); // still fading
    vi.advanceTimersByTime(400);
    expect(host.querySelector(".spec-entrance")).toBeNull();
  });

  it("dismiss() is idempotent", () => {
    const cb = makeCallbacks();
    const inst = mountSpecEntrance(host, [makeDraft()], cb);
    inst.dismiss();
    expect(() => inst.dismiss()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Sky (canvas) guards — jsdom has no 2d context, so the real context is stubbed.
// ---------------------------------------------------------------------------

// Partial stub covering exactly the calls the sky makes; the cast is justified
// because jsdom provides no CanvasRenderingContext2D implementation at all.
function stub2d(): CanvasRenderingContext2D {
  return {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
}

describe("entrance sky", () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("mounts without throwing when getContext returns null (jsdom default)", () => {
    expect(() => mountSpecEntrance(host, [makeDraft()], makeCallbacks())).not.toThrow();
  });

  it("prefers-reduced-motion renders a single static frame, no loop", () => {
    const ctx = stub2d();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));

    mountSpecEntrance(host, [makeDraft()], makeCallbacks());
    // Static frame draws synchronously exactly once; an animation loop would
    // draw zero times synchronously (rAF is async).
    expect(ctx.clearRect).toHaveBeenCalledTimes(1);
  });

  it("dismiss() cancels the animation loop", () => {
    const ctx = stub2d();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    const cancelSpy = vi.spyOn(window, "cancelAnimationFrame");

    const inst = mountSpecEntrance(host, [makeDraft()], makeCallbacks());
    inst.dismiss();
    expect(cancelSpy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run ui/src/spec-chat/entrance.test.ts`
Expected: FAIL — `mountSpecEntrance` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `ui/src/spec-chat/entrance.ts`:

```typescript
// ---------------------------------------------------------------------------
// Draft-card helpers
// ---------------------------------------------------------------------------

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "< 1 min";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function shortSummary(draft: SpecDraftSummary): string {
  const firstUser = draft.messages.find((m) => m.role === "User");
  if (!firstUser) return "No messages";
  // CSS clamps to 2 lines; this cap just keeps the DOM text bounded.
  return firstUser.content.length > 140
    ? firstUser.content.slice(0, 140) + "…"
    : firstUser.content;
}

// ---------------------------------------------------------------------------
// Constellation sky
// ---------------------------------------------------------------------------

interface Particle { x: number; y: number; vx: number; vy: number; r: number }

const PARTICLE_COUNT = 80;
const LINK_DIST = 110;

/** Starts the sky; returns a teardown fn. No-ops when canvas 2d is unavailable. */
function startSky(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};

  const reduced =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const light = document.body.classList.contains("theme-light");
  // Same accent hue in both themes; light needs deeper alpha to read on paper.
  const rgb = "124,140,255";
  const dotAlpha = light ? 0.38 : 0.16;
  const linkAlpha = light ? 0.16 : 0.07;

  let w = 0;
  let h = 0;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const size = (): void => {
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  size();

  const ps: Particle[] = [];
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    ps.push({
      x: Math.random() * Math.max(w, 1),
      y: Math.random() * Math.max(h, 1),
      vx: (Math.random() - 0.5) * 0.18,
      vy: (Math.random() - 0.5) * 0.14,
      r: 0.6 + Math.random() * 1.4,
    });
  }

  const draw = (): void => {
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = 1;
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const dx = ps[i]!.x - ps[j]!.x;
        const dy = ps[i]!.y - ps[j]!.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < LINK_DIST * LINK_DIST) {
          const a = (1 - Math.sqrt(d2) / LINK_DIST) * linkAlpha;
          ctx.strokeStyle = `rgba(${rgb},${a.toFixed(3)})`;
          ctx.beginPath();
          ctx.moveTo(ps[i]!.x, ps[i]!.y);
          ctx.lineTo(ps[j]!.x, ps[j]!.y);
          ctx.stroke();
        }
      }
    }
    for (const p of ps) {
      ctx.fillStyle = `rgba(${rgb},${Math.min(1, dotAlpha + p.r * 0.08).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  const step = (): void => {
    for (const p of ps) {
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < -4) p.x = w + 4;
      else if (p.x > w + 4) p.x = -4;
      if (p.y < -4) p.y = h + 4;
      else if (p.y > h + 4) p.y = -4;
    }
  };

  let ro: ResizeObserver | null = null;
  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(() => {
      size();
      if (reduced) draw();
    });
    ro.observe(canvas);
  }

  let raf = 0;
  if (reduced) {
    draw();
  } else {
    const loop = (): void => {
      step();
      draw();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  }

  return () => {
    cancelAnimationFrame(raf);
    ro?.disconnect();
  };
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

const EXIT_MS = 320;
const RISE_STAGGER_MS = 60;

export function mountSpecEntrance(
  host: HTMLElement,
  drafts: SpecDraftSummary[],
  cb: EntranceCallbacks,
): EntranceInstance {
  const root = document.createElement("div");
  root.className = "spec-entrance";

  const scrim = document.createElement("div");
  scrim.className = "spec-entrance-scrim";
  root.appendChild(scrim);

  const sky = document.createElement("canvas");
  sky.className = "spec-entrance-sky";
  root.appendChild(sky);

  const content = document.createElement("div");
  content.className = "spec-entrance-content";
  root.appendChild(content);

  const brand = document.createElement("header");
  brand.className = "spec-entrance-brand spec-entrance-rise";
  brand.innerHTML = `
    <span class="spec-entrance-spark" aria-hidden="true">${Icons.sparkles({ size: 22 })}</span>
    <h2 class="spec-entrance-title">Spec Creator</h2>
    <p class="spec-entrance-lead">what do you want to build?</p>`;
  content.appendChild(brand);

  const cardsEl = document.createElement("div");
  cardsEl.className = "spec-entrance-drafts";
  content.appendChild(cardsEl);

  function buildCard(draft: SpecDraftSummary): HTMLElement {
    const card = document.createElement("div");
    card.className = "spec-entrance-card spec-entrance-rise";
    card.setAttribute("role", "button");
    card.tabIndex = 0;

    const summary = document.createElement("div");
    summary.className = "spec-entrance-card-summary";
    summary.textContent = shortSummary(draft);
    card.appendChild(summary);

    const meta = document.createElement("div");
    meta.className = "spec-entrance-card-meta";
    const msgs = draft.messages.length;
    meta.textContent = `${msgs} message${msgs === 1 ? "" : "s"} · ${relativeTime(draft.last_updated)}`;
    card.appendChild(meta);

    const dots = document.createElement("div");
    dots.className = "spec-entrance-card-dots";
    for (const filled of sectionProgress(draft.partial_md)) {
      const dot = document.createElement("span");
      dot.className = filled ? "dot filled" : "dot";
      dots.appendChild(dot);
    }
    card.appendChild(dots);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "spec-entrance-card-del";
    del.setAttribute("aria-label", "Delete draft");
    del.innerHTML = Icons.trash({ size: 13 });
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await cb.deleteDraft(draft.id);
        card.remove();
        if (cardsEl.querySelectorAll(".spec-entrance-card").length === 0) cb.onEmptied();
      } catch {
        // silently ignore deletion failures (same as the old chooser)
      }
    });
    card.appendChild(del);

    const activate = (): void => cb.onResume(draft.id);
    card.addEventListener("click", activate);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate();
      }
    });
    return card;
  }

  for (const draft of drafts.slice(0, 3)) cardsEl.appendChild(buildCard(draft));

  const cta = document.createElement("button");
  cta.type = "button";
  cta.className = "spec-entrance-cta spec-entrance-rise";
  cta.innerHTML = `<span class="spec-entrance-cta-spark" aria-hidden="true">${Icons.sparkles({ size: 15 })}</span><span>Start a new spec</span>`;
  cta.addEventListener("click", () => cb.onNew());
  content.appendChild(cta);

  const blank = document.createElement("button");
  blank.type = "button";
  blank.className = "spec-entrance-blank spec-entrance-rise";
  blank.textContent = "blank draft (no chat)";
  blank.addEventListener("click", () => cb.onBlank());
  content.appendChild(blank);

  const hint = document.createElement("div");
  hint.className = "spec-entrance-hint";
  hint.innerHTML = "<kbd>esc</kbd>";
  root.appendChild(hint);

  // Staggered rise: brand → cards → CTA → blank.
  const risers = [brand, ...Array.from(cardsEl.children), cta, blank] as HTMLElement[];
  risers.forEach((el, i) => el.style.setProperty("--rise-delay", `${i * RISE_STAGGER_MS}ms`));

  // Backdrop: any click outside the content column dismisses (scrim, sky, hint).
  root.addEventListener("click", (e) => {
    if (!(e.target instanceof Node) || !content.contains(e.target)) cb.onDismiss();
  });

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      cb.onDismiss();
    }
  };
  document.addEventListener("keydown", onKey);

  host.appendChild(root);
  requestAnimationFrame(() => root.classList.add("open"));

  const stopSky = startSky(sky);

  let dismissed = false;
  const dismiss = (): void => {
    if (dismissed) return;
    dismissed = true;
    document.removeEventListener("keydown", onKey);
    stopSky();
    root.classList.remove("open");
    root.classList.add("closing");
    setTimeout(() => root.remove(), EXIT_MS);
  };

  return { dismiss };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run ui/src/spec-chat/entrance.test.ts`
Expected: all entrance tests PASS (4 from Task 1 + 12 new).

---

### Task 3: `entrance.css` — full Constellation styling

**Files:**
- Modify: `ui/src/spec-chat/entrance.css` (replace the placeholder entirely)

No unit test covers CSS; correctness is verified visually in Task 6. Class names must match Task 2 exactly.

- [ ] **Step 1: Write the stylesheet**

Replace `ui/src/spec-chat/entrance.css` with:

```css
/* spec-chat/entrance.css — Constellation entrance for the Spec Creator.
   Scoped under .spec-entrance. Theme variants: default dark (matches
   immersive.css palette), body.theme-true-dark (OLED), body.theme-light. */

.spec-entrance {
  --se-bg: rgba(7, 8, 12, 0.86);
  --se-accent: #7c8cff;
  --se-accent-soft: #5663c9;
  --se-txt: #e7e8ec;
  --se-txt-dim: #9a9da7;
  --se-good: #4ec9a0;
  --se-card-bg: rgba(19, 20, 28, 0.82);
  --se-card-border: #23252e;
  --se-dot-bg: rgba(255, 255, 255, 0.08);
  --se-dot-border: rgba(255, 255, 255, 0.14);
  position: fixed;
  top: 38px;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 10100;
}

.spec-entrance-scrim {
  position: absolute;
  inset: 0;
  background: var(--se-bg);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  opacity: 0;
  transition: opacity 0.4s ease;
}

.spec-entrance-sky {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  transition: opacity 0.8s ease 0.1s;
}

.spec-entrance.open .spec-entrance-scrim,
.spec-entrance.open .spec-entrance-sky {
  opacity: 1;
}

.spec-entrance.closing .spec-entrance-scrim,
.spec-entrance.closing .spec-entrance-sky {
  opacity: 0;
  transition: opacity 0.28s ease;
}

/* Staggered rise choreography — transitions keyed off .open so they reverse
   cleanly on close. --rise-delay is set per element from TS. */
.spec-entrance .spec-entrance-rise {
  opacity: 0;
  transform: translateY(16px);
  transition:
    opacity 0.45s ease var(--rise-delay, 0ms),
    transform 0.52s cubic-bezier(0.18, 0.7, 0.27, 1) var(--rise-delay, 0ms);
}

.spec-entrance.open .spec-entrance-rise {
  opacity: 1;
  transform: none;
}

.spec-entrance.closing .spec-entrance-rise {
  opacity: 0;
  transition: opacity 0.22s ease;
}

.spec-entrance-content {
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 26px;
  padding: 40px;
  box-sizing: border-box;
}

/* --- Brand ----------------------------------------------------------- */

.spec-entrance-brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  text-align: center;
}

.spec-entrance-spark {
  display: inline-flex;
  color: var(--se-accent);
  filter: drop-shadow(0 0 8px rgba(124, 140, 255, 0.55));
  animation: se-pulse 3.2s ease-in-out infinite;
}

@keyframes se-pulse {
  0%, 100% { opacity: 0.85; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.1); }
}

.spec-entrance-title {
  margin: 0;
  font-size: 26px;
  font-weight: 650;
  letter-spacing: 0.01em;
  background: linear-gradient(100deg, var(--se-txt) 35%, var(--se-accent) 50%, var(--se-txt) 65%);
  background-size: 220% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: se-shimmer 6s ease-in-out infinite;
}

@keyframes se-shimmer {
  0%, 100% { background-position: 0% 0; }
  50% { background-position: 100% 0; }
}

.spec-entrance-lead {
  margin: 2px 0 0;
  color: var(--se-txt-dim);
  font-size: 13px;
  letter-spacing: 0.02em;
}

/* --- Draft cards ------------------------------------------------------ */

.spec-entrance-drafts {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 14px;
  max-width: 880px;
}

.spec-entrance-drafts:empty {
  display: none;
}

.spec-entrance-card {
  position: relative;
  width: 250px;
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 14px 16px;
  background: var(--se-card-bg);
  border: 1px solid var(--se-card-border);
  border-radius: 12px;
  cursor: pointer;
  transition:
    transform 0.22s cubic-bezier(0.18, 0.7, 0.27, 1),
    border-color 0.22s ease,
    box-shadow 0.25s ease;
}

.spec-entrance-card:hover,
.spec-entrance-card:focus-visible {
  transform: translateY(-3px);
  border-color: rgba(124, 140, 255, 0.55);
  box-shadow: 0 12px 32px -12px rgba(124, 140, 255, 0.35);
  outline: none;
}

.spec-entrance-card-summary {
  color: var(--se-txt);
  font-size: 13px;
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 2.9em;
}

.spec-entrance-card-meta {
  color: var(--se-txt-dim);
  font-size: 11px;
}

.spec-entrance-card-dots {
  display: flex;
  gap: 5px;
}

.spec-entrance-card-dots .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--se-dot-bg);
  border: 1px solid var(--se-dot-border);
}

.spec-entrance-card-dots .dot.filled {
  background: var(--se-good);
  border-color: var(--se-good);
  box-shadow: 0 0 6px rgba(78, 201, 160, 0.5);
}

.spec-entrance-card-del {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: 7px;
  color: var(--se-txt-dim);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.18s ease, color 0.18s ease, background 0.18s ease;
}

.spec-entrance-card:hover .spec-entrance-card-del,
.spec-entrance-card-del:focus-visible {
  opacity: 1;
}

.spec-entrance-card-del:hover {
  color: var(--danger, #e5534b);
  background: rgba(229, 83, 75, 0.1);
}

/* --- Hero CTA ---------------------------------------------------------- */

.spec-entrance-cta {
  position: relative;
  overflow: hidden;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 13px 34px;
  border: none;
  border-radius: 999px;
  background: linear-gradient(180deg, var(--se-accent), var(--se-accent-soft));
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.01em;
  cursor: pointer;
  box-shadow: 0 6px 24px -6px rgba(124, 140, 255, 0.55);
  transition: transform 0.18s ease, box-shadow 0.25s ease;
}

.spec-entrance-cta:hover {
  transform: translateY(-1px);
  box-shadow: 0 10px 32px -6px rgba(124, 140, 255, 0.7);
}

.spec-entrance-cta-spark {
  display: inline-flex;
}

/* Periodic shimmer sweep across the CTA. */
.spec-entrance-cta::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: linear-gradient(115deg, transparent 30%, rgba(255, 255, 255, 0.35) 50%, transparent 70%);
  background-size: 250% 100%;
  animation: se-sweep 4.2s ease-in-out infinite;
}

@keyframes se-sweep {
  0%, 60%, 100% { background-position: 160% 0; }
  25% { background-position: -60% 0; }
}

/* --- Blank link & hint -------------------------------------------------- */

.spec-entrance-blank {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--se-txt-dim);
  font-size: 12px;
  letter-spacing: 0.02em;
  opacity: 0.75;
  transition: opacity 0.18s ease, color 0.18s ease;
}

.spec-entrance-blank:hover {
  opacity: 1;
  color: var(--se-txt);
}

.spec-entrance-hint {
  position: absolute;
  right: 18px;
  bottom: 14px;
  opacity: 0.6;
}

.spec-entrance-hint kbd {
  font-family: var(--mono, ui-monospace, "SF Mono", Menlo, monospace);
  font-size: 11px;
  color: var(--se-txt-dim);
  border: 1px solid var(--se-card-border);
  border-radius: 5px;
  padding: 2px 7px;
  background: var(--se-card-bg);
}

/* --- Reduced motion ------------------------------------------------------ */

@media (prefers-reduced-motion: reduce) {
  .spec-entrance .spec-entrance-spark,
  .spec-entrance .spec-entrance-title,
  .spec-entrance .spec-entrance-cta::after {
    animation: none;
  }

  .spec-entrance .spec-entrance-rise {
    transition-duration: 0.01s;
    transition-delay: 0ms;
  }
}

/* --- True Dark (OLED): neutral lifts, never accent tints on surfaces. --- */

body.theme-true-dark .spec-entrance {
  --se-bg: rgba(0, 0, 0, 0.92);
  --se-card-bg: #0a0a0a;
  --se-card-border: #1a1a1a;
}

body.theme-true-dark .spec-entrance-card:hover,
body.theme-true-dark .spec-entrance-card:focus-visible {
  border-color: rgba(231, 232, 236, 0.28);
  box-shadow: 0 12px 32px -12px rgba(231, 232, 236, 0.12);
}

/* --- Light theme --------------------------------------------------------- */

body.theme-light .spec-entrance {
  --se-bg: rgba(244, 246, 250, 0.88);
  --se-accent: #4656d8;
  --se-accent-soft: #3e3aa8;
  --se-txt: #1c2027;
  --se-txt-dim: #5a6170;
  --se-card-bg: rgba(255, 255, 255, 0.92);
  --se-card-border: #d6dae2;
  --se-dot-bg: rgba(20, 25, 40, 0.1);
  --se-dot-border: rgba(20, 25, 40, 0.18);
}

body.theme-light .spec-entrance-card {
  box-shadow: 0 2px 10px rgba(15, 20, 30, 0.08);
}

body.theme-light .spec-entrance-card:hover,
body.theme-light .spec-entrance-card:focus-visible {
  border-color: rgba(70, 86, 216, 0.5);
  box-shadow: 0 12px 28px -12px rgba(70, 86, 216, 0.3);
}

body.theme-light .spec-entrance-spark {
  filter: drop-shadow(0 0 8px rgba(70, 86, 216, 0.4));
}

body.theme-light .spec-entrance-cta {
  box-shadow: 0 6px 24px -6px rgba(70, 86, 216, 0.45);
}
```

- [ ] **Step 2: Verify tests still pass (CSS import unchanged)**

Run: `npx vitest run ui/src/spec-chat/entrance.test.ts`
Expected: PASS (CSS content doesn't affect jsdom tests).

---

### Task 4: Integrate into `index.ts` + adapt `index.test.ts`

**Files:**
- Modify: `ui/src/spec-chat/index.ts`
- Modify: `ui/src/spec-chat/index.test.ts`

- [ ] **Step 1: Adapt the existing tests to the new DOM (failing first)**

In `ui/src/spec-chat/index.test.ts`, make these changes:

1. Replace every occurrence of selector `.spec-chat-chooser` with `.spec-entrance` (tests 1, 2, 3, 4, 6b, 7a, 7b, 6c).
2. Test 2: replace the button-text assertions with card-summary assertions:

```typescript
    const cards = host.querySelectorAll<HTMLElement>(".spec-entrance-card-summary");
    const texts = Array.from(cards).map((c) => c.textContent ?? "");

    expect(texts.some((t) => t.includes("Alpha project spec"))).toBe(true);
    expect(texts.some((t) => t.includes("Beta project spec"))).toBe(true);
```

3. Test 3: replace the resume-button lookup + click with:

```typescript
    const card = host.querySelector<HTMLElement>(".spec-entrance-card");
    expect(card).not.toBeNull();
    card!.click();
```

   and replace the immediate chooser-gone assertion with a waitFor (exit fade defers DOM removal):

```typescript
    await vi.waitFor(() => expect(host.querySelector(".spec-entrance")).toBeNull());
```

4. Test 4: replace the blank-button lookup with:

```typescript
    const blankBtn = host.querySelector<HTMLButtonElement>(".spec-entrance-blank");
```

   and replace `expect(host.querySelector(".spec-chat-chooser")).toBeNull();` with:

```typescript
    await vi.waitFor(() => expect(host.querySelector(".spec-entrance")).toBeNull());
```

5. Test 6b (Escape): replace the immediate assertion with:

```typescript
    await vi.waitFor(() => expect(host.querySelector(".spec-entrance")).toBeNull());
    expect(ctrl.isOpen()).toBe(false);
```

   (`isOpen()` flips synchronously; only DOM removal is deferred.)

6. Test 7a: selector `.spec-chat-chooser-del` → `.spec-entrance-card-del`; final assertion becomes:

```typescript
    await vi.waitFor(() => expect(host.querySelector(".spec-entrance")).toBeNull());
```

7. Test 7b: selectors `.spec-chat-chooser-del` → `.spec-entrance-card-del` and `.spec-chat-chooser-row` → `.spec-entrance-card`.
8. Test 6c (backdrop): the click target is the root itself (still "backdrop" — outside `.spec-entrance-content`):

```typescript
    const entrance = host.querySelector(".spec-entrance") as HTMLElement;
    entrance.click();

    await vi.waitFor(() => expect(host.querySelector(".spec-entrance")).toBeNull());
    expect(ctrl.isOpen()).toBe(false);
```

- [ ] **Step 2: Run to verify the adapted tests fail**

Run: `npx vitest run ui/src/spec-chat/index.test.ts`
Expected: FAIL — index.ts still renders `.spec-chat-chooser`.

- [ ] **Step 3: Rewire index.ts**

In `ui/src/spec-chat/index.ts`:

1. Remove the `Icons` import (line 15) — no longer used.
2. Add after the immersive import:

```typescript
import { mountSpecEntrance } from "./entrance";
import type { EntranceInstance } from "./entrance";
```

3. Delete the `relativeTime` and `shortSummary` helpers (lines 51–71) — they moved to `entrance.ts`. Keep `isInProgress`.
4. Inside `mountSpecChat`, replace the chooser plumbing. Delete:
   - `let chooserEl: HTMLElement | null = null;`
   - `let chooserKeyHandler: ... = null;`
   - the whole `removeChooser()` function
   - the whole `renderChooser()` function

   Replace with:

```typescript
  let entrance: EntranceInstance | null = null;
  let entranceMounted = false;

  function removeEntrance(): void {
    entranceMounted = false;
    if (entrance) {
      entrance.dismiss();
      entrance = null;
    }
  }

  function renderEntrance(drafts: SpecDraftSummary[]): void {
    removeEntrance();
    entrance = mountSpecEntrance(host, drafts, {
      onResume: (id) => {
        removeEntrance();
        openImmersive(id);
      },
      onNew: () => {
        removeEntrance();
        openImmersive(null);
      },
      onBlank: () => {
        controller.close();
        deps.openBlankWizard();
      },
      onDismiss: () => controller.close(),
      deleteDraft: (id) => deleteDraft(id),
      onEmptied: () => {
        removeEntrance();
        openImmersive(null);
      },
    });
    entranceMounted = true;
    host.hidden = false;
  }
```

5. Update the controller:

```typescript
  const controller: SpecChatController = {
    isOpen: () => panelMounted || entranceMounted,

    open() {
      if (controller.isOpen()) return;

      void listDrafts().then((all) => {
        const inProgress = all.filter(isInProgress);
        if (inProgress.length > 0) {
          renderEntrance(inProgress);
        } else {
          openImmersive(null);
        }
      }).catch(() => {
        // On error, open a fresh immersive session
        openImmersive(null);
      });
    },

    close() {
      removeEntrance();
      if (panelMounted) {
        currentPanel.close();
        panelMounted = false;
      }
      host.hidden = true;
    },
  };
```

(Note: a separate `entranceMounted` flag — not `entrance !== null` — keeps `isOpen()` semantics correct while the dismissed root is still fading out in the DOM.)

- [ ] **Step 4: Run the full spec-chat suite**

Run: `npx vitest run ui/src/spec-chat/`
Expected: ALL tests pass (entrance.test.ts + adapted index.test.ts + the untouched panel/state/stream/immersive suites).

---

### Task 5: Retire the old chooser CSS

**Files:**
- Modify: `ui/src/styles.css` (delete the `.spec-chat-chooser*` block, ≈ lines 12886–13018)

- [ ] **Step 1: Confirm nothing else references the old classes**

Run: `grep -rn "spec-chat-chooser" ui/src --include="*.ts"`
Expected: no matches (index.ts was rewired in Task 4; tests adapted).

- [ ] **Step 2: Delete the CSS block**

In `ui/src/styles.css`, delete everything from the `.spec-chat-chooser {` rule through the last `body.theme-light .spec-chat-chooser-btn--blank { ... }` rule (the contiguous block, currently lines ≈12886–13018, including the section comment above it if one exists). Verify afterwards:

Run: `grep -n "spec-chat-chooser" ui/src/styles.css`
Expected: no matches.

- [ ] **Step 3: Re-run the suite**

Run: `npx vitest run ui/src/spec-chat/`
Expected: PASS.

---

### Task 6: Full verification + single feature commit

**Files:** none new.

- [ ] **Step 1: Full test suite**

Run: `npx vitest run`
Expected: everything green (note from project memory: if any telegram/long-poll Rust-adjacent tests appear to hang, that is a known pre-existing gotcha — frontend vitest is what matters here and must be fully green).

- [ ] **Step 2: Typecheck + production build**

Run: `npm run build`
Expected: `tsc` clean (no unused-import errors in index.ts, strict mode satisfied) and `vite build` succeeds.

- [ ] **Step 3: Single feature commit (user's commit-granularity preference)**

```bash
git add ui/src/spec-chat/entrance.ts ui/src/spec-chat/entrance.css ui/src/spec-chat/entrance.test.ts ui/src/spec-chat/index.ts ui/src/spec-chat/index.test.ts ui/src/styles.css
git commit -m "feat(spec-creator): constellation entrance — particle sky, draft cards, hero CTA

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: In-app visual verification (manual)**

Run the app (`respawn` skill / `npm run tauri:dev` from the worktree) and verify:
- Entrance opens with staggered rise + drifting constellation sky
- Draft cards show summary, meta, progress dots; hover lift + trash reveal
- CTA shimmer sweep; blank link quiet; esc hint visible
- Esc / backdrop dismiss; resume → immersive cross-fade
- All three themes (default dark, True Dark, light)

This step is observational; record outcome (the project tracks in-app verification status in memory).
