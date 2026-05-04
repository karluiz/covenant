import {
  OPERATOR_PERSONA_TEMPLATES,
  type PersonaTemplate,
} from "./persona-templates";

type SaveHandler = (text: string) => void;

/**
 * Fullscreen-ish modal for editing the operator persona / authorization
 * charter. Owns its DOM. The host (OperatorsPane) calls `open` with the
 * current textarea value and a callback; the modal writes the edited
 * text back via the callback on Save and closes itself on Save or Cancel.
 *
 * The modal does NOT touch the operator persistence layer — the host
 * dispatches an `input` event on the underlying textarea so the existing
 * dirty-tracking pipeline activates unchanged.
 */
export class PersonaComposerModal {
  private root: HTMLElement | null = null;
  private textarea: HTMLTextAreaElement | null = null;
  private onSave: SaveHandler | null = null;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;

  open(initial: string, onSave: SaveHandler): void {
    if (this.root) this.close();
    this.onSave = onSave;
    this.root = this.buildDom(initial);
    document.body.appendChild(this.root);
    this.keydownHandler = (e) => this.handleKeydown(e);
    window.addEventListener("keydown", this.keydownHandler);
    requestAnimationFrame(() => this.textarea?.focus());
  }

  close(): void {
    if (this.keydownHandler) {
      window.removeEventListener("keydown", this.keydownHandler);
      this.keydownHandler = null;
    }
    this.root?.remove();
    this.root = null;
    this.textarea = null;
    this.onSave = null;
  }

  private save(): void {
    if (!this.textarea || !this.onSave) return;
    const text = this.textarea.value;
    const cb = this.onSave;
    this.close();
    cb(text);
  }

  private handleKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      this.save();
      return;
    }
  }

  private buildDom(initial: string): HTMLElement {
    const root = document.createElement("div");
    root.className = "persona-composer";

    const backdrop = document.createElement("div");
    backdrop.className = "persona-composer__backdrop";
    root.appendChild(backdrop);

    const panel = document.createElement("div");
    panel.className = "persona-composer__panel";
    root.appendChild(panel);

    panel.appendChild(this.buildHeader());
    panel.appendChild(this.buildTemplatesRow());
    panel.appendChild(this.buildEditor(initial));
    panel.appendChild(this.buildFooter());

    return root;
  }

  private buildHeader(): HTMLElement {
    const header = document.createElement("header");
    header.className = "persona-composer__header";

    const title = document.createElement("h2");
    title.className = "persona-composer__title";
    title.textContent = "PERSONA / AUTHORIZATION CHARTER";

    const actions = document.createElement("div");
    actions.className = "persona-composer__actions";

    const save = document.createElement("button");
    save.type = "button";
    save.className = "persona-composer__save";
    save.textContent = "Save";
    save.addEventListener("click", () => this.save());

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "persona-composer__cancel modal-cancel-btn";
    cancel.title = "Cancel (Esc)";
    cancel.innerHTML = `<span>Cancel</span><kbd class="modal-kbd">Esc</kbd>`;
    cancel.addEventListener("click", () => this.close());

    actions.append(save, cancel);
    header.append(title, actions);
    return header;
  }

  private buildTemplatesRow(): HTMLElement {
    const row = document.createElement("div");
    row.className = "persona-composer__templates";

    const label = document.createElement("span");
    label.className = "persona-composer__templates-label";
    label.textContent = "Templates:";
    row.appendChild(label);

    for (const t of OPERATOR_PERSONA_TEMPLATES) {
      row.appendChild(this.buildTemplatePill(t));
    }
    return row;
  }

  private buildTemplatePill(template: PersonaTemplate): HTMLElement {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "persona-composer__template";
    pill.textContent = template.name;
    pill.addEventListener("click", () => this.loadTemplate(template));
    return pill;
  }

  private loadTemplate(template: PersonaTemplate): void {
    if (!this.textarea) return;
    const current = this.textarea.value.trim();
    if (current.length > 0) {
      const ok = window.confirm("Overwrite current persona?");
      if (!ok) return;
    }
    this.textarea.value = template.persona;
    this.textarea.focus();
  }

  private buildEditor(initial: string): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "persona-composer__editor";

    const ta = document.createElement("textarea");
    ta.className = "persona-composer__textarea";
    ta.value = initial;
    ta.spellcheck = false;
    ta.autocapitalize = "off";
    ta.autocomplete = "off";
    this.textarea = ta;

    wrap.appendChild(ta);
    return wrap;
  }

  private buildFooter(): HTMLElement {
    const footer = document.createElement("footer");
    footer.className = "persona-composer__footer";
    const modKey = navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl+";
    footer.innerHTML =
      `<kbd class="modal-kbd">${modKey}S</kbd> save · ` +
      `<kbd class="modal-kbd">Esc</kbd> cancel`;
    return footer;
  }
}
