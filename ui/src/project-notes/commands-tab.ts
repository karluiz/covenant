import { projectNotesApi, type Command } from "./api";
import { writeToActiveTabInGroup } from "./paste";
import { attachTooltip } from "../tooltip/tooltip";

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
    if (this.commands.length === 0) {
      const empty = document.createElement("div");
      empty.className = "rail-empty";
      empty.innerHTML = `
        <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
        <div class="rail-empty-title">No commands yet</div>
        <div class="rail-empty-hint">Click <kbd>+ New command</kbd> to add one</div>
      `;
      this.list.appendChild(empty);
      return;
    }
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
          <button class="pn-cmd-paste">paste</button>
          <button class="pn-cmd-edit">edit</button>
          <button class="pn-cmd-del">×</button>
        </div>
      `;
      (li.querySelector(".pn-cmd-title") as HTMLElement).textContent = c.title;
      (li.querySelector(".pn-cmd-code") as HTMLElement).textContent = c.command;
      const pasteBtn = li.querySelector<HTMLElement>(".pn-cmd-paste")!;
      pasteBtn.addEventListener("click", () => this.paste(c));
      attachTooltip(pasteBtn, "Paste into active tab");

      const editBtn = li.querySelector<HTMLElement>(".pn-cmd-edit")!;
      editBtn.addEventListener("click", () => this.openEditor(c));
      attachTooltip(editBtn, "Edit");

      const delBtn = li.querySelector<HTMLElement>(".pn-cmd-del")!;
      delBtn.addEventListener("click", () => this.delete(c));
      attachTooltip(delBtn, "Delete");
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
    // Only one editor at a time.
    this.container.querySelector(".pn-cmd-editor")?.remove();

    const dialog = document.createElement("div");
    dialog.className = "pn-cmd-editor";
    dialog.innerHTML = `
      <input class="pn-cmd-title-input" placeholder="Title" autocomplete="off" autocapitalize="off" spellcheck="false" />
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

    // When creating a new command, hide the empty-state placeholder and
    // surface the editor inline at the top, right under the "+ New command"
    // button — so the form appears where the user is already looking.
    const isCreating = !existing;
    const empty = this.list.querySelector<HTMLElement>(".rail-empty");
    if (isCreating && empty) empty.style.display = "none";

    const restoreEmpty = () => {
      if (isCreating && empty && this.commands.length === 0) {
        empty.style.display = "";
      }
    };

    dialog.querySelector(".pn-cmd-cancel")!.addEventListener("click", () => {
      dialog.remove();
      restoreEmpty();
    });
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

    if (isCreating) {
      this.list.insertAdjacentElement("beforebegin", dialog);
    } else {
      this.container.appendChild(dialog);
    }
    titleInput.focus();
  }
}
