import { projectNotesApi } from "./api";
import { MarkdownEditor } from "../ui/markdown-editor";

export interface DocsTabOpts {
  groupId: string;
}

export class DocsTab {
  private container: HTMLElement;
  private editor: MarkdownEditor;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private opts: DocsTabOpts) {
    this.container = document.createElement("div");
    this.container.className = "pn-docs-tab";

    this.editor = new MarkdownEditor({
      mode: "full",
      placeholder: "# Project docs\n\nMarkdown supported.",
      onChange: () => {
        this.dirty = true;
        this.scheduleSave();
      },
    });
    this.container.appendChild(this.editor.element);
  }

  mount(parent: HTMLElement): this {
    parent.appendChild(this.container);
    void this.load();
    return this;
  }

  private async load(): Promise<void> {
    try {
      const body = await projectNotesApi.getDocs(this.opts.groupId);
      this.editor.value = body;
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
    try {
      await projectNotesApi.saveDocs(this.opts.groupId, this.editor.value);
      this.dirty = false;
    } catch (err) {
      console.error("docs save failed", err);
    }
  }
}
