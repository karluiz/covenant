// CM6 wiring for LSP navigation. All features no-op gracefully when
// host.doc() is null (server still downloading/starting/unsupported).
import type { Extension } from "@codemirror/state";
import { EditorView, hoverTooltip, showPanel, type Panel } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";
import { lintGutter, setDiagnostics, type Diagnostic as CmDiagnostic } from "@codemirror/lint";

import type { LspDoc } from "./manager";
import { lspRangeToCm, lspToOffset, offsetToLsp, uriToPath } from "./positions";
import type { LspDiagnostic, LspLocation } from "./client";

export interface LspHost {
  doc(): LspDoc | null;
  openFile(path: string, line: number): void;
}

export function lspExtensions(host: LspHost): Extension {
  return [
    definitionOnCmdClick(host),
    lspHover(host),
    referencesField,
    referencesPanelExt(host),
    lintGutter(),
  ];
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
// markers render via `lintGutter()` in `lspExtensions`.
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
  view.dispatch(setDiagnostics(view.state, cm));
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
