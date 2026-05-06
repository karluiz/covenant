import { projectNotesApi, type Command } from "./api";
import { writeToActiveTabInGroup } from "./paste";

export interface CommandsTabHooks {
  groupId: string;
  /// Called after any local mutation so the panel can refresh sibling state if needed.
  onChange?: () => void;
}

export class CommandsTab {
  private container: HTMLElement;
  private list: HTMLUListElement;
  private commands: Command[] = [];

  constructor(private hooks: CommandsTabHooks) {
    this.container = document.createElement("div");
    this.container.className = "pn-cmd-tab";

    const newBtn = document.createElement("button");
    newBtn.className = "pn-cmd-new";
    newBtn.textContent = "+ New command";
    newBtn.addEventListener("click", () => this.openEditor(null));

    this.list = document.createElement("ul");
    this.list.className = "pn-cmd-list";

    this.container.appendChild(newBtn);
    this.container.appendChild(this.list);
  }

  mount(parent: HTMLElement): this {
    parent.appendChild(this.container);
    void this.refresh();
    return this;
  }

  async refresh(): Promise<void> {
    const snap = await projectNotesApi.snapshot(this.hooks.groupId);
    this.commands = snap.commands;
    this.render();
  }

  private render(): void {
    this.list.replaceChildren();
    for (const c of this.commands) {
      const li = document.createElement("li");
      li.className = "pn-cmd-row";
      li.dataset.id = c.id;
      li.innerHTML = `
        <div class="pn-cmd-meta">
          <div class="pn-cmd-title"></div>
          <code class="pn-cmd-code"></code>
        </div>
        <div class="pn-cmd-actions">
          <button class="pn-cmd-paste" title="Paste into active tab">paste</button>
          <button class="pn-cmd-edit" title="Edit">edit</button>
          <button class="pn-cmd-del" title="Delete">×</button>
        </div>
      `;
      (li.querySelector(".pn-cmd-title") as HTMLElement).textContent = c.title;
      (li.querySelector(".pn-cmd-code") as HTMLElement).textContent = c.command;
      li.querySelector(".pn-cmd-paste")!.addEventListener("click", () =>
        this.paste(c),
      );
      li.querySelector(".pn-cmd-edit")!.addEventListener("click", () =>
        this.openEditor(c),
      );
      li.querySelector(".pn-cmd-del")!.addEventListener("click", () =>
        this.delete(c),
      );
      this.list.appendChild(li);
    }
  }

  private async paste(c: Command): Promise<void> {
    try {
      await writeToActiveTabInGroup(this.hooks.groupId, c.command);
    } catch (err) {
      console.error("paste failed", err);
      // surface via a toast in real wiring; for now log only.
    }
  }

  private async delete(c: Command): Promise<void> {
    await projectNotesApi.deleteCommand(c.id);
    await this.refresh();
    this.hooks.onChange?.();
  }

  private openEditor(existing: Command | null): void {
    const dialog = document.createElement("div");
    dialog.className = "pn-cmd-editor";
    dialog.innerHTML = `
      <input class="pn-cmd-title-input" placeholder="Title" />
      <textarea class="pn-cmd-cmd-input" placeholder="Command" rows="3"></textarea>
      <div class="pn-cmd-editor-actions">
        <button class="pn-cmd-save">Save</button>
        <button class="pn-cmd-cancel">Cancel</button>
      </div>
    `;
    const titleInput = dialog.querySelector<HTMLInputElement>(".pn-cmd-title-input")!;
    const cmdInput = dialog.querySelector<HTMLTextAreaElement>(".pn-cmd-cmd-input")!;
    if (existing) {
      titleInput.value = existing.title;
      cmdInput.value = existing.command;
    }
    dialog.querySelector(".pn-cmd-cancel")!.addEventListener("click", () => dialog.remove());
    dialog.querySelector(".pn-cmd-save")!.addEventListener("click", async () => {
      const title = titleInput.value.trim();
      const command = cmdInput.value.trim();
      if (!title || !command) return;
      if (existing) {
        await projectNotesApi.updateCommand(existing.id, title, command);
      } else {
        await projectNotesApi.createCommand(this.hooks.groupId, title, command);
      }
      dialog.remove();
      await this.refresh();
      this.hooks.onChange?.();
    });
    this.container.appendChild(dialog);
    titleInput.focus();
  }
}
