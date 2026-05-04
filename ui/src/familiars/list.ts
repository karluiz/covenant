import { Familiars, type FamiliarSummary } from "./api";

export class FamiliarList {
  private el: HTMLDivElement;
  private items: FamiliarSummary[] = [];
  private selected: string | null = null;
  private onSelect: (id: string) => void;

  constructor(parent: HTMLElement, onSelect: (id: string) => void) {
    this.el = document.createElement("div");
    this.el.className = "familiar-list";
    parent.appendChild(this.el);
    this.onSelect = onSelect;
  }

  async refresh() {
    this.items = await Familiars.list();
    this.render();
  }

  select(id: string | null) {
    this.selected = id;
    this.render();
  }

  private render() {
    this.el.innerHTML = "";
    if (this.items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "familiar-list-empty";
      empty.textContent = "No Familiars yet.";
      this.el.appendChild(empty);
      return;
    }
    for (const f of this.items) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "familiar-row" + (f.id === this.selected ? " selected" : "");
      row.innerHTML = `
        <span class="familiar-dot"></span>
        <span class="familiar-name">${escapeHtml(f.name)}</span>
        <span class="familiar-session">${escapeHtml(f.session_id.slice(0, 6))}</span>`;
      row.addEventListener("click", () => this.onSelect(f.id));
      this.el.appendChild(row);
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
