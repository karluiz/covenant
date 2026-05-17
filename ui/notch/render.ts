import type { StackStore } from "./store";
import { renderPill } from "./pill";

export function mountRender(stack: HTMLElement, store: StackStore): void {
  const MAX_VISIBLE = 5;
  const update = () => {
    const pills = store.pills();
    const visible = pills.slice(0, MAX_VISIBLE);
    const overflow = pills.length - visible.length;
    let html = visible.map(renderPill).join("");
    if (overflow > 0) {
      html += `<div class="pill compact overflow" style="--tab:#888"><span class="verb">+${overflow} more</span></div>`;
    }
    stack.innerHTML = html;
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
