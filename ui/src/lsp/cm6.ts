// CM6 wiring for LSP navigation. All features no-op gracefully when
// host.doc() is null (server still downloading/starting/unsupported).
import type { Extension } from "@codemirror/state";
import { EditorView, GutterMarker, gutter, hoverTooltip, keymap, showPanel, type Panel } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";
import { lintGutter, setDiagnostics, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import { type CompletionSource, type Completion } from "@codemirror/autocomplete";

import { ContextMenu, type MenuItem } from "../menu/context-menu";
import type { LspDoc } from "./manager";
import { lspRangeToCm, lspToOffset, offsetToLsp, uriToPath } from "./positions";
import type { LspCodeAction, LspDiagnostic, LspCompletionItem, LspLocation } from "./client";
import { applyWorkspaceEdit, countFiles, type LspEdit, type WorkspaceEdit } from "./edits";

export interface LspHost {
  doc(): LspDoc | null;
  openFile(path: string, line: number): void;
  /// uri of the file currently open in this editor instance, or null.
  /// Used by rename/code-actions to route a WorkspaceEdit's per-uri
  /// edits to the live CM6 view vs. disk.
  activeUri(): string | null;
  /// Dispatch `edits` (LSP-coordinate ranges) as CM6 changes against
  /// the active view.
  applyToActiveView(edits: LspEdit[]): void;
}

export function lspExtensions(host: LspHost): Extension {
  return [
    definitionOnCmdClick(host),
    lspHover(host),
    referencesField,
    referencesPanelExt(host),
    lintGutter(),
    renameKeymap(host),
    lspDiagnosticsField,
    codeActionGutter(host),
  ];
}

// --- semantic completion -----------------------------------------------

// LSP CompletionItemKind → a short CM6 type label for the icon.
const KIND_LABEL: Record<number, string> = {
  2: "method",
  3: "function",
  5: "property",
  6: "variable",
  7: "class",
  8: "interface",
  9: "module",
  14: "keyword",
  21: "constant",
};

export function lspCompletionSource(host: LspHost): CompletionSource {
  return async (ctx) => {
    const doc = host.doc();
    if (!doc) return null;
    // Trigger on identifier chars or explicit invocation (Ctrl-Space).
    const word = ctx.matchBefore(/[\w:]+/);
    if (!ctx.explicit && !word) return null;
    let items: LspCompletionItem[] = [];
    try {
      items = await doc.client.completion(doc.uri, offsetToLsp(ctx.state.doc, ctx.pos));
    } catch {
      return null; // timeout/error: silent per spec, matches definition/hover/references
    }
    if (!items.length) return null;
    const options: Completion[] = items.slice(0, 200).map((it) => ({
      label: it.label,
      detail: it.detail,
      type: it.kind ? KIND_LABEL[it.kind] : undefined,
      apply: it.textEdit
        ? (view: EditorView) => {
            const range = it.textEdit!.range;
            const from = lspToOffset(view.state.doc, range.start);
            const to = lspToOffset(view.state.doc, range.end);
            view.dispatch({ changes: { from, to, insert: it.textEdit!.newText } });
          }
        : (it.insertText ?? it.label),
    }));
    return { from: word ? word.from : ctx.pos, options };
  };
}

// --- diagnostics (squiggles + gutter) ---------------------------------

const SEVERITY_MAP: Record<number, CmDiagnostic["severity"]> = {
  1: "error",
  2: "warning",
  3: "info",
  4: "info",
};

// Host method that lets the editor push freshly-arrived diagnostics into
// the view. `setDiagnostics` installs/updates the lint state; the gutter
// markers render via `lintGutter()` in `lspExtensions`. We also stash the
// RAW LspDiagnostic[] (original LSP ranges/severity/source, pre-CmDiagnostic
// conversion) in `lspDiagnosticsField` — the code-action gutter needs the
// original shape to build a `textDocument/codeAction` request `context`,
// which `@codemirror/lint`'s own state (string severities, message already
// prefixed with source) can't reconstruct.
export function applyLspDiagnostics(view: EditorView, diags: LspDiagnostic[]): void {
  const doc = view.state.doc;
  const cm: CmDiagnostic[] = diags.map((d) => {
    const { from, to } = lspRangeToCm(doc, d.range);
    return {
      from,
      // Widen zero-length ranges by one char so the squiggle is visible;
      // clamp to doc.length so an EOF diagnostic never overruns the doc.
      to: Math.min(to > from ? to : from + 1, doc.length),
      severity: SEVERITY_MAP[d.severity ?? 1] ?? "error",
      message: d.source ? `${d.source}: ${d.message}` : d.message,
    };
  });
  view.dispatch(setDiagnostics(view.state, cm), { effects: setLspDiagnostics.of(diags) });
}

// --- code actions (quick fixes) ----------------------------------------

const setLspDiagnostics = StateEffect.define<LspDiagnostic[]>();

// Raw LSP diagnostics for the current document, keyed by nothing but
// "latest publishDiagnostics for this uri" — `applyLspDiagnostics` is only
// ever called with diagnostics already filtered to the active doc's uri
// (see `LspDoc.onDiagnostics` in manager.ts), so one flat list is enough.
const lspDiagnosticsField = StateField.define<LspDiagnostic[]>({
  create: () => [],
  update: (value, tr) => {
    for (const e of tr.effects) if (e.is(setLspDiagnostics)) return e.value;
    return value;
  },
});

class LightbulbMarker extends GutterMarker {
  eq(): boolean {
    return true; // one flyweight marker type — identical wherever it appears
  }
  toDOM(): Node {
    const el = document.createElement("div");
    el.className = "lsp-codeaction-lightbulb";
    el.innerHTML =
      '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M8 1a5 5 0 0 0-3 9v2h6v-2a5 5 0 0 0-3-9z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6 14h4M6.5 15.5h3" stroke="currentColor" stroke-width="1.3"/></svg>';
    return el;
  }
}
const lightbulbMarker = new LightbulbMarker();

/// Diagnostics from `lspDiagnosticsField` whose range overlaps `line`
/// (a CM6 `BlockInfo`, i.e. one visual line's [from, to) offsets).
function diagnosticsOnLine(view: EditorView, from: number, to: number): LspDiagnostic[] {
  const diags = view.state.field(lspDiagnosticsField, false) ?? [];
  const doc = view.state.doc;
  return diags.filter((d) => {
    const r = lspRangeToCm(doc, d.range);
    return r.from <= to && r.to >= from;
  });
}

// Gutter lightbulb: rendered on any line that currently has an LSP
// diagnostic. Click fetches `textDocument/codeAction` for that line's
// range + diagnostics and shows a menu of the returned titles.
function codeActionGutter(host: LspHost): Extension {
  return gutter({
    class: "lsp-codeaction-gutter",
    lineMarker: (view, line) => (diagnosticsOnLine(view, line.from, line.to).length ? lightbulbMarker : null),
    lineMarkerChange: (update) =>
      update.state.field(lspDiagnosticsField) !== update.startState.field(lspDiagnosticsField),
    domEventHandlers: {
      click: (view, line, event) => {
        const diags = diagnosticsOnLine(view, line.from, line.to);
        if (!diags.length) return false;
        void showCodeActions(view, host, line.from, line.to, diags, event as MouseEvent);
        return true;
      },
    },
  });
}

async function showCodeActions(
  view: EditorView,
  host: LspHost,
  lineFrom: number,
  lineTo: number,
  diags: LspDiagnostic[],
  event: MouseEvent,
): Promise<void> {
  const doc = host.doc();
  if (!doc) return;
  const range = { start: offsetToLsp(view.state.doc, lineFrom), end: offsetToLsp(view.state.doc, lineTo) };
  let actions: LspCodeAction[] = [];
  try {
    actions = await doc.client.codeAction(doc.uri, range, diags);
  } catch {
    return; // timeout/error: silent per spec, matches definition/hover/references
  }
  if (!actions.length) return;
  const items: MenuItem[] = actions.map((action) => ({
    label: action.title,
    onClick: () => void applyCodeAction(doc, host, action),
  }));
  new ContextMenu(document.body).show(event.clientX, event.clientY, items);
}

async function applyCodeAction(doc: LspDoc, host: LspHost, action: LspCodeAction): Promise<void> {
  try {
    if (action.edit) await applyWorkspaceEdit(action.edit, host);
    if (action.command) await doc.client.executeCommand(action.command.command, action.command.arguments);
  } catch (e) {
    console.warn("[lsp] code action failed", e);
  }
}

// --- go to definition / references (mouse) ---------------------------

function definitionOnCmdClick(host: LspHost): Extension {
  return EditorView.domEventHandlers({
    click: (event, view) => {
      if (!event.metaKey && !event.ctrlKey) return false;
      const doc = host.doc();
      if (!doc) return false;
      const offset = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (offset === null) return false;
      const pos = offsetToLsp(view.state.doc, offset);
      if (event.altKey) {
        void showReferences(view, doc, pos);
      } else {
        void jumpToDefinition(view, host, doc, pos);
      }
      return true;
    },
  });
}

async function jumpToDefinition(
  view: EditorView,
  host: LspHost,
  doc: LspDoc,
  pos: { line: number; character: number },
): Promise<void> {
  let locs: LspLocation[] = [];
  try {
    locs = await doc.client.definition(doc.uri, pos);
  } catch {
    return; // timeout/error: silent per spec
  }
  const target = locs[0];
  if (!target) return;
  if (target.uri === doc.uri) {
    const offset = lspToOffset(view.state.doc, target.range.start);
    view.dispatch({
      selection: { anchor: offset },
      effects: EditorView.scrollIntoView(offset, { y: "center" }),
    });
    view.focus();
  } else {
    host.openFile(uriToPath(target.uri), target.range.start.line + 1);
  }
}

// --- hover ------------------------------------------------------------

function lspHover(host: LspHost): Extension {
  return hoverTooltip(async (view, offset) => {
    const doc = host.doc();
    if (!doc) return null;
    let text: string | null = null;
    try {
      text = await doc.client.hover(doc.uri, offsetToLsp(view.state.doc, offset));
    } catch {
      return null;
    }
    if (!text) return null;
    const value = text;
    return {
      pos: offset,
      create: () => {
        const dom = document.createElement("div");
        dom.className = "lsp-hover";
        // ponytail: hover text comes from doc-comments in THIRD-PARTY crates the
        // language server indexes, not just code the user wrote — rendering it as
        // markdown/HTML (csp: null) is a drive-by XSS surface into a webview with
        // full Tauri IPC. Render as plain text for P1; rich markdown returns in P2
        // once it goes through proper sanitization (DOMPurify) or CSP re-enables.
        const stripped = value
          .split("\n")
          .filter((line) => !/^\s*```\w*\s*$/.test(line))
          .join("\n");
        dom.textContent = stripped;
        return { dom };
      },
    };
  }, { hoverTime: 300 });
}

// --- references panel ---------------------------------------------------

const setReferences = StateEffect.define<LspLocation[] | null>();

const referencesField = StateField.define<LspLocation[] | null>({
  create: () => null,
  update: (value, tr) => {
    for (const e of tr.effects) if (e.is(setReferences)) return e.value;
    return value;
  },
});

function referencesPanelExt(host: LspHost): Extension {
  return showPanel.from(referencesField, (refs) =>
    refs && refs.length ? (view) => referencesPanel(view, host, refs) : null,
  );
}

async function showReferences(
  view: EditorView,
  doc: LspDoc,
  pos: { line: number; character: number },
): Promise<void> {
  let locs: LspLocation[] = [];
  try {
    locs = await doc.client.references(doc.uri, pos);
  } catch {
    return;
  }
  view.dispatch({ effects: setReferences.of(locs.length ? locs : null) });
}

function referencesPanel(view: EditorView, host: LspHost, refs: LspLocation[]): Panel {
  const dom = document.createElement("div");
  dom.className = "lsp-references";
  const header = document.createElement("div");
  header.className = "lsp-references-header";
  header.textContent = `${refs.length} reference${refs.length === 1 ? "" : "s"}`;
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "✕";
  close.addEventListener("click", () => view.dispatch({ effects: setReferences.of(null) }));
  header.appendChild(close);
  dom.appendChild(header);
  const list = document.createElement("div");
  list.className = "lsp-references-list";
  const shown = refs.slice(0, 200);
  for (const ref of shown) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "lsp-references-row";
    const path = uriToPath(ref.uri);
    row.textContent = `${path.split("/").slice(-2).join("/")}:${ref.range.start.line + 1}`;
    row.addEventListener("click", () => {
      host.openFile(path, ref.range.start.line + 1);
      view.dispatch({ effects: setReferences.of(null) });
    });
    list.appendChild(row);
  }
  if (refs.length > shown.length) {
    const more = document.createElement("div");
    more.className = "lsp-references-row lsp-references-more";
    more.textContent = `+ ${refs.length - shown.length} more`;
    list.appendChild(more);
  }
  dom.appendChild(list);
  return { dom };
}

// --- rename symbol (F2) -------------------------------------------------

function renameKeymap(host: LspHost): Extension {
  return keymap.of([
    {
      key: "F2",
      preventDefault: true,
      run: (view) => {
        void startRename(view, host);
        return true;
      },
    },
  ]);
}

// Word (identifier) touching `pos` on its line — CM6's language-aware
// word boundaries aren't available generically, so this is a plain
// `\w` scan, matching the completion source's word regex.
function wordRangeAt(view: EditorView, pos: number): { from: number; to: number; text: string } | null {
  const line = view.state.doc.lineAt(pos);
  const text = line.text;
  const offset = pos - line.from;
  let start = offset;
  while (start > 0 && /\w/.test(text[start - 1])) start--;
  let end = offset;
  while (end < text.length && /\w/.test(text[end])) end++;
  if (start === end) return null;
  return { from: line.from + start, to: line.from + end, text: text.slice(start, end) };
}

async function startRename(view: EditorView, host: LspHost): Promise<void> {
  const doc = host.doc();
  if (!doc) return;
  const word = wordRangeAt(view, view.state.selection.main.head);
  if (!word) return;
  const coords = view.coordsAtPos(word.from);
  if (!coords) return;

  const box = document.createElement("div");
  box.className = "lsp-rename";
  box.style.left = `${coords.left}px`;
  box.style.top = `${coords.bottom + 4}px`;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "lsp-rename-input";
  input.value = word.text;
  box.appendChild(input);
  document.body.appendChild(box);
  input.focus();
  input.select();

  const cleanup = () => {
    box.remove();
    document.removeEventListener("mousedown", onOutsideClick, true);
    view.focus();
  };
  const onOutsideClick = (e: MouseEvent) => {
    if (!box.contains(e.target as Node)) cleanup();
  };
  document.addEventListener("mousedown", onOutsideClick, true);

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      cleanup();
    } else if (e.key === "Enter") {
      e.preventDefault();
      void commitRename(view, host, doc, word, input.value, box, cleanup);
    }
  });
}

async function commitRename(
  view: EditorView,
  host: LspHost,
  doc: LspDoc,
  word: { from: number; text: string },
  newName: string,
  box: HTMLDivElement,
  cleanup: () => void,
): Promise<void> {
  const trimmed = newName.trim();
  if (!trimmed || trimmed === word.text) {
    cleanup();
    return;
  }
  let edit: WorkspaceEdit | null = null;
  try {
    edit = await doc.client.rename(doc.uri, offsetToLsp(view.state.doc, word.from), trimmed);
  } catch {
    cleanup();
    return; // timeout/error: silent, matches definition/hover/references
  }
  if (!edit) {
    cleanup();
    return;
  }
  // Narrow into a new const (rather than `edit!` in the closure below) —
  // `edit`'s null-check above doesn't survive into the deferred arrow fn.
  const resolvedEdit = edit;
  const fileCount = countFiles(resolvedEdit);
  if (fileCount > 1) {
    showRenameConfirm(
      box,
      fileCount,
      async () => {
        try {
          await applyWorkspaceEdit(resolvedEdit, host);
        } catch (e) {
          console.warn("[lsp] rename failed", e);
        } finally {
          cleanup();
        }
      },
      cleanup,
    );
    return;
  }
  try {
    await applyWorkspaceEdit(resolvedEdit, host);
  } catch (e) {
    console.warn("[lsp] rename failed", e);
  } finally {
    cleanup();
  }
}

function showRenameConfirm(
  box: HTMLDivElement,
  fileCount: number,
  onApply: () => void,
  onCancel: () => void,
): void {
  box.textContent = "";
  const msg = document.createElement("div");
  msg.className = "lsp-rename-confirm-msg";
  msg.textContent = `Rename touches ${fileCount} files.`;
  box.appendChild(msg);

  const actions = document.createElement("div");
  actions.className = "lsp-rename-confirm-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", onCancel);
  const apply = document.createElement("button");
  apply.type = "button";
  apply.textContent = "Apply";
  apply.addEventListener("click", onApply);
  actions.appendChild(cancel);
  actions.appendChild(apply);
  box.appendChild(actions);
}
