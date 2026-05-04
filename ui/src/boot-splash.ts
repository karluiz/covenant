// Boot splash dismiss helper. The splash markup lives directly in
// `index.html` so it paints on the first frame, before main.ts loads
// and wires the app. This module is the single dismiss path — call
// `dismissBootSplash()` once tab restore + first paint settle, and
// the overlay fades out and removes itself from the DOM.
//
// A minimum on-screen time keeps the splash from "blinking" when boot
// is fast enough that the user only sees a flash. Anything under
// MIN_VISIBLE_MS gets padded so the brand actually registers.

const MIN_VISIBLE_MS = 600;
const FADE_MS = 320;
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
    el.classList.add("is-leaving");
    window.setTimeout(() => {
      el.remove();
    }, FADE_MS);
  }, wait);
}
