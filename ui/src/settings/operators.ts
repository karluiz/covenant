// ui/src/settings/operators.ts
export * from "../operator/creator";

import {
  Operator,
  OperatorDraft,
  operatorCreate,
  operatorDelete,
  operatorList,
  operatorSetDefault,
  operatorUpdate,
  marketplacePublish,
} from "../api";
import { AVATAR_PACK_V2, parseAvatar, renderAvatarHtml } from "../operator/avatars";
import { pushInfoToast } from "../notifications/toast";
import { Icons } from "../icons";
import { MarketplacePanel } from "./operator_marketplace";
import { scheduleCloudPush } from "./cloud_push";
import { PersonaComposerModal } from "../operator/persona-composer";
import { CustomSelect } from "../ui/select";
import {
  openOperatorModal,
  renderOperatorList,
  wireOperatorModal,
  withCurrentModel,
  operatorModelOptions,
  type ModalHandle,
} from "../operator/creator";

/// Blank draft seeded into the legacy split-pane editor when starting a
/// new operator from scratch (before Task 14's SOUL.md-first modal).
const DEFAULT_DRAFT: OperatorDraft = {
  name: "",
  // Default to a v2 pack character so new operators participate in the
  // sentiment system from turn one (avatar pose + mood badge driven by
  // the LLM's SENTIMENT: tag). Any v2 character works; `bella` is a
  // neutral starter — the user can change it in the avatar grid.
  emoji: "pack2:bella",
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
  private market: MarketplacePanel | null = null;

  constructor(private mount: HTMLElement) {
    this.mount.innerHTML = `
      <div class="operators-pane-v2">
        <div class="operators-pane-v2__tabs">
          <button class="op-tab is-active" data-tab="local" type="button">My operators</button>
          <button class="op-tab" data-tab="market" type="button">Marketplace</button>
        </div>
        <header class="operators-pane-v2__head" data-role="local-head">
          <button type="button" class="operators-pane-v2__new" data-role="new">${Icons.plus({ size: 15 })}<span>New operator</span></button>
        </header>
        <div class="operators-pane-v2__grid" data-role="grid"></div>
        <div class="operators-pane-v2__market" data-role="market" hidden></div>
      </div>
    `;
    this.grid = this.mount.querySelector<HTMLElement>('[data-role="grid"]');
    this.mount
      .querySelector<HTMLButtonElement>('[data-role="new"]')
      ?.addEventListener("click", () => this.startCreate());
    this.mount.querySelectorAll<HTMLButtonElement>(".op-tab").forEach((b) =>
      b.addEventListener("click", () => this.showTab(b.dataset.tab as "local" | "market")),
    );
  }

  private showTab(tab: "local" | "market"): void {
    const isLocal = tab === "local";
    this.mount.querySelectorAll<HTMLButtonElement>(".op-tab").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.tab === tab),
    );
    this.mount.querySelector<HTMLElement>('[data-role="grid"]')!.hidden = !isLocal;
    this.mount.querySelector<HTMLElement>('[data-role="local-head"]')!.hidden = !isLocal;
    const marketEl = this.mount.querySelector<HTMLElement>('[data-role="market"]')!;
    marketEl.hidden = isLocal;
    if (!isLocal && !this.market) {
      this.market = new MarketplacePanel(marketEl, () => void this.refresh());
    }
    if (!isLocal) void this.market!.open();
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
      onPublish: (op) => void this.publishOperator(op),
    });
    this.grid.appendChild(list);
  }

  private openModalWith(handle: ModalHandle): void {
    wireOperatorModal(handle, {
      onSaved: () => this.refresh(),
      onDelete: (op) => this.deleteOperator(op),
    });
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
      // Notify the rest of the app — tabs/manager.ts drops the cache
      // entry and clears any pane.operator pointer; the status bar
      // re-renders without the dangling avatar.
      window.dispatchEvent(
        new CustomEvent("operator:deleted", { detail: { id: op.id } }),
      );
      await this.refresh();
      pushInfoToast({ message: `Deleted operator: ${op.name}` });
      scheduleCloudPush();
    } catch (e) {
      alert(`Delete failed: ${e}`);
    }
  }

  private async publishOperator(op: Operator): Promise<void> {
    try {
      await marketplacePublish(op.id);
      pushInfoToast({ message: `"${op.name}" submitted — pending review.` });
    } catch (e) {
      pushInfoToast({ message: `Publish failed: ${e}` });
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
        const star = op.is_default ? Icons.star({ size: 13 }) : "";
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
      <button type="button" class="operators-pane__new" data-role="new">${Icons.plus({ size: 15 })}<span>New operator</span></button>
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
        <div class="operators-pane__avatar-grid" data-avatar-pack="v2">
          ${AVATAR_PACK_V2.map((a) => {
            const selected = this.editing.emoji === `pack2:${a.character}`;
            // data-poses is a JSON-encoded array of all URLs for this
            // character (in arbitrary emotion order). The click handler
            // wires up hover cycling from it — keeps the markup
            // declarative so render() can be re-run without leaking
            // listeners.
            const poses = Object.values(a.urlsByEmotion).filter(Boolean) as string[];
            return `<button type="button"
                            class="operators-pane__avatar-cell${selected ? " is-selected" : ""}"
                            data-avatar-id="${a.character}"
                            data-poses='${escapeHtml(JSON.stringify(poses))}'
                            aria-label="${escapeHtml(a.label)}">
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
        <label>Skills <span class="muted">(comma-separated — drive who gets handed work)</span></label>
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
          <span data-role="model-select"></span>
        </div>
      </div>

      <details class="operators-pane__advanced"
               ${this.editing.hard_constraints.trim().length > 0 ? "open" : ""}>
        <summary>Hard constraints <span class="muted">(optional — regex deny rules, one per line)</span></summary>
        <textarea data-bind="hard_constraints" rows="5"
          placeholder="One regex per line — matching commands are never auto-executed. Examples:&#10;^git push --force&#10;^npm publish&#10;^terraform apply"
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
      const el = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(
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

    const modelHost = root.querySelector<HTMLElement>('[data-role="model-select"]');
    if (modelHost) {
      const modelSelect = new CustomSelect({
        className: "operators-pane__select",
        ariaLabel: "Operator model",
        value: this.editing.model,
        options: withCurrentModel([], this.editing.model),
      });
      modelSelect.element.addEventListener("change", () => {
        this.editing.model = modelSelect.value;
        this.dirty = true;
      });
      modelHost.replaceWith(modelSelect.element);
      void operatorModelOptions(this.editing.model).then((opts) => {
        modelSelect.setOptions(opts, this.editing.model);
      });
    }

    // Wire avatar grid clicks + hover cycling. Each button stores its
    // pose URLs in `data-poses` (JSON array). On hover we cycle through
    // them at 250ms intervals to preview the character's emotional
    // range; on leave we snap back to the neutral pose (= the <img>'s
    // current src as rendered initially). Click writes
    // `pack2:<character>` to the draft.
    root.querySelectorAll<HTMLButtonElement>('.operators-pane__avatar-cell').forEach((btn) => {
      const img = btn.querySelector("img");
      const neutralSrc = img?.getAttribute("src") ?? "";
      let poses: string[] = [];
      try {
        poses = JSON.parse(btn.dataset.poses ?? "[]");
      } catch { /* malformed — leave empty, no cycle */ }
      let cycleTimer: number | null = null;
      btn.addEventListener("mouseenter", () => {
        if (!img || poses.length < 2) return;
        let i = 0;
        cycleTimer = window.setInterval(() => {
          i = (i + 1) % poses.length;
          img.src = poses[i]!;
        }, 250);
      });
      btn.addEventListener("mouseleave", () => {
        if (cycleTimer != null) {
          clearInterval(cycleTimer);
          cycleTimer = null;
        }
        if (img && neutralSrc) img.src = neutralSrc;
      });
      btn.addEventListener("click", () => {
        const character = btn.dataset.avatarId!;
        this.editing.emoji = `pack2:${character}`;
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
      scheduleCloudPush();
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
      scheduleCloudPush();
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
