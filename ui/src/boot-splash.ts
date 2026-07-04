// Boot splash dismiss helper. The splash markup + all of its CSS live
// directly in `index.html` so it paints on the first frame, before
// main.ts loads and wires the app. This module is the single dismiss
// path — call `dismissBootSplash()` once tab restore + first paint
// settle (or on boot failure), and the overlay plays its CSS exit and
// removes itself from the DOM.
//
// Lifecycle (ports the covenant-splash motion design's port_contract):
//   ACT 1 "first prompt"    0–1.5s   plays once on load (CSS keyframes)
//   ACT 2 "heartbeat idle"  1.5s+    1.35s-period infinite loop
//   EXIT  "light folds home" 800ms   `.bsplash-leaving` → condensed ACT 3
//
// Exit arming: exit keyframes are authored to launch from the canonical
// idle baseline. MIN_VISIBLE_MS = 1600ms guarantees ACT 1 has fully
// settled (baseline reached at 1.5s) before the leaving class lands.
// From idle, we fire immediately rather than quantizing to the next
// 1.35s systole boundary: idle amplitudes are ≤6% (cursor excepted —
// and hard cuts are a square wave's native language), which the
// port_contract blesses as sub-perceptual, and it avoids adding up to
// 1.35s of latency to every boot.

const MIN_VISIBLE_MS = 1600;
// Matches the 800ms bsp-exit-* keyframes in index.html (+ a small
// grace so the final frame isn't clipped before removal).
const EXIT_MS = 800;
const EXIT_GRACE_MS = 50;

const mountedAt = performance.now();
let dismissed = false;

export function dismissBootSplash(): void {
  if (dismissed) return;
  dismissed = true;
  const el = document.getElementById("boot-splash");
  if (!el) return;
  const elapsed = performance.now() - mountedAt;
  const wait = Math.max(0, MIN_VISIBLE_MS - elapsed);
  window.setTimeout(() => {
    el.classList.add("bsplash-leaving");
    window.setTimeout(() => {
      el.remove();
    }, EXIT_MS + EXIT_GRACE_MS);
  }, wait);
}
