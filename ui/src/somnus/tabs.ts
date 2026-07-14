import { Icons } from "../icons";

export type TabView = { title: string; method: string; dirty: boolean };

export interface TabsOpts {
  onSelect: (i: number) => void;
  onClose: (i: number) => void;
  onNew: () => void;
}

/// Dumb renderer for the expanded-mode request tab strip. Panel owns state.
export class RequestTabs {
  readonly element: HTMLElement;

  constructor(private opts: TabsOpts) {
    this.element = document.createElement("div");
    this.element.className = "somnus-tabsbar";
  }

  render(tabs: TabView[], active: number): void {
    this.element.replaceChildren();
    tabs.forEach((tab, i) => {
      const el = document.createElement("div");
      el.className = "somnus-reqtab";
      el.classList.toggle("is-active", i === active);
      el.setAttribute("role", "button");
      el.setAttribute("tabindex", "0");
      const chip = document.createElement("span");
      chip.className = "somnus-chip";
      chip.dataset.method = tab.method;
      chip.textContent = tab.method;
      const title = document.createElement("span");
      title.className = "somnus-reqtab-title";
      title.textContent = tab.title || "Untitled";
      el.append(chip, title);
      if (tab.dirty) {
        const dot = document.createElement("span");
        dot.className = "somnus-tab-dot";
        el.append(dot);
      }
      const close = document.createElement("button");
      close.type = "button";
      close.className = "somnus-reqtab-close";
      close.setAttribute("aria-label", "Close tab");
      close.innerHTML = Icons.x({ size: 12 });
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        this.opts.onClose(i);
      });
      el.append(close);
      el.addEventListener("click", () => this.opts.onSelect(i));
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") this.opts.onSelect(i);
      });
      this.element.append(el);
    });
    const add = document.createElement("button");
    add.type = "button";
    add.className = "somnus-reqtab-new";
    add.setAttribute("aria-label", "New request tab");
    add.innerHTML = Icons.plus({ size: 13 });
    add.addEventListener("click", () => this.opts.onNew());
    this.element.append(add);
  }
}
