// GPU-composited crossfade for tab activation's cross-cut (see the
// pane-crosscut keyframe in styles.css). The incoming pane — already
// fitted and rendered while visibility:hidden — fades in ON TOP of the
// still-painted outgoing pane: opacity only, no layout, no xterm refit.
// `onDone` (which hides the outgoing pane) runs exactly once, on
// animationend, animationcancel, or via the returned force-finisher —
// TabManager stores that and invokes it at the top of activate() so
// rapid switching degrades to hard cuts and pickPaintedPaneId's
// single-painted-pane invariant holds.
//
// pane-crosscut-out on the outgoing pane demotes it into its own
// stacking context below the fade — without it, the outgoing pane's
// positioned overlays (finder z:30, editor z:10, cd-picker z:7) would
// paint above the incoming pane's z:5 and pop off at animationend. It
// also lets the sidebar sliders exclude the not-yet-hidden outgoing
// pane from their "visible pane" query.

const IN_CLS = "pane-crosscut";
const OUT_CLS = "pane-crosscut-out";

export function playCrossfade(
  incoming: HTMLElement,
  outgoing: HTMLElement,
  onDone: () => void,
): () => void {
  let done = false;
  const finish = (e?: Event): void => {
    if (done) return;
    // animationend bubbles — a child animation finishing inside the
    // pane must not end the crossfade early.
    if (e && (e as AnimationEvent).animationName !== IN_CLS) return;
    done = true;
    incoming.classList.remove(IN_CLS);
    outgoing.classList.remove(OUT_CLS);
    incoming.removeEventListener("animationend", finish);
    incoming.removeEventListener("animationcancel", finish);
    onDone();
  };
  incoming.classList.add(IN_CLS);
  outgoing.classList.add(OUT_CLS);
  incoming.addEventListener("animationend", finish);
  incoming.addEventListener("animationcancel", finish);
  return finish;
}
