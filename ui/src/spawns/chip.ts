import type { SpawnSpec } from "./types";

const escHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface SpawnsChipDeps {
  list: () => Promise<SpawnSpec[]>;
  getBoundId: () => string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
}

export class SpawnsChip {
  private readonly host: HTMLElement;
  private button: HTMLButtonElement | null = null;
  private popover: HTMLDivElement | null = null;
  private specs: SpawnSpec[] = [];

  constructor(host: HTMLElement, private deps: SpawnsChipDeps) {
    this.host = host;
    this.render();
  }

  async refresh(): Promise<void> {
    this.specs = await this.deps.list();
    this.render();
  }

  private render(): void {
    const bound =
      this.specs.find((s) => s.id === this.deps.getBoundId()) ??
      this.specs.find((s) => s.default) ??
      this.specs[0];
    this.host.innerHTML = "";
    const btn = document.createElement("button");
    btn.className = "spawns-chip";
    btn.type = "button";
    btn.innerHTML = `
      <span class="spawns-chip__dot"></span>
      <span class="spawns-chip__label">${escHtml(bound?.label ?? "Spawn")}</span>
      ${bound?.model ? `<span class="spawns-chip__model">${escHtml(bound.model)}</span>` : ""}
      <span class="spawns-chip__caret">&#9660;</span>
    `;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.toggle();
    });
    this.button = btn;
    this.host.appendChild(btn);
  }

  private async toggle(): Promise<void> {
    if (this.popover) {
      this.close();
      return;
    }
    await this.refresh();
    this.open();
  }

  private open(): void {
    const pop = document.createElement("div");
    pop.className = "spawns-popover";
    const rect = this.button!.getBoundingClientRect();
    pop.style.top = `${Math.round(rect.bottom + 4)}px`;
    pop.style.left = `${Math.round(rect.left)}px`;
    const boundId = this.deps.getBoundId();
    pop.innerHTML =
      this.specs
        .map(
          (s) => `
        <button class="spawns-popover__item${s.id === boundId ? " is-active" : ""}" data-id="${s.id}" type="button">
          <span class="dot"></span>
          <span class="label">${escHtml(s.label)}</span>
          ${s.model ? `<span class="meta">${escHtml(s.model)}</span>` : ""}
        </button>`
        )
        .join("") +
      `<div class="spawns-popover__sep"></div>
       <button class="spawns-popover__add" type="button">+ add executor…</button>`;
    pop.addEventListener("click", (e) => {
      const item = (e.target as HTMLElement).closest("[data-id]") as HTMLElement | null;
      if (item?.dataset["id"]) {
        this.deps.onSelect(item.dataset["id"]);
        this.close();
        return;
      }
      if ((e.target as HTMLElement).closest(".spawns-popover__add")) {
        this.deps.onAdd();
        this.close();
      }
    });
    document.body.appendChild(pop);
    this.popover = pop;
    setTimeout(
      () => document.addEventListener("click", this.closeOnOutside, { once: true }),
      0
    );
  }

  private closeOnOutside = (e: MouseEvent): void => {
    if (this.popover && !this.popover.contains(e.target as Node)) {
      this.close();
    }
  };

  private close(): void {
    this.popover?.remove();
    this.popover = null;
  }
}
