import type { SpecPromptState, TabSnapshot } from "./spec-prompt-state";

export interface SpecBadgeHandle {
  destroy(): void;
}

export interface SpecBadgeHost {
  setMissionForTab(tabId: string, path: string): Promise<void>;
  openSpec(path: string): Promise<void>;
}

export function mountSpecBadge(
  parent: HTMLElement,
  tabId: string,
  state: SpecPromptState,
  listTabs: () => TabSnapshot[],
  host: SpecBadgeHost,
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

  let popover: HTMLElement | null = null;

  const closePopover = () => {
    popover?.remove();
    popover = null;
    document.removeEventListener("click", onDocClick, true);
  };

  const onDocClick = (e: MouseEvent) => {
    if (!popover) return;
    if (popover.contains(e.target as Node) || badge.contains(e.target as Node)) return;
    closePopover();
  };

  const openPopover = () => {
    if (popover) { closePopover(); return; }
    const tabs = listTabs();
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const pending = state.getPendingForTab(tab, tabs, Date.now());
    if (pending.length === 0) return;
    popover = document.createElement("div");
    popover.className = "spec-badge-popover";
    popover.innerHTML = pending.map((c) => {
      const fileName = c.path.split("/").pop() ?? c.path;
      return `
        <div class="spec-badge-item" data-path="${escapeAttr(c.path)}">
          <div class="spec-badge-item-file">${escapeHtml(fileName)}</div>
          <div class="spec-badge-item-snippet">${escapeHtml(c.goal_snippet)}</div>
          <div class="spec-badge-item-actions">
            <button type="button" class="spec-badge-set">Asignar</button>
            <button type="button" class="spec-badge-open">Abrir</button>
            <button type="button" class="spec-badge-dismiss">Descartar</button>
          </div>
        </div>`;
    }).join("");
    document.body.appendChild(popover);
    const r = badge.getBoundingClientRect();
    popover.style.position = "fixed";
    popover.style.top = `${r.bottom + 4}px`;
    popover.style.left = `${r.left}px`;

    popover.querySelectorAll<HTMLElement>(".spec-badge-item").forEach((item) => {
      const path = item.dataset.path!;
      item.querySelector(".spec-badge-set")!.addEventListener("click", async () => {
        state.acceptOnTab(tabId, path);
        closePopover();
        try { await host.setMissionForTab(tabId, path); }
        catch (e) { console.error("setMissionForTab failed", e); }
      });
      item.querySelector(".spec-badge-open")!.addEventListener("click", async () => {
        try { await host.openSpec(path); }
        catch (e) { console.error("openSpec failed", e); }
      });
      item.querySelector(".spec-badge-dismiss")!.addEventListener("click", () => {
        state.dismiss(tabId, path);
        closePopover();
      });
    });

    setTimeout(() => document.addEventListener("click", onDocClick, true), 0);
  };

  badge.addEventListener("click", openPopover);

  return {
    destroy() {
      unsub();
      closePopover();
      badge.remove();
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function escapeAttr(s: string): string { return escapeHtml(s); }
