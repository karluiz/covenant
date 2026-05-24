export interface MentionItem {
  path: string;
}

export class MentionPopup {
  private el: HTMLDivElement;
  private listEl: HTMLDivElement;
  private items: MentionItem[] = [];
  private activeIndex = 0;
  private onPick: (item: MentionItem) => void = () => {};

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "mention-popup is-hidden";
    this.listEl = document.createElement("div");
    this.listEl.className = "mention-popup-list";
    this.el.append(this.listEl);
    document.body.append(this.el);
  }

  setOnPick(cb: (item: MentionItem) => void): void {
    this.onPick = cb;
  }

  show(anchor: { x: number; y: number }, items: MentionItem[], activeIndex = 0): void {
    this.items = items;
    this.activeIndex = Math.min(activeIndex, Math.max(0, items.length - 1));
    this.listEl.innerHTML = "";
    items.forEach((it, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "mention-popup-row" + (i === this.activeIndex ? " is-active" : "");
      row.textContent = it.path;
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.onPick(it);
      });
      this.listEl.append(row);
    });
    this.el.style.left = `${anchor.x}px`;
    this.el.style.top = `${anchor.y}px`;
    this.el.classList.toggle("is-hidden", items.length === 0);
  }

  setActive(idx: number): void {
    if (this.items.length === 0) return;
    this.activeIndex = ((idx % this.items.length) + this.items.length) % this.items.length;
    Array.from(this.listEl.children).forEach((c, i) => {
      c.classList.toggle("is-active", i === this.activeIndex);
    });
  }

  getActive(): MentionItem | null {
    return this.items[this.activeIndex] ?? null;
  }

  moveActive(delta: number): void {
    this.setActive(this.activeIndex + delta);
  }

  hide(): void {
    this.el.classList.add("is-hidden");
    this.items = [];
  }

  isOpen(): boolean {
    return !this.el.classList.contains("is-hidden");
  }

  destroy(): void {
    this.el.remove();
  }
}
