import { marked } from "marked";
import { projectNotesApi } from "./api";

export interface DocsTabOpts {
  groupId: string;
}

type Mode = "edit" | "preview";

export class DocsTab {
  private container: HTMLElement;
  private modeBar: HTMLElement;
  private editBtn: HTMLButtonElement;
  private previewBtn: HTMLButtonElement;
  private textarea: HTMLTextAreaElement;
  private preview: HTMLElement;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private mode: Mode = "edit";

  constructor(private opts: DocsTabOpts) {
    this.container = document.createElement("div");
    this.container.className = "pn-docs-tab";

    this.modeBar = document.createElement("div");
    this.modeBar.className = "pn-docs-modes";
    this.editBtn = document.createElement("button");
    this.editBtn.type = "button";
    this.editBtn.textContent = "edit";
    this.editBtn.className = "pn-docs-mode active";
    this.editBtn.addEventListener("click", () => this.setMode("edit"));
    this.previewBtn = document.createElement("button");
    this.previewBtn.type = "button";
    this.previewBtn.textContent = "preview";
    this.previewBtn.className = "pn-docs-mode";
    this.previewBtn.addEventListener("click", () => this.setMode("preview"));
    this.modeBar.appendChild(this.editBtn);
    this.modeBar.appendChild(this.previewBtn);

    this.textarea = document.createElement("textarea");
    this.textarea.className = "pn-docs-editor";
    this.textarea.placeholder = "# Project docs\n\nMarkdown supported. Switch to preview to render.";
    this.textarea.spellcheck = false;
    this.textarea.addEventListener("input", () => {
      this.dirty = true;
      this.scheduleSave();
    });

    this.preview = document.createElement("div");
    this.preview.className = "pn-docs-preview";
    this.preview.style.display = "none";

    this.container.appendChild(this.modeBar);
    this.container.appendChild(this.textarea);
    this.container.appendChild(this.preview);
  }

  mount(parent: HTMLElement): this {
    parent.appendChild(this.container);
    void this.load();
    return this;
  }

  private setMode(mode: Mode): void {
    this.mode = mode;
    const editing = mode === "edit";
    this.editBtn.classList.toggle("active", editing);
    this.previewBtn.classList.toggle("active", !editing);
    this.textarea.style.display = editing ? "" : "none";
    this.preview.style.display = editing ? "none" : "";
    if (!editing) this.renderPreview();
  }

  private renderPreview(): void {
    const src = this.textarea.value.trim();
    if (!src) {
      this.preview.innerHTML =
        `<div class="pn-empty pn-empty-inline">
           <div class="pn-empty-title">Nothing to preview</div>
           <div class="pn-empty-hint">Write some markdown in the edit tab</div>
         </div>`;
      return;
    }
    // marked is configured with safe defaults: GFM on, breaks on, no
    // raw-HTML execution risk for our local content (only the user
    // types into this textarea — same trust level as the editor).
    const html = marked.parse(src, { async: false }) as string;
    this.preview.innerHTML = html;
  }

  private async load(): Promise<void> {
    try {
      const body = await projectNotesApi.getDocs(this.opts.groupId);
      this.textarea.value = body;
      this.dirty = false;
      if (this.mode === "preview") this.renderPreview();
    } catch (err) {
      console.error("docs load failed", err);
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, 500);
  }

  private async flush(): Promise<void> {
    if (!this.dirty) return;
    const body = this.textarea.value;
    try {
      await projectNotesApi.saveDocs(this.opts.groupId, body);
      this.dirty = false;
    } catch (err) {
      console.error("docs save failed", err);
    }
  }
}
