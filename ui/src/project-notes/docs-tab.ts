import { projectNotesApi } from "./api";

export interface DocsTabOpts {
  groupId: string;
}

export class DocsTab {
  private container: HTMLElement;
  private textarea: HTMLTextAreaElement;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private opts: DocsTabOpts) {
    this.container = document.createElement("div");
    this.container.className = "pn-docs-tab";

    this.textarea = document.createElement("textarea");
    this.textarea.className = "pn-docs-editor";
    this.textarea.placeholder = "Markdown docs for this project…";
    this.textarea.spellcheck = false;

    this.textarea.addEventListener("input", () => {
      this.dirty = true;
      this.scheduleSave();
    });

    this.container.appendChild(this.textarea);
  }

  mount(parent: HTMLElement): this {
    parent.appendChild(this.container);
    void this.load();
    return this;
  }

  private async load(): Promise<void> {
    try {
      const body = await projectNotesApi.getDocs(this.opts.groupId);
      this.textarea.value = body;
      this.dirty = false;
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
