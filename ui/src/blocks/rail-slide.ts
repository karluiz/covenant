// GPU-composited slide choreography for the right rail's global
// collapse/expand (see the .rail-slide-* keyframes in styles.css).
// The grid track SNAPS — one layout, one xterm refit — and the panel
// itself animates transform on the compositor, never layout. Collapse
// slides the panel out and snaps on animationend; expand snaps first,
// then slides the panel in.

const EXIT = "rail-slide-exit";
const ENTER = "rail-slide-enter";

/// Force-finisher for an in-flight slide, so a rapid re-toggle (or an
/// animation cancelled by display:none) never leaves the snap dangling
/// behind a `forwards` transform.
let pending: (() => void) | null = null;

/// The active tab's rail panel, if it's actually rendered. offsetWidth
/// is 0 when a full-page route or sidebar view hides the pane — then
/// there is nothing to animate and callers just snap.
function visiblePanel(): HTMLElement | null {
  const el = document.querySelector<HTMLElement>(
    ".tab-pane:not([hidden]) > .tab-blocks",
  );
  return el && el.offsetWidth > 0 ? el : null;
}

/// Plays one slide on `panel`, calling `onDone` exactly once when the
/// named keyframe ends or is cancelled. Guards on animationName because
/// animationend bubbles — a child animation finishing inside the panel
/// must not end the slide early.
function play(
  panel: HTMLElement,
  cls: string,
  animationName: string,
  onDone: () => void,
): void {
  const finish = (e?: Event): void => {
    if (e && (e as AnimationEvent).animationName !== animationName) return;
    pending = null;
    panel.classList.remove(cls);
    panel.removeEventListener("animationend", finish);
    panel.removeEventListener("animationcancel", finish);
    onDone();
  };
  pending = finish;
  panel.classList.add(cls);
  panel.addEventListener("animationend", finish);
  panel.addEventListener("animationcancel", finish);
}

/// `snap` applies the actual layout change (the blocks-globally-collapsed
/// body class) and is called exactly once per invocation — after the
/// slide-out on collapse, before the slide-in on expand.
export function slideRail(collapse: boolean, snap: () => void): void {
  pending?.();
  if (collapse) {
    const panel = visiblePanel();
    if (!panel) {
      snap();
      return;
    }
    play(panel, EXIT, "rail-slide-out", snap);
  } else {
    snap();
    const panel = visiblePanel();
    if (panel) play(panel, ENTER, "rail-slide-in", () => {});
  }
}
