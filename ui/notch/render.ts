import type { StackStore } from "./store";
import { renderPill } from "./pill";

export function mountRender(stack: HTMLElement, store: StackStore): void {
  const update = () => {
    const pills = store.pills();
    stack.innerHTML = pills.map(renderPill).join("");
  };
  store.subscribe(update);
  stack.addEventListener("click", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".pill");
    if (!el) return;
    const sid = el.dataset.sid!;
    const pill = store.pills().find((p) => p.sessionId === sid);
    if (!pill) return;
    if (pill.phase.kind === "done") store.dismiss(sid);
    else if (pill.compact) store.expandSticky(sid);
  });
  update();
}
