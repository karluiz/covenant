export type MenuItem = { label: string; danger?: boolean; onPick: () => void };

function popover(className: string): HTMLDivElement {
  const pop = document.createElement("div");
  pop.className = `ui-select__popover ${className}`;
  return pop;
}

function place(pop: HTMLElement, x: number, y: number): void {
  pop.style.position = "fixed";
  document.body.append(pop);
  const r = pop.getBoundingClientRect();
  pop.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
  pop.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
}

/// Outside-click + Escape dismissal for a body-portaled popover. Escape
/// stopPropagations so it never bubbles into surface-level Esc handling.
export function dismissable(pop: HTMLElement): () => void {
  const close = (): void => {
    pop.remove();
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
  };
  const onDown = (e: PointerEvent): void => {
    if (!pop.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  return close;
}

/// Context menu on .ui-select__* chrome (DESIGN rule 14).
export function showMenu(x: number, y: number, items: MenuItem[]): void {
  const pop = popover("somnus-menu");
  const close = dismissable(pop);
  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `ui-select__option${item.danger ? " is-danger" : ""}`;
    btn.textContent = item.label;
    btn.addEventListener("click", () => {
      close();
      item.onPick();
    });
    pop.append(btn);
  }
  place(pop, x, y);
}
