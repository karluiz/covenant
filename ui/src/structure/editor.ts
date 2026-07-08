// In-app editor backed by CodeMirror 6. The pane lives inside the
// Structure split (between terminal and sidebar); same header as
// before (path, ext chip, dirty indicator, wrap toggle, close), but
// the body is now an EditorView with syntax highlighting, gutter,
// undo, multi-cursor, in-file ⌘F search, and virtualised rendering.
//
// ⌘F     — open in-file search panel (CM6 default).
// ⌘⇧F    — UNTOUCHED. The global content-search palette wins; we
//          deliberately don't register Mod-Shift-f anywhere here.
// ⌘S     — save file (custom keymap below).
// ⌘Z/⌘⇧Z — undo / redo (history extension).
// Tab / Shift-Tab — indent / dedent (CM6 default).
//
// Wrap toggle, save, jumpToLine and the size/binary placeholder all
// route through CM6's reconfiguration / dispatch APIs instead of the
// previous textarea+gutter DOM.

import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  rectangularSelection,
  crosshairCursor,
  type ViewUpdate,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  toggleComment,
  toggleBlockComment,
  selectAll,
} from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
} from "@codemirror/language";
import {
  search,
  searchKeymap,
  highlightSelectionMatches,
  openSearchPanel,
  selectSelectionMatches,
} from "@codemirror/search";
import {
  autocompletion,
  completeAnyWord,
  completionKeymap,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";

import { Icons } from "../icons";
import {
  resolveExistingPath,
  structureReadBinaryFile,
  structureReadFile,
  structureWriteBinaryFile,
  structureWriteFile,
} from "../api";
import { languageForPath } from "./languages";
import {
  HtmlPreview,
  MarkdownPreview,
  PngPreview,
  type Preview,
  type PreviewKind,
  previewKindForPath,
  SvgPreview,
  CsvPreview,
  XlsxPreview,
  DocxPreview,
  PdfPreview,
} from "./preview";
import {
  loadSvgScale,
  type PngScale,
  saveSvgScale,
  svgToPng,
} from "./png-export";
import { editorHighlight, editorTheme, currentEditorMode } from "./theme";
import { CustomSelect } from "../ui/select";
import { ContextMenu } from "../menu/context-menu";
import { applyLspDiagnostics, lspCompletionSource, lspExtensions, type LspHost } from "../lsp/cm6";
import { lspManager, lspLanguageId, onCodeIntelChange, type LspDoc, type LspDocStatus } from "../lsp/manager";
import { lspRangeToCm, pathToUri } from "../lsp/positions";

export interface EditorCallbacks {
  onSave?: (path: string) => void;
  onClose?: () => void;
  toast?: (message: string, severity?: "info" | "error") => void;
  /// Attach the currently open spec file to the active tab as its
  /// mission. Wired from the "Apply spec" header button; only invoked
  /// when the open file looks like a spec (see `isSpecPath`).
  onApplySpec?: (path: string) => void;
  /// Open another file in this editor. Used for Cmd/Ctrl-clicking
  /// Astro component tags that are imported in the current file.
  onOpenPath?: (path: string) => void;
}

/// Heuristic: a file is "spec-like" when it's markdown and lives under
/// a directory named `specs` (project specs, .superpowers/specs, etc.).
/// Used to decide whether to surface the "Apply spec" button.
export function isSpecPath(path: string | null | undefined): boolean {
  if (!path) return false;
  const lower = path.toLowerCase();
  if (!(lower.endsWith(".md") || lower.endsWith(".markdown"))) return false;
  return /\/specs\//.test(path) || /\/specs\\/.test(path);
}

const SIZE_THRESHOLD_BYTES = 1024 * 1024; // 1 MiB per spec.

// Shared autocompletion() knobs — identical whether or not LSP is in the
// source list, so both config builders below spread this instead of
// repeating it.
const COMPLETION_OPTS = {
  activateOnTyping: true,
  closeOnBlur: true,
  maxRenderedOptions: 20,
} as const;

/// Default completion config: no `override`, so CM6 gathers whatever the
/// active language registers via `languageDataAt("autocomplete", …)`
/// (e.g. lang-javascript/python's local + keyword sources) PLUS
/// `completeAnyWord`, which `buildState` registers unconditionally via a
/// language-agnostic `EditorState.languageData` provider (see below) so
/// every file — including `.rs`, whose CM6 language pack registers no
/// autocomplete source at all — gets at least buffer-word completion.
/// This is the config used whenever LSP is inactive for any reason.
function defaultCompletion(): Extension {
  return autocompletion({ ...COMPLETION_OPTS });
}

/// LSP-active completion config. `override` doesn't mean "try these in
/// order, fall back on empty" — CM6 queries and MERGES every source in
/// `override` on every keystroke, so listing `completeAnyWord` alongside
/// `lspCompletionSource` here would permanently duplicate results (e.g.
/// rust-analyzer's `foo` entry AND a near-identical buffer-word `foo`
/// entry, every time). The fallback-when-inactive behavior instead comes
/// from the `completionCompartment` swap in `startLsp`/`teardownLsp`:
/// when LSP isn't ready (master off, no consent, not installed, crash,
/// still starting), the compartment holds `defaultCompletion()` — no
/// `override`, so `completeAnyWord` + language-pack sources apply. Once
/// LSP is ready, the compartment swaps to this config: pure LSP
/// completion, no word-completion noise.
function lspCompletion(host: LspHost): Extension {
  return autocompletion({
    ...COMPLETION_OPTS,
    override: [lspCompletionSource(host)],
  });
}

/// Which mode the editor body is currently in. "source" = CodeMirror,
/// "preview" = read-only renderer keyed off the file extension. The
/// default mode for a freshly-opened file is decided by the
/// per-extension preference (see `loadViewModePref` / `saveViewModePref`).
type ViewMode = "source" | "preview";

const VIEW_MODE_PREFS_KEY = "covenant.editor.view-mode-by-ext";

interface ViewModePrefs {
  /// Lowercased extension → last-used mode. Persisted across sessions.
  /// Files without a registered preview never end up in this map.
  [ext: string]: ViewMode;
}

function loadViewModePrefs(): ViewModePrefs {
  try {
    const raw = localStorage.getItem(VIEW_MODE_PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as ViewModePrefs) : {};
  } catch {
    return {};
  }
}

function saveViewModePrefs(prefs: ViewModePrefs): void {
  try {
    localStorage.setItem(VIEW_MODE_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode / quota — runtime value still wins this session */
  }
}

export class StructureEditor {
  private readonly root: HTMLElement;
  private readonly headerEl: HTMLElement;
  private readonly pathLabelEl: HTMLElement;
  private readonly extEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly editorHostEl: HTMLElement;
  private readonly placeholderEl: HTMLElement;
  private currentPath: string | null = null;
  private originalContent: string | null = null;

  /// LSP-backed doc for the currently open file. Null until `setupLsp`
  /// resolves (unsupported language / consent pending / still starting).
  private lspDoc: LspDoc | null = null;
  /// Unsubscribe for the current `lspDoc`'s diagnostics stream. Torn
  /// down whenever the doc is released (new file open, or close()).
  private lspDiagUnsub: (() => void) | null = null;
  /// The `LspHost` built by the most recent `buildState` call, stashed
  /// so `startLsp`/`teardownLsp` can reconfigure `completionCompartment`
  /// without rebuilding it. Rebuilt on every file open alongside the
  /// rest of the state; null only before the first `buildState` call.
  private lspHost: LspHost | null = null;
  /// Unsubscribe for the `onCodeIntelChange` listener (module-level
  /// `Set` in `lsp/manager.ts` — it lives for the whole app session).
  /// Non-null while a file is open; (re-)armed by `subscribeCodeIntel`
  /// on `open()`, released in `close()`. See `subscribeCodeIntel` for
  /// why and its caveat on tab-destroy paths that never call `close()`.
  private codeIntelUnsub: (() => void) | null = null;
  private readonly lspChipEl: HTMLElement;
  private readonly lspBannerEl: HTMLElement;
  /// Latest known content irrespective of viewer. In source mode it
  /// shadows the CM6 doc on every change; in preview mode it keeps
  /// the last source value so toggling back doesn't lose edits.
  private liveContent = "";
  private dirty = false;
  private visible = false;

  /// CM6 view + a reconfigurable compartment for the language so file
  /// opens can swap grammar without rebuilding the whole state. Line
  /// wrapping is hardcoded ON — the previous toggle was confusing and
  /// rarely useful for the kind of files this editor handles.
  private view: EditorView | null = null;
  private readonly languageCompartment = new Compartment();
  /// Reconfigured between `defaultCompletion()` and `lspCompletion(host)`
  /// as the current file's LSP doc comes up / goes away (see `startLsp`
  /// and `teardownLsp`), so completion degrades gracefully instead of
  /// going empty — see the fix-1 note on `defaultCompletion` above.
  private readonly completionCompartment = new Compartment();

  /// Right-click editing menu (Cut/Copy/Paste, Select All, etc.).
  /// Reuses the shared floating ContextMenu used by tabs/blocks.
  private readonly contextMenu = new ContextMenu(document.body);

  /// Preview state. `previewKind` is null when the open file has no
  /// preview available (the toggle hides). `currentPreview` holds the
  /// active renderer when `viewMode === "preview"`, null otherwise.
  /// `previewHostEl` is permanent so we don't churn DOM nodes on toggle.
  private viewMode: ViewMode = "source";
  private previewKind: PreviewKind | null = null;
  private currentPreview: Preview | null = null;
  private readonly previewHostEl: HTMLElement;
  private readonly previewBtn: HTMLButtonElement;

  /// "Apply spec" button — attaches the currently open file to the
  /// active tab as its mission spec. Shown only for spec-like paths
  /// (markdown under a `specs/` dir) and when a callback is wired.
  private readonly applySpecBtn: HTMLButtonElement;

  /// PNG export controls — sibling pair to `previewBtn`. Only shown
  /// when `previewKind === "svg"`; hidden for markdown/code so the
  /// header stays uncluttered.
  private readonly pngBtn: HTMLButtonElement;
  private readonly pngScaleSelect: CustomSelect;
  private pngScale: PngScale = 2;

  /// In-preview find bar. Source mode uses CM6's built-in panel; this
  /// bar covers preview mode (markdown / svg) where there's no editor
  /// to host CM6's search. Highlights via the CSS Custom Highlight API
  /// so we don't mutate the rendered DOM.
  private readonly findBarEl: HTMLElement;
  private readonly findInputEl: HTMLInputElement;
  private readonly findCountEl: HTMLElement;
  private findRanges: Range[] = [];
  private findActiveIdx = -1;
  private findOpen = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly callbacks: EditorCallbacks,
  ) {
    this.root = document.createElement("div");
    this.root.className = "structure-editor";
    this.root.hidden = true;

    this.headerEl = document.createElement("header");
    this.headerEl.className = "structure-editor-header";
    this.root.appendChild(this.headerEl);

    // Download-consent banner — sits between header and body. Shown
    // when a language server needs the user's OK before downloading.
    this.lspBannerEl = document.createElement("div");
    this.lspBannerEl.className = "structure-editor-lsp-banner";
    this.lspBannerEl.hidden = true;
    this.root.insertBefore(this.lspBannerEl, this.headerEl.nextSibling);

    this.pathLabelEl = document.createElement("span");
    this.pathLabelEl.className = "structure-editor-path";
    this.headerEl.appendChild(this.pathLabelEl);

    this.extEl = document.createElement("span");
    this.extEl.className = "structure-editor-ext";
    this.extEl.hidden = true;
    this.headerEl.appendChild(this.extEl);

    this.statusEl = document.createElement("span");
    this.statusEl.className = "structure-editor-status";
    this.headerEl.appendChild(this.statusEl);

    // LSP status chip — shows download/starting/ready/error state for
    // the currently open file's language server. Hidden when the file
    // has no LSP support.
    this.lspChipEl = document.createElement("span");
    this.lspChipEl.className = "structure-editor-lsp-chip";
    this.lspChipEl.hidden = true;
    this.headerEl.appendChild(this.lspChipEl);

    // Scale dropdown — sits left of the PNG button. Persisted choice
    // applies across restarts; default 2× covers the retina case.
    this.pngScale = loadSvgScale();
    this.pngScaleSelect = new CustomSelect({
      className: "structure-editor-png-scale",
      ariaLabel: "PNG export scale",
      title: "PNG export scale",
      value: String(this.pngScale),
      options: ([1, 2, 3] as const).map((s) => ({
        value: String(s),
        label: `${s}x`,
      })),
    });
    this.pngScaleSelect.element.hidden = true;
    this.pngScaleSelect.element.addEventListener("change", () => {
      const v = Number(this.pngScaleSelect.value);
      if (v === 1 || v === 2 || v === 3) {
        this.pngScale = v;
        saveSvgScale(v);
      }
    });
    this.headerEl.appendChild(this.pngScaleSelect.element);

    // PNG export button — single-click overwrite of <basename>.png.
    this.pngBtn = document.createElement("button");
    this.pngBtn.type = "button";
    this.pngBtn.className = "structure-editor-png-btn";
    this.pngBtn.textContent = "PNG";
    this.pngBtn.title = "Export as PNG next to source";
    this.pngBtn.hidden = true;
    this.pngBtn.addEventListener("click", () => {
      void this.handleExportPng();
    });
    this.headerEl.appendChild(this.pngBtn);

    // Preview/Source toggle — only shown when the open file has a
    // preview kind registered (md/svg). Hidden for plain code files
    // so the header doesn't carry a non-functional button.
    this.previewBtn = document.createElement("button");
    this.previewBtn.type = "button";
    this.previewBtn.className = "structure-editor-preview-btn";
    this.previewBtn.hidden = true;
    this.previewBtn.addEventListener("click", () => this.toggleViewMode());
    this.headerEl.appendChild(this.previewBtn);

    this.applySpecBtn = document.createElement("button");
    this.applySpecBtn.type = "button";
    this.applySpecBtn.className = "structure-editor-apply-spec-btn";
    this.applySpecBtn.textContent = "Apply spec";
    this.applySpecBtn.title = "Attach this spec to the active tab's mission";
    this.applySpecBtn.hidden = true;
    this.applySpecBtn.addEventListener("click", () => {
      if (!this.currentPath) return;
      this.callbacks.onApplySpec?.(this.currentPath);
    });
    this.headerEl.appendChild(this.applySpecBtn);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "structure-editor-close";
    closeBtn.title = "Close editor";
    closeBtn.innerHTML = Icons.x({ size: 12 });
    closeBtn.addEventListener("click", () => this.close());
    this.headerEl.appendChild(closeBtn);

    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "structure-editor-body";
    this.root.appendChild(this.bodyEl);

    // Editor host — CM6 mounts here. Kept separate from `bodyEl` so the
    // placeholder can sit alongside without colliding with CM6's layout.
    this.editorHostEl = document.createElement("div");
    this.editorHostEl.className = "structure-editor-cm";
    this.editorHostEl.addEventListener("contextmenu", (e) =>
      this.showContextMenu(e),
    );
    this.bodyEl.appendChild(this.editorHostEl);

    // Preview host — sibling to the CM6 host. Each view-mode shows
    // exactly one of the two via .hidden, sparing us a teardown of
    // CM6's DOM tree on every toggle.
    this.previewHostEl = document.createElement("div");
    this.previewHostEl.className = "structure-editor-preview";
    this.previewHostEl.hidden = true;
    this.bodyEl.appendChild(this.previewHostEl);

    this.placeholderEl = document.createElement("div");
    this.placeholderEl.className = "structure-editor-placeholder";
    this.placeholderEl.hidden = true;
    this.bodyEl.appendChild(this.placeholderEl);

    // Find bar — floats over the body, hidden by default.
    this.findBarEl = document.createElement("div");
    this.findBarEl.className = "structure-editor-find";
    this.findBarEl.hidden = true;
    this.findInputEl = document.createElement("input");
    this.findInputEl.type = "text";
    this.findInputEl.placeholder = "Find in preview…";
    this.findInputEl.className = "structure-editor-find-input";
    this.findInputEl.spellcheck = false;
    this.findCountEl = document.createElement("span");
    this.findCountEl.className = "structure-editor-find-count";
    const mkBtn = (label: string, title: string, onClick: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "structure-editor-find-btn";
      b.textContent = label;
      b.title = title;
      b.tabIndex = -1;
      b.addEventListener("click", (e) => {
        e.preventDefault();
        onClick();
      });
      return b;
    };
    const prevBtn = mkBtn("‹", "Previous match (⇧⏎)", () => this.findStep(-1));
    const nextBtn = mkBtn("›", "Next match (⏎)", () => this.findStep(1));
    const closeBtn2 = mkBtn("✕", "Close (Esc)", () => this.closeFind());
    this.findBarEl.appendChild(this.findInputEl);
    this.findBarEl.appendChild(this.findCountEl);
    this.findBarEl.appendChild(prevBtn);
    this.findBarEl.appendChild(nextBtn);
    this.findBarEl.appendChild(closeBtn2);
    this.bodyEl.appendChild(this.findBarEl);

    this.findInputEl.addEventListener("input", () => this.recomputeMatches());
    this.findInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.closeFind();
      } else if (e.key === "Enter") {
        e.preventDefault();
        this.findStep(e.shiftKey ? -1 : 1);
      }
    });

    // ⌘F at the root level — only intercept in preview mode. In source
    // CM6 already binds Mod-f via searchKeymap and we let it through.
    this.root.addEventListener("keydown", (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && (e.key === "f" || e.key === "F") && !e.shiftKey) {
        if (this.viewMode === "preview" && this.previewKind !== "png") {
          e.preventDefault();
          e.stopPropagation();
          this.openFind();
        }
      }
      // ⌘S normally lives in the CM6 keymap, which doesn't exist in
      // preview mode — editable previews (CSV) need it here.
      if (meta && (e.key === "s" || e.key === "S") && !e.shiftKey) {
        if (this.viewMode === "preview") {
          e.preventDefault();
          e.stopPropagation();
          // Commit the in-flight cell edit (blur fires focusout → commit
          // synchronously) before snapshotting liveContent.
          const active = document.activeElement;
          if (active instanceof HTMLElement && this.previewHostEl.contains(active)) {
            active.blur();
          }
          void this.save();
        }
      }
    });

    this.host.appendChild(this.root);

    // Fix 2 (live teardown): the Settings panel's Code intelligence
    // section flips the master toggle / per-language consent, then calls
    // `refreshCodeIntelSettings()` — which only affects NEW `setupLsp`
    // calls (i.e. new file opens) unless we also re-run it for whatever
    // is open right now. See `subscribeCodeIntel` for the subscribe /
    // unsubscribe lifecycle — it's re-armed on `open()` and released on
    // `close()` so a long-lived, reused editor instance (one per tab in
    // `tabs/manager.ts`) doesn't hold a permanent listener while its
    // drawer is closed and there's no `currentPath` to refresh anyway.
    this.subscribeCodeIntel();
  }

  /// (Re-)register the `onCodeIntelChange` listener. `onCodeIntelChange`
  /// adds to a module-level `Set` in `lsp/manager.ts` that lives for the
  /// whole app session, so holding an active subscription forever would
  /// pin this instance in memory via the closure's `this` capture. We
  /// only need the listener while a file is actually open (it no-ops via
  /// the `currentPath` guard otherwise), so `open()` re-subscribes and
  /// `close()` unsubscribes — see the comment there. `close()` is the
  /// only teardown hook this class exposes; it's per-file semantics in
  /// most callers (drawer close, file trash) but `executors/pi/view.ts
  /// #destroy()` calls it right before dropping its own `editor`
  /// reference, so that path is fully covered. `tabs/manager.ts`'s
  /// `finalizeCloseTab` currently drops its `tab.editor` reference on
  /// tab close WITHOUT calling `close()` first — if the drawer happens
  /// to be open at that moment, this subscription isn't released; a
  /// separate, pre-existing gap (tracked, not fixed here).
  private subscribeCodeIntel(): void {
    if (this.codeIntelUnsub) return;
    this.codeIntelUnsub = onCodeIntelChange(() => {
      if (this.currentPath) void this.setupLsp(this.currentPath);
    });
  }

  // ─── Find-in-preview ───────────────────────────────────

  private openFind(): void {
    this.findOpen = true;
    this.findBarEl.hidden = false;
    // Seed with current selection if any
    const sel = window.getSelection();
    if (sel && sel.toString().trim() && this.previewHostEl.contains(sel.anchorNode)) {
      this.findInputEl.value = sel.toString();
    }
    this.findInputEl.focus();
    this.findInputEl.select();
    this.recomputeMatches();
  }

  private closeFind(): void {
    this.findOpen = false;
    this.findBarEl.hidden = true;
    this.findInputEl.value = "";
    this.clearFindHighlights();
    this.findRanges = [];
    this.findActiveIdx = -1;
    if (this.viewMode === "preview") {
      this.previewHostEl.tabIndex = -1;
      this.previewHostEl.focus({ preventScroll: true });
    }
  }

  /// Walk text nodes inside the preview host, build Ranges for every
  /// case-insensitive substring match, and apply CSS Custom Highlights.
  private recomputeMatches(): void {
    this.clearFindHighlights();
    this.findRanges = [];
    this.findActiveIdx = -1;
    const query = this.findInputEl.value;
    if (!query) {
      this.renderFindCount();
      return;
    }
    const lower = query.toLowerCase();
    const walker = document.createTreeWalker(
      this.previewHostEl,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (n) => {
          if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          // Skip text inside hidden / non-rendered nodes.
          const parent = n.parentElement;
          if (parent && parent.closest("[hidden]")) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      },
    );
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue ?? "";
      const hay = text.toLowerCase();
      let from = 0;
      while (from <= hay.length) {
        const i = hay.indexOf(lower, from);
        if (i < 0) break;
        const r = document.createRange();
        r.setStart(node, i);
        r.setEnd(node, i + query.length);
        this.findRanges.push(r);
        from = i + Math.max(1, query.length);
      }
    }
    if (this.findRanges.length > 0) this.findActiveIdx = 0;
    this.applyFindHighlights();
    this.renderFindCount();
    this.scrollActiveIntoView();
  }

  private findStep(delta: number): void {
    if (this.findRanges.length === 0) return;
    const n = this.findRanges.length;
    this.findActiveIdx = (this.findActiveIdx + delta + n) % n;
    this.applyFindHighlights();
    this.renderFindCount();
    this.scrollActiveIntoView();
  }

  private applyFindHighlights(): void {
    // CSS Custom Highlight API. WebKit (Tauri) supports it; gracefully
    // skip when unavailable — the bar still works as next/prev nav.
    const cssAny = CSS as unknown as { highlights?: Map<string, unknown> };
    if (!cssAny.highlights || typeof Highlight === "undefined") return;
    cssAny.highlights.delete("editor-find");
    cssAny.highlights.delete("editor-find-active");
    if (this.findRanges.length === 0) return;
    const inactive: Range[] = [];
    let active: Range | null = null;
    for (let i = 0; i < this.findRanges.length; i++) {
      if (i === this.findActiveIdx) active = this.findRanges[i];
      else inactive.push(this.findRanges[i]);
    }
    cssAny.highlights.set("editor-find", new Highlight(...inactive));
    if (active) cssAny.highlights.set("editor-find-active", new Highlight(active));
  }

  private clearFindHighlights(): void {
    const cssAny = CSS as unknown as { highlights?: Map<string, unknown> };
    if (!cssAny.highlights) return;
    cssAny.highlights.delete("editor-find");
    cssAny.highlights.delete("editor-find-active");
  }

  private renderFindCount(): void {
    if (this.findRanges.length === 0) {
      this.findCountEl.textContent = this.findInputEl.value ? "0/0" : "";
      this.findCountEl.classList.toggle("none", !!this.findInputEl.value);
    } else {
      this.findCountEl.textContent = `${this.findActiveIdx + 1}/${this.findRanges.length}`;
      this.findCountEl.classList.remove("none");
    }
  }

  private scrollActiveIntoView(): void {
    if (this.findActiveIdx < 0) return;
    const r = this.findRanges[this.findActiveIdx];
    const rect = r.getBoundingClientRect();
    const hostRect = this.previewHostEl.getBoundingClientRect();
    if (rect.top < hostRect.top || rect.bottom > hostRect.bottom) {
      const target = (r.startContainer.parentElement ?? null);
      target?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  /// Build a fresh EditorState for `text` with the language matching
  /// `path` (null → no language, plain editing). Reusable on every
  /// file open: CM6 is fastest when the state is constructed once
  /// per document instead of mutated piecemeal.
  private buildState(path: string, text: string): EditorState {
    const lang = languageForPath(path, text);
    const langExtension = lang ? [lang] : [];

    // Shared with `lspExtensions` below — one host object per state so
    // both navigation (definition/hover/references) and completion read
    // the same live `this.lspDoc` getter (it's null until the server
    // finishes starting; each call site re-reads it lazily).
    const lspHost: LspHost = {
      doc: () => this.lspDoc,
      openFile: (p, line) => {
        void this.open(p, { line });
      },
      // Rename / code-actions (WorkspaceEdit applier, edits.ts): the
      // "active" file is whatever this editor instance currently has
      // open, identified by uri so it can be matched against the
      // WorkspaceEdit's per-uri edit map.
      activeUri: () => (this.currentPath ? pathToUri(this.currentPath) : null),
      applyToActiveView: (edits) => {
        const view = this.view;
        if (!view) return;
        view.dispatch({
          changes: edits.map((e) => {
            const { from, to } = lspRangeToCm(view.state.doc, e.range);
            return { from, to, insert: e.newText };
          }),
        });
      },
    };
    this.lspHost = lspHost;

    return EditorState.create({
      doc: text,
      extensions: [
        // Chrome — theme resolved at state-build time. Reopening a file
        // (or theme change) rebuilds the state via `setSource`, so the
        // editor always picks up the current light/dark palette.
        editorTheme(currentEditorMode()),
        editorHighlight(currentEditorMode()),
        lineNumbers(),
        foldGutter(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        drawSelection(),
        rectangularSelection(),
        crosshairCursor(),
        highlightSelectionMatches(),
        // Search panel anchored at the TOP of the editor so the
        // find-and-replace inputs aren't clipped by the body's bottom
        // edge when the file is short. Mod-f opens it; the panel
        // already exposes both find and replace fields.
        search({ top: true }),

        // Editing.
        history(),
        bracketMatching(),
        closeBrackets(),
        indentOnInput(),
        // Local autocomplete: language-aware completions where the CM6
        // language pack provides them (ts/py/json/css/html/sql/yaml/md),
        // plus buffer-word fallback via `completeAnyWord`, registered
        // language-agnostically below so it applies even to languages
        // whose CM6 pack ships no autocomplete source at all (`.rs` —
        // `@codemirror/lang-rust` registers none). No network calls.
        // Ctrl-Space opens the popup manually; Tab/Enter accepts.
        //
        // ponytail: CM6 permits exactly one autocompletion() instance per
        // state — there's no "add a second source" API, only `override`
        // which replaces the whole source list. That ruled out just
        // statically picking LSP-vs-default at build time (the P1
        // approach): `override` REPLACES all sources, and
        // `lspCompletionSource` returns null whenever `host.doc()` isn't
        // ready — which for a disabled/uninstalled/crashed language
        // server is PERMANENT, not just a startup window, leaving `.rs`
        // with zero completion of any kind. Fix: put `autocompletion()`
        // itself in a Compartment (`completionCompartment`), defaulting
        // to `defaultCompletion()` (no override — language-pack + word).
        // `startLsp`/`teardownLsp` reconfigure it to `lspCompletion(host)`
        // (pure LSP, no word-completion dupes — see that function) only
        // while a live `lspDoc` exists, and back to the default the
        // moment it goes away for any reason.
        this.completionCompartment.of(defaultCompletion()),
        // Buffer-word fallback source, language-agnostic (see comment
        // above) — merges into `languageDataAt("autocomplete", …)`
        // alongside whatever the active `Language` itself registers, so
        // `defaultCompletion()`'s un-overridden `autocompletion()` picks
        // it up automatically.
        EditorState.languageData.of(() => [{ autocomplete: completeAnyWord }]),
        indentUnit.of("  "), // 2-space indent — matches the previous textarea behaviour.
        EditorView.lineWrapping,

        // Language (in a compartment so future file opens swap it
        // without rebuilding the whole state).
        this.languageCompartment.of(langExtension),

        // Keymap. Order matters — search/history/default keep their
        // standard bindings; we add Mod-s explicitly. We deliberately
        // do NOT include any binding that would touch Mod-Shift-f
        // (the global content-search palette owns that).
        keymap.of([
          { key: "Mod-s", preventDefault: true, run: () => this.handleSave() },
          {
            key: "Mod-Shift-p",
            preventDefault: true,
            run: () => {
              this.toggleViewMode();
              return true;
            },
          },
          // VS Code-style comment toggles. Line comment on Mod-/,
          // block comment on Shift-Alt-A. Explicit (not relying on
          // defaultKeymap) so the binding is stable regardless of
          // ordering, and language-aware via each grammar's
          // commentTokens (see languages.ts).
          { key: "Mod-/", preventDefault: true, run: toggleComment },
          { key: "Shift-Alt-a", preventDefault: true, run: toggleBlockComment },
          ...closeBracketsKeymap,
          ...completionKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...defaultKeymap,
          indentWithTab,
        ]),

        // Cmd/Ctrl-click go-to-definition / hover / references, backed
        // by the LSP client. Registered BEFORE the Astro handler below
        // so `.rs` files' ⌘click is consumed here first (this handler
        // returns `true` when it acts); it no-ops when `lspDoc` isn't
        // ready, letting the click fall through as normal.
        lspExtensions(lspHost),

        // Cmd/Ctrl-click imported Astro component tags to jump to the
        // component file. This is intentionally local/static: no LSP,
        // no project index, just imports in the current document.
        EditorView.domEventHandlers({
          click: (event, view) => {
            if (!event.metaKey && !event.ctrlKey) return false;
            void this.handleComponentCmdClick(event, view);
            return false;
          },
        }),

        // Track dirty state. Cheaper than diffing the whole doc — the
        // listener fires only when the document actually changes.
        EditorView.updateListener.of((u) => {
          if (u.docChanged) this.onDocChanged(u);
        }),
      ],
    });
  }

  private async handleComponentCmdClick(event: MouseEvent, view: EditorView): Promise<void> {
    if (!this.currentPath || !/\.astro$/i.test(this.currentPath)) return;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return;
    const doc = view.state.doc.toString();
    const name = componentNameAt(doc, pos);
    if (!name) return;
    const spec = importedComponentSpec(doc, name);
    if (!spec) return;
    event.preventDefault();
    event.stopPropagation();
    const baseDir = dirname(this.currentPath);
    for (const candidate of componentCandidates(spec)) {
      const resolved = await resolveExistingPath(candidate, baseDir).catch(() => null);
      if (resolved) {
        this.callbacks.onOpenPath?.(resolved);
        return;
      }
    }
    this.callbacks.toast?.(`Component not found: ${name}`, "error");
  }

  /// Edits coming from an editable preview (CSV grid). The preview
  /// hands us the full re-serialized text; dirty tracking + ⌘S save
  /// work exactly like source-mode edits.
  private onPreviewEdit(text: string): void {
    this.liveContent = text;
    const next = text !== (this.originalContent ?? "");
    if (next !== this.dirty) {
      this.dirty = next;
      this.renderStatus();
    }
  }

  private onDocChanged(update: ViewUpdate): void {
    if (!this.view) return;
    this.liveContent = this.view.state.doc.toString();
    const next = this.liveContent !== (this.originalContent ?? "");
    if (next !== this.dirty) {
      this.dirty = next;
      this.renderStatus();
    }
    this.lspDoc?.changeIncremental(update);
  }

  /// Save handler bound to ⌘S in the keymap. Returns `true` to stop
  /// CM6 from also handling the event.
  private handleSave(): boolean {
    void this.save();
    return true;
  }

  /// Right-click menu over the CM6 editor. Source mode only — in
  /// preview mode the browser default applies. Items map straight to
  /// CM6 commands / the clipboard; nothing here needs app-level wiring.
  private showContextMenu(e: MouseEvent): void {
    const view = this.view;
    if (this.viewMode !== "source" || !view) return;
    e.preventDefault();

    const sel = view.state.selection.main;
    const hasSelection = !sel.empty;
    const run = (cmd: (v: EditorView) => boolean) => {
      view.focus();
      cmd(view);
    };

    this.contextMenu.show(e.clientX, e.clientY, [
      {
        label: "Cut",
        shortcut: "⌘X",
        disabled: !hasSelection,
        onClick: () => void this.clipboardCut(),
      },
      {
        label: "Copy",
        shortcut: "⌘C",
        disabled: !hasSelection,
        onClick: () => void this.clipboardCopy(),
      },
      { label: "Paste", shortcut: "⌘V", onClick: () => void this.clipboardPaste() },
      { divider: true },
      { label: "Select All", shortcut: "⌘A", onClick: () => run(selectAll) },
      {
        label: "Change All Occurrences",
        shortcut: "⌘F2",
        disabled: !hasSelection,
        onClick: () => run(selectSelectionMatches),
      },
      { divider: true },
      { label: "Find…", shortcut: "⌘F", onClick: () => run(openSearchPanel) },
    ]);
  }

  private selectedText(): string {
    const view = this.view;
    if (!view) return "";
    const { from, to } = view.state.selection.main;
    return view.state.sliceDoc(from, to);
  }

  private async clipboardCopy(): Promise<void> {
    const text = this.selectedText();
    if (text) await navigator.clipboard.writeText(text).catch(() => {});
  }

  private async clipboardCut(): Promise<void> {
    const view = this.view;
    if (!view) return;
    await this.clipboardCopy();
    const { from, to } = view.state.selection.main;
    if (from !== to) {
      view.dispatch({ changes: { from, to, insert: "" } });
    }
    view.focus();
  }

  private async clipboardPaste(): Promise<void> {
    const view = this.view;
    if (!view) return;
    const text = await navigator.clipboard.readText().catch(() => "");
    if (!text) return;
    const { from, to } = view.state.selection.main;
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
    });
    view.focus();
  }

  isVisible(): boolean {
    return this.visible;
  }

  /// Path of the currently-open file, or null if no file is open.
  /// Used by external listeners (e.g., the file tree) to react when
  /// a rename / trash affects the editor's target.
  getCurrentPath(): string | null {
    return this.currentPath;
  }

  async open(path: string, opts?: { line?: number }): Promise<void> {
    this.subscribeCodeIntel();
    this.currentPath = path;
    this.pathLabelEl.textContent = shortenPath(path);
    this.pathLabelEl.title = path;
    this.setExt(path);
    this.statusEl.textContent = "loading…";
    this.statusEl.classList.remove("dirty");

    // Release the previous file's LSP doc and kick off acquisition for
    // the new one. Non-blocking — file open must NEVER wait on LSP.
    this.teardownLsp();
    void this.setupLsp(path);

    this.show();

    // Binary-only preview kinds (images, spreadsheets) bypass the
    // text-read path entirely. Their preview is the only useful view
    // (no source-mode editing makes sense), so we read raw bytes and
    // hand them straight to the appropriate renderer.
    const kind = previewKindForPath(path);
    if (kind === "png" || kind === "xlsx" || kind === "docx" || kind === "pdf") {
      await this.openBinary(path, kind);
      return;
    }

    let result;
    try {
      result = await structureReadFile(path, SIZE_THRESHOLD_BYTES);
    } catch (err) {
      this.showPlaceholder(`Failed to read: ${err}`);
      return;
    }
    if (result.kind === "too_large") {
      this.showPlaceholder(
        `File too large to preview (${formatBytes(result.size_bytes)}). ` +
          `Edit it in your editor of choice.`,
      );
      return;
    }
    if (result.kind === "binary") {
      this.showPlaceholder("Binary file — not editable here.");
      return;
    }
    const text = result.content ?? "";
    this.originalContent = text;
    this.liveContent = text;
    this.dirty = false;
    this.placeholderEl.hidden = true;

    // Decide initial view mode based on the file's preview kind +
    // user's persisted preference for that extension. Preview is the
    // default for previewable types when the user hasn't picked yet.
    // EXCEPTION: a `line` jump from global search forces source mode —
    // line jumping is meaningless in a rendered preview.
    this.previewKind = previewKindForPath(path);
    const ext = extensionOf(path);
    const prefs = loadViewModePrefs();
    const preferred =
      this.previewKind && ext
        ? (prefs[ext] ?? "preview")
        : "source";
    const initialMode: ViewMode =
      this.previewKind && opts?.line === undefined ? preferred : "source";

    // Tear down any previous CM6 view + Preview before remounting.
    if (this.view) {
      this.view.destroy();
      this.view = null;
    }
    if (this.currentPreview) {
      this.currentPreview.dispose();
      this.currentPreview = null;
    }
    this.previewHostEl.innerHTML = "";

    if (initialMode === "preview") {
      this.enterPreview(text, { focus: false });
    } else {
      this.enterSource(text, { focus: true, jumpToLine: opts?.line });
    }
    this.refreshPreviewButton();
    this.renderStatus();
  }

  // ─── LSP wiring ────────────────────────────────────────

  /// Resolve the LSP status for `path` and either render the
  /// consent/error/unsupported state or start the server. Kicked off
  /// (not awaited) from `open()` so file loads never block on LSP; also
  /// re-run for the CURRENTLY open file whenever code-intelligence
  /// settings change (see `subscribeCodeIntel`'s `onCodeIntelChange`
  /// listener) — that's what makes a live "disable" take effect
  /// immediately instead of on the next file open.
  private async setupLsp(path: string): Promise<void> {
    if (!lspLanguageId(path)) {
      this.teardownLsp();
      this.renderLspState({ kind: "unsupported" });
      return;
    }
    const status = await lspManager.status(path);
    if (this.currentPath !== path) return; // user moved on
    if (status.kind === "ready") {
      if (!this.lspDoc) await this.startLsp(path);
      return; // already active for this path — settings change was a no-op here
    }
    // Any non-ready status (unsupported/consent-needed/error) means LSP
    // must NOT be active for this file — tear down whatever's live.
    this.teardownLsp();
    this.renderLspState(status);
  }

  private async startLsp(path: string): Promise<void> {
    this.renderLspState({ kind: "starting" });
    try {
      const doc = await lspManager.open(path, this.liveContent);
      if (this.currentPath !== path) {
        doc.close();
        return;
      }
      this.lspDoc = doc;
      this.lspDiagUnsub?.();
      this.lspDiagUnsub = doc.onDiagnostics((diags) => {
        if (this.view && this.lspDoc === doc) applyLspDiagnostics(this.view, diags);
      });
      // Upgrade completion to pure LSP now that the doc is live (see
      // `lspCompletion` / `completionCompartment`).
      if (this.view && this.lspHost) {
        this.view.dispatch({ effects: this.completionCompartment.reconfigure(lspCompletion(this.lspHost)) });
      }
      this.renderLspState({ kind: "ready" });
    } catch (e) {
      this.renderLspState({ kind: "error", message: String(e) });
    }
  }

  /// Release the active `lspDoc` (if any) and drop the editor back to
  /// default (non-LSP) completion + clear any squiggles it left behind.
  /// Idempotent — safe to call whether or not LSP was actually active.
  /// Called from `open()`/`close()` (new file / editor teardown) and
  /// from `setupLsp()` whenever a fresh status resolves to non-ready
  /// (Fix 2: disabling code intelligence tears down the OPEN editor
  /// immediately, not just future file opens).
  private teardownLsp(): void {
    if (!this.lspDoc && !this.lspDiagUnsub) return;
    this.lspDoc?.close();
    this.lspDoc = null;
    this.lspDiagUnsub?.();
    this.lspDiagUnsub = null;
    if (this.view) {
      applyLspDiagnostics(this.view, []);
      this.view.dispatch({ effects: this.completionCompartment.reconfigure(defaultCompletion()) });
    }
  }

  private async downloadLspServer(path: string, language: string): Promise<void> {
    await lspManager.grantConsent(language);
    this.lspBannerEl.hidden = true;
    this.renderLspState({ kind: "downloading", percent: 0 });
    try {
      await lspManager.download(language, (percent) => {
        if (this.currentPath === path) this.renderLspState({ kind: "downloading", percent });
      });
      if (this.currentPath === path) await this.startLsp(path);
    } catch (e) {
      if (this.currentPath === path) this.renderLspState({ kind: "error", message: String(e) });
    }
  }

  /// Renders the LSP chip + consent banner for the given status.
  private renderLspState(status: LspDocStatus): void {
    const chip = this.lspChipEl;
    const banner = this.lspBannerEl;
    banner.hidden = true;
    switch (status.kind) {
      case "unsupported":
        chip.hidden = true;
        break;
      case "needs-runtime": {
        chip.hidden = true;
        banner.hidden = false;
        banner.replaceChildren();
        const label = document.createElement("span");
        // status.name is the runtime binary name (e.g. "node") — capitalize
        // for display. Phrasing stays generic (not hardcoded to
        // TypeScript/Node) since future npm-installed servers (C#/Java, P4-P5)
        // reuse this same banner with a different runtime.
        const runtimeName = status.name.charAt(0).toUpperCase() + status.name.slice(1);
        label.textContent =
          `Code intelligence needs ${runtimeName} ≥ ${status.min}` +
          (status.found ? ` (found ${status.found})` : " — not found in your shell PATH");
        const recheck = document.createElement("button");
        recheck.type = "button";
        recheck.textContent = "Recheck";
        recheck.addEventListener("click", () => {
          const path = this.currentPath;
          if (path) void this.setupLsp(path);
        });
        banner.append(label, recheck);
        break;
      }
      case "consent-needed": {
        chip.hidden = true;
        banner.hidden = false;
        banner.replaceChildren();
        const label = document.createElement("span");
        label.textContent = `Download ${status.name} (~${status.approxSizeMb} MB) to enable code intelligence?`;
        const yes = document.createElement("button");
        yes.type = "button";
        yes.textContent = "Download";
        yes.addEventListener("click", () => {
          const path = this.currentPath;
          const language = path ? lspLanguageId(path) : null;
          if (path && language) void this.downloadLspServer(path, language);
        });
        const no = document.createElement("button");
        no.type = "button";
        no.textContent = "Not now";
        no.addEventListener("click", () => {
          banner.hidden = true;
        });
        banner.append(label, yes, no);
        break;
      }
      case "downloading":
        chip.hidden = false;
        chip.textContent = status.percent === null ? "LSP: downloading…" : `LSP: ${status.percent}%`;
        chip.dataset.state = "busy";
        break;
      case "starting":
        chip.hidden = false;
        chip.textContent = "LSP: starting…";
        chip.dataset.state = "busy";
        break;
      case "ready":
        chip.hidden = false;
        chip.textContent = "LSP";
        chip.dataset.state = "ready";
        break;
      case "error":
        chip.hidden = false;
        chip.textContent = "LSP: error";
        chip.dataset.state = "error";
        console.warn("[lsp]", status.message);
        break;
    }
  }

  /// Mount CM6 with `text` as the initial doc. Used both for fresh
  /// file opens and for toggling preview→source.
  private enterSource(
    text: string,
    opts: { focus: boolean; jumpToLine?: number },
  ): void {
    this.viewMode = "source";
    this.previewHostEl.hidden = true;
    this.editorHostEl.hidden = false;
    if (this.findOpen) this.closeFind();
    if (this.currentPreview) {
      this.currentPreview.dispose();
      this.currentPreview = null;
    }
    if (!this.currentPath) return;
    const state = this.buildState(this.currentPath, text);
    this.view = new EditorView({
      state,
      parent: this.editorHostEl,
    });
    this.installSearchPanelTweaks();
    requestAnimationFrame(() => {
      if (!this.view) return;
      if (opts.focus) this.view.focus();
      if (opts.jumpToLine !== undefined) this.jumpToLine(opts.jumpToLine);
    });
  }

  /// CM6 renders the search panel into the editor DOM lazily on first
  /// ⌘F. We can't reach those inputs at mount time, so a MutationObserver
  /// watches the editor host for the panel and (a) disables iOS/macOS
  /// autocapitalize / autocorrect / spellcheck on the find/replace
  /// inputs (capital "L" suggestions while typing "lang" were ugly) and
  /// (b) swaps the close button's `×` glyph for the same lucide-X icon
  /// the editor header uses, so the affordance looks consistent.
  private installSearchPanelTweaks(): void {
    const host = this.editorHostEl;
    const apply = (panel: Element) => {
      panel.querySelectorAll<HTMLInputElement>("input.cm-textfield").forEach(
        (inp) => {
          inp.setAttribute("autocapitalize", "off");
          inp.setAttribute("autocorrect", "off");
          inp.setAttribute("autocomplete", "off");
          inp.setAttribute("spellcheck", "false");
        },
      );
      const closeBtn = panel.querySelector<HTMLButtonElement>(
        'button[name="close"]',
      );
      if (closeBtn && !closeBtn.dataset.iconified) {
        closeBtn.innerHTML = Icons.x({ size: 12 });
        closeBtn.dataset.iconified = "1";
        closeBtn.classList.add("cm-search-close");
      }
    };
    // Apply now if the panel already exists (e.g. survived a state swap).
    host.querySelectorAll(".cm-panel.cm-search").forEach(apply);
    const obs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach((n) => {
          if (!(n instanceof HTMLElement)) return;
          if (n.matches?.(".cm-panel.cm-search")) apply(n);
          n.querySelectorAll?.(".cm-panel.cm-search").forEach(apply);
        });
      }
    });
    obs.observe(host, { childList: true, subtree: true });
    // Stash so the next view rebuild can disconnect (we don't keep the
    // ref otherwise; the new EditorView replaces the host's children).
    (this.editorHostEl as unknown as { __searchObs?: MutationObserver }).__searchObs?.disconnect();
    (this.editorHostEl as unknown as { __searchObs?: MutationObserver }).__searchObs = obs;
  }

  /// Mount the preview renderer for the current `previewKind` with
  /// `text` as content. `text` may be the original disk content OR
  /// the user's edits-in-flight when toggling source→preview.
  private enterPreview(text: string, opts: { focus: boolean }): void {
    if (!this.previewKind) return;
    this.viewMode = "preview";
    this.editorHostEl.hidden = true;
    this.previewHostEl.hidden = false;
    if (this.view) {
      this.view.destroy();
      this.view = null;
    }
    this.currentPreview = makePreview(this.previewKind);
    this.currentPreview.mount(this.previewHostEl, text, {
      path: this.currentPath,
      onEdit: (t) => this.onPreviewEdit(t),
    });
    if (this.findOpen) this.recomputeMatches();
    if (opts.focus) {
      // Preview is read-only but should be focusable for ⌘⇧P / Esc.
      this.previewHostEl.tabIndex = -1;
      this.previewHostEl.focus({ preventScroll: true });
    }
  }

  /// Binary-only open path: read bytes, hand to the appropriate preview
  /// renderer (PngPreview for images, XlsxPreview for spreadsheets).
  /// No source mode at all. Toggling source/preview is disabled for
  /// these kinds.
  private async openBinary(
    path: string,
    kind: "png" | "xlsx" | "docx" | "pdf",
  ): Promise<void> {
    let result;
    try {
      // PDFs comfortably exceed the 10 MiB default — bump to 50 MiB to
      // match `PdfPreview`'s own ceiling. Other kinds keep the default.
      const maxBytes = kind === "pdf" ? 50 * 1024 * 1024 : undefined;
      result = await structureReadBinaryFile(path, maxBytes);
    } catch (err) {
      this.showPlaceholder(`Failed to read file: ${err}`);
      return;
    }
    if (result.kind === "too_large") {
      this.showPlaceholder(
        `File too large to preview (${formatBytes(result.size_bytes)}).`,
      );
      return;
    }

    if (this.view) {
      this.view.destroy();
      this.view = null;
    }
    if (this.currentPreview) {
      this.currentPreview.dispose();
      this.currentPreview = null;
    }
    this.previewHostEl.innerHTML = "";

    this.previewKind = kind;
    this.viewMode = "preview";
    this.editorHostEl.hidden = true;
    this.previewHostEl.hidden = false;
    this.placeholderEl.hidden = true;
    this.originalContent = null;
    this.liveContent = "";
    this.dirty = false;

    this.currentPreview = makePreview(kind);
    this.currentPreview.mount(this.previewHostEl, JSON.stringify(result.bytes));

    this.refreshPreviewButton();
    this.renderStatus();
  }

  /// Flip between Preview and Source for the current file. No-op when
  /// `previewKind` is null (button is hidden, so the only way in is
  /// the keyboard shortcut firing on a non-previewable file). Images
  /// have no source view so we no-op for them too.
  private toggleViewMode(): void {
    if (
      this.previewKind === "png" ||
      this.previewKind === "xlsx" ||
      this.previewKind === "docx" ||
      this.previewKind === "pdf"
    )
      return;
    if (!this.previewKind || !this.currentPath) return;

    // Commit any in-flight editable-preview cell edit before snapshotting.
    if (this.viewMode === "preview") {
      const active = document.activeElement;
      if (active instanceof HTMLElement && this.previewHostEl.contains(active)) {
        active.blur();
      }
    }

    // Snapshot the latest text before swapping. In source mode we read
    // from CM6's doc (could be dirty); in preview mode liveContent
    // already holds the most recent edit.
    const text =
      this.viewMode === "source" && this.view
        ? this.view.state.doc.toString()
        : this.liveContent;
    this.liveContent = text;

    if (this.viewMode === "source") {
      this.enterPreview(text, { focus: true });
    } else {
      this.enterSource(text, { focus: true });
    }

    // Persist the choice for this extension so the next file with
    // the same extension opens straight into the user's preferred mode.
    const ext = extensionOf(this.currentPath);
    if (ext) {
      const prefs = loadViewModePrefs();
      prefs[ext] = this.viewMode;
      saveViewModePrefs(prefs);
    }

    this.refreshPreviewButton();
  }

  private refreshPreviewButton(): void {
    if (
      !this.previewKind ||
      this.previewKind === "png" ||
      this.previewKind === "xlsx" ||
      this.previewKind === "docx" ||
      this.previewKind === "pdf"
    ) {
      this.previewBtn.hidden = true;
    } else {
      this.previewBtn.hidden = false;
      const inPreview = this.viewMode === "preview";
      this.previewBtn.textContent = inPreview ? "source" : "preview";
      this.previewBtn.title = inPreview
        ? "Show source (⌘⇧P)"
        : "Show preview (⌘⇧P)";
    }

    // PNG controls — visible only for SVG files, regardless of
    // source/preview view mode.
    const isSvg = this.previewKind === "svg";
    this.pngBtn.hidden = !isSvg;
    this.pngScaleSelect.element.hidden = !isSvg;

    this.applySpecBtn.hidden =
      !this.callbacks.onApplySpec || !isSpecPath(this.currentPath);
  }

  /// Rasterize the open SVG to <basename>.png next to the source.
  /// Uses the live in-memory text so unsaved edits are reflected.
  /// Overwrites the destination without prompting (the spec calls
  /// this out — re-export to update is the common case). Disables
  /// the button during the async work so a frantic double-click
  /// can't fire two writes against the same file.
  private async handleExportPng(): Promise<void> {
    if (!this.currentPath) return;
    if (this.previewKind !== "svg") return;

    const svgText = this.getCurrentSvgText();
    const outPath = pngPathFor(this.currentPath);

    this.pngBtn.disabled = true;
    try {
      const result = await svgToPng(svgText, this.pngScale);
      await structureWriteBinaryFile(outPath, result.bytes);
      const baseName = outPath.split("/").pop() ?? outPath;
      this.callbacks.toast?.(
        `Exported ${baseName} (${this.pngScale}x, ${result.width}×${result.height})`,
        "info",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.callbacks.toast?.(`PNG export failed: ${msg}`, "error");
    } finally {
      this.pngBtn.disabled = false;
    }
  }

  /// Return the current SVG text — CM6 doc when in source mode,
  /// `liveContent` (last edit snapshot) when in preview mode.
  private getCurrentSvgText(): string {
    return this.viewMode === "source" && this.view
      ? this.view.state.doc.toString()
      : this.liveContent;
  }

  /// Move caret + scroll to `line` (1-based) in the active doc. Used
  /// by global content search "click to open" and intentional jumps
  /// from elsewhere in the app.
  private jumpToLine(line: number): void {
    if (!this.view) return;
    const doc = this.view.state.doc;
    const target = Math.max(1, Math.min(line, doc.lines));
    const lineInfo = doc.line(target);
    this.view.dispatch({
      selection: { anchor: lineInfo.from, head: lineInfo.to },
      effects: EditorView.scrollIntoView(lineInfo.from, { y: "center" }),
    });
  }

  async save(): Promise<void> {
    if (!this.currentPath) return;
    if (!this.dirty) return;
    // In preview mode the file isn't directly editable, but we may
    // have buffered edits from a prior source toggle in `liveContent`.
    // Either way liveContent is the source of truth for "what the user
    // would save right now".
    const text =
      this.viewMode === "source" && this.view
        ? this.view.state.doc.toString()
        : this.liveContent;
    try {
      await structureWriteFile(this.currentPath, text);
      // ponytail: flush a didChange instead of wiring a real didSave
      // notification — rust-analyzer treats them equivalently for
      // freshness purposes, and a dedicated didSave is P2 polish.
      this.lspDoc?.client.didChange(this.lspDoc.uri, [{ text }]);
      this.originalContent = text;
      this.liveContent = text;
      this.dirty = false;
      this.renderStatus();
      this.callbacks.toast?.("Saved", "info");
      this.callbacks.onSave?.(this.currentPath);
    } catch (err) {
      this.callbacks.toast?.(`Save failed: ${err}`, "error");
    }
  }

  show(): void {
    if (this.visible) return;
    this.visible = true;
    this.root.hidden = false;
    this.host.classList.add("structure-editor-open");
    // Replay the entry animation on every fresh show. We remove the
    // class first and force a reflow so re-adding it actually
    // retriggers the keyframes (otherwise the class is already there
    // from a prior open and nothing happens).
    this.root.classList.remove("structure-editor-entering");
    void this.root.offsetWidth;
    this.root.classList.add("structure-editor-entering");
    const onEnd = () => {
      this.root.classList.remove("structure-editor-entering");
      this.root.removeEventListener("animationend", onEnd);
    };
    this.root.addEventListener("animationend", onEnd);
  }

  close(): void {
    if (!this.visible) return;
    if (this.dirty) {
      const ok = window.confirm("Discard unsaved changes?");
      if (!ok) return;
    }
    this.visible = false;
    this.root.hidden = true;
    this.host.classList.remove("structure-editor-open");
    this.currentPath = null;
    this.originalContent = null;
    this.liveContent = "";
    this.dirty = false;
    this.previewKind = null;
    this.teardownLsp();
    this.codeIntelUnsub?.();
    this.codeIntelUnsub = null;
    this.renderLspState({ kind: "unsupported" });
    if (this.view) {
      this.view.destroy();
      this.view = null;
    }
    if (this.currentPreview) {
      this.currentPreview.dispose();
      this.currentPreview = null;
    }
    this.previewBtn.hidden = true;
    this.pngBtn.hidden = true;
    this.pngScaleSelect.element.hidden = true;
    if (this.findOpen) this.closeFind();
    this.contextMenu.dismiss();
    this.callbacks.onClose?.();
  }

  private showPlaceholder(message: string): void {
    if (this.view) {
      this.view.destroy();
      this.view = null;
    }
    if (this.currentPreview) {
      this.currentPreview.dispose();
      this.currentPreview = null;
    }
    this.editorHostEl.hidden = true;
    this.previewHostEl.hidden = true;
    this.previewKind = null;
    this.previewBtn.hidden = true;
    this.pngBtn.hidden = true;
    this.pngScaleSelect.element.hidden = true;
    this.placeholderEl.hidden = false;
    this.placeholderEl.textContent = message;
    this.originalContent = null;
    this.liveContent = "";
    this.dirty = false;
    this.statusEl.textContent = "";
    this.statusEl.classList.remove("dirty");
  }

  /// `●` when modified, empty when clean. Tooltip carries the full
  /// "press ⌘S to save" hint so the affordance isn't lost.
  private renderStatus(): void {
    if (this.dirty) {
      this.statusEl.textContent = "●";
      this.statusEl.title = "Unsaved changes — ⌘S to save";
      this.statusEl.classList.add("dirty");
    } else {
      this.statusEl.textContent = "";
      this.statusEl.title = "";
      this.statusEl.classList.remove("dirty");
    }
  }

  private setExt(path: string): void {
    const ext = extensionOf(path);
    if (!ext) {
      this.extEl.hidden = true;
      this.extEl.textContent = "";
      return;
    }
    this.extEl.hidden = false;
    this.extEl.textContent = ext;
  }
}

function makePreview(kind: PreviewKind): Preview {
  switch (kind) {
    case "markdown":
      return new MarkdownPreview();
    case "html":
      return new HtmlPreview();
    case "svg":
      return new SvgPreview();
    case "png":
      return new PngPreview();
    case "csv":
      return new CsvPreview();
    case "xlsx":
      return new XlsxPreview();
    case "docx":
      return new DocxPreview();
    case "pdf":
      return new PdfPreview();
  }
}

function shortenPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 3) return p;
  return ".../" + parts.slice(-3).join("/");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

function componentNameAt(doc: string, pos: number): string | null {
  const left = doc.slice(Math.max(0, pos - 80), pos);
  const right = doc.slice(pos, Math.min(doc.length, pos + 80));
  const around = left + right;
  const offset = left.length;
  for (const m of around.matchAll(/<\/?([A-Z][A-Za-z0-9_$]*)\b/g)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (offset >= start && offset <= end) return m[1];
  }
  return null;
}

function importedComponentSpec(doc: string, name: string): string | null {
  const re = new RegExp(`import\\s+${escapeRegExp(name)}\\s+from\\s+["']([^"']+)["']`, "m");
  return re.exec(doc)?.[1] ?? null;
}

function componentCandidates(spec: string): string[] {
  if (/\.[A-Za-z0-9]+$/.test(spec)) return [spec];
  return [
    spec,
    `${spec}.astro`,
    `${spec}.tsx`,
    `${spec}.jsx`,
    `${spec}.ts`,
    `${spec}.js`,
    `${spec}/index.astro`,
    `${spec}/index.tsx`,
    `${spec}/index.jsx`,
  ];
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i) : ".";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extensionOf(path: string): string | null {
  const base = path.split("/").pop() ?? "";
  // Dotfiles without an extension (e.g. `.gitignore`) — show "dot".
  if (base.startsWith(".") && !base.slice(1).includes(".")) {
    return base.slice(1).toLowerCase().slice(0, 8) || null;
  }
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  if (!ext || ext.length > 8) return null;
  return ext;
}

/// Map `foo/bar.svg` → `foo/bar.png`. Always replaces the final
/// extension; for files without a dot we just append `.png`.
function pngPathFor(svgPath: string): string {
  const slash = svgPath.lastIndexOf("/");
  const base = slash >= 0 ? svgPath.slice(slash + 1) : svgPath;
  const dir = slash >= 0 ? svgPath.slice(0, slash + 1) : "";
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return `${dir}${stem}.png`;
}
