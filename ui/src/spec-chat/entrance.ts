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
import { SECTIONS } from "./sections";

export interface EntranceCallbacks {
  onResume: (draftId: string) => void;
  onNew: () => void;
  onBlank: () => void;
  onDismiss: () => void;
  deleteDraft: (id: string) => Promise<void>;
  onEmptied: () => void;
}

export interface EntranceInstance {
  /** Detaches the Esc listener, inerts all interactions, starts the exit fade; DOM removed after it. */
  dismiss: () => void;
}

/** Display titles, single-sourced from the shared sections util. */
const SECTION_TITLES = SECTIONS.map((s) => s.title);

export function sectionProgress(partialMd: string | null): boolean[] {
  if (!partialMd) return SECTION_TITLES.map(() => false);
  return SECTION_TITLES.map((t) =>
    new RegExp(`^##\\s+${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "mi").test(partialMd),
  );
}

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

interface Particle {
  x: number;
  y: number;
  /** Corner spawn point the intro starts from. */
  sx: number;
  sy: number;
  /** Home position the intro converges to; drift takes over from there. */
  hx: number;
  hy: number;
  /** Per-particle intro stagger (ms). */
  delay: number;
  /** Current opacity factor (0..1), ramps in during the intro. */
  a: number;
  vx: number;
  vy: number;
  r: number;
  fill: string;
}

const PARTICLE_COUNT = 80;
const LINK_DIST = 110;
// The sky opens already mostly assembled: particles spawn pulled slightly
// toward their nearest corner and settle home over a short, staggered intro.
const INTRO_MS = 1400;
const INTRO_STAGGER_MS = 500;

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
  const ps: Particle[] = [];
  const size = (): void => {
    const oldW = w;
    const oldH = h;
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Redistribute existing particles to the new bounds (no-op before seeding).
    if (oldW > 0 && oldH > 0) {
      const kx = w / oldW;
      const ky = h / oldH;
      for (const p of ps) {
        p.x *= kx;
        p.y *= ky;
        p.sx *= kx;
        p.sy *= ky;
        p.hx *= kx;
        p.hy *= ky;
      }
    }
  };
  size();

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const r = 0.6 + Math.random() * 1.4;
    const hx = Math.random() * Math.max(w, 1);
    const hy = Math.random() * Math.max(h, 1);
    // Spawn pulled 22–40% from home toward the nearest corner: the field is
    // recognizable immediately and the intro reads as a settle, not a build.
    const cx = hx < w / 2 ? 0 : w;
    const cy = hy < h / 2 ? 0 : h;
    const pull = 0.22 + Math.random() * 0.18;
    const sx = hx + (cx - hx) * pull + (Math.random() - 0.5) * 40;
    const sy = hy + (cy - hy) * pull + (Math.random() - 0.5) * 40;
    ps.push({
      x: reduced ? hx : sx,
      y: reduced ? hy : sy,
      sx,
      sy,
      hx,
      hy,
      delay: Math.random() * INTRO_STAGGER_MS,
      a: reduced ? 1 : 0,
      vx: (Math.random() - 0.5) * 0.18,
      vy: (Math.random() - 0.5) * 0.14,
      r,
      fill: `rgba(${rgb},${Math.min(1, dotAlpha + r * 0.08).toFixed(3)})`,
    });
  }

  // 0..1 across the whole intro; links ramp with √intro so the web is
  // visible almost immediately and just sharpens as particles settle.
  let intro = reduced ? 1 : 0;

  const draw = (): void => {
    ctx.clearRect(0, 0, w, h);
    const linkScale = Math.sqrt(intro);
    if (linkScale > 0.02) {
      ctx.lineWidth = 1;
      for (let i = 0; i < ps.length; i++) {
        for (let j = i + 1; j < ps.length; j++) {
          const dx = ps[i]!.x - ps[j]!.x;
          const dy = ps[i]!.y - ps[j]!.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < LINK_DIST * LINK_DIST) {
            const a = (1 - Math.sqrt(d2) / LINK_DIST) * linkAlpha * linkScale;
            ctx.strokeStyle = `rgba(${rgb},${a.toFixed(3)})`;
            ctx.beginPath();
            ctx.moveTo(ps[i]!.x, ps[i]!.y);
            ctx.lineTo(ps[j]!.x, ps[j]!.y);
            ctx.stroke();
          }
        }
      }
    }
    for (const p of ps) {
      ctx.globalAlpha = p.a;
      ctx.fillStyle = p.fill;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };

  const t0 = typeof performance !== "undefined" ? performance.now() : 0;

  const step = (): void => {
    const elapsed = (typeof performance !== "undefined" ? performance.now() : 0) - t0;
    intro = Math.min(1, elapsed / (INTRO_MS + INTRO_STAGGER_MS));
    if (intro < 1) {
      // Converge corner spawns toward home, eased and staggered per particle.
      for (const p of ps) {
        const k = Math.min(1, Math.max(0, (elapsed - p.delay) / INTRO_MS));
        const e = 1 - (1 - k) ** 3;
        p.x = p.sx + (p.hx - p.sx) * e;
        p.y = p.sy + (p.hy - p.sy) * e;
        p.a = 0.45 + 0.55 * e;
      }
      return;
    }
    for (const p of ps) {
      p.a = 1;
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

export const EXIT_MS = 320;
const RISE_STAGGER_MS = 60;

export function mountSpecEntrance(
  host: HTMLElement,
  drafts: SpecDraftSummary[],
  cb: EntranceCallbacks,
): EntranceInstance {
  // Hoisted above the DOM construction so every handler below can close over
  // it: once true, the entrance is mid exit-fade and all interactions are inert.
  let dismissed = false;

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
      if (dismissed) return;
      del.disabled = true; // prevent double-fire while the delete is in flight
      try {
        await cb.deleteDraft(draft.id);
        if (dismissed) return;
        card.remove();
        if (cardsEl.querySelectorAll(".spec-entrance-card").length === 0) cb.onEmptied();
      } catch {
        // silently ignore deletion failures (same as the old chooser)
        del.disabled = false;
      }
    });
    card.appendChild(del);

    const activate = (): void => {
      if (dismissed) return;
      cb.onResume(draft.id);
    };
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
  cta.addEventListener("click", () => {
    if (dismissed) return;
    cb.onNew();
  });
  content.appendChild(cta);

  const blank = document.createElement("button");
  blank.type = "button";
  blank.className = "spec-entrance-blank spec-entrance-rise";
  blank.textContent = "blank draft (no chat)";
  blank.addEventListener("click", () => {
    if (dismissed) return;
    cb.onBlank();
  });
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
    if (dismissed) return;
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
