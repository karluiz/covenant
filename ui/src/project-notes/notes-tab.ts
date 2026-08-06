import { projectNotesApi, type Note } from "./api";
import { Icons } from "../icons";
import { appModHeld, formatChord, modHeld } from "../platform";
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
  private composer!: HTMLElement;
  private input: HTMLTextAreaElement;
  private preview!: HTMLElement;
  private previewBtn!: HTMLButtonElement;
  private previewing = false;
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
  /** Cursor row, tracked by id so it survives filtering and deletion. */
  private cursorId: string | null = null;
  /** What `render` last put on screen, in cursor-traversal order. */
  private visible: Note[] = [];

  constructor(private hooks: NotesTabHooks) {
    this.container = document.createElement("div");
    this.container.className = "pn-notes-tab";

    this.input = document.createElement("textarea");
    this.input.className = "pn-note-input";
    this.input.placeholder = `Write a note, ${formatChord(["mod", "enter"])} to save…`;
    this.input.rows = 1;
    this.input.addEventListener("input", () => {
      this.autosize();
      // The toggle only exists once there is something to preview.
      this.previewBtn.hidden = !this.input.value.trim();
    });
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

    // Preview renders the draft through the same renderer and the same
    // `.pn-note-body` treatment a saved row uses, so it cannot disagree with
    // what saving produces.
    this.preview = document.createElement("div");
    // `pn-md` carries the rail-tight markdown treatment the saved rows use —
    // shared class, not shared identity, so the preview is never mistaken for a
    // note row.
    this.preview.className = "pn-note-preview pn-md markdown-doc";
    this.preview.hidden = true;
    this.preview.addEventListener("click", () => this.setPreview(false));

    this.previewBtn = document.createElement("button");
    this.previewBtn.type = "button";
    this.previewBtn.className = "pn-note-preview-toggle";
    this.previewBtn.textContent = "Preview";
    this.previewBtn.hidden = true;
    this.previewBtn.addEventListener("click", () => this.setPreview(!this.previewing));

    this.composer = document.createElement("div");
    this.composer.className = "pn-note-composer";
    this.composer.append(this.input, this.preview, this.previewBtn);

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

    this.container.append(this.composer, this.controls, this.list, this.more, this.live);
    this.container.addEventListener("keydown", this.onKey);
  }

  private setPreview(on: boolean): void {
    const draft = this.input.value.trim();
    this.previewing = on && !!draft;
    this.preview.hidden = !this.previewing;
    this.input.hidden = this.previewing;
    this.previewBtn.hidden = !draft;
    this.previewBtn.textContent = this.previewing ? "Edit" : "Preview";
    if (this.previewing) {
      this.preview.innerHTML = renderMarkdown(this.input.value);
    } else if (draft) {
      this.input.focus();
    }
  }

  /** Row grammar, borrowed from the command palette: the target is always the
   *  row under the cursor, never an implicit "current note". Typing surfaces
   *  keep their own keys — the guard below hands them back. */
  private onKey = (e: KeyboardEvent): void => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    const typing = tag === "TEXTAREA" || tag === "INPUT";

    // While previewing the textarea is hidden, so ⌘↵ has to be caught here for
    // the chord to keep working from the preview.
    if (this.previewing && modHeld(e) && e.key === "Enter") {
      e.preventDefault();
      void this.append();
      return;
    }

    if (modHeld(e) && !e.shiftKey && (e.key === "f" || e.key === "F")) {
      e.preventDefault();
      e.stopPropagation();
      this.filter.focus();
      this.filter.select();
      return;
    }
    if (typing) {
      // From the filter, ↓ walks into the list; everything else is the field's.
      if (e.target === this.filter && e.key === "ArrowDown" && this.visible.length) {
        e.preventDefault();
        this.moveCursor(0, true);
      }
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); this.moveCursor(1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); this.moveCursor(-1); return; }

    const n = this.cursorNote();
    if (!n) return;
    if (modHeld(e) && (e.key === "e" || e.key === "E")) {
      e.preventDefault();
      const li = this.rowEl(n.id);
      if (li) this.beginEdit(li, n);
      return;
    }
    if (appModHeld(e) && e.key === "Backspace") {
      e.preventDefault();
      this.delete(n);
      return;
    }
    if (modHeld(e) && e.shiftKey && (e.key === "p" || e.key === "P" || e.code === "KeyP")) {
      e.preventDefault();
      void this.togglePin(n);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      this.toggleFold(n.id);
    }
  };

  private cursorNote(): Note | null {
    return this.visible.find((n) => n.id === this.cursorId) ?? null;
  }

  private rowEl(id: string): HTMLElement | null {
    return this.list.querySelector<HTMLElement>(`.pn-note-card[data-id="${id}"]`);
  }

  /** `absolute` jumps to index `delta` instead of stepping from the cursor. */
  private moveCursor(delta: number, absolute = false): void {
    if (this.visible.length === 0) return;
    const at = this.visible.findIndex((n) => n.id === this.cursorId);
    const next = absolute
      ? delta
      : at < 0
        ? (delta > 0 ? 0 : this.visible.length - 1)
        : (at + delta + this.visible.length) % this.visible.length;
    this.cursorId = this.visible[next]?.id ?? null;
    this.highlight();
  }

  private highlight(): void {
    for (const el of this.list.querySelectorAll<HTMLElement>(".pn-note-card")) {
      const on = el.dataset.id === this.cursorId;
      el.classList.toggle("is-cursor", on);
      if (on) {
        el.focus();
        el.scrollIntoView?.({ block: "nearest" });
      }
    }
  }

  private toggleFold(id: string): void {
    if (this.expanded.has(id)) this.expanded.delete(id);
    else this.expanded.add(id);
    this.render();
  }

  private async togglePin(n: Note): Promise<void> {
    const next = !n.pinned;
    try {
      const updated = await projectNotesApi.setPinned(n.id, next);
      const i = this.notes.findIndex((x) => x.id === n.id);
      if (i >= 0) this.notes[i] = updated ?? { ...n, pinned: next };
      this.render();
      this.announce(next ? "Note pinned" : "Note unpinned");
    } catch (err) {
      console.error("note pin failed", err);
    }
  }

  mount(parent: HTMLElement): this {
    parent.appendChild(this.container);
    void this.refresh();
    return this;
  }

  /** The composer's current text. Read/written by the panel so a draft
   *  survives the list being rebuilt for another group. */
  get draft(): string {
    return this.input.value;
  }
  set draft(v: string) {
    this.input.value = v;
    this.autosize();
    this.previewBtn.hidden = !v.trim();
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
    this.setPreview(false);
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
      this.previewBtn.hidden = false;
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

    // Pinned rows lead, ungrouped — they are deliberately out of chronological
    // order, so a day divider over them would be a lie.
    const pinned = visible.filter((n) => n.pinned);
    const rest = visible.filter((n) => !n.pinned);
    this.visible = [...pinned, ...rest];

    if (pinned.length) {
      this.list.appendChild(divider("pinned"));
      for (const n of pinned) this.list.appendChild(this.noteRow(n));
    }
    let day = "";
    for (const n of rest) {
      const label = dayLabel(n.created_at_unix_ms);
      if (label !== day) {
        day = label;
        this.list.appendChild(divider(label));
      }
      this.list.appendChild(this.noteRow(n));
    }
    // A cursor whose row got filtered or deleted away stops being a cursor.
    if (this.cursorId && !this.visible.some((n) => n.id === this.cursorId)) {
      this.cursorId = null;
    }
    this.highlight();
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
    li.tabIndex = -1;
    if (n.pinned) li.classList.add("is-pinned");
    const { title, rest } = splitTitle(n.body);
    const fold = foldInfo(rest);
    const open = this.expanded.has(n.id);
    li.innerHTML = `
      <div class="pn-note-meta">
        <span class="pn-note-source"></span>
        <span class="rail-meta pn-note-stamp"></span>
      </div>
      <div class="pn-note-title"></div>
      <div class="pn-note-body pn-md markdown-doc"></div>
      <button class="pn-note-fold" type="button"></button>
      <div class="rail-row-actions">
        <button class="rail-row-action pn-note-pin" aria-label="${n.pinned ? "Unpin note" : "Pin note"}">${Icons.pin({ size: 13 })}</button>
        <button class="rail-row-action pn-note-edit" aria-label="Edit note">${Icons.pencil({ size: 13 })}</button>
        <button class="rail-row-action pn-note-del" aria-label="Delete note">${Icons.trash({ size: 13 })}</button>
      </div>
    `;
    (li.querySelector(".pn-note-stamp") as HTMLElement).textContent =
      formatStamp(n.created_at_unix_ms);

    const titleEl = li.querySelector(".pn-note-title") as HTMLElement;
    // Through the renderer too, or a title carrying `code` or **bold** shows
    // its markers raw. CSS flattens the wrapping <p>.
    if (title) titleEl.innerHTML = renderMarkdown(title);
    else titleEl.remove();

    const bodyEl = li.querySelector(".pn-note-body") as HTMLElement;
    bodyEl.innerHTML = renderMarkdown(rest);

    const srcEl = li.querySelector(".pn-note-source") as HTMLElement;
    if (n.source) srcEl.textContent = n.source;
    else srcEl.remove();

    const foldBtn = li.querySelector(".pn-note-fold") as HTMLButtonElement;
    if (fold.long) {
      li.classList.toggle("is-folded", !open);
      foldBtn.textContent = open ? "Show less" : fold.label;
      foldBtn.addEventListener("click", () => this.toggleFold(n.id));
      bodyEl.addEventListener("click", () => this.toggleFold(n.id));
    } else {
      foldBtn.remove();
    }

    // Clicking a row makes it the cursor row, so ⌘E / ⌘⌫ / ⌘⇧P act on what you
    // just pointed at.
    li.addEventListener("mousedown", () => {
      this.cursorId = n.id;
      this.highlight();
    });
    li.querySelector(".pn-note-pin")!.addEventListener("click", () => void this.togglePin(n));
    li.querySelector(".pn-note-del")!.addEventListener("click", () => this.delete(n));
    li.querySelector(".pn-note-edit")!.addEventListener("click", () => this.beginEdit(li, n));
    return li;
  }
}

function divider(label: string): HTMLElement {
  const d = document.createElement("li");
  d.className = "rail-divider pn-note-day";
  d.textContent = label;
  return d;
}

/** A note's first line becomes its title when it reads like one. Nothing is
 *  stored — a title column would be a second copy of the body's first line to
 *  keep in sync forever.
 *  ponytail: heuristic. A one-liner has no title (it IS the title), and a first
 *  line that opens a list, quote or code block belongs to the body. Widen only
 *  if real notes come out wrong. */
function splitTitle(body: string): { title: string | null; rest: string } {
  const lines = body.split("\n");
  const first = (lines[0] ?? "").trim();
  const rest = lines.slice(1).join("\n").trim();
  if (!rest) return { title: null, rest: body };
  const heading = first.match(/^#{1,6}\s+(.*)$/);
  if (heading) return { title: heading[1]!.trim(), rest };
  if (first.length <= 80 && !/^([-*+>|]|\d+\.|```)/.test(first)) {
    return { title: first, rest };
  }
  return { title: null, rest: body };
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
  if (lines > FOLD_LINES) {
    const hidden = lines - FOLD_LINES;
    return { long: true, label: `+${hidden} ${hidden === 1 ? "line" : "lines"}` };
  }
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
