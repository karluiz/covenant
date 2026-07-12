// Custom tooltip — replaces native `title=` attributes on chrome
// elements (status bar, score heatmap, etc.). One singleton DOM node
// is positioned above the hovered target, with a 350ms open delay so
// it never gets in the way of a quick mouse-by.

import { zoom } from "../zoom";

export type TooltipContent =
  | string
  | {
      title?: string;
      subtitle?: string;
      meta?: string;
      preview?: string;
      hint?: string;
      kbd?: string;
    };

const OPEN_DELAY_MS = 350;
const CLOSE_DELAY_MS = 60;
const EDGE_PAD = 8;
const POINTER_SLOP = 6;

let host: HTMLElement | null = null;
let openTimer: number | null = null;
let closeTimer: number | null = null;
let activeTarget: HTMLElement | null = null;
let watchRaf: number | null = null;
let lastMouseX: number | null = null;
let lastMouseY: number | null = null;
// The rect-based hide in startWatch() only fires when we trust lastMouse.
// Over a `-webkit-app-region: drag` ancestor (the titlebar) macOS suppresses
// mousemove, so lastMouse is stale-outside when mouseenter opens the tooltip —
// arming on stale coords would hide it on the first frame. Armed = pointer was
// genuinely over the target at show(), or a fresh mousemove arrived since.
let watchArmed = false;

function ensureHost(): HTMLElement {
  if (host) return host;
  const el = document.createElement("div");
  el.className = "ck-tooltip";
  el.setAttribute("role", "tooltip");
  el.setAttribute("aria-hidden", "true");
  document.body.appendChild(el);
  host = el;
  return el;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderContent(content: TooltipContent): string {
  if (typeof content === "string") {
    return `<div class="ck-tooltip__body">${escapeHtml(content)}</div>`;
  }
  const parts: string[] = [];
  if (content.title) {
    parts.push(`<div class="ck-tooltip__title">${escapeHtml(content.title)}</div>`);
  }
  if (content.subtitle) {
    parts.push(`<div class="ck-tooltip__subtitle">${escapeHtml(content.subtitle)}</div>`);
  }
  if (content.meta) {
    parts.push(`<div class="ck-tooltip__meta">${escapeHtml(content.meta)}</div>`);
  }
  if (content.preview) {
    parts.push(`<div class="ck-tooltip__preview">${escapeHtml(content.preview)}</div>`);
  }
  if (content.hint || content.kbd) {
    parts.push(
      `<div class="ck-tooltip__hint">` +
        `<span>${escapeHtml(content.hint ?? "")}</span>` +
        (content.kbd ? `<kbd>${escapeHtml(content.kbd)}</kbd>` : "") +
        `</div>`,
    );
  }
  return parts.join("");
}

/// Pure clamp math in LAYOUT px. `rect` comes from getBoundingClientRect(),
/// which WebKit reports in visual (zoomed) px, while the fixed tooltip's
/// left/top are layout px — so everything is divided by the zoom level
/// (same semantics as the pane-menu fix, manager.ts / 970e45b).
export function computeTooltipPos(
  rect: { top: number; bottom: number; left: number; width: number },
  tw: number,
  th: number,
  z: number,
  visualVw: number,
  visualVh: number,
): { top: number; left: number; below: boolean } {
  const rTop = rect.top / z;
  const rBottom = rect.bottom / z;
  const rLeft = rect.left / z;
  const rWidth = rect.width / z;
  const vw = visualVw / z;
  const vh = visualVh / z;
  // Prefer above; flip below if not enough room
  const below = rTop < th + EDGE_PAD + 8;
  let top = below ? rBottom + 8 : rTop - th - 8;
  let left = rLeft + rWidth / 2 - tw / 2;
  if (left < EDGE_PAD) left = EDGE_PAD;
  if (left + tw > vw - EDGE_PAD) left = vw - EDGE_PAD - tw;
  if (top < EDGE_PAD) top = EDGE_PAD;
  if (top + th > vh - EDGE_PAD) top = vh - EDGE_PAD - th;
  return { top, left, below };
}

function position(target: HTMLElement): void {
  const el = ensureHost();
  const rect = target.getBoundingClientRect();
  // Measure
  el.style.visibility = "hidden";
  el.style.display = "block";
  const tw = el.offsetWidth;
  const th = el.offsetHeight;
  const pos = computeTooltipPos(rect, tw, th, zoom.level(), window.innerWidth, window.innerHeight);
  el.style.top = `${Math.round(pos.top)}px`;
  el.style.left = `${Math.round(pos.left)}px`;
  el.classList.toggle("ck-tooltip--below", pos.below);
  el.style.visibility = "";
}

function pointerOutside(r: DOMRect): boolean {
  if (lastMouseX == null || lastMouseY == null) return false;
  return (
    lastMouseX < r.left - POINTER_SLOP ||
    lastMouseX > r.right + POINTER_SLOP ||
    lastMouseY < r.top - POINTER_SLOP ||
    lastMouseY > r.bottom + POINTER_SLOP
  );
}

function show(target: HTMLElement, content: TooltipContent): void {
  const el = ensureHost();
  el.innerHTML = renderContent(content);
  activeTarget = target;
  // Trust the rect-watch only if the pointer is really over the target now.
  // Stale-outside coords (titlebar drag region) leave it disarmed until a
  // fresh mousemove proves where the cursor is.
  watchArmed = lastMouseX != null && !pointerOutside(target.getBoundingClientRect());
  position(target);
  el.classList.add("is-visible");
  el.setAttribute("aria-hidden", "false");
  startWatch();
}

function hide(): void {
  stopWatch();
  if (!host) return;
  host.classList.remove("is-visible");
  host.setAttribute("aria-hidden", "true");
  activeTarget = null;
}

/// Content can move out from under a stationary cursor (scroll,
/// re-layout, streaming re-renders) without any mouse event firing —
/// and WebKit is also known to drop mouseleave in those cases — which
/// leaves the fixed-position tooltip stuck on screen indefinitely.
/// Poll while visible and hide when the target detaches from the DOM
/// or the pointer is no longer over the target's current rect. The
/// rect check is safe because the tooltip is pointer-events: none, so
/// any real cursor exit already fires mouseleave today; it only ever
/// catches the no-event cases above. It skips while an enter/leave
/// timer is in flight so sweeping between adjacent targets keeps the
/// existing cross-fade instead of flickering.
function startWatch(): void {
  stopWatch();
  const tick = () => {
    watchRaf = null;
    if (!activeTarget) return;
    if (!activeTarget.isConnected) {
      hide();
      return;
    }
    if (watchArmed && lastMouseX != null && lastMouseY != null && openTimer == null && closeTimer == null) {
      if (pointerOutside(activeTarget.getBoundingClientRect())) {
        hide();
        return;
      }
    }
    watchRaf = window.requestAnimationFrame(tick);
  };
  watchRaf = window.requestAnimationFrame(tick);
}

function stopWatch(): void {
  if (watchRaf != null) {
    window.cancelAnimationFrame(watchRaf);
    watchRaf = null;
  }
}

function clearTimers(): void {
  if (openTimer != null) {
    window.clearTimeout(openTimer);
    openTimer = null;
  }
  if (closeTimer != null) {
    window.clearTimeout(closeTimer);
    closeTimer = null;
  }
}

/**
 * Attach a custom tooltip to `el`. Strips any existing native `title`
 * so the OS tooltip never races ours. Pass either a string (simple)
 * or a structured object (title/subtitle/meta/preview/hint/kbd).
 *
 * Returns a detach fn for elements that get re-rendered.
 */
export function attachTooltip(el: HTMLElement, content: TooltipContent): () => void {
  // Suppress native tooltip; preserve any prior aria-label.
  if (el.hasAttribute("title")) el.removeAttribute("title");

  const onEnter = () => {
    clearTimers();
    openTimer = window.setTimeout(() => {
      openTimer = null;
      show(el, content);
    }, OPEN_DELAY_MS);
  };
  const onLeave = () => {
    clearTimers();
    closeTimer = window.setTimeout(() => {
      closeTimer = null;
      if (activeTarget === el || activeTarget == null) hide();
    }, CLOSE_DELAY_MS);
  };
  const onDown = () => {
    clearTimers();
    hide();
  };

  el.addEventListener("mouseenter", onEnter);
  el.addEventListener("mouseleave", onLeave);
  el.addEventListener("mousedown", onDown);
  el.addEventListener("focusout", onLeave);

  return () => {
    el.removeEventListener("mouseenter", onEnter);
    el.removeEventListener("mouseleave", onLeave);
    el.removeEventListener("mousedown", onDown);
    el.removeEventListener("focusout", onLeave);
    if (activeTarget === el) hide();
  };
}

// Hide on Escape and on window blur — covers edge cases where the
// mouseleave never fires (window switch, modal opens, etc.).
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hide();
});
window.addEventListener("blur", () => hide());
window.addEventListener(
  "mousemove",
  (e) => {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    // A real move gives trustworthy coords — arm the rect-watch so a genuine
    // pointer-exit (even one WebKit drops the mouseleave for) still closes it.
    watchArmed = true;
  },
  { capture: true, passive: true },
);
