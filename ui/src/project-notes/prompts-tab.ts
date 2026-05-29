import { promptsApi, type Prompt } from "./api";
import { sendToActiveTabInGroup } from "./paste";
import { attachTooltip } from "../tooltip/tooltip";

export interface PromptsTabHooks {
  /// Used only to resolve the active terminal for "send". The prompt library
  /// itself is global, not scoped to the group.
  groupId: string;
  onChange?: () => void;
}

export class PromptsTab {
  private container: HTMLElement;
  private list: HTMLUListElement;
  private prompts: Prompt[] = [];
  private draggingId: string | null = null;

  constructor(private hooks: PromptsTabHooks) {
    this.container = document.createElement("div");
    this.container.className = "pn-prompt-tab";

    const newBtn = document.createElement("button");
    newBtn.className = "pn-prompt-new";
    newBtn.textContent = "+ New prompt";
    newBtn.addEventListener("click", () => this.openEditor(null));

    this.list = document.createElement("ul");
    this.list.className = "pn-prompt-list";

    this.container.appendChild(newBtn);
    this.container.appendChild(this.list);
  }

  mount(parent: HTMLElement): this {
    parent.appendChild(this.container);
    void this.refresh();
    return this;
  }

  async refresh(): Promise<void> {
    this.prompts = await promptsApi.list();
    this.render();
  }

  private render(): void {
    this.list.replaceChildren();
    if (this.prompts.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pn-empty";
      empty.innerHTML = `
        <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16M4 12h16M4 19h10"/></svg>
        <div class="pn-empty-title">No prompts yet</div>
        <div class="pn-empty-hint">Click <span class="pn-kbd">+ New prompt</span> to add one</div>
      `;
      this.list.appendChild(empty);
      return;
    }
    for (const p of this.prompts) {
      const li = document.createElement("li");
      li.className = "pn-prompt-row";
      li.dataset.id = p.id;
      li.draggable = true;
      li.addEventListener("dragstart", (e) => {
        this.draggingId = p.id;
        li.classList.add("pn-prompt-dragging");
        e.dataTransfer?.setData("text/plain", p.id);
      });
      li.addEventListener("dragend", () => {
        this.draggingId = null;
        li.classList.remove("pn-prompt-dragging");
        this.list
          .querySelectorAll(".pn-prompt-drop-before, .pn-prompt-drop-after")
          .forEach((el) => {
            el.classList.remove("pn-prompt-drop-before");
            el.classList.remove("pn-prompt-drop-after");
          });
      });
      li.addEventListener("dragover", (e) => {
        e.preventDefault();
        li.classList.remove("pn-prompt-drop-before");
        li.classList.remove("pn-prompt-drop-after");
        const fromIdx = this.prompts.findIndex((q) => q.id === this.draggingId);
        const overIdx = this.prompts.findIndex((q) => q.id === p.id);
        if (fromIdx !== -1 && fromIdx < overIdx) {
          li.classList.add("pn-prompt-drop-after");
        } else {
          li.classList.add("pn-prompt-drop-before");
        }
      });
      li.addEventListener("dragleave", () => {
        li.classList.remove("pn-prompt-drop-before");
        li.classList.remove("pn-prompt-drop-after");
      });
      li.addEventListener("drop", (e) => {
        e.preventDefault();
        li.classList.remove("pn-prompt-drop-before");
        li.classList.remove("pn-prompt-drop-after");
        const draggedId = this.draggingId ?? e.dataTransfer?.getData("text/plain");
        if (draggedId && draggedId !== p.id) {
          this.applyReorder(draggedId, p.id);
        }
      });
      li.innerHTML = `
        <div class="pn-prompt-meta">
          <div class="pn-prompt-title"></div>
          <div class="pn-prompt-body"></div>
        </div>
        <div class="pn-prompt-actions">
          <button class="pn-prompt-send">send</button>
          <button class="pn-prompt-edit">edit</button>
          <button class="pn-prompt-del">×</button>
        </div>
      `;
      (li.querySelector(".pn-prompt-title") as HTMLElement).textContent = p.title;
      (li.querySelector(".pn-prompt-body") as HTMLElement).textContent = p.body;
      const sendBtn = li.querySelector<HTMLElement>(".pn-prompt-send")!;
      sendBtn.addEventListener("click", () => this.send(p));
      attachTooltip(sendBtn, "Send to active tab");

      const editBtn = li.querySelector<HTMLElement>(".pn-prompt-edit")!;
      editBtn.addEventListener("click", () => this.openEditor(p));
      attachTooltip(editBtn, "Edit");

      const delBtn = li.querySelector<HTMLElement>(".pn-prompt-del")!;
      delBtn.addEventListener("click", () => this.delete(p));
      attachTooltip(delBtn, "Delete");
      this.list.appendChild(li);
    }
  }

  private async send(p: Prompt): Promise<void> {
    try {
      await sendToActiveTabInGroup(this.hooks.groupId, p.body);
    } catch (err) {
      console.error("send failed", err);
    }
  }

  /// Move `draggedId` to the position currently held by `targetId`, persist the
  /// new order, and re-render. Pure enough to unit-test directly.
  applyReorder(draggedId: string, targetId: string): void {
    const from = this.prompts.findIndex((p) => p.id === draggedId);
    const to = this.prompts.findIndex((p) => p.id === targetId);
    if (from === -1 || to === -1 || from === to) return;
    const [moved] = this.prompts.splice(from, 1);
    this.prompts.splice(to, 0, moved);
    this.render();
    void promptsApi
      .reorder(this.prompts.map((p) => p.id))
      .then(() => this.hooks.onChange?.())
      .catch(() => this.refresh());
  }

  private async delete(p: Prompt): Promise<void> {
    await promptsApi.delete(p.id);
    await this.refresh();
    this.hooks.onChange?.();
  }

  private openEditor(existing: Prompt | null): void {
    this.container.querySelector(".pn-prompt-editor")?.remove();

    const dialog = document.createElement("div");
    dialog.className = "pn-prompt-editor";
    dialog.innerHTML = `
      <input class="pn-prompt-title-input" placeholder="Title" />
      <textarea class="pn-prompt-body-input" placeholder="Prompt" rows="6"></textarea>
      <div class="pn-prompt-editor-actions">
        <button class="pn-prompt-save">Save</button>
        <button class="pn-prompt-cancel">Cancel</button>
      </div>
    `;
    const titleInput =
      dialog.querySelector<HTMLInputElement>(".pn-prompt-title-input")!;
    const bodyInput =
      dialog.querySelector<HTMLTextAreaElement>(".pn-prompt-body-input")!;
    if (existing) {
      titleInput.value = existing.title;
      bodyInput.value = existing.body;
    }

    const isCreating = !existing;
    const empty = this.list.querySelector<HTMLElement>(".pn-empty");
    if (isCreating && empty) empty.style.display = "none";

    const restoreEmpty = () => {
      if (isCreating && empty && this.prompts.length === 0) {
        empty.style.display = "";
      }
    };

    dialog.querySelector(".pn-prompt-cancel")!.addEventListener("click", () => {
      dialog.remove();
      restoreEmpty();
    });
    dialog.querySelector(".pn-prompt-save")!.addEventListener("click", async () => {
      const title = titleInput.value.trim();
      const body = bodyInput.value.trim();
      if (!title || !body) return;
      if (existing) {
        await promptsApi.update(existing.id, title, body);
      } else {
        await promptsApi.create(title, body);
      }
      dialog.remove();
      await this.refresh();
      this.hooks.onChange?.();
    });

    if (isCreating) {
      this.list.insertAdjacentElement("beforebegin", dialog);
    } else {
      this.container.appendChild(dialog);
    }
    titleInput.focus();
  }
}
