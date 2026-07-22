/// Positions the single Glass-theme sliding indicator under the active tab.
/// No-op unless `body.tab-style-glass` is set. Idempotent: reuses (or creates)
/// one `.tab-glass-indicator` child of the tabbar host. Horizontal layout
/// animates left/width; vertical animates top/height — the same rect-driven
/// code serves both (`body.tabbar-left` only changes the rect shape).
export function positionGlassIndicator(host: HTMLElement): void {
  const glass = document.body.classList.contains("tab-style-glass");
  let ind = host.querySelector<HTMLElement>(":scope > .tab-glass-indicator");
  if (!glass) { ind?.remove(); return; }
  if (!ind) {
    ind = document.createElement("div");
    ind.className = "tab-glass-indicator";
    host.insertBefore(ind, host.firstChild);
  }
  const active = host.querySelector<HTMLElement>(".tab-btn.active");
  if (!active) { ind.style.opacity = "0"; return; }
  // Folded group member: the pill is a zero-size sliver, so the capsule
  // springs onto the group chip that now represents the active tab.
  const target = active.classList.contains("tab-pill-folded")
    ? (active
        .closest(".tab-group-shell")
        ?.querySelector<HTMLElement>(".group-chip") ?? null)
    : active;
  if (!target) { ind.style.opacity = "0"; return; }
  const hr = host.getBoundingClientRect();
  const ar = target.getBoundingClientRect();
  const color = getComputedStyle(active).getPropertyValue("--tab-color").trim() || "var(--accent)";
  ind.style.setProperty("--gi-color", color);
  ind.style.top = `${ar.top - hr.top + host.scrollTop}px`;
  ind.style.left = `${ar.left - hr.left + host.scrollLeft}px`;
  ind.style.width = `${ar.width}px`;
  ind.style.height = `${ar.height}px`;
  ind.style.opacity = "1";
}
