import { projectNotesApi, type Note } from "./api";
import { Icons } from "../icons";

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

    this.sectionLabel = document.createElement("div");
    this.sectionLabel.className = "rail-divider";
    this.sectionLabel.textContent = "recent";

    this.container.appendChild(this.input);
    this.container.appendChild(this.sectionLabel);
    this.container.appendChild(this.list);
  }

  private sectionLabel!: HTMLDivElement;

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

  private beginEdit(li: HTMLElement, n: Note): void {
    if (li.querySelector(".pn-note-editor")) return;
    const editor = document.createElement("textarea");
    editor.className = "pn-note-editor";
    editor.value = n.body;
    editor.rows = 3;
    const save = document.createElement("button");
    save.className = "rail-row-action pn-note-save";
    save.textContent = "Save";
    save.addEventListener("click", () => void this.saveEdit(n, editor.value));
    li.appendChild(editor);
    li.appendChild(save);
    editor.focus();
  }

  private async saveEdit(n: Note, body: string): Promise<void> {
    const trimmed = body.trim();
    if (!trimmed || trimmed === n.body) { await this.refresh(); return; }
    try {
      await projectNotesApi.updateNote(n.id, trimmed);
    } catch (err) {
      console.error("note update failed", err);
    }
    await this.refresh();
    this.hooks.onChange?.();
  }

  private render(): void {
    this.list.replaceChildren();
    const empty = this.notes.length === 0;
    this.sectionLabel.style.display = empty ? "none" : "";
    if (empty) {
      const e = document.createElement("li");
      e.className = "rail-empty";
      e.innerHTML = `
        <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v4"/><path d="M12 2v4"/><path d="M16 2v4"/><rect width="16" height="18" x="4" y="4" rx="2"/><path d="M8 10h6"/><path d="M8 14h8"/><path d="M8 18h5"/></svg>
        <div class="rail-empty-title">No notes yet</div>
        <div class="rail-empty-hint">Type above and press <kbd>⌘↵</kbd> to save</div>
      `;
      this.list.appendChild(e);
      return;
    }
    for (const n of this.notes) {
      const li = document.createElement("li");
      li.className = "rail-row pn-note-card";
      li.dataset.id = n.id;
      const stamp = formatRelative(n.created_at_unix_ms);
      li.innerHTML = `
        <div class="pn-note-body"></div>
        <div class="pn-note-source"></div>
        <div class="rail-meta pn-note-stamp"></div>
        <div class="rail-row-actions">
          <button class="rail-row-action pn-note-edit" aria-label="Edit note">${Icons.pencil({ size: 13 })}</button>
          <button class="rail-row-action pn-note-del" aria-label="Delete note">${Icons.trash({ size: 13 })}</button>
        </div>
      `;
      (li.querySelector(".pn-note-stamp") as HTMLElement).textContent = stamp;
      (li.querySelector(".pn-note-body") as HTMLElement).textContent = n.body;
      const srcEl = li.querySelector(".pn-note-source") as HTMLElement;
      if (n.source) srcEl.textContent = n.source;
      else srcEl.remove();
      li.querySelector(".pn-note-del")!.addEventListener("click", () => this.delete(n));
      li.querySelector(".pn-note-edit")!.addEventListener("click", () => this.beginEdit(li, n));
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
