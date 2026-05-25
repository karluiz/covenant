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
  specs: "§",
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
    this.el.setAttribute("contenteditable", "true");
    this.el.setAttribute("role", "textbox");
    this.el.setAttribute("aria-multiline", "false");
    if (opts.placeholder) this.el.dataset.placeholder = opts.placeholder;
    this.el.addEventListener("input", () => { this.inputCbs.forEach((cb) => cb()); });
    this.el.addEventListener("keydown", (e) => {
      this.keydownCbs.forEach((cb) => cb(e));
      if (e.defaultPrevented) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.submitCbs.forEach((cb) => cb());
        return;
      }
      if (e.key === "Backspace") {
        if (this.tryDeleteChipBeforeCaret()) {
          e.preventDefault();
          this.inputCbs.forEach((cb) => cb());
        }
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
    // Strip zero-width spaces inserted as caret-anchors around chips.
    return out.replace(/​/g, "");
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
    let node: Node | null = range.startContainer;
    let caret = range.startOffset;
    // WebKit/Chromium often anchor the caret on the contenteditable
    // element itself (not a text node) right after typing into a
    // previously-empty div. Descend to the relevant text-node child.
    if (node.nodeType !== Node.TEXT_NODE) {
      if (!(node instanceof HTMLElement) || !this.el.contains(node)) return null;
      const child = node.childNodes[caret - 1] ?? node.childNodes[caret] ?? node.lastChild;
      if (!child || child.nodeType !== Node.TEXT_NODE) return null;
      node = child;
      caret = (child.textContent ?? "").length;
    }
    const text = node.textContent ?? "";
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
      // Trailing zero-width space + regular space. WebKit collapses
      // adjacent whitespace text nodes around contenteditable=false
      // siblings and the caret can't land in a "collapsed" node — the
      // ​ keeps the node materially non-empty.
      const trailing = document.createTextNode("​ ");
      r.insertNode(trailing);
      r.insertNode(chip);
      this.el.focus();
      // Defer caret placement one tick: WebKit may re-normalize text
      // nodes immediately after insertNode and discard our selection.
      requestAnimationFrame(() => {
        const sel = window.getSelection();
        if (!sel || !trailing.parentNode) return;
        const after = document.createRange();
        after.setStart(trailing, trailing.length);
        after.collapse(true);
        sel.removeAllRanges();
        sel.addRange(after);
      });
    } else {
      range.deleteContents();
      const chip = this.buildChip(spec);
      range.insertNode(chip);
      range.collapse(false);
      this.el.appendChild(document.createTextNode(" "));
    }
    this.inputCbs.forEach((cb) => cb());
  }

  /// If the caret sits at the start of an empty/whitespace-only text
  /// node that follows a chip (including the ZWSP+space caret anchor
  /// we insert after a pick), delete the chip + that anchor as a unit.
  /// Returns true if anything was deleted.
  private tryDeleteChipBeforeCaret(): boolean {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return false;
    let node: Node | null = range.startContainer;
    let offset = range.startOffset;
    // If caret is at element level, descend.
    if (node.nodeType !== Node.TEXT_NODE) {
      const child = (node as HTMLElement).childNodes[offset - 1] ?? null;
      if (child && child.nodeType === Node.TEXT_NODE) {
        node = child;
        offset = (child.textContent ?? "").length;
      }
    }
    if (!node) return false;
    // Find the preceding chip. Walk left through whitespace-only text.
    let cursor: Node | null = node;
    // From inside a text node: caret must be at offset 0 OR the text
    // to the left is all whitespace/ZWSP.
    if (cursor.nodeType === Node.TEXT_NODE) {
      const before = (cursor.textContent ?? "").slice(0, offset);
      if (!/^[\s​]*$/.test(before)) return false;
    }
    // Walk to the previous sibling chain; the first non-empty thing
    // we hit must be a chip element.
    let prev: Node | null = cursor.previousSibling;
    while (prev && prev.nodeType === Node.TEXT_NODE && /^[\s​]*$/.test(prev.textContent ?? "")) {
      prev = prev.previousSibling;
    }
    if (!(prev instanceof HTMLElement) || !prev.classList.contains("tmt-chip")) return false;
    // Delete the chip and all whitespace/ZWSP text nodes between it and
    // the current text node (inclusive of those, exclusive of cursor's
    // remaining content). Then collapse caret where the chip was.
    const toRemove: Node[] = [];
    let walk: Node | null = prev.nextSibling;
    while (walk && walk !== cursor) {
      toRemove.push(walk);
      walk = walk.nextSibling;
    }
    // If cursor text node is fully whitespace, remove it too and place
    // caret after the chip's old position.
    let cursorRemoved = false;
    if (cursor.nodeType === Node.TEXT_NODE && /^[\s​]*$/.test(cursor.textContent ?? "")) {
      toRemove.push(cursor);
      cursorRemoved = true;
    }
    const parent = prev.parentNode!;
    const anchorAfter = prev.nextSibling; // may be null
    prev.remove();
    toRemove.forEach((n) => n.parentNode && (n as ChildNode).remove());
    // Caret placement.
    const newSel = window.getSelection();
    if (newSel) {
      const r = document.createRange();
      if (cursorRemoved || !cursor.parentNode) {
        // Place at the position the chip used to occupy.
        if (anchorAfter && anchorAfter.parentNode === parent) {
          r.setStartBefore(anchorAfter);
        } else {
          r.selectNodeContents(parent);
          r.collapse(false);
        }
      } else {
        // Cursor text node still exists; place caret at its current offset.
        r.setStart(cursor, Math.min(offset, (cursor.textContent ?? "").length));
      }
      r.collapse(true);
      newSel.removeAllRanges();
      newSel.addRange(r);
    }
    this.el.focus();
    return true;
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
