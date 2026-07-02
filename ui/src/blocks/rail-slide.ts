// GPU-composited slide choreography for sidebar collapse/expand (see
// the .rail-slide-* / .tabbar-slide-* keyframes in styles.css). The
// grid track SNAPS — one layout, one xterm refit — and the panel
// itself animates transform on the compositor, never layout. Collapse
// slides the panel out and snaps on animationend; expand snaps first,
// then slides the panel in.

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

/// Builds a slide function with its own pending-finish state, so a
/// rapid re-toggle (or an animation cancelled by display:none) never
/// leaves the snap dangling behind a `forwards` transform. Each slider
/// tracks its own pending — a left fold mustn't force-finish a right
/// fold in flight.
function makeSlider(cfg: SliderCfg): (collapse: boolean, snap: () => void) => void {
  let pending: (() => void) | null = null;

  // Plays one slide on `panel`, calling `onDone` exactly once when the
  // named keyframe ends or is cancelled. Guards on animationName because
  // animationend bubbles — a child animation finishing inside the panel
  // must not end the slide early.
  const play = (
    panel: HTMLElement,
    cls: string,
    animationName: string,
    onDone: () => void,
  ): void => {
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
  };

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
      play(panel, cfg.exitCls, cfg.exitName, snap);
    } else {
      snap();
      const panel = cfg.panel();
      if (panel) play(panel, cfg.enterCls, cfg.enterName, () => {});
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
    const el = document.querySelector<HTMLElement>(
      ".tab-pane:not([hidden]) > .tab-blocks",
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
