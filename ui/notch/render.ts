import type { Pill, StackStore } from "./store";
import { renderPill } from "./pill";

const MAX_VISIBLE = 5;

interface NodeState {
  el: HTMLElement;
  phaseKey: string;
  metaKey: string;
}

function phaseKey(p: Pill): string {
  // Identity for the loader + verb + target. If unchanged we leave the inner
  // DOM alone so the CSS animation keeps its phase instead of restarting.
  return JSON.stringify(p.phase) + "|" + (p.compact ? "c" : "e");
}

function metaKey(p: Pill): string {
  return p.tabLabel + "|" + p.tabColor;
}

function makeNode(p: Pill): HTMLElement {
  const tmp = document.createElement("div");
  tmp.innerHTML = renderPill(p).trim();
  return tmp.firstElementChild as HTMLElement;
}

export function mountRender(stack: HTMLElement, store: StackStore): void {
  const nodes = new Map<string, NodeState>();
  let overflowEl: HTMLElement | null = null;

  const update = () => {
    const pills = store.pills();
    const visible = pills.slice(0, MAX_VISIBLE);
    const overflow = pills.length - visible.length;
    const seen = new Set<string>();

    // Reconcile pills in order.
    let prevSibling: ChildNode | null = null;
    for (const p of visible) {
      seen.add(p.sessionId);
      const pk = phaseKey(p);
      const mk = metaKey(p);
      let state = nodes.get(p.sessionId);
      if (!state) {
        const el = makeNode(p);
        state = { el, phaseKey: pk, metaKey: mk };
        nodes.set(p.sessionId, state);
      } else if (state.phaseKey !== pk) {
        // Phase changed: re-render this pill's inner DOM but keep the
        // wrapper element so its slideIn doesn't replay.
        const fresh = makeNode(p);
        state.el.className = fresh.className;
        state.el.setAttribute("style", fresh.getAttribute("style") ?? "");
        state.el.innerHTML = fresh.innerHTML;
        state.phaseKey = pk;
        state.metaKey = mk;
      } else if (state.metaKey !== mk) {
        // Only tab metadata changed: patch chip + color cheaply.
        state.el.setAttribute(
          "style",
          `--tab:${p.tabColor}`,
        );
        const chip = state.el.querySelector(".tabchip");
        if (chip) chip.textContent = p.tabLabel;
        state.metaKey = mk;
      }

      const desired: ChildNode | null = prevSibling
        ? prevSibling.nextSibling
        : stack.firstChild;
      if (desired !== state.el) {
        stack.insertBefore(state.el, desired);
      }
      prevSibling = state.el;
    }

    // Drop nodes that are no longer visible.
    for (const [sid, state] of nodes) {
      if (!seen.has(sid)) {
        state.el.remove();
        nodes.delete(sid);
      }
    }

    // Overflow chip.
    if (overflow > 0) {
      if (!overflowEl) {
        overflowEl = document.createElement("div");
        overflowEl.className = "pill compact overflow";
        overflowEl.setAttribute("style", "--tab:#888");
      }
      overflowEl.innerHTML = `<span class="verb">+${overflow} more</span>`;
      stack.appendChild(overflowEl);
    } else if (overflowEl) {
      overflowEl.remove();
      overflowEl = null;
    }
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
