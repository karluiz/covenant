// GPU-composited slide choreography for sidebar collapse/expand (see
// the .rail-slide-* / .tabbar-slide-* keyframes in styles.css). The
// grid track SNAPS — one layout, one xterm refit — and the panel
// itself animates transform on the compositor, never layout. Collapse
// slides the panel out and snaps on animationend; expand snaps first,
// then slides the panel in.

/// Plays one keyframe animation on `el`: adds `cls`, and calls `onDone`
/// exactly once when the named animation ends or is cancelled (or when
/// the returned force-finisher is invoked — store it and call it before
/// starting a conflicting animation, so a rapid re-toggle never leaves
/// the follow-up work dangling behind a `forwards` transform). Guards
/// on animationName because animationend bubbles — a child animation
/// finishing inside the panel must not end this one early.
export function playAnimation(
  el: HTMLElement,
  cls: string,
  animationName: string,
  onDone: () => void,
): () => void {
  let done = false;
  const finish = (e?: Event): void => {
    if (done) return;
    if (e && (e as AnimationEvent).animationName !== animationName) return;
    done = true;
    el.classList.remove(cls);
    el.removeEventListener("animationend", finish);
    el.removeEventListener("animationcancel", finish);
    onDone();
  };
  el.classList.add(cls);
  el.addEventListener("animationend", finish);
  el.addEventListener("animationcancel", finish);
  return finish;
}

interface SliderCfg {
  exitCls: string;
  exitName: string;
  enterCls: string;
  enterName: string;
  /// Resolves the panel to animate. Called BEFORE the snap on collapse
  /// and AFTER it on expand (the panel may only become visible once the
  /// snap lands). Returning null skips the animation and just snaps.
  panel: () => HTMLElement | null;
}

/// Builds a slide function with its own pending-finish state. Each
/// slider tracks its own pending — a left fold mustn't force-finish a
/// right fold in flight.
function makeSlider(cfg: SliderCfg): (collapse: boolean, snap: () => void) => void {
  let pending: (() => void) | null = null;

  // `snap` applies the actual layout change (a body class) and is called
  // exactly once per invocation — after the slide-out on collapse,
  // before the slide-in on expand.
  return (collapse: boolean, snap: () => void): void => {
    pending?.();
    if (collapse) {
      const panel = cfg.panel();
      if (!panel) {
        snap();
        return;
      }
      pending = playAnimation(panel, cfg.exitCls, cfg.exitName, () => {
        pending = null;
        snap();
      });
    } else {
      snap();
      const panel = cfg.panel();
      if (panel) {
        pending = playAnimation(panel, cfg.enterCls, cfg.enterName, () => {
          pending = null;
        });
      }
    }
  };
}

/// Right rail (per-tab Blocks/Files panel), toggled via
/// body.blocks-globally-collapsed. offsetWidth is 0 when a full-page
/// route or sidebar view hides the pane — nothing to animate.
export const slideRail = makeSlider({
  exitCls: "rail-slide-exit",
  exitName: "rail-slide-out",
  enterCls: "rail-slide-enter",
  enterName: "rail-slide-in",
  panel: () => {
    // :not(.pane-crosscut-out) — during a tab-switch crossfade the
    // OUTGOING pane stays un-hidden for ~140ms (tabs/crossfade.ts);
    // without the exclusion this could resolve the wrong (about-to-be-
    // hidden) pane's rail and animate a panel the user never sees.
    const el = document.querySelector<HTMLElement>(
      ".tab-pane:not([hidden]):not(.pane-crosscut-out) > .tab-blocks",
    );
    return el && el.offsetWidth > 0 ? el : null;
  },
});

/// Left tabbar, toggled via body.tabbar-left-collapsed. Only meaningful
/// in tabbar-left mode — in top mode the fold body class is inert and
/// there is no column to slide.
export const slideTabbar = makeSlider({
  exitCls: "tabbar-slide-exit",
  exitName: "tabbar-slide-out",
  enterCls: "tabbar-slide-enter",
  enterName: "tabbar-slide-in",
  panel: () => {
    if (!document.body.classList.contains("tabbar-left")) return null;
    const el = document.getElementById("tabbar-host");
    return el && el.offsetWidth > 0 ? el : null;
  },
});
