import type { SpecPromptState, TabSnapshot } from "./spec-prompt-state";

export interface SpecBadgeHandle {
  destroy(): void;
}

export function mountSpecBadge(
  parent: HTMLElement,
  tabId: string,
  state: SpecPromptState,
  listTabs: () => TabSnapshot[],
): SpecBadgeHandle {
  const badge = document.createElement("button");
  badge.type = "button";
  badge.className = "spec-badge hidden";
  badge.title = "Specs pending for this tab";
  badge.innerHTML = `<span class="spec-badge-icon">📎</span><span class="spec-badge-count"></span>`;
  parent.appendChild(badge);

  const render = () => {
    const tabs = listTabs();
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) {
      badge.classList.add("hidden");
      return;
    }
    const pending = state.getPendingForTab(tab, tabs, Date.now());
    if (pending.length === 0) {
      badge.classList.add("hidden");
      return;
    }
    badge.classList.remove("hidden");
    const count = badge.querySelector(".spec-badge-count")!;
    count.textContent = pending.length > 1 ? String(pending.length) : "";
  };

  const unsub = state.onChange(render);
  render();

  return {
    destroy() {
      unsub();
      badge.remove();
    },
  };
}
