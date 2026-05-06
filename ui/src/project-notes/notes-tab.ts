import { projectNotesApi, type Note } from "./api";

export interface NotesTabHooks {
  groupId: string;
  onChange?: () => void;
}

export class NotesTab {
  private container: HTMLElement;
  private input: HTMLTextAreaElement;
  private list: HTMLUListElement;
  private notes: Note[] = [];

  constructor(private hooks: NotesTabHooks) {
    this.container = document.createElement("div");
    this.container.className = "pn-notes-tab";

    this.input = document.createElement("textarea");
    this.input.className = "pn-note-input";
    this.input.placeholder = "Write a note, ⌘↵ to save…";
    this.input.rows = 2;
    this.input.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void this.append();
      }
    });

    this.list = document.createElement("ul");
    this.list.className = "pn-note-list";

    this.container.appendChild(this.input);
    this.container.appendChild(this.list);
  }

  mount(parent: HTMLElement): this {
    parent.appendChild(this.container);
    void this.refresh();
    return this;
  }

  async refresh(): Promise<void> {
    const snap = await projectNotesApi.snapshot(this.hooks.groupId);
    this.notes = snap.notes;
    this.render();
  }

  private async append(): Promise<void> {
    const body = this.input.value.trim();
    if (!body) return;
    const value = this.input.value;
    this.input.value = "";
    try {
      await projectNotesApi.appendNote(this.hooks.groupId, body);
      await this.refresh();
      this.hooks.onChange?.();
    } catch (err) {
      this.input.value = value;
      console.error("note append failed", err);
    }
  }

  private async delete(n: Note): Promise<void> {
    await projectNotesApi.deleteNote(n.id);
    await this.refresh();
    this.hooks.onChange?.();
  }

  private render(): void {
    this.list.replaceChildren();
    for (const n of this.notes) {
      const li = document.createElement("li");
      li.className = "pn-note-row";
      li.dataset.id = n.id;
      const stamp = formatRelative(n.created_at_unix_ms);
      li.innerHTML = `
        <span class="pn-note-stamp"></span>
        <span class="pn-note-body"></span>
        <button class="pn-note-del" aria-label="Delete note">×</button>
      `;
      (li.querySelector(".pn-note-stamp") as HTMLElement).textContent = stamp;
      (li.querySelector(".pn-note-body") as HTMLElement).textContent = n.body;
      li.querySelector(".pn-note-del")!.addEventListener("click", () => this.delete(n));
      this.list.appendChild(li);
    }
  }
}

function formatRelative(ts: number): string {
  const delta = Math.max(0, Date.now() - ts) / 1000;
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}
