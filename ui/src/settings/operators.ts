// ui/src/settings/operators.ts
import {
  Operator,
  OperatorDraft,
  operatorCreate,
  operatorDelete,
  operatorList,
  operatorSetDefault,
  operatorUpdate,
} from "../api";
import { AVATAR_PACK, parseAvatar, renderAvatarHtml } from "../operator/avatars";

const DEFAULT_DRAFT: OperatorDraft = {
  name: "",
  emoji: "🤖",
  color: "#6B7280",
  tags: [],
  persona: "",
  escalate_threshold: 0.6,
  model: "claude-sonnet-4-6",
  hard_constraints: "",
};

export class OperatorsPane {
  private operators: Operator[] = [];
  private selectedId: string | null = null;
  private dirty = false;
  private editing: OperatorDraft = { ...DEFAULT_DRAFT };

  constructor(private mount: HTMLElement) {
    this.mount.innerHTML = `
      <div class="operators-pane__layout">
        <aside class="operators-pane__list" data-role="list"></aside>
        <section class="operators-pane__editor" data-role="editor"></section>
      </div>
    `;
  }

  async open(): Promise<void> {
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    this.operators = await operatorList();
    if (this.selectedId === null && this.operators.length > 0) {
      this.selectedId = this.operators.find((o) => o.is_default)?.id
        ?? this.operators[0].id;
      this.loadDraftFromSelected();
    }
    this.renderList();
    this.renderEditor();
  }

  private loadDraftFromSelected(): void {
    const sel = this.operators.find((o) => o.id === this.selectedId);
    if (!sel) {
      this.editing = { ...DEFAULT_DRAFT };
      this.dirty = false;
      return;
    }
    this.editing = {
      name: sel.name,
      emoji: sel.emoji,
      color: sel.color,
      tags: [...sel.tags],
      persona: sel.persona,
      escalate_threshold: sel.escalate_threshold,
      model: sel.model,
      hard_constraints: sel.hard_constraints,
    };
    this.dirty = false;
  }

  private renderList(): void {
    const root = this.mount.querySelector<HTMLElement>('[data-role="list"]')!;
    const items = this.operators
      .map((op) => {
        const star = op.is_default ? "⭐" : "";
        const selected = op.id === this.selectedId ? " is-selected" : "";
        return `
          <button class="operators-pane__row${selected}" data-id="${op.id}">
            <span class="operators-pane__row-emoji"
                  style="background:${op.color}">${renderAvatarHtml(op.emoji, 22)}</span>
            <span class="operators-pane__row-name">${escapeHtml(op.name)}</span>
            <span class="operators-pane__row-star">${star}</span>
          </button>`;
      })
      .join("");
    root.innerHTML = `
      ${items}
      <button class="operators-pane__new" data-role="new">+ New operator</button>
    `;
    root.querySelectorAll<HTMLButtonElement>('.operators-pane__row').forEach((btn) => {
      btn.addEventListener("click", () => this.selectId(btn.dataset.id!));
    });
    root.querySelector<HTMLButtonElement>('[data-role="new"]')!
      .addEventListener("click", () => this.startNew());
  }

  private selectId(id: string): void {
    if (this.dirty && !confirm("Discard unsaved changes?")) return;
    this.selectedId = id;
    this.loadDraftFromSelected();
    this.renderList();
    this.renderEditor();
  }

  private startNew(): void {
    if (this.dirty && !confirm("Discard unsaved changes?")) return;
    this.selectedId = null;
    this.editing = { ...DEFAULT_DRAFT };
    this.dirty = true;
    this.renderList();
    this.renderEditor();
  }

  private renderEditor(): void {
    const root = this.mount.querySelector<HTMLElement>('[data-role="editor"]')!;
    const isNew = this.selectedId === null;
    const sel = this.operators.find((o) => o.id === this.selectedId);
    const isDefault = sel?.is_default ?? false;
    const canDelete = !isNew && !isDefault && this.operators.length > 1;
    const canSetDefault = !isNew && !isDefault;

    root.innerHTML = `
      <header class="operators-pane__editor-head">
        <h4>${isNew ? "New operator" : escapeHtml(sel!.name)}</h4>
        <div class="operators-pane__editor-actions">
          <button data-act="set-default" ${canSetDefault ? "" : "disabled"}>
            Set as default
          </button>
          <button data-act="duplicate" ${isNew ? "disabled" : ""}>
            Duplicate
          </button>
          <button data-act="delete" class="danger" ${canDelete ? "" : "disabled"}>
            Delete
          </button>
        </div>
      </header>

      <div class="operators-pane__field">
        <label>Name</label>
        <input data-bind="name" type="text" maxlength="64"
               value="${escapeHtml(this.editing.name)}" />
      </div>

      <div class="operators-pane__field">
        <label>Avatar</label>
        <div class="operators-pane__avatar-grid">
          ${AVATAR_PACK.map((a) => {
            const selected = this.editing.emoji === `pack:${a.id}`;
            return `<button type="button"
                            class="operators-pane__avatar-cell${selected ? " is-selected" : ""}"
                            data-avatar-id="${a.id}"
                            title="${escapeHtml(a.label)}">
                      <img src="${a.url}" alt="${escapeHtml(a.label)}"
                           width="56" height="56"
                           class="op-avatar op-avatar-pixel" draggable="false" />
                    </button>`;
          }).join("")}
        </div>
        <details class="operators-pane__avatar-fallback">
          <summary>or use an emoji</summary>
          <input type="text" data-bind="emoji" maxlength="4"
                 value="${escapeHtml(parseAvatar(this.editing.emoji).kind === "emoji" ? (parseAvatar(this.editing.emoji) as { kind: "emoji"; char: string }).char : "")}"
                 placeholder="🤖" />
        </details>
      </div>

      <div class="operators-pane__field">
        <label>Color</label>
        <input data-bind="color" type="color"
               value="${this.editing.color}" />
      </div>

      <div class="operators-pane__field">
        <label>Tags <span class="muted">(comma-separated)</span></label>
        <input data-bind="tags" type="text"
               value="${escapeHtml(this.editing.tags.join(", "))}" />
      </div>

      <div class="operators-pane__field">
        <label>Persona / authorization charter</label>
        <textarea data-bind="persona" rows="14">${escapeHtml(this.editing.persona)}</textarea>
      </div>

      <div class="operators-pane__row-2">
        <div class="operators-pane__field">
          <label>Escalate threshold
            <span class="muted" data-role="threshold-readout">
              ${this.editing.escalate_threshold.toFixed(2)}
            </span>
          </label>
          <input data-bind="escalate_threshold" type="range"
                 min="0" max="1" step="0.05"
                 value="${this.editing.escalate_threshold}" />
        </div>
        <div class="operators-pane__field">
          <label>Model</label>
          <select data-bind="model">
            <option value="claude-haiku-4-5-20251001"
              ${this.editing.model.startsWith("claude-haiku") ? "selected" : ""}>
              Haiku 4.5
            </option>
            <option value="claude-sonnet-4-6"
              ${this.editing.model.startsWith("claude-sonnet") ? "selected" : ""}>
              Sonnet 4.6
            </option>
            <option value="claude-opus-4-7"
              ${this.editing.model.startsWith("claude-opus") ? "selected" : ""}>
              Opus 4.7
            </option>
          </select>
        </div>
      </div>

      <details class="operators-pane__advanced"
               ${this.editing.hard_constraints.trim().length > 0 ? "open" : ""}>
        <summary>Hard constraints <span class="muted">(optional — extra ALWAYS-ASK-ME, one per line)</span></summary>
        <textarea data-bind="hard_constraints" rows="5"
          placeholder="One rule per line. Examples:&#10;always ask before touching ~/.aws or ~/.ssh&#10;never auto-merge to main&#10;ask before npm install of new packages&#10;skip auto-formatting on *.lock"
          >${escapeHtml(this.editing.hard_constraints)}</textarea>
      </details>

      <footer class="operators-pane__editor-foot">
        <button data-act="cancel">Discard changes</button>
        <button data-act="save" class="primary">
          ${isNew ? "Create operator" : "Save operator"}
        </button>
      </footer>
    `;

    this.wireEditor(root);
  }

  private wireEditor(root: HTMLElement): void {
    const bind = <K extends keyof OperatorDraft>(name: K, parse: (v: string) => OperatorDraft[K]) => {
      const el = root.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
        `[data-bind="${String(name)}"]`,
      );
      el?.addEventListener("input", () => {
        (this.editing as unknown as Record<string, unknown>)[name as string] = parse(el.value);
        this.dirty = true;
        if (name === "escalate_threshold") {
          const out = root.querySelector<HTMLElement>('[data-role="threshold-readout"]');
          if (out) out.textContent = this.editing.escalate_threshold.toFixed(2);
        }
      });
    };

    // Wire avatar grid clicks — each button sets emoji to "pack:<id>"
    root.querySelectorAll<HTMLButtonElement>('.operators-pane__avatar-cell').forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.avatarId!;
        this.editing.emoji = `pack:${id}`;
        this.dirty = true;
        root.querySelectorAll('.operators-pane__avatar-cell').forEach(c => c.classList.remove('is-selected'));
        btn.classList.add('is-selected');
        const emojiInput = root.querySelector<HTMLInputElement>('[data-bind="emoji"]');
        if (emojiInput) emojiInput.value = "";
      });
    });

    bind("name", (v) => v);
    bind("emoji", (v) => v);
    bind("color", (v) => v);
    bind("tags", (v) =>
      v.split(",").map((s) => s.trim()).filter((s) => s.length > 0),
    );
    bind("persona", (v) => v);
    bind("escalate_threshold", (v) => Number.parseFloat(v));
    bind("model", (v) => v);
    bind("hard_constraints", (v) => v);

    root.querySelector<HTMLButtonElement>('[data-act="cancel"]')!
      .addEventListener("click", () => {
        this.loadDraftFromSelected();
        this.renderEditor();
      });

    root.querySelector<HTMLButtonElement>('[data-act="save"]')!
      .addEventListener("click", () => this.save());

    root.querySelector<HTMLButtonElement>('[data-act="set-default"]')
      ?.addEventListener("click", () => this.setDefault());

    root.querySelector<HTMLButtonElement>('[data-act="delete"]')
      ?.addEventListener("click", () => this.deleteSelected());

    root.querySelector<HTMLButtonElement>('[data-act="duplicate"]')
      ?.addEventListener("click", () => this.duplicate());
  }

  private async save(): Promise<void> {
    if (this.editing.name.trim().length === 0) {
      alert("Name is required.");
      return;
    }
    try {
      if (this.selectedId === null) {
        const created = await operatorCreate(this.editing);
        this.selectedId = created.id;
      } else {
        await operatorUpdate(this.selectedId, this.editing);
      }
      this.dirty = false;
      await this.refresh();
    } catch (e) {
      alert(`Save failed: ${e}`);
    }
  }

  private async setDefault(): Promise<void> {
    if (this.selectedId === null) return;
    try {
      await operatorSetDefault(this.selectedId);
      await this.refresh();
    } catch (e) {
      alert(`Set default failed: ${e}`);
    }
  }

  private async deleteSelected(): Promise<void> {
    if (this.selectedId === null) return;
    const name = this.operators.find((o) => o.id === this.selectedId)?.name ?? "?";
    if (!confirm(`Delete operator "${name}"? Tabs pinned to it will fall back to the default.`))
      return;
    try {
      await operatorDelete(this.selectedId);
      this.selectedId = null;
      await this.refresh();
    } catch (e) {
      alert(`Delete failed: ${e}`);
    }
  }

  private duplicate(): void {
    const sel = this.operators.find((o) => o.id === this.selectedId);
    if (!sel) return;
    this.selectedId = null;
    this.editing = {
      name: `${sel.name} copy`,
      emoji: sel.emoji,
      color: sel.color,
      tags: [...sel.tags],
      persona: sel.persona,
      escalate_threshold: sel.escalate_threshold,
      model: sel.model,
      hard_constraints: sel.hard_constraints,
    };
    this.dirty = true;
    this.renderList();
    this.renderEditor();
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
