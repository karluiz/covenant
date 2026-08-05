import { projectNotesApi, type Note } from "./api";
import { Icons } from "../icons";
import { formatChord } from "../platform";
import { renderMarkdown } from "../ui/markdown";

export interface NotesTabHooks {
  groupId: string;
  onChange?: () => void;
}

/** Matches the page size the backend snapshot uses, so "load older" only
 *  appears once the first page is actually full. */
const PAGE = 50;
/** Lines a collapsed note shows before it folds. Mirrors --pn-note-fold-lines. */
const FOLD_LINES = 3;
/** How long a deleted note stays recoverable before the delete is committed. */
const UNDO_MS = 6000;

interface PendingDelete {
  note: Note;
  /** Where it sat in `notes`, so undo puts it back in order. */
  index: number;
  timer: number;
}

export class NotesTab {
  private container: HTMLElement;
  private input: HTMLTextAreaElement;
  private controls: HTMLElement;
  private filter: HTMLInputElement;
  private list: HTMLUListElement;
  private more: HTMLButtonElement;
  private live: HTMLElement;
  private notes: Note[] = [];
  private query = "";
  /** Note ids the reader has unfolded. Survives re-renders, not remounts. */
  private expanded = new Set<string>();
  private pending: PendingDelete | null = null;
  /** True once `listNotes` returns a short page — no older notes left. */
  private exhausted = false;

  constructor(private hooks: NotesTabHooks) {
    this.container = document.createElement("div");
    this.container.className = "pn-notes-tab";

    this.input = document.createElement("textarea");
    this.input.className = "pn-note-input";
    this.input.placeholder = `Write a note, ${formatChord(["mod", "enter"])} to save…`;
    this.input.rows = 1;
    this.input.addEventListener("input", () => this.autosize());
    this.input.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void this.append();
      } else if (e.key === "Escape" && this.input.value.trim()) {
        // A draft outranks the panel's Escape-to-close: blur instead, or the
        // keystroke that means "stop typing" also throws the draft away.
        e.stopPropagation();
        this.input.blur();
      }
    });

    this.controls = document.createElement("div");
    this.controls.className = "rail-controls pn-note-controls";
    const search = document.createElement("div");
    search.className = "rail-search";
    search.innerHTML = Icons.search({ size: 14 });
    this.filter = document.createElement("input");
    this.filter.type = "search";
    this.filter.placeholder = "Filter notes…";
    this.filter.addEventListener("input", () => {
      this.query = this.filter.value.trim().toLowerCase();
      this.render();
    });
    search.appendChild(this.filter);
    this.controls.appendChild(search);

    this.list = document.createElement("ul");
    this.list.className = "pn-note-list";

    this.more = document.createElement("button");
    this.more.type = "button";
    this.more.className = "pn-note-more";
    this.more.textContent = "Load older";
    this.more.addEventListener("click", () => void this.loadOlder());

    this.live = document.createElement("div");
    this.live.className = "pn-note-live";
    this.live.setAttribute("aria-live", "polite");

    this.container.append(this.input, this.controls, this.list, this.more, this.live);
  }

  mount(parent: HTMLElement): this {
    parent.appendChild(this.container);
    void this.refresh();
    return this;
  }

  async refresh(): Promise<void> {
    const snap = await projectNotesApi.snapshot(this.hooks.groupId);
    this.notes = snap.notes;
    this.exhausted = snap.notes.length < PAGE;
    this.render();
  }

  /** Grow to fit the draft, capped in CSS so the list never gets pushed off
   *  screen. `scrollHeight` excludes the border, hence the +2. */
  private autosize(): void {
    this.input.style.height = "0";
    this.input.style.height = `${this.input.scrollHeight + 2}px`;
  }

  private announce(msg: string): void {
    this.live.textContent = msg;
  }

  private async append(): Promise<void> {
    const body = this.input.value.trim();
    if (!body) return;
    const draft = this.input.value;
    this.input.value = "";
    this.autosize();
    try {
      const created = await projectNotesApi.appendNote(this.hooks.groupId, body);
      // Optimistic insert — a full snapshot refetch here rebuilt every row and
      // jumped the list under the cursor.
      this.notes.unshift(created);
      this.render();
      this.announce("Note saved");
      this.hooks.onChange?.();
    } catch (err) {
      this.input.value = draft;
      this.autosize();
      console.error("note append failed", err);
    }
  }

  private async loadOlder(): Promise<void> {
    const oldest = this.notes[this.notes.length - 1]?.created_at_unix_ms;
    try {
      const older = await projectNotesApi.listNotes(this.hooks.groupId, PAGE, oldest);
      if (older.length < PAGE) this.exhausted = true;
      const seen = new Set(this.notes.map((n) => n.id));
      this.notes.push(...older.filter((n) => !seen.has(n.id)));
      this.render();
    } catch (err) {
      console.error("note page failed", err);
    }
  }

  private delete(n: Note): void {
    // One undo slot: deleting a second note commits the first. A queue of
    // recoverable deletes is state nobody asked for.
    void this.commitPending();
    const index = this.notes.findIndex((x) => x.id === n.id);
    this.notes = this.notes.filter((x) => x.id !== n.id);
    this.pending = {
      note: n,
      index: index < 0 ? 0 : index,
      timer: window.setTimeout(() => void this.commitPending(), UNDO_MS),
    };
    this.render();
    this.announce("Note deleted");
  }

  private async commitPending(): Promise<void> {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    try {
      await projectNotesApi.deleteNote(p.note.id);
      this.hooks.onChange?.();
    } catch (err) {
      // The row is already gone from the list; put it back rather than lie.
      console.error("note delete failed", err);
      this.notes.splice(p.index, 0, p.note);
    }
    // Always re-render: the undo strip has to go once its window closes, or it
    // sits there offering a recovery that no longer exists.
    this.render();
  }

  private undo(): void {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending = null;
    this.notes.splice(p.index, 0, p.note);
    this.render();
    this.announce("Note restored");
  }

  private beginEdit(li: HTMLElement, n: Note): void {
    if (li.querySelector(".pn-note-editor")) return;
    // `is-editing` swaps the row from read chrome (folded body + the
    // hover actions the Save button used to land on top of) to the editor.
    li.classList.add("is-editing");
    const box = document.createElement("div");
    box.className = "pn-note-editor";
    box.innerHTML = `
      <textarea class="pn-note-editor-input" rows="3" spellcheck="false"></textarea>
      <div class="pn-note-editor-actions">
        <span class="pn-note-editor-hint">${formatChord(["mod", "enter"])} to save · Esc to cancel</span>
        <button class="pn-note-save" type="button">Save</button>
        <button class="pn-note-cancel" type="button">Cancel</button>
      </div>
    `;
    const editor = box.querySelector<HTMLTextAreaElement>(".pn-note-editor-input")!;
    editor.value = n.body;

    const cancel = () => {
      li.classList.remove("is-editing");
      box.remove();
    };
    editor.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void this.saveEdit(n, editor.value);
      }
    });
    box.querySelector(".pn-note-cancel")!.addEventListener("click", cancel);
    box.querySelector(".pn-note-save")!.addEventListener(
      "click",
      () => void this.saveEdit(n, editor.value),
    );

    li.appendChild(box);
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }

  private async saveEdit(n: Note, body: string): Promise<void> {
    const trimmed = body.trim();
    if (!trimmed || trimmed === n.body) { this.render(); return; }
    try {
      const updated = await projectNotesApi.updateNote(n.id, trimmed);
      const i = this.notes.findIndex((x) => x.id === n.id);
      if (i >= 0) this.notes[i] = updated ?? { ...n, body: trimmed };
      this.announce("Note saved");
      this.hooks.onChange?.();
    } catch (err) {
      console.error("note update failed", err);
    }
    this.render();
  }

  private filtered(): Note[] {
    if (!this.query) return this.notes;
    const q = this.query;
    return this.notes.filter(
      (n) => n.body.toLowerCase().includes(q) || (n.source ?? "").toLowerCase().includes(q),
    );
  }

  private render(): void {
    this.list.replaceChildren();
    const visible = this.filtered();
    // Nothing to filter until there is more than one note to filter through.
    this.controls.hidden = this.notes.length < 2 && !this.query;
    this.more.hidden = !!this.query || this.exhausted || this.notes.length < PAGE;

    if (this.pending) this.list.appendChild(this.undoRow());

    if (visible.length === 0) {
      this.list.appendChild(this.query ? emptyFilter(this.query) : emptyNotes());
      return;
    }

    let day = "";
    for (const n of visible) {
      const label = dayLabel(n.created_at_unix_ms);
      if (label !== day) {
        day = label;
        const d = document.createElement("li");
        d.className = "rail-divider pn-note-day";
        d.textContent = label;
        this.list.appendChild(d);
      }
      this.list.appendChild(this.noteRow(n));
    }
  }

  private undoRow(): HTMLElement {
    // Rendered at the top rather than back in its slot — a transient strip you
    // look up at beats one that hides wherever the row used to be.
    const li = document.createElement("li");
    li.className = "pn-note-undo";
    li.innerHTML = `
      <span class="pn-note-undo-label">Note deleted</span>
      <button class="pn-note-undo-btn" type="button">${Icons.undo2({ size: 13 })}<span>Undo</span></button>
    `;
    li.querySelector(".pn-note-undo-btn")!.addEventListener("click", () => this.undo());
    return li;
  }

  private noteRow(n: Note): HTMLElement {
    const li = document.createElement("li");
    li.className = "rail-row pn-note-card";
    li.dataset.id = n.id;
    const fold = foldInfo(n.body);
    const open = this.expanded.has(n.id);
    li.innerHTML = `
      <div class="pn-note-meta">
        <span class="pn-note-source"></span>
        <span class="rail-meta pn-note-stamp"></span>
      </div>
      <div class="pn-note-body markdown-doc"></div>
      <button class="pn-note-fold" type="button"></button>
      <div class="rail-row-actions">
        <button class="rail-row-action pn-note-edit" aria-label="Edit note">${Icons.pencil({ size: 13 })}</button>
        <button class="rail-row-action pn-note-del" aria-label="Delete note">${Icons.trash({ size: 13 })}</button>
      </div>
    `;
    (li.querySelector(".pn-note-stamp") as HTMLElement).textContent =
      formatStamp(n.created_at_unix_ms);

    const bodyEl = li.querySelector(".pn-note-body") as HTMLElement;
    bodyEl.innerHTML = renderMarkdown(n.body);

    const srcEl = li.querySelector(".pn-note-source") as HTMLElement;
    if (n.source) srcEl.textContent = n.source;
    else srcEl.remove();

    const foldBtn = li.querySelector(".pn-note-fold") as HTMLButtonElement;
    if (fold.long) {
      li.classList.toggle("is-folded", !open);
      foldBtn.textContent = open ? "Show less" : fold.label;
      const toggle = () => {
        if (this.expanded.has(n.id)) this.expanded.delete(n.id);
        else this.expanded.add(n.id);
        this.render();
      };
      foldBtn.addEventListener("click", toggle);
      bodyEl.addEventListener("click", toggle);
    } else {
      foldBtn.remove();
    }

    li.querySelector(".pn-note-del")!.addEventListener("click", () => this.delete(n));
    li.querySelector(".pn-note-edit")!.addEventListener("click", () => this.beginEdit(li, n));
    return li;
  }
}

function emptyNotes(): HTMLElement {
  const e = document.createElement("li");
  e.className = "rail-empty";
  e.innerHTML = `
    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v4"/><path d="M12 2v4"/><path d="M16 2v4"/><rect width="16" height="18" x="4" y="4" rx="2"/><path d="M8 10h6"/><path d="M8 14h8"/><path d="M8 18h5"/></svg>
    <div class="rail-empty-title">No notes yet</div>
    <div class="rail-empty-hint">Type above and press <kbd>${formatChord(["mod", "enter"])}</kbd> to save</div>
  `;
  return e;
}

function emptyFilter(q: string): HTMLElement {
  const e = document.createElement("li");
  e.className = "rail-empty";
  const title = document.createElement("div");
  title.className = "rail-empty-title";
  title.textContent = `No note matches “${q}”`;
  const hint = document.createElement("div");
  hint.className = "rail-empty-hint";
  hint.textContent = "Clear the filter, or load older notes to search further back.";
  e.append(title, hint);
  return e;
}

/** Whether a note folds, and what the affordance says.
 *  ponytail: counted on the source text, not measured in layout — rows are
 *  built while detached (the cockpit appends the section after mounting), so
 *  scrollHeight would read 0 there. Upgrade to a real measurement only if the
 *  line count visibly disagrees with what the row renders. */
function foldInfo(body: string): { long: boolean; label: string } {
  const lines = body.split("\n").filter((l) => l.trim()).length;
  if (lines > FOLD_LINES) return { long: true, label: `+${lines - FOLD_LINES} lines` };
  if (body.length > 240) return { long: true, label: "Show more" };
  return { long: false, label: "" };
}

/** Time within the day. The date itself is carried by the day divider, which
 *  is why this never has to say "412d ago". */
function formatStamp(ts: number): string {
  const delta = Math.max(0, Date.now() - ts) / 1000;
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Uppercased by `.rail-divider` in CSS, never in the string. */
function dayLabel(ts: number): string {
  const d = new Date(ts);
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}
