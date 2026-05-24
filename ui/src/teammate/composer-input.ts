/// Wraps a contenteditable div as a single-line composer that supports
/// atomic, color-coded mention chips. Chips are non-editable spans;
/// backspace removes them whole (browser-native behavior on
/// contenteditable=false nodes).
///
/// getValue() serializes chips back to `@token` text so the rest of
/// the send pipeline keeps working with plain strings.

import type { Source } from "./mention-sources";

export interface ChipSpec {
  kind: Source;
  token: string;
  label: string;
}

export interface ComposerInputOpts {
  placeholder?: string;
}

const ICONS: Record<Source, string> = {
  files: "⌗",
  sessions: "▮",
  commands: "$",
  teammates: "@",
};

export class ComposerInput {
  private el: HTMLDivElement;
  private inputCbs: Array<() => void> = [];
  private keydownCbs: Array<(e: KeyboardEvent) => void> = [];
  private submitCbs: Array<() => void> = [];

  constructor(host: HTMLElement, opts: ComposerInputOpts = {}) {
    this.el = document.createElement("div");
    this.el.className = "teammate-panel-input";
    this.el.setAttribute("contenteditable", "plaintext-only");
    this.el.setAttribute("role", "textbox");
    this.el.setAttribute("aria-multiline", "false");
    if (opts.placeholder) this.el.dataset.placeholder = opts.placeholder;
    this.el.addEventListener("input", () => { this.inputCbs.forEach((cb) => cb()); });
    this.el.addEventListener("keydown", (e) => {
      this.keydownCbs.forEach((cb) => cb(e));
      if (e.key === "Enter" && !e.shiftKey && !e.defaultPrevented) {
        e.preventDefault();
        this.submitCbs.forEach((cb) => cb());
      }
    });
    host.appendChild(this.el);
  }

  element(): HTMLDivElement { return this.el; }

  setPlaceholder(p: string): void { this.el.dataset.placeholder = p; }

  setValue(text: string): void { this.el.textContent = text; }

  getValue(): string {
    let out = "";
    this.el.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) {
        out += n.textContent ?? "";
      } else if (n instanceof HTMLElement && n.classList.contains("tmt-chip")) {
        out += "@" + (n.dataset.token ?? "");
      } else {
        out += n.textContent ?? "";
      }
    });
    return out;
  }

  clear(): void { this.el.innerHTML = ""; }
  focus(): void { this.el.focus(); }

  /// Returns the active `@token` segment to the left of the caret, or
  /// null if the caret isn't inside one. Only inspects the current
  /// text node — chips terminate scanning because they live in their
  /// own DOM nodes.
  getActiveMention(): { node: Text; start: number; end: number; query: string } | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return null;
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return null;
    const text = node.textContent ?? "";
    const caret = range.startOffset;
    let i = caret - 1;
    while (i >= 0) {
      const ch = text[i];
      if (ch === "@") {
        const startOfNode = i === 0;
        const prev = startOfNode ? " " : text[i - 1];
        if (startOfNode || /\s/.test(prev)) {
          return { node: node as Text, start: i, end: caret, query: text.slice(i + 1, caret) };
        }
        return null;
      }
      if (/\s/.test(ch)) return null;
      i--;
    }
    return null;
  }

  /// Replaces the `@query` segment with an atomic chip + trailing space.
  /// Accepts either an active-mention range (from getActiveMention) or a
  /// raw DOM Range (used by tests).
  replaceQueryWithChip(
    range: { node: Text; start: number; end: number } | Range,
    spec: ChipSpec,
    _query: string,
  ): void {
    if ("node" in range) {
      const r = document.createRange();
      r.setStart(range.node, range.start);
      r.setEnd(range.node, range.end);
      r.deleteContents();
      const chip = this.buildChip(spec);
      const trailing = document.createTextNode(" ");
      r.insertNode(trailing);
      r.insertNode(chip);
      // Re-focus the contenteditable; clicking a popup row stole focus.
      this.el.focus();
      const sel = window.getSelection();
      if (sel) {
        const after = document.createRange();
        // Caret INSIDE the trailing text node at its end — element-level
        // caret positions break typing/backspace in contenteditable.
        after.setStart(trailing, trailing.length);
        after.collapse(true);
        sel.removeAllRanges();
        sel.addRange(after);
      }
    } else {
      range.deleteContents();
      const chip = this.buildChip(spec);
      range.insertNode(chip);
      range.collapse(false);
      this.el.appendChild(document.createTextNode(" "));
    }
    this.inputCbs.forEach((cb) => cb());
  }

  removeAllChips(): void {
    this.el.querySelectorAll(".tmt-chip").forEach((c) => c.remove());
    this.inputCbs.forEach((cb) => cb());
  }

  chips(): Array<{ kind: Source; token: string }> {
    return Array.from(this.el.querySelectorAll<HTMLElement>(".tmt-chip")).map((c) => ({
      kind: c.dataset.kind as Source,
      token: c.dataset.token ?? "",
    }));
  }

  onInput(cb: () => void): void { this.inputCbs.push(cb); }
  onKeydown(cb: (e: KeyboardEvent) => void): void { this.keydownCbs.push(cb); }
  onSubmit(cb: () => void): void { this.submitCbs.push(cb); }

  private buildChip(spec: ChipSpec): HTMLSpanElement {
    const c = document.createElement("span");
    c.className = `tmt-chip tmt-chip--${spec.kind}`;
    c.setAttribute("contenteditable", "false");
    c.dataset.kind = spec.kind;
    c.dataset.token = spec.token;
    c.innerHTML = `<span class="tmt-chip__ico">${ICONS[spec.kind]}</span>` + escapeHtml(spec.label);
    return c;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]!));
}
