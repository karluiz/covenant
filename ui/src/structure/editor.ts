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

import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  rectangularSelection,
  crosshairCursor,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
} from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";

import { Icons } from "../icons";
import {
  structureReadBinaryFile,
  structureReadFile,
  structureWriteBinaryFile,
  structureWriteFile,
} from "../api";
import { languageForPath } from "./languages";
import {
  MarkdownPreview,
  PngPreview,
  type Preview,
  type PreviewKind,
  previewKindForPath,
  SvgPreview,
} from "./preview";
import {
  loadSvgScale,
  type PngScale,
  saveSvgScale,
  svgToPng,
} from "./png-export";
import { editorHighlight, editorTheme } from "./theme";

export interface EditorCallbacks {
  onSave?: (path: string) => void;
  onClose?: () => void;
  toast?: (message: string, severity?: "info" | "error") => void;
}

const SIZE_THRESHOLD_BYTES = 1024 * 1024; // 1 MiB per spec.

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

  /// Preview state. `previewKind` is null when the open file has no
  /// preview available (the toggle hides). `currentPreview` holds the
  /// active renderer when `viewMode === "preview"`, null otherwise.
  /// `previewHostEl` is permanent so we don't churn DOM nodes on toggle.
  private viewMode: ViewMode = "source";
  private previewKind: PreviewKind | null = null;
  private currentPreview: Preview | null = null;
  private readonly previewHostEl: HTMLElement;
  private readonly previewBtn: HTMLButtonElement;

  /// PNG export controls — sibling pair to `previewBtn`. Only shown
  /// when `previewKind === "svg"`; hidden for markdown/code so the
  /// header stays uncluttered.
  private readonly pngBtn: HTMLButtonElement;
  private readonly pngScaleSelect: HTMLSelectElement;
  private pngScale: PngScale = 2;

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

    // Scale dropdown — sits left of the PNG button. Persisted choice
    // applies across restarts; default 2× covers the retina case.
    this.pngScale = loadSvgScale();
    this.pngScaleSelect = document.createElement("select");
    this.pngScaleSelect.className = "structure-editor-png-scale";
    this.pngScaleSelect.title = "PNG export scale";
    this.pngScaleSelect.hidden = true;
    for (const s of [1, 2, 3] as const) {
      const opt = document.createElement("option");
      opt.value = String(s);
      opt.textContent = `${s}x`;
      if (s === this.pngScale) opt.selected = true;
      this.pngScaleSelect.appendChild(opt);
    }
    this.pngScaleSelect.addEventListener("change", () => {
      const v = Number(this.pngScaleSelect.value);
      if (v === 1 || v === 2 || v === 3) {
        this.pngScale = v;
        saveSvgScale(v);
      }
    });
    this.headerEl.appendChild(this.pngScaleSelect);

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

    this.host.appendChild(this.root);
  }

  /// Build a fresh EditorState for `text` with the language matching
  /// `path` (null → no language, plain editing). Reusable on every
  /// file open: CM6 is fastest when the state is constructed once
  /// per document instead of mutated piecemeal.
  private buildState(path: string, text: string): EditorState {
    const lang = languageForPath(path);
    const langExtension = lang ? [lang] : [];

    return EditorState.create({
      doc: text,
      extensions: [
        // Chrome.
        editorTheme,
        editorHighlight,
        lineNumbers(),
        foldGutter(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        drawSelection(),
        rectangularSelection(),
        crosshairCursor(),
        highlightSelectionMatches(),

        // Editing.
        history(),
        bracketMatching(),
        indentOnInput(),
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
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...defaultKeymap,
          indentWithTab,
        ]),

        // Track dirty state. Cheaper than diffing the whole doc — the
        // listener fires only when the document actually changes.
        EditorView.updateListener.of((u) => {
          if (u.docChanged) this.onDocChanged();
        }),
      ],
    });
  }

  private onDocChanged(): void {
    if (!this.view) return;
    this.liveContent = this.view.state.doc.toString();
    const next = this.liveContent !== (this.originalContent ?? "");
    if (next !== this.dirty) {
      this.dirty = next;
      this.renderStatus();
    }
  }

  /// Save handler bound to ⌘S in the keymap. Returns `true` to stop
  /// CM6 from also handling the event.
  private handleSave(): boolean {
    void this.save();
    return true;
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
    this.currentPath = path;
    this.pathLabelEl.textContent = shortenPath(path);
    this.pathLabelEl.title = path;
    this.setExt(path);
    this.statusEl.textContent = "loading…";
    this.statusEl.classList.remove("dirty");

    this.show();

    // Image-class files bypass the text-read path entirely. Their
    // preview is the only useful view (no source-mode editing makes
    // sense), so we read raw bytes and hand them straight to the
    // PngPreview renderer.
    if (previewKindForPath(path) === "png") {
      await this.openImage(path);
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

  /// Mount CM6 with `text` as the initial doc. Used both for fresh
  /// file opens and for toggling preview→source.
  private enterSource(
    text: string,
    opts: { focus: boolean; jumpToLine?: number },
  ): void {
    this.viewMode = "source";
    this.previewHostEl.hidden = true;
    this.editorHostEl.hidden = false;
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
    requestAnimationFrame(() => {
      if (!this.view) return;
      if (opts.focus) this.view.focus();
      if (opts.jumpToLine !== undefined) this.jumpToLine(opts.jumpToLine);
    });
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
    this.currentPreview.mount(this.previewHostEl, text);
    if (opts.focus) {
      // Preview is read-only but should be focusable for ⌘⇧P / Esc.
      this.previewHostEl.tabIndex = -1;
      this.previewHostEl.focus({ preventScroll: true });
    }
  }

  /// Image-only open path: read bytes, hand to PngPreview, no source
  /// mode at all. Toggling source/preview is disabled for this kind.
  private async openImage(path: string): Promise<void> {
    let result;
    try {
      result = await structureReadBinaryFile(path);
    } catch (err) {
      this.showPlaceholder(`Failed to read image: ${err}`);
      return;
    }
    if (result.kind === "too_large") {
      this.showPlaceholder(
        `Image too large to preview (${formatBytes(result.size_bytes)}).`,
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

    this.previewKind = "png";
    this.viewMode = "preview";
    this.editorHostEl.hidden = true;
    this.previewHostEl.hidden = false;
    this.placeholderEl.hidden = true;
    this.originalContent = null;
    this.liveContent = "";
    this.dirty = false;

    this.currentPreview = makePreview("png");
    // PngPreview consumes the JSON-stringified byte array via its
    // `content` param — keeping the Preview interface uniform across
    // text and image kinds.
    this.currentPreview.mount(
      this.previewHostEl,
      JSON.stringify(result.bytes),
    );

    this.refreshPreviewButton();
    this.renderStatus();
  }

  /// Flip between Preview and Source for the current file. No-op when
  /// `previewKind` is null (button is hidden, so the only way in is
  /// the keyboard shortcut firing on a non-previewable file). Images
  /// have no source view so we no-op for them too.
  private toggleViewMode(): void {
    if (this.previewKind === "png") return;
    if (!this.previewKind || !this.currentPath) return;

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
    if (!this.previewKind) {
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
    this.pngScaleSelect.hidden = !isSvg;
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
    this.pngScaleSelect.hidden = true;
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
    this.pngScaleSelect.hidden = true;
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
    case "svg":
      return new SvgPreview();
    case "png":
      return new PngPreview();
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
