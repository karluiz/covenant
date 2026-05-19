// ui/src/settings/operators.ts
import {
  Operator,
  OperatorDraft,
  VoiceTone,
  operatorCreate,
  operatorDelete,
  operatorList,
  operatorSetDefault,
  operatorUpdate,
} from "../api";
import { PRESETS, type PresetKey } from "./operator_presets";
import { renderOperatorChip } from "./operator_chip";
import { AVATAR_PACK, parseAvatar, renderAvatarHtml } from "../operator/avatars";
import { pushInfoToast } from "../notifications/toast";
import { Icons } from "../icons";
import { PersonaComposerModal } from "../operator/persona-composer";

const DEFAULT_DRAFT: OperatorDraft = {
  name: "",
  emoji: "🤖",
  color: "#6B7280",
  tags: [],
  persona: "",
  escalate_threshold: 0.6,
  model: "claude-sonnet-4-6",
  hard_constraints: "",
  voice: "Terse",
};

/// New settings pane (Task 16) — uses the shared
/// `renderOperatorList` card grid + the two-step `openOperatorModal`.
/// The legacy split-pane editor is retained below as
/// `LegacyOperatorsPane` for reference; the panel.ts wiring now
/// targets this thinner shell.
///
/// Behavior preserved from the legacy pane:
///   - List + Edit + Duplicate + Delete (Delete still calls
///     `operator_delete`).
///   - Re-fetch on save (via `refresh()`).
///   - Discard-confirm on close-without-save is now handled inside the
///     modal lifecycle (Cancel/X simply discards — TODO(task-17) port
///     the "discard unsaved changes?" prompt if it shows up missing
///     in QA).
export class OperatorsPane {
  private operators: Operator[] = [];
  private grid: HTMLElement | null = null;

  constructor(private mount: HTMLElement) {
    this.mount.innerHTML = `
      <div class="operators-pane-v2">
        <header class="operators-pane-v2__head">
          <h4>Operators</h4>
          <button type="button" class="primary" data-role="new">+ New operator</button>
        </header>
        <div class="operators-pane-v2__grid" data-role="grid"></div>
      </div>
    `;
    this.grid = this.mount.querySelector<HTMLElement>('[data-role="grid"]');
    this.mount
      .querySelector<HTMLButtonElement>('[data-role="new"]')
      ?.addEventListener("click", () => this.startCreate());
  }

  async open(): Promise<void> {
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    this.operators = await operatorList();
    if (!this.grid) return;
    this.grid.innerHTML = "";
    const list = renderOperatorList(this.operators, {
      onEdit: (op) => this.startEdit(op),
      onDelete: (op) => void this.deleteOperator(op),
      onDuplicate: (op) => this.startDuplicate(op),
    });
    this.grid.appendChild(list);
  }

  private openModalWith(handle: ModalHandle): void {
    // Wrap the modal save so we refresh the grid after the underlying
    // `operator_create` / `operator_update` Tauri command resolves.
    const origSave = handle.el.querySelector<HTMLButtonElement>(".op-modal-save");
    // The modal autowires its save button to `saveOperator(h)`; we
    // observe completion by polling for the modal being torn down.
    // Simpler: hook a one-shot click that wraps saveOperator + refresh.
    // We re-bind the save button after each render — use event
    // delegation off the modal root.
    handle.el.addEventListener("click", (ev) => {
      const target = ev.target as HTMLElement | null;
      if (!target) return;
      if (target.classList.contains("op-modal-save")) {
        ev.stopImmediatePropagation();
        ev.preventDefault();
        (async () => {
          try {
            await saveOperator(handle);
            handle.el.remove();
            await this.refresh();
            pushInfoToast({
              message: `${handle.state.mode === "edit" ? "Saved" : "Created"} operator: ${handle.state.draft.name}`,
            });
          } catch (e) {
            // eslint-disable-next-line no-console
            console.error("operator save failed", e);
            alert(`Save failed: ${e}`);
          }
        })();
      }
    }, true);
    // Reference origSave to suppress unused-var lints; the capture
    // listener above pre-empts the inner click handler.
    void origSave;

    // Lightweight close affordance: click outside the inner card or
    // press Escape. We don't have a wrapper backdrop in the modal,
    // so add a global Escape listener tied to this modal instance.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && document.body.contains(handle.el)) {
        handle.el.remove();
        document.removeEventListener("keydown", onKey);
      }
    };
    document.addEventListener("keydown", onKey);
  }

  private startCreate(): void {
    this.openModalWith(openOperatorModal({ mode: "create" }));
  }

  private startEdit(op: Operator): void {
    this.openModalWith(openOperatorModal({ mode: "edit", existing: op }));
  }

  private startDuplicate(op: Operator): void {
    // Duplicate = create-mode seeded from existing draft, name suffixed.
    const seeded: Operator = { ...op, name: `${op.name} copy` };
    this.openModalWith(openOperatorModal({ mode: "create", existing: seeded }));
  }

  private async deleteOperator(op: Operator): Promise<void> {
    if (op.is_default) {
      alert("Cannot delete the default operator. Set a different default first.");
      return;
    }
    if (this.operators.length <= 1) {
      alert("Cannot delete the last operator.");
      return;
    }
    if (!confirm(`Delete operator "${op.name}"? Tabs pinned to it will fall back to the default.`)) {
      return;
    }
    try {
      await operatorDelete(op.id);
      await this.refresh();
      pushInfoToast({ message: `Deleted operator: ${op.name}` });
    } catch (e) {
      alert(`Delete failed: ${e}`);
    }
  }
}

/// Legacy pane — kept for reference until Task 17 visual QA confirms
/// the new grid handles every code path the old form did (set-default,
/// persona composer, hard-constraints expander). The panel does NOT
/// instantiate this class anymore. Exported so noUnusedLocals doesn't
/// complain; rename or drop after Task 17.
export class LegacyOperatorsPane {
  private operators: Operator[] = [];
  private selectedId: string | null = null;
  private dirty = false;
  private editing: OperatorDraft = { ...DEFAULT_DRAFT };
  private composer = new PersonaComposerModal();

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
      voice: sel.voice,
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
          <button type="button" class="operators-pane__row${selected}" data-id="${op.id}">
            <span class="operators-pane__row-emoji"
                  style="background:${op.color}">${renderAvatarHtml(op.emoji, 22)}</span>
            <span class="operators-pane__row-name">${escapeHtml(op.name)}</span>
            <span class="operators-pane__row-star">${star}</span>
          </button>`;
      })
      .join("");
    root.innerHTML = `
      ${items}
      <button type="button" class="operators-pane__new" data-role="new">+ New operator</button>
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
          <button type="button" data-act="set-default" ${canSetDefault ? "" : "disabled"}>
            Set as default
          </button>
          <button type="button" data-act="duplicate" ${isNew ? "disabled" : ""}>
            Duplicate
          </button>
          <button type="button" data-act="delete" class="danger" ${canDelete ? "" : "disabled"}>
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
        <input data-bind="tags" type="text" autocapitalize="off" autocorrect="off" spellcheck="false"
               value="${escapeHtml(this.editing.tags.join(", "))}" />
      </div>

      <div class="operators-pane__field operators-pane__field--persona">
        <label>
          Persona / authorization charter
          <button type="button" class="operators-pane__persona-expand"
                  data-role="persona-expand" title="Expand editor">
            ${Icons.maximize({ size: 14 })}
          </button>
        </label>
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
        <button type="button" data-act="cancel">Discard changes</button>
        <button type="button" data-act="save" class="primary">
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

    const expandBtn = root.querySelector<HTMLButtonElement>(
      '[data-role="persona-expand"]',
    );
    const personaTextarea = root.querySelector<HTMLTextAreaElement>(
      'textarea[data-bind="persona"]',
    );
    if (expandBtn && personaTextarea) {
      expandBtn.addEventListener("click", () => {
        this.composer.open(personaTextarea.value, (next) => {
          personaTextarea.value = next;
          // Fire 'input' so the existing data-bind plumbing picks up
          // the change and marks the form dirty.
          personaTextarea.dispatchEvent(new Event("input", { bubbles: true }));
        });
      });
    }

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
      const isCreate = this.selectedId === null;
      let savedName = this.editing.name;
      if (isCreate) {
        const created = await operatorCreate(this.editing);
        this.selectedId = created.id;
        savedName = created.name;
      } else {
        const updated = await operatorUpdate(this.selectedId!, this.editing);
        savedName = updated.name;
      }
      this.dirty = false;
      await this.refresh();
      pushInfoToast({ message: `${isCreate ? "Created" : "Saved"} operator: ${savedName}` });
    } catch (e) {
      alert(`Save failed: ${e}`);
    }
  }

  private async setDefault(): Promise<void> {
    if (this.selectedId === null) return;
    try {
      await operatorSetDefault(this.selectedId);
      const name = this.operators.find((o) => o.id === this.selectedId)?.name ?? "operator";
      await this.refresh();
      pushInfoToast({ message: `Default set to ${name}` });
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
      pushInfoToast({ message: `Deleted operator: ${name}` });
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
      voice: sel.voice,
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

// ─────────────────────────────────────────────────────────────────────────────
// Task 14 — two-step "New Operator" modal.
// Step 1: Identity (name, emoji, color, voice + chip preview)
// Step 2: Behavior (model, escalate_threshold, persona, hard_constraints)
// Public surface: openOperatorModal, canProceedFromStep1, saveOperator.
// ─────────────────────────────────────────────────────────────────────────────

export interface ModalDraft extends OperatorDraft {
  id?: string;
}

export interface ModalState {
  mode: "create" | "edit";
  draft: ModalDraft;
}

export interface ModalHandle {
  state: ModalState;
  el: HTMLElement;
  setName(s: string): void;
  setEmoji(s: string): void;
  setColor(s: string): void;
  setVoice(v: VoiceTone): void;
  applyPreset(key: PresetKey): void;
}

export function canSave(m: ModalHandle): boolean {
  const n = m.state.draft.name.trim();
  return n.length > 0 && [...n].length <= 24;
}

// Back-compat alias used by the unit tests written against the
// earlier two-step wizard. Behaves identically to `canSave`.
export const canProceedFromStep1 = canSave;

const SWATCHES = [
  "#a855f7", "#22c55e", "#3b82f6", "#eab308",
  "#f97316", "#ef4444", "#a16207", "#94a3b8",
];

function defaultDraft(): ModalDraft {
  return {
    name: "",
    emoji: "🟣",
    color: "#a855f7",
    voice: "Terse",
    tags: [],
    persona: "",
    escalate_threshold: 0.5,
    model: "claude-sonnet-4-6",
    hard_constraints: "",
  };
}

function draftFromExisting(op: Operator): ModalDraft {
  return {
    id: op.id,
    name: op.name,
    emoji: op.emoji,
    color: op.color,
    voice: op.voice,
    tags: [...op.tags],
    persona: op.persona,
    escalate_threshold: op.escalate_threshold,
    model: op.model,
    hard_constraints: op.hard_constraints,
  };
}

export function openOperatorModal(opts: {
  mode: "create" | "edit";
  preset?: PresetKey;
  existing?: Operator;
}): ModalHandle {
  let draft: ModalDraft;
  if (opts.existing) {
    draft = draftFromExisting(opts.existing);
  } else if (opts.preset) {
    const preset = PRESETS.find((p) => p.key === opts.preset);
    draft = preset ? { ...preset.seed() } : defaultDraft();
  } else {
    draft = defaultDraft();
  }

  const state: ModalState = {
    mode: opts.mode,
    draft,
  };

  const el = document.createElement("div");
  el.className = "op-modal";
  el.addEventListener("click", (ev) => {
    if (ev.target === el) el.remove();
  });
  document.body.appendChild(el);

  const h: ModalHandle = {
    state,
    el,
    setName(s) { state.draft.name = s; render(); },
    setEmoji(s) { state.draft.emoji = s; render(); },
    setColor(s) { state.draft.color = s; render(); },
    setVoice(v) { state.draft.voice = v; render(); },
    applyPreset(key) {
      const preset = PRESETS.find((p) => p.key === key);
      if (!preset) return;
      // Preserve the operator's name if the user already typed one; otherwise
      // adopt the preset's name.
      const userName = state.draft.name.trim();
      state.draft = { ...preset.seed() };
      if (userName) state.draft.name = userName;
      render();
    },
  };

  function render(): void {
    el.innerHTML = "";
    el.append(renderForm(h));
  }
  render();
  return h;
}

function labeled(text: string, child: HTMLElement): HTMLElement {
  const w = document.createElement("label");
  w.className = "op-modal-field";
  const t = document.createElement("span");
  t.className = "op-modal-label";
  t.textContent = text;
  w.append(t, child);
  return w;
}

function renderForm(h: ModalHandle): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "op-modal-step op-modal-form";

  // ── Header: live chip preview + dismiss "×" ────────────────────────────
  const header = document.createElement("div");
  header.className = "op-modal-header";
  header.append(
    renderOperatorChip(
      {
        name: h.state.draft.name || "New operator",
        emoji: h.state.draft.emoji,
        color: h.state.draft.color,
      },
      "lg",
    ),
  );
  const close = document.createElement("button");
  close.type = "button";
  close.className = "op-modal-close";
  close.setAttribute("aria-label", "Close");
  close.textContent = "×";
  close.addEventListener("click", () => h.el.remove());
  header.append(close);
  wrap.append(header);

  // ── Presets (create mode only) ─────────────────────────────────────────
  if (h.state.mode === "create") {
    const presetRow = document.createElement("div");
    presetRow.className = "op-preset-row";
    const presetLabel = document.createElement("span");
    presetLabel.className = "op-modal-label op-preset-label";
    presetLabel.textContent = "Start from preset";
    presetRow.append(presetLabel);
    const chips = document.createElement("div");
    chips.className = "op-preset-chips";
    PRESETS.forEach((p) => {
      const c = document.createElement("button");
      c.type = "button";
      c.className = "op-preset-chip";
      c.title = p.description;
      c.textContent = p.label;
      c.addEventListener("click", () => h.applyPreset(p.key));
      chips.append(c);
    });
    presetRow.append(chips);
    wrap.append(presetRow);
  }

  // ── Identity section ───────────────────────────────────────────────────
  wrap.append(section("Identity"));

  const name = document.createElement("input");
  name.type = "text";
  name.maxLength = 24;
  name.placeholder = "Operator name";
  name.value = h.state.draft.name;
  name.addEventListener("input", () => h.setName(name.value));
  wrap.append(labeled("Name", name));

  // Avatar picker — grid of pack thumbnails. Selected = ring.
  const avatarGrid = document.createElement("div");
  avatarGrid.className = "op-avatar-grid";
  AVATAR_PACK.forEach((entry) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className =
      "op-avatar-tile" +
      (h.state.draft.emoji === `pack:${entry.id}` ? " is-selected" : "");
    b.title = entry.label;
    const img = document.createElement("img");
    img.src = entry.url;
    img.alt = entry.label;
    img.width = 40;
    img.height = 40;
    img.draggable = false;
    b.append(img);
    b.addEventListener("click", () => h.setEmoji(`pack:${entry.id}`));
    avatarGrid.append(b);
  });
  wrap.append(labeled("Avatar", avatarGrid));

  // Custom emoji fallback
  const emoji = document.createElement("input");
  emoji.type = "text";
  emoji.maxLength = 16;
  emoji.placeholder = "Or type an emoji / leave a pack: value";
  emoji.value = h.state.draft.emoji;
  emoji.addEventListener("input", () => h.setEmoji(emoji.value));
  wrap.append(labeled("Custom emoji", emoji));

  const colors = document.createElement("div");
  colors.className = "op-color-row";
  SWATCHES.forEach((c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "op-color-swatch" + (h.state.draft.color === c ? " is-selected" : "");
    b.style.background = c;
    b.dataset.color = c;
    b.addEventListener("click", () => h.setColor(c));
    colors.append(b);
  });
  wrap.append(labeled("Color", colors));

  const voiceRow = document.createElement("div");
  voiceRow.className = "op-voice-row";
  (["Terse", "Warm", "Formal"] as VoiceTone[]).forEach((v) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = v;
    b.className = "op-voice" + (h.state.draft.voice === v ? " op-voice-active" : "");
    b.addEventListener("click", () => h.setVoice(v));
    voiceRow.append(b);
  });
  wrap.append(labeled("Voice", voiceRow));

  // ── Behavior section ───────────────────────────────────────────────────
  wrap.append(section("Behavior"));

  const model = document.createElement("input");
  model.type = "text";
  model.value = h.state.draft.model;
  model.addEventListener("input", () => {
    h.state.draft.model = model.value;
  });
  wrap.append(labeled("Model", model));

  const thr = document.createElement("input");
  thr.type = "number";
  thr.min = "0";
  thr.max = "1";
  thr.step = "0.05";
  thr.value = String(h.state.draft.escalate_threshold);
  thr.addEventListener("input", () => {
    const v = Number.parseFloat(thr.value);
    if (!Number.isNaN(v)) h.state.draft.escalate_threshold = v;
  });
  wrap.append(labeled("Escalate threshold", thr));

  const persona = document.createElement("textarea");
  persona.rows = 10;
  persona.value = h.state.draft.persona;
  persona.addEventListener("input", () => {
    h.state.draft.persona = persona.value;
  });
  wrap.append(labeled("Persona", persona));

  const hc = document.createElement("textarea");
  hc.rows = 4;
  hc.value = h.state.draft.hard_constraints;
  hc.addEventListener("input", () => {
    h.state.draft.hard_constraints = hc.value;
  });
  wrap.append(labeled("Hard constraints", hc));

  // ── Actions (right-aligned, matches Settings page) ─────────────────────
  const actions = document.createElement("div");
  actions.className = "op-modal-actions settings-actions";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "settings-cancel";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => h.el.remove());

  const save = document.createElement("button");
  save.type = "button";
  save.className = "op-modal-save settings-save";
  save.textContent = h.state.mode === "edit" ? "Save changes" : "Create operator";
  save.disabled = !canSave(h);
  save.addEventListener("click", () => {
    void saveOperator(h);
  });

  actions.append(cancel, save);
  wrap.append(actions);

  return wrap;
}

function section(title: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "op-modal-section";
  el.textContent = title;
  return el;
}

export async function saveOperator(h: ModalHandle): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { id, ...draft } = h.state.draft;
  if (h.state.mode === "edit" && id) {
    await invoke("operator_update", { id, draft });
  } else {
    await invoke("operator_create", { draft });
  }
}

export interface ListHandlers {
  onEdit(op: Operator): void;
  onDelete(op: Operator): void;
  onDuplicate(op: Operator): void;
}

export function renderOperatorList(ops: Operator[], h: ListHandlers): HTMLElement {
  const root = document.createElement("div");
  root.className = "op-card-grid";
  for (const op of ops) {
    const card = document.createElement("div");
    card.className = "op-card";
    card.append(renderOperatorChip(op, "lg"));
    const summary = document.createElement("div");
    summary.className = "op-card-summary";
    summary.textContent = `${op.voice} · threshold ${op.escalate_threshold.toFixed(2)} · ${op.model || "—"}`;
    card.append(summary);
    const actions = document.createElement("div");
    actions.className = "op-card-actions";
    const mk = (label: string, fn: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "op-card-btn";
      b.textContent = label;
      b.addEventListener("click", fn);
      return b;
    };
    actions.append(mk("Edit", () => h.onEdit(op)));
    actions.append(mk("Duplicate", () => h.onDuplicate(op)));
    actions.append(mk("Delete", () => h.onDelete(op)));
    card.append(actions);
    root.append(card);
  }
  return root;
}
