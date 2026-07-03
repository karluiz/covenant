// ui/src/settings/operators.ts
import {
  Operator,
  OperatorDraft,
  VoiceTone,
  operatorCreate,
  operatorDelete,
  operatorList,
  operatorSetDefault,
  operatorSetGithubAccess,
  operatorSetAcpEnabled,
  operatorUpdate,
  operatorListArchetypes,
  operatorSoulRead,
  operatorSoulParse,
  getSettings,
  listModelsAnthropic,
  listModelsAzureFoundry,
  listModelsOpenAiCompat,
  marketplacePublish,
  type ArchetypeView,
  type GithubAccess,
  type SoulView,
  type ModelInfo,
} from "../api";
import { PRESETS, type PresetKey } from "./operator_presets";
import { setFrontmatterScalar } from "./soul_frontmatter";
import { renderOperatorChip } from "./operator_chip";
import { AVATAR_PACK_V2, parseAvatar, renderAvatarHtml } from "../operator/avatars";
import { pushInfoToast } from "../notifications/toast";
import { Icons } from "../icons";
import { attachTooltip } from "../tooltip/tooltip";
import { MarketplacePanel } from "./operator_marketplace";
import { scheduleCloudPush } from "./cloud_push";
import { PersonaComposerModal } from "../operator/persona-composer";
import { CustomSelect } from "../ui/select";
import { MarkdownEditor } from "../ui/markdown-editor";
import "./operator-creator.css";

/// Blank SOUL.md template seeded into the editor when the user starts
/// from scratch (or opens create-mode before picking an archetype).
const BLANK_SOUL = `---\nname: New Operator\nvoice: terse\nescalate_threshold: 0.6\n---\n\n# New Operator\n\n`;

/// Starter skill vocabulary for the operator creator's suggestion chips —
/// useful before any other operator exists. At runtime the live union of
/// every operator's tags (the same vocabulary handoff_task routes on) is
/// folded in via loadSkillVocab().
export const STARTER_SKILLS = [
  "rust", "typescript", "frontend", "backend", "security", "devops",
  "testing", "database", "debugging", "refactoring", "docs", "api",
  "performance", "ci/cd", "ui/ux",
];

/// Merge starter skills with the live team union, case-insensitively
/// deduped, starters first, original casing preserved.
export function mergeSkillVocab(starters: string[], union: string[]): string[] {
  const seen = new Set<string>();
  return [...starters, ...union].filter(
    (s) => !!s && !seen.has(s.toLowerCase()) && !!seen.add(s.toLowerCase()),
  );
}

/// Cached team skill vocabulary, loaded once per session.
let skillVocab: string[] | null = null;
async function loadSkillVocab(): Promise<string[]> {
  if (skillVocab) return skillVocab;
  let union: string[] = [];
  try {
    union = (await operatorList()).flatMap((o) => o.tags ?? []);
  } catch {
    // ponytail: first run / offline — starters alone still suggest fine.
  }
  skillVocab = mergeSkillVocab(STARTER_SKILLS, union);
  return skillVocab;
}

/// One-click starter rules for the hard-constraints editor. Backslash-free
/// on purpose: Milkdown's markdown round-trip can mangle `\`-escapes.
/// Excludes rules the global hard blocklist already covers (sudo, rm -rf, …).
const HARD_CONSTRAINT_EXAMPLES = [
  "^git push --force",
  "^git commit",
  "^npm publish",
  "^terraform apply",
  "^docker push",
  "^gh release",
] as const;

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
            // saveOperator now routes through the from-soul commands and
            // returns the persisted operator — use it for the set-default
            // + toast flow instead of the (now vestigial) draft.
            const saved = await saveOperator(handle);
            // Promote to default if the toggle was flipped on.
            if (handle.state.setAsDefault && !handle.state.isDefault && saved.id) {
              try { await operatorSetDefault(saved.id); } catch (e) {
                console.warn("operator_set_default failed", e);
              }
            }
            // Persist GitHub access if it changed — registry-side field,
            // not carried by the SOUL.md save path.
            const prevAccess = handle.state.mode === "edit"
              ? (handle.state.existing?.github_access ?? "Off")
              : "Off";
            if (saved.id && handle.state.githubAccess !== prevAccess) {
              try { await operatorSetGithubAccess(saved.id, handle.state.githubAccess); } catch (e) {
                console.warn("operator_set_github_access failed", e);
              }
            }
            // Same registry-side pattern for the dispatch_acp gate.
            const prevAcp = handle.state.mode === "edit"
              ? (handle.state.existing?.acp_enabled ?? false)
              : false;
            if (saved.id && handle.state.acpEnabled !== prevAcp) {
              try { await operatorSetAcpEnabled(saved.id, handle.state.acpEnabled); } catch (e) {
                console.warn("operator_set_acp_enabled failed", e);
              }
            }
            closeCreator(handle.el);
            await this.refresh();
            pushInfoToast({
              message: `${handle.state.mode === "edit" ? "Saved" : "Created"} operator: ${saved.name}`,
            });
          } catch (e) {
            console.error("operator save failed", e);
            alert(`Save failed: ${e}`);
          }
        })();
      } else if (target.classList.contains("op-modal-delete")) {
        ev.stopImmediatePropagation();
        ev.preventDefault();
        const existing = handle.state.existing;
        if (!existing) return;
        (async () => {
          await this.deleteOperator(existing);
          closeCreator(handle.el);
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
        closeCreator(handle.el);
      }
    };
    document.addEventListener("keydown", onKey);
    // Tear down the keydown listener once the modal element is removed,
    // no matter which close path (scrim/Cancel/esc-pill/Save/Delete) fired.
    const teardownObserver = new MutationObserver(() => {
      if (!document.body.contains(handle.el)) {
        document.removeEventListener("keydown", onKey);
        teardownObserver.disconnect();
      }
    });
    teardownObserver.observe(document.body, { childList: true, subtree: true });
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

// ─────────────────────────────────────────────────────────────────────────────
// Task 14 — two-step "New Operator" modal.
// Step 1: Identity (name, emoji, color, voice + chip preview)
// Step 2: Behavior (model, escalate_threshold, persona, hard_constraints)
// Public surface: openOperatorModal, canProceedFromStep1, saveOperator.
// ─────────────────────────────────────────────────────────────────────────────

export type SectionKey = "start" | "identity" | "behaviour" | "soul";

export interface ModalDraft extends OperatorDraft {
  id?: string;
}

export interface ModalState {
  mode: "create" | "edit";
  draft: ModalDraft;
  /// Snapshot of `is_default` at modal-open time. Immutable for the
  /// modal lifetime; `setAsDefault` carries the user's intent.
  isDefault: boolean;
  /// User-toggleable. On save, if differs from `isDefault`, the
  /// `operator_set_default` Tauri command runs after create/update.
  setAsDefault: boolean;
  /// Present in edit/duplicate mode; needed for Delete + default flow.
  existing?: Operator;
  /// GitHub access level. Registry-side (not SOUL); persisted via the
  /// dedicated operator_set_github_access command after save, same
  /// pattern as setAsDefault.
  githubAccess: GithubAccess;
  /// dispatch_acp gate (background Copilot subtasks). Registry-side, same
  /// save pattern as githubAccess.
  acpEnabled: boolean;
  /// Active section in the immersive shell UI.
  activeSection: SectionKey;
  /// Raw SOUL.md text bound to the split-editor textarea. Authoritative
  /// source for create/update (routed through the from-soul commands).
  soulRaw: string;
  /// Operator id when editing an existing persona; drives
  /// `operator_update_from_soul`. Absent in create/duplicate mode.
  existingId?: string;
}

export interface ModalHandle {
  state: ModalState;
  el: HTMLElement;
  setName(s: string): void;
  setEmoji(s: string): void;
  setColor(s: string): void;
  setVoice(v: VoiceTone): void;
  setModel(s: string): void;
  setThreshold(n: number): void;
  setPersona(s: string): void;
  setHardConstraints(s: string): void;
  setAsDefault(b: boolean): void;
  setGithubAccess(a: GithubAccess): void;
  setAcpEnabled(b: boolean): void;
  applyPreset(key: PresetKey): void;
  setSection(s: SectionKey): void;
}

export function canSave(m: ModalHandle): boolean {
  const n = m.state.draft.name.trim();
  return n.length > 0 && [...n].length <= 24;
}

// Back-compat alias used by the unit tests written against the
// earlier two-step wizard. Behaves identically to `canSave`.
export const canProceedFromStep1 = canSave;

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

  const isDefault = opts.existing?.is_default ?? false;
  const state: ModalState = {
    mode: opts.mode,
    draft,
    isDefault,
    setAsDefault: isDefault,
    existing: opts.existing,
    githubAccess: opts.existing?.github_access ?? "Off",
    acpEnabled: opts.existing?.acp_enabled ?? false,
    activeSection: opts.mode === "create" ? "start" : "identity",
    // SOUL.md is the authoritative source for the new split editor.
    // Edit mode loads it asynchronously below; create starts blank
    // (or from a picked archetype).
    soulRaw: BLANK_SOUL,
    existingId: opts.mode === "edit" ? opts.existing?.id : undefined,
  };

  // Edit mode: pull the operator's real SOUL.md off disk and re-render.
  // Duplicate (create-mode + existing) also seeds from the source soul so
  // the user starts from the original body rather than a blank template.
  if (opts.existing && opts.existing.id) {
    void operatorSoulRead(opts.existing.id)
      .then((raw) => {
        if (opts.mode === "create") {
          // Duplicate: keep the body but rename so it doesn't clash.
          state.soulRaw = setFrontmatterScalar(raw, "name", opts.existing!.name);
        } else {
          state.soulRaw = raw;
        }
        render();
      })
      .catch((e) => {
        console.warn("operator_soul_read failed", e);
      });
  }

  const el = document.createElement("div");
  el.className = "op-creator";
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("open"));

  const h: ModalHandle = {
    state,
    el,
    setName(s) { state.draft.name = s; render(); },
    setEmoji(s) { state.draft.emoji = s; render(); },
    setColor(s) { state.draft.color = s; render(); },
    setVoice(v) { state.draft.voice = v; render(); },
    setModel(s) { state.draft.model = s; render(); },
    setThreshold(n) { state.draft.escalate_threshold = n; render(); },
    setPersona(s) { state.draft.persona = s; render(); },
    setHardConstraints(s) { state.draft.hard_constraints = s; render(); },
    // Native checkbox self-displays; no full render needed (would flash the modal).
    setAsDefault(b) { state.setAsDefault = b; },
    setGithubAccess(a) { state.githubAccess = a; render(); },
    setAcpEnabled(b) { state.acpEnabled = b; render(); },
    setSection(s) {
      if (state.activeSection === s) return;
      state.activeSection = s;
      // Partial update: swap only the middle section + refresh rail active
      // states. A full render() would wipe the DOM and reload every avatar
      // image, flashing the whole modal on each rail click.
      const ed = getSoulEditor(h);
      const sectionHost = el.querySelector<HTMLElement>(".op-section");
      if (sectionHost) ed.mountSection(sectionHost, s);
      const rail = el.querySelector<HTMLElement>(".op-rail");
      if (rail) rail.replaceWith(renderRail(h));
    },
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
    // Preserve scroll across full-DOM rebuilds (voice/color/avatar/model
    // toggles all call render(), which would otherwise jump the modal
    // back to the top).
    const prevScroll = el.querySelector<HTMLElement>(".op-section")?.scrollTop ?? 0;
    el.innerHTML = "";
    // Reset the per-render soul-editor instance so this full render builds a
    // fresh one (seeded from the current soulRaw) shared by header/section/live.
    (el as HTMLElement & { __soulEditor?: SoulEditor | null }).__soulEditor = null;
    el.append(renderForm(h));
    const section = el.querySelector<HTMLElement>(".op-section");
    if (section) section.scrollTop = prevScroll;
  }
  // Stamp the render closure on the element so renderers (e.g. the
  // archetype gallery's onPick) can request a full re-render without the
  // closure being threaded through every helper.
  (el as HTMLElement & { __rerender?: () => void }).__rerender = render;
  render();
  return h;
}

/// Human explanation of the escalate-threshold slider, with a band-specific
/// tail so the value the user just dragged to actually means something.
function thresholdHint(t: number): string {
  const base =
    "How much doubt the operator tolerates before it stops and asks you instead of acting on its own. " +
    "Lower = cautious (pings you often); higher = autonomous (acts solo, only pausing for risky or irreversible steps). " +
    "Truly dangerous commands are always blocked regardless of this setting. ";
  let band: string;
  if (t <= 0.25) band = `Now at ${t.toFixed(2)}: very cautious — asks before almost anything non-trivial.`;
  else if (t <= 0.55) band = `Now at ${t.toFixed(2)}: balanced — asks on anything ambiguous or risky.`;
  else if (t <= 0.8) band = `Now at ${t.toFixed(2)}: confident — proceeds on most routine work, escalates real risk.`;
  else band = `Now at ${t.toFixed(2)}: near-autopilot — only stops for clearly irreversible or destructive actions.`;
  return base + band;
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

const RAIL: { key: SectionKey; label: string; createOnly?: boolean }[] = [
  { key: "start", label: "Start", createOnly: true },
  { key: "identity", label: "Identity" },
  { key: "behaviour", label: "Behaviour" },
  { key: "soul", label: "The Soul" },
];

/// Animated teardown: drop the `.open` class to trigger the exit transition,
/// then remove the node once it completes.
function closeCreator(el: HTMLElement): void {
  el.classList.remove("open");
  setTimeout(() => el.remove(), 420);
}

function renderForm(h: ModalHandle): DocumentFragment {
  const frag = document.createDocumentFragment();

  const scrim = document.createElement("div");
  scrim.className = "scrim";
  scrim.addEventListener("click", () => closeCreator(h.el));

  const creator = document.createElement("div");
  creator.className = "creator";
  creator.setAttribute("role", "dialog");
  creator.setAttribute("aria-label", h.state.mode === "edit" ? "Edit operator" : "New operator");

  creator.append(renderHeader(h));

  const stage = document.createElement("div");
  stage.className = "stage";
  stage.append(renderRail(h), renderSectionHost(h), renderSoulLive(h));
  creator.append(stage);

  creator.append(renderFooter(h));

  frag.append(scrim, creator);
  return frag;
}

function renderHeader(h: ModalHandle): HTMLElement {
  const header = document.createElement("header");
  const brand = document.createElement("div");
  brand.className = "brand";
  const brandLabel = h.state.mode === "edit" ? "Edit operator" : "New operator";
  brand.innerHTML = `${Icons.headphones({ size: 16 })}<span>${brandLabel}</span>`;
  const chipHost = document.createElement("div");
  chipHost.className = "op-hero-chip";
  chipHost.style.flex = "1";
  const kbd = document.createElement("div");
  kbd.className = "kbd";
  kbd.textContent = "esc";
  kbd.addEventListener("click", () => closeCreator(h.el));
  header.append(brand, chipHost, kbd);
  getSoulEditor(h).mountChip(chipHost);
  return header;
}

function renderRail(h: ModalHandle): HTMLElement {
  const rail = document.createElement("nav");
  rail.className = "op-rail";
  for (const item of RAIL) {
    if (item.createOnly && h.state.mode !== "create") continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "op-rail-item";
    if (h.state.activeSection === item.key) btn.classList.add("is-active");
    btn.textContent = item.label;
    btn.addEventListener("click", () => h.setSection(item.key));
    rail.append(btn);
  }
  return rail;
}

function renderSectionHost(h: ModalHandle): HTMLElement {
  const host = document.createElement("div");
  host.className = "op-section";
  getSoulEditor(h).mountSection(host, h.state.activeSection);
  return host;
}

function renderSoulLive(h: ModalHandle): HTMLElement {
  const live = document.createElement("div");
  live.className = "op-soul-live";
  getSoulEditor(h).mountLive(live);
  return live;
}

/// Shared per-render soul-editor instance. `render()` clears the stamp at the
/// top of each full rebuild, so header/section/live all share ONE editor
/// (seeded from the current soulRaw) within a single render pass; the next
/// render builds a fresh one. This is lossless because `commit()` keeps
/// `soulRaw` continuously in sync, so re-seeding from it is a no-op.
function getSoulEditor(h: ModalHandle): SoulEditor {
  const stamped = h.el as HTMLElement & { __soulEditor?: SoulEditor | null };
  if (!stamped.__soulEditor) stamped.__soulEditor = buildSoulEditor(h);
  return stamped.__soulEditor;
}

/// Force a full modal re-render. `openOperatorModal` owns the actual
/// `render()` closure (it preserves scroll); we re-invoke it by clearing
/// and rebuilding from the handle. We expose it via a stamped function on
/// the element to avoid threading `render` through every renderer.
function rerenderModal(h: ModalHandle): void {
  const fn = (h.el as HTMLElement & { __rerender?: () => void }).__rerender;
  if (fn) fn();
}

// ── Archetype gallery (create mode): seeds the editor with a soul ───────────
function renderArchetypeGallery(onPick: (raw: string) => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "op-archetypes";
  const title = document.createElement("div");
  title.className = "op-modal-label";
  title.textContent = "Start from a soul";
  wrap.append(title);
  const grid = document.createElement("div");
  grid.className = "op-archetype-grid";
  wrap.append(grid);

  const blank = document.createElement("button");
  blank.type = "button";
  blank.className = "op-archetype-card op-archetype-blank";
  blank.textContent = "＋ Blank";
  blank.addEventListener("click", () => onPick(BLANK_SOUL));
  grid.append(blank);

  void operatorListArchetypes().then((list: ArchetypeView[]) => {
    for (const a of list ?? []) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "op-archetype-card";
      if (a.color) card.style.setProperty("--operator-color", a.color);
      const name = document.createElement("div");
      name.className = "op-archetype-name";
      name.textContent = a.name;
      const tag = document.createElement("div");
      tag.className = "op-archetype-tagline";
      tag.textContent = a.tagline;
      card.append(name, tag);
      card.addEventListener("click", () => onPick(a.raw));
      grid.append(card);
    }
  }).catch((e) => {
    console.warn("operator_list_archetypes failed", e);
  });
  return wrap;
}

// ── Editor: rich identity/behaviour controls (left) + the soul prose &
//    live preview (right), with the full SOUL.md source as an escape hatch ──

const COLOR_SWATCHES = [
  "#6B7280", "#3b82f6", "#a855f7", "#5ad19a", "#e6b673",
  "#c4a7ff", "#ff8585", "#f472b6", "#34d399", "#fbbf24",
];

/// YAML-quote a hex colour — unquoted `#…` reads as a comment.
function yamlColor(c: string): string {
  return `'${c}'`;
}

/// Does a name need quoting to survive a YAML round-trip?
function nameNeedsQuote(s: string): boolean {
  return /[:#[\]{}",&*!|>%@`]/.test(s) || /^\s|\s$/.test(s);
}

/// Deterministically rebuild the full SOUL.md text from a parsed view.
/// Invoked whenever a form control changes a field — canonicalises the
/// frontmatter; the body is preserved verbatim.
function soulRawFromView(v: SoulView): string {
  const out: string[] = ["---"];
  const name = v.name && v.name.trim().length ? v.name : "New Operator";
  out.push(`name: ${nameNeedsQuote(name) ? JSON.stringify(name) : name}`);
  if (v.avatar) out.push(`avatar: ${v.avatar}`);
  if (v.color) out.push(`color: ${yamlColor(v.color)}`);
  if (v.model) out.push(`model: ${v.model}`);
  out.push(`voice: ${v.voice ?? "terse"}`);
  out.push(`escalate_threshold: ${v.escalate_threshold ?? 0.6}`);
  const tags = (v.tags ?? []).map((t) => t.trim()).filter(Boolean);
  if (tags.length) out.push(`tags: [${tags.join(", ")}]`);
  const hc = (v.hard_constraints ?? "").replace(/\s+$/, "");
  if (hc.length) {
    out.push("hard_constraints: |");
    for (const ln of hc.split("\n")) out.push(`  ${ln}`);
  }
  out.push("---", "", (v.body ?? "").replace(/\s+$/, ""), "");
  return out.join("\n");
}

function soulSection(title: string): HTMLElement {
  const s = document.createElement("div");
  s.className = "op-soul-section";
  const t = document.createElement("div");
  t.className = "op-soul-section-title";
  t.textContent = title;
  s.append(t);
  return s;
}

interface SoulEditor {
  mountSection(host: HTMLElement, section: SectionKey): void;
  mountLive(host: HTMLElement): void;
  mountChip(host: HTMLElement): void;
}

function buildSoulEditor(h: ModalHandle): SoulEditor {
  // Working structured view. Controls mutate this and regenerate the raw
  // SOUL.md; seeded from the modal's current soulRaw on first parse.
  let view: SoulView = {
    name: "", avatar: null, color: null, model: null, voice: "terse",
    escalate_threshold: 0.6, tags: [], hard_constraints: null, body: "",
    validation_error: null,
  };

  // SOUL body — WYSIWYG markdown editor. `suppressBodyChange` guards the
  // programmatic value-set path: MarkdownEditor.value = ... triggers Milkdown's
  // change listener (a <textarea> would not), which would otherwise feed back
  // into the raw source and fight the raw-source editor.
  let suppressBodyChange = false;
  const bodyEditor = new MarkdownEditor({
    mode: "full",
    placeholder: "Write this operator's soul — who it is, how it judges, what it will never do without you.",
    onChange: (md) => {
      if (suppressBodyChange) return;
      view.body = md;
      h.state.soulRaw = soulRawFromView(view);
      src.value = h.state.soulRaw;
    },
  });
  // The guard relies on Milkdown firing its change listener synchronously
  // inside replaceAll() (true for the current version). try/finally ensures a
  // throw from the editor can't wedge the flag and silently swallow all
  // subsequent user edits.
  function setBodyValue(md: string): void {
    suppressBodyChange = true;
    try { bodyEditor.value = md; }
    finally { suppressBodyChange = false; }
  }

  // Live pane: raw source + error — always visible on right.

  // Always-visible, read-only mirror of the generated SOUL.md (front-matter +
  // body). No collapsible chevron — the WYSIWYG body editor + structured
  // controls are the source of truth; this just shows the file that gets saved.
  const rawDetails = document.createElement("div");
  rawDetails.className = "op-soul-rawwrap";
  const rawSummary = document.createElement("div");
  rawSummary.className = "op-soul-rawhead";
  rawSummary.textContent = "SOUL.md source";
  const src = document.createElement("textarea");
  src.className = "op-soul-source";
  src.spellcheck = false;
  src.readOnly = true;
  rawDetails.append(rawSummary, src);

  const errLine = document.createElement("div");
  errLine.className = "op-soul-error";

  // Mount the live operator chip into whatever host currently holds it.
  function mountChipInner(host: HTMLElement): void {
    host.innerHTML = "";
    host.append(
      renderOperatorChip(
        { name: view.name || "New Operator", emoji: view.avatar || "🟣", color: view.color || "#6B7280" },
        "lg",
      ),
    );
  }

  // Funnel a control change into the raw text + state, refresh the header
  // chip + live preview, and (when `remountSection`) re-mount the active
  // section. `remountSection` is skipped while a text field is focused so
  // the caret survives.
  function commit(remountSection: boolean): void {
    h.state.soulRaw = soulRawFromView(view);
    src.value = h.state.soulRaw;
    const chipHost = h.el.querySelector<HTMLElement>(".op-hero-chip");
    if (chipHost) mountChipInner(chipHost);
    if (remountSection) {
      const sectionHost = h.el.querySelector<HTMLElement>(".op-section");
      if (sectionHost) mountSectionInner(sectionHost, h.state.activeSection);
    }
  }

  function paintIdentity(controls: HTMLElement): void {
    controls.innerHTML = "";

    // ── Identity ──────────────────────────────────────────────────────
    const identity = soulSection("Identity");

    const name = document.createElement("input");
    name.type = "text";
    name.className = "op-modal-input";
    name.maxLength = 64;
    name.value = view.name ?? "";
    name.addEventListener("input", () => { view.name = name.value; commit(false); });
    identity.append(labeled("Name", name));

    const avField = document.createElement("div");
    avField.className = "op-modal-field";
    const avLbl = document.createElement("span");
    avLbl.className = "op-modal-label";
    avLbl.textContent = "Avatar";
    const grid = document.createElement("div");
    grid.className = "op-soul-avatar-grid";
    for (const a of AVATAR_PACK_V2) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "op-soul-avatar-cell";
      if (view.avatar === `pack2:${a.character}`) cell.classList.add("is-selected");
      cell.setAttribute("aria-label", a.label);
      const img = document.createElement("img");
      img.src = a.url; img.width = 44; img.height = 44; img.draggable = false;
      img.className = "op-avatar op-avatar-pixel"; img.alt = a.label;
      cell.append(img);
      // Hover-cycle through the character's emotional poses (250ms),
      // snapping back to the neutral pose on leave — mirrors the old pane.
      const poses = Object.values(a.urlsByEmotion).filter(Boolean) as string[];
      let cycle: number | null = null;
      cell.addEventListener("mouseenter", () => {
        if (poses.length < 2) return;
        let i = 0;
        cycle = window.setInterval(() => {
          i = (i + 1) % poses.length;
          img.src = poses[i];
        }, 250);
      });
      cell.addEventListener("mouseleave", () => {
        if (cycle !== null) { window.clearInterval(cycle); cycle = null; }
        img.src = a.url;
      });
      cell.addEventListener("click", () => { view.avatar = `pack2:${a.character}`; commit(true); });
      grid.append(cell);
    }
    avField.append(avLbl, grid);
    identity.append(avField);

    const colField = document.createElement("div");
    colField.className = "op-modal-field";
    const colLbl = document.createElement("span");
    colLbl.className = "op-modal-label";
    colLbl.textContent = "Color";
    const swatches = document.createElement("div");
    swatches.className = "op-soul-swatches";
    for (const c of COLOR_SWATCHES) {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "op-soul-swatch";
      if ((view.color ?? "").toLowerCase() === c.toLowerCase()) sw.classList.add("is-selected");
      sw.style.background = c;
      sw.setAttribute("aria-label", c);
      sw.addEventListener("click", () => { view.color = c; commit(true); });
      swatches.append(sw);
    }
    const custom = document.createElement("input");
    custom.type = "color";
    custom.className = "op-soul-color-custom";
    custom.value = view.color ?? "#6B7280";
    custom.addEventListener("input", () => { view.color = custom.value; commit(false); });
    custom.addEventListener("change", () => { view.color = custom.value; commit(true); });
    swatches.append(custom);
    colField.append(colLbl, swatches);
    identity.append(colField);

    // ── Skills ────────────────────────────────────────────────────────
    // Skills are the team's routing vocabulary: handoff_task delegates to
    // the teammate whose skills overlap a task's required_skills, and a
    // successful routed handoff is what earns the Good Delegate badge. An
    // operator with no skills can never receive a handoff — so we make this
    // a first-class pill editor with suggestions, not a bare text field.
    const skills = document.createElement("div");
    skills.className = "op-skills";

    const pills = document.createElement("div");
    pills.className = "op-skills-pills";
    const entry = document.createElement("input");
    entry.type = "text";
    entry.className = "op-skills-entry";

    const has = (t: string) =>
      (view.tags ?? []).some((x) => x.toLowerCase() === t.toLowerCase());

    function addSkill(raw: string): void {
      const t = raw.trim();
      entry.value = "";
      if (t && !has(t)) {
        view.tags = [...(view.tags ?? []), t];
        commit(false);
      }
      renderPills();
      renderSuggest();
    }
    function removeSkill(t: string): void {
      view.tags = (view.tags ?? []).filter((x) => x !== t);
      commit(false);
      renderPills();
      renderSuggest();
    }
    function renderPills(): void {
      pills.querySelectorAll(".op-skill-pill").forEach((n) => n.remove());
      for (const t of view.tags ?? []) {
        const pill = document.createElement("span");
        pill.className = "op-skill-pill";
        const lbl = document.createElement("span");
        lbl.textContent = t;
        const x = document.createElement("button");
        x.type = "button"; x.className = "op-skill-pill-x"; x.textContent = "×";
        x.setAttribute("aria-label", `Remove ${t}`);
        x.addEventListener("click", () => removeSkill(t));
        pill.append(lbl, x);
        pills.insertBefore(pill, entry);
      }
      entry.placeholder = (view.tags?.length ?? 0) ? "" : "type a skill, Enter to add";
    }

    entry.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addSkill(entry.value); }
      else if (e.key === "Backspace" && !entry.value && (view.tags?.length ?? 0)) {
        removeSkill(view.tags![view.tags!.length - 1]);
      }
    });
    entry.addEventListener("blur", () => addSkill(entry.value));
    // Click anywhere in the field (not on a pill) focuses the entry.
    pills.addEventListener("click", (e) => { if (e.target === pills) entry.focus(); });
    pills.append(entry);
    renderPills();

    const hint = document.createElement("div");
    hint.className = "op-skills-hint";
    hint.textContent =
      "Skills are how operators delegate. When one hits work outside its lane, " +
      "handoff_task routes to the teammate whose skills overlap — and a successful " +
      "routed handoff is what earns the Good Delegate badge. No skills means this " +
      "operator can never receive a handoff.";

    const suggest = document.createElement("div");
    suggest.className = "op-skills-suggest";
    function renderSuggest(): void {
      suggest.innerHTML = "";
      const avail = (skillVocab ?? STARTER_SKILLS)
        .filter((s) => !has(s))
        .slice(0, 12);
      if (!avail.length) return;
      const lbl = document.createElement("span");
      lbl.className = "op-skills-suggest-lbl";
      lbl.textContent = "Suggested";
      suggest.append(lbl);
      for (const s of avail) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "op-skills-chip";
        chip.textContent = s;
        chip.addEventListener("click", () => addSkill(s));
        suggest.append(chip);
      }
    }
    renderSuggest();
    // Fold in the live team vocabulary (union of every operator's tags) once
    // it loads — same vocabulary handoff_task routes on.
    void loadSkillVocab().then(renderSuggest);

    skills.append(pills, hint, suggest);
    const skillField = document.createElement("div");
    skillField.className = "op-modal-field";
    const skillLbl = document.createElement("span");
    skillLbl.className = "op-modal-label";
    skillLbl.textContent = "Skills";
    skillField.append(skillLbl, skills);
    identity.append(skillField);
    controls.append(identity);
  }

  function paintBehaviour(controls: HTMLElement): void {
    controls.innerHTML = "";

    // ── Behaviour ─────────────────────────────────────────────────────
    const behaviour = soulSection("Behaviour");

    const voiceSelect = new CustomSelect({
      className: "op-modal-select",
      ariaLabel: "Operator voice",
      value: view.voice ?? "terse",
      options: [
        { value: "terse", label: "terse" },
        { value: "warm", label: "warm" },
        { value: "formal", label: "formal" },
      ],
    });
    voiceSelect.element.addEventListener("change", () => { view.voice = voiceSelect.value; commit(false); });
    behaviour.append(labeled("Voice", voiceSelect.element));

    const modelField = document.createElement("label");
    modelField.className = "op-modal-field";
    const modelLbl = document.createElement("span");
    modelLbl.className = "op-modal-label";
    modelLbl.textContent = "Model";
    const modelSelect = new CustomSelect({
      className: "op-modal-select",
      ariaLabel: "Operator model",
      value: view.model ?? "claude-sonnet-4-6",
      options: withCurrentModel([], view.model ?? undefined),
    });
    modelSelect.element.addEventListener("change", () => { view.model = modelSelect.value; commit(false); });
    void operatorModelOptions(view.model ?? undefined).then((opts) => {
      modelSelect.setOptions(opts, view.model ?? "claude-sonnet-4-6");
    });
    modelField.append(modelLbl, modelSelect.element);
    behaviour.append(modelField);

    const thr = document.createElement("input");
    thr.type = "range"; thr.min = "0"; thr.max = "1"; thr.step = "0.05";
    thr.value = String(view.escalate_threshold ?? 0.6);
    const thrField = labeled(
      `Escalate threshold · ${(view.escalate_threshold ?? 0.6).toFixed(2)}`,
      thr,
    );
    thr.addEventListener("input", () => {
      view.escalate_threshold = Number.parseFloat(thr.value);
      const lbl = thrField.querySelector<HTMLElement>(".op-modal-label");
      if (lbl) lbl.textContent = `Escalate threshold · ${(view.escalate_threshold ?? 0.6).toFixed(2)}`;
      const hintEl = thrField.querySelector<HTMLElement>(".op-modal-hint");
      if (hintEl) hintEl.textContent = thresholdHint(view.escalate_threshold ?? 0.6);
      commit(false);
    });
    const thrHint = document.createElement("small");
    thrHint.className = "op-modal-hint";
    thrHint.textContent = thresholdHint(view.escalate_threshold ?? 0.6);
    thrField.append(thrHint);
    behaviour.append(thrField);

    // ── GitHub access (registry-side, not part of the SOUL) ───────────
    const ghSeg = document.createElement("div");
    ghSeg.className = "op-soul-seg";
    const GH_OPTIONS: { value: GithubAccess; label: string }[] = [
      { value: "Off", label: "Off" },
      { value: "ReadOnly", label: "Read-only" },
      { value: "ReadWrite", label: "Read & write" },
    ];
    for (const opt of GH_OPTIONS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "op-soul-seg-btn";
      if (h.state.githubAccess === opt.value) btn.classList.add("is-selected");
      btn.textContent = opt.label;
      btn.addEventListener("click", () => h.setGithubAccess(opt.value));
      ghSeg.append(btn);
    }
    // div (not <label>) wrapper — a label would forward clicks on the
    // hint/label text to the first button, silently selecting "Off".
    // Mirrors the avatar-grid field structure above.
    const ghField = document.createElement("div");
    ghField.className = "op-modal-field";
    const ghLbl = document.createElement("span");
    ghLbl.className = "op-modal-label";
    ghLbl.textContent = "GitHub access";
    const ghHint = document.createElement("small");
    ghHint.className = "op-modal-hint";
    ghHint.textContent =
      "Read lets this operator list and read issues and PRs; read & write can also create issues, comment, and open PRs as you.";
    ghField.append(ghLbl, ghSeg, ghHint);
    behaviour.append(ghField);

    // ── Copilot delegation (dispatch_acp gate — registry-side) ────────
    const acpSeg = document.createElement("div");
    acpSeg.className = "op-soul-seg";
    for (const opt of [
      { value: false, label: "Off" },
      { value: true, label: "On" },
    ]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "op-soul-seg-btn";
      if (h.state.acpEnabled === opt.value) btn.classList.add("is-selected");
      btn.textContent = opt.label;
      btn.addEventListener("click", () => h.setAcpEnabled(opt.value));
      acpSeg.append(btn);
    }
    const acpField = document.createElement("div");
    acpField.className = "op-modal-field";
    const acpLbl = document.createElement("span");
    acpLbl.className = "op-modal-label";
    acpLbl.textContent = "Copilot delegation";
    const acpHint = document.createElement("small");
    acpHint.className = "op-modal-hint";
    acpHint.textContent =
      "Lets this operator dispatch self-contained subtasks to background GitHub Copilot sessions. File edits stay inside the workspace; risky commands are denied by policy.";
    acpField.append(acpLbl, acpSeg, acpHint);
    behaviour.append(acpField);
    controls.append(behaviour);

    // ── Hard constraints (safety — extra deny rules) ──────────────────
    const adv = document.createElement("details");
    adv.className = "op-soul-advanced";
    if ((view.hard_constraints ?? "").trim().length) adv.open = true;
    const advSum = document.createElement("summary");
    advSum.textContent = "Hard constraints";
    const hcHint = document.createElement("div");
    hcHint.className = "op-hc-hint";
    hcHint.textContent =
      "Regex deny rules — a command matching any line is never auto-executed; the operator asks you first. One rule per line.";
    const hc = new MarkdownEditor({
      mode: "inline",
      className: "op-soul-hard",
      value: view.hard_constraints ?? "",
      placeholder: "One deny rule per line (regex). e.g. ^git push --force",
      onChange: (md) => { view.hard_constraints = md; commit(false); },
    });
    const hcChips = document.createElement("div");
    hcChips.className = "op-hc-chips";
    for (const rule of HARD_CONSTRAINT_EXAMPLES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "op-hc-chip";
      btn.textContent = rule;
      btn.addEventListener("click", () => {
        const cur = (view.hard_constraints ?? "").trim();
        if (cur.split("\n").some((l) => l.trim() === rule)) return;
        const next = cur ? `${cur}\n${rule}` : rule;
        view.hard_constraints = next;
        hc.value = next;
        commit(false);
      });
      hcChips.appendChild(btn);
    }
    adv.append(advSum, hcHint, hc.element, hcChips);
    controls.append(adv);
  }

  // Inner section mount — shared by `commit` and the returned `mountSection`.
  function mountSectionInner(host: HTMLElement, section: SectionKey): void {
    host.innerHTML = "";
    if (section === "start") {
      host.append(
        renderArchetypeGallery((raw) => {
          h.state.soulRaw = raw;
          rerenderModal(h);
        }),
      );
      return;
    }
    if (section === "identity") { paintIdentity(host); return; }
    if (section === "behaviour") { paintBehaviour(host); return; }
    if (section === "soul") {
      const label = document.createElement("div");
      label.className = "op-soul-section-title";
      label.textContent = "The soul";
      host.append(label, bodyEditor.element);
    }
  }

  // Re-mount the chip + active section after a structured-control change.
  function repaintAll(): void {
    const chipHost = h.el.querySelector<HTMLElement>(".op-hero-chip");
    if (chipHost) mountChipInner(chipHost);
    const sectionHost = h.el.querySelector<HTMLElement>(".op-section");
    if (sectionHost) mountSectionInner(sectionHost, h.state.activeSection);
  }

  const self: SoulEditor = {
    mountSection(host, section) { mountSectionInner(host, section); },
    mountLive(host) {
      host.innerHTML = "";
      host.append(rawDetails, errLine);
    },
    mountChip(host) { mountChipInner(host); },
  };

  // Initial hydrate from the modal's current soulRaw. Guard the post-await
  // repaint so a stale (superseded) editor closure doesn't repaint over a
  // newer render's nodes.
  void (async () => {
    try {
      const v = await operatorSoulParse(h.state.soulRaw);
      if (v) { view = v; errLine.textContent = v.validation_error ?? ""; }
    } catch (e) {
      errLine.textContent = `Parse failed: ${e}`;
    }
    if ((h.el as HTMLElement & { __soulEditor?: SoulEditor | null }).__soulEditor !== self) return;
    src.value = h.state.soulRaw;
    setBodyValue(view.body ?? "");
    repaintAll();
  })();

  return self;
}

// ── Footer: default toggle (left), delete + cancel + save (right) ───────────
function renderFooter(h: ModalHandle): HTMLElement {
  const foot = document.createElement("div");
  foot.className = "op-modal-footer";

  const left = document.createElement("label");
  left.className = "op-modal-default-toggle";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = h.state.setAsDefault;
  // Existing default can't un-default itself directly — must promote another.
  cb.disabled = h.state.isDefault;
  cb.addEventListener("change", () => h.setAsDefault(cb.checked));
  const cbLbl = document.createElement("span");
  cbLbl.textContent = h.state.isDefault ? "Default operator" : "Set as default";
  left.append(cb, cbLbl);
  foot.append(left);

  const right = document.createElement("div");
  right.className = "op-modal-footer-actions settings-actions";

  if (h.state.mode === "edit" && h.state.existing) {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "op-modal-delete";
    del.textContent = "Delete";
    del.disabled = h.state.isDefault;
    right.append(del);
  }

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "settings-cancel";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => closeCreator(h.el));
  right.append(cancel);

  const save = document.createElement("button");
  save.type = "button";
  save.className = "op-modal-save settings-save";
  save.textContent = h.state.mode === "edit" ? "Save changes" : "Create operator";
  // SOUL.md is now the source of truth; gate save on the raw text being
  // non-empty rather than the (vestigial) draft name. Backend
  // `operator_*_from_soul` does the authoritative validation.
  save.disabled = h.state.soulRaw.trim().length === 0;
  right.append(save);

  foot.append(right);
  return foot;
}

type ModelOption = { value: string; label: string };

/// Static fallback list, used only when the configured Operator provider
/// can't be reached (offline, no key) so the dropdown is never empty.
const MODELS: ModelOption[] = [
  { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { value: "claude-opus-4-7", label: "Opus 4.7" },
];

/// Ensure the operator's currently-selected model stays selectable even
/// if the provider doesn't list it (custom/legacy id).
function withCurrentModel(opts: ModelOption[], current?: string): ModelOption[] {
  if (current && !opts.some((m) => m.value === current)) {
    return [...opts, { value: current, label: `${current} (custom)` }];
  }
  return opts;
}

/// Resolve the model dropdown options from the provider configured for the
/// `operator` role in Settings → Models (the same source the Models tab
/// uses), so the picker lists exactly the models that provider serves.
/// Falls back to the static `MODELS` list if the provider is unreachable.
async function operatorModelOptions(current?: string): Promise<ModelOption[]> {
  try {
    const settings = await getSettings();
    const route = settings.model_routes?.operator;
    const entry = route ? settings.providers?.[route.provider_id] : undefined;
    if (!entry) return withCurrentModel([...MODELS], current);

    let models: ModelInfo[];
    if (entry.kind === "anthropic") {
      models = await listModelsAnthropic();
    } else if (entry.kind === "azure_foundry") {
      models = await listModelsAzureFoundry({
        endpoint: entry.base_url ?? "",
        apiKey: entry.api_key ?? "",
        mode: entry.azure_mode ?? "azure_open_ai",
        apiVersion:
          entry.azure_api_version ??
          (entry.azure_mode === "ai_inference"
            ? "2024-05-01-preview"
            : "2024-10-21"),
      });
    } else {
      models = await listModelsOpenAiCompat(entry.base_url ?? "");
    }

    const opts: ModelOption[] = models.map((m) => ({
      value: m.id,
      label: m.label ?? m.id,
    }));
    return withCurrentModel(opts.length ? opts : [...MODELS], current);
  } catch {
    return withCurrentModel([...MODELS], current);
  }
}

/// Persist the operator via the SOUL.md (`*_from_soul`) commands. Returns
/// the created/updated operator so the caller can drive the post-save
/// set-default + toast flow off real backend data.
export async function saveOperator(h: ModalHandle): Promise<Operator> {
  const { operatorCreateFromSoul, operatorUpdateFromSoul } = await import("../api");
  if (h.state.mode === "edit" && h.state.existingId) {
    return operatorUpdateFromSoul(h.state.existingId, h.state.soulRaw);
  }
  return operatorCreateFromSoul(h.state.soulRaw);
}

export interface ListHandlers {
  onEdit(op: Operator): void;
  onDelete(op: Operator): void;
  onDuplicate(op: Operator): void;
  onPublish?(op: Operator): void;
}

export function renderOperatorList(ops: Operator[], h: ListHandlers): HTMLElement {
  const root = document.createElement("div");
  root.className = "op-card-grid";
  for (const op of ops) {
    const card = document.createElement("div");
    card.className = "op-card";
    // Bleed the operator's color into the card itself (background tint,
    // border, hover state) — without this, --operator-color only reaches
    // the chip inside and the card around it looks generic gray. Same
    // pattern as the modal hero card.
    card.style.setProperty("--operator-color", op.color);
    card.append(renderOperatorChip(op, "lg"));
    const summary = document.createElement("div");
    summary.className = "op-card-summary";
    summary.textContent = `${op.voice} · threshold ${op.escalate_threshold.toFixed(2)} · ${op.model || "—"}`;
    card.append(summary);
    const tags = op.tags.map((t) => t.trim()).filter(Boolean);
    if (tags.length > 0) {
      const tagsRow = document.createElement("div");
      tagsRow.className = "op-card-tags";
      for (const tag of tags) {
        const pill = document.createElement("span");
        pill.className = "op-card-tag";
        pill.textContent = tag;
        tagsRow.append(pill);
      }
      card.append(tagsRow);
    }
    const actions = document.createElement("div");
    actions.className = "op-card-actions";
    const mk = (label: string, icon: string, fn: () => void, danger = false) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = danger ? "op-card-iconbtn is-danger" : "op-card-iconbtn";
      b.innerHTML = icon;
      b.setAttribute("aria-label", label);
      attachTooltip(b, label);
      b.addEventListener("click", fn);
      return b;
    };
    actions.append(mk("Edit", Icons.pencil(), () => h.onEdit(op)));
    actions.append(mk("Duplicate", Icons.copy(), () => h.onDuplicate(op)));
    if (h.onPublish) {
      actions.append(mk("Publish", Icons.upload(), () => h.onPublish!(op)));
    }
    actions.append(mk("Delete", Icons.trash(), () => h.onDelete(op), true));
    card.append(actions);
    root.append(card);
  }
  return root;
}
