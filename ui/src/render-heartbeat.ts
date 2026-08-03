/// Keeps WebKit's rendering-update cycle from going cold.
///
/// Evidence chain (2026-08-02, installed app, `sample` on all six processes
/// during a live 1974ms first-switch-after-idle repro):
///   * repaint scales with idle-time-since-last-switch — p50 246ms under 10s
///     idle vs ~2s beyond 5m, saturating ~2-2.5s (90-day vitals, 685 samples);
///   * during the 1.9s frame1 gap NOTHING ran: Tauri main thread idle in its
///     event loop, WebKit GPU processes idle, WebContent main thread idle,
///     JS timers punctual (gapStarvedMs 89). The first rendering update was
///     simply never scheduled for ~2s;
///   * occlusion is ruled out — the 0.11.10 `_setWindowOcclusionDetectionEnabled:`
///     opt-out shipped, applied (selector verified live) and changed nothing.
/// The remaining mechanism is WebKit marking the visible-but-static page
/// visually idle and being slow to re-engage its update cycle.
///
/// Countermeasure: a 1×1 composited layer whose transform flips every second.
/// A transform change on a composited layer produces a real (tiny) layer-tree
/// commit — the same UI-process `commitLayerTree` path a tab switch needs —
/// without painting a visible pixel. One commit per second is the price; the
/// vitals `repaint` idle-bucket p50 collapsing toward the warm ~250ms is the
/// regression test. If it does not collapse, take this out rather than keep
/// it as cargo cult (same contract as mac_render.rs).
export function startRenderHeartbeat(intervalMs = 1000): () => void {
  const el = document.createElement("div");
  el.setAttribute("aria-hidden", "true");
  el.style.cssText =
    "position:fixed;left:0;top:0;width:1px;height:1px;" +
    "pointer-events:none;will-change:transform;transform:translateZ(0)";
  document.body.appendChild(el);
  let flip = false;
  const id = window.setInterval(() => {
    flip = !flip;
    // Sub-pixel translate: invisible, but a layer-property change WebKit
    // must commit. Overwrites the same property, so nothing accumulates
    // while updates are suspended (e.g. window occluded).
    el.style.transform = flip ? "translate3d(0.4px,0,0)" : "translateZ(0)";
  }, intervalMs);
  return () => {
    window.clearInterval(id);
    el.remove();
  };
}
