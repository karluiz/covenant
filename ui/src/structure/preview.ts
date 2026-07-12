// Per-file-type preview renderers for the StructureEditor.
//
// Each Preview takes a host element + content string and renders a
// read-only view of the file. The editor swaps between an EditorView
// (Source) and one of these (Preview) via a header toggle. Previews
// don't own dirty state — that lives on the StructureEditor; they
// just paint.
//
// Adding a new preview kind:
//   1. Implement Preview.
//   2. Add a branch in `previewKindForPath`.
//   3. Add a factory call in StructureEditor.

import { renderMarkdown } from "../ui/markdown";
import { htmlPreviewSrcdoc } from "./brainstorm-frame";

export type PreviewKind =
  | "markdown"
  | "svg"
  | "png"
  | "html"
  | "csv"
  | "xlsx"
  | "docx"
  | "pdf";

/// Optional context passed alongside content. Most previews ignore it;
/// HtmlPreview uses `path` to detect superpowers brainstorm fragments
/// (body-only screens) and wrap them in the brainstorm frame template so
/// their design renders, rather than painting a bare unstyled fragment.
/// CsvPreview uses `onEdit` to push cell edits back into the editor's
/// dirty-tracking (the preview itself never touches disk).
export interface PreviewCtx {
  path?: string | null;
  onEdit?: (text: string) => void;
}

export interface Preview {
  /// Mount + render. The implementation OWNS `host.innerHTML` for
  /// the duration; StructureEditor calls `dispose()` before reuse.
  mount(host: HTMLElement, content: string, ctx?: PreviewCtx): void;
  /// Re-render with new content (used when the user edits in source
  /// and toggles back to preview). Default impl is mount-from-scratch.
  update(host: HTMLElement, content: string, ctx?: PreviewCtx): void;
  /// Tear down any listeners / DOM state. Idempotent.
  dispose(): void;
}

/// Decide whether a given file path has a preview available. Returns
/// the kind, or null when the file is plain "source-only".
export function previewKindForPath(path: string): PreviewKind | null {
  const base = path.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  if (ext === "md" || ext === "markdown" || ext === "mdx") return "markdown";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "svg") return "svg";
  if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "gif" || ext === "webp") {
    return "png";
  }
  if (ext === "csv" || ext === "tsv") return "csv";
  if (ext === "xlsx" || ext === "xls" || ext === "xlsm" || ext === "ods") {
    return "xlsx";
  }
  if (ext === "docx") return "docx";
  if (ext === "pdf") return "pdf";
  return null;
}

// ─── Markdown ──────────────────────────────────────────

export class MarkdownPreview implements Preview {
  mount(host: HTMLElement, content: string): void {
    host.innerHTML = `<div class="structure-preview-md markdown-body">${renderMarkdown(content)}</div>`;
  }
  update(host: HTMLElement, content: string): void {
    this.mount(host, content);
  }
  dispose(): void {
    /* no listeners to clean up */
  }
}

// ─── SVG ───────────────────────────────────────────────

/// SVG renderer that parses with `DOMParser` instead of dropping the
/// raw markup via `innerHTML`. The DOMParser path doesn't execute
/// any `<script>` elements that might be embedded — we trust local
/// files but the cost of safety is essentially zero so we take it.
export class SvgPreview implements Preview {
  mount(host: HTMLElement, content: string): void {
    host.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "structure-preview-svg";

    const parsed = new DOMParser().parseFromString(content, "image/svg+xml");
    const errEl = parsed.querySelector("parsererror");
    const root = parsed.documentElement;

    if (errEl || !root || root.nodeName.toLowerCase() !== "svg") {
      // Malformed SVG — show the raw text + the parser's complaint
      // so the user can spot the problem and toggle to Source to fix.
      const msg = errEl?.textContent?.trim() ?? "Not a valid SVG document";
      wrap.innerHTML = `
        <div class="structure-preview-error">
          <strong>SVG parse failed.</strong> Toggle to <em>Source</em> to inspect.
          <pre>${escapeHtml(msg)}</pre>
        </div>
      `;
      host.appendChild(wrap);
      return;
    }

    // Strip any <script> children defensively. DOMParser yields a
    // disconnected document, so script tags inside it haven't run —
    // but once we adopt the node into our live DOM, browsers WILL
    // fetch external `xlink:href` stylesheets etc. Removing scripts
    // closes the obvious foot-gun.
    parsed.querySelectorAll("script").forEach((s) => s.remove());

    // Make sure the SVG scales sensibly inside the pane regardless
    // of its declared dimensions. Authors often hard-code width/height
    // in pixels; we let CSS take over via max-width and the viewBox.
    const svgEl = document.adoptNode(root) as unknown as SVGElement;
    svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svgEl.style.maxWidth = "100%";
    svgEl.style.maxHeight = "100%";
    svgEl.style.height = "auto";

    wrap.appendChild(svgEl);
    host.appendChild(wrap);
  }
  update(host: HTMLElement, content: string): void {
    this.mount(host, content);
  }
  dispose(): void {
    /* no listeners */
  }
}

// ─── HTML ──────────────────────────────────────────────

/// Renders the HTML document inside a sandboxed iframe via `srcdoc`.
/// The sandbox allows scripts and same-origin so Tailwind CDN, Google
/// Fonts, FontAwesome, and inline `<script>` blocks behave like a real
/// browser open — but the iframe can't navigate the parent or touch
/// our app's storage. Network is permitted for CDN assets.
///
/// Superpowers brainstorm screens are body-only fragments whose design
/// lives in the brainstorm server's frame template. We can't fetch a
/// per-file wrapped page from that server (it only wraps the newest screen
/// at `/` and 404s on `/<file>.html` — a stale URL there used to swap the
/// iframe to a blank "Not found" page), so `htmlPreviewSrcdoc` wraps such
/// fragments locally with a vendored copy of that template. Everything stays
/// in srcdoc — no cross-origin probe, no blank-on-404 failure mode.
export class HtmlPreview implements Preview {
  private iframeEl: HTMLIFrameElement | null = null;

  mount(host: HTMLElement, content: string, ctx?: PreviewCtx): void {
    host.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "structure-preview-html";

    const iframe = document.createElement("iframe");
    iframe.className = "structure-preview-html-frame";
    // allow-scripts + allow-same-origin: CDN scripts (Tailwind JIT,
    // FontAwesome) need both. allow-popups/forms intentionally OFF —
    // a preview shouldn't open windows or POST anywhere.
    iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.srcdoc = htmlPreviewSrcdoc(content, ctx?.path ?? null);
    iframe.style.width = "100%";
    iframe.style.height = "100%";
    iframe.style.border = "0";
    iframe.style.background = "#fff";

    wrap.appendChild(iframe);
    host.appendChild(wrap);
    this.iframeEl = iframe;
  }
  update(host: HTMLElement, content: string, ctx?: PreviewCtx): void {
    // Recompute srcdoc from the current content + path (the wrapping
    // decision depends on the path). Reusing the iframe avoids a reload
    // flash when nothing changed.
    const next = htmlPreviewSrcdoc(content, ctx?.path ?? null);
    if (this.iframeEl) {
      if (this.iframeEl.srcdoc !== next) this.iframeEl.srcdoc = next;
      return;
    }
    this.mount(host, content, ctx);
  }
  dispose(): void {
    this.iframeEl = null;
  }
}

// ─── Raster image (PNG / JPG / GIF / WebP) ─────────────

/// Renders a raster image from raw bytes via a transient object URL.
/// Despite the kind name "png", this is reused for jpg/gif/webp —
/// the browser sniffs the actual format from the bytes. Disposes the
/// object URL on `dispose()` so we don't leak the blob through repeated
/// file opens.
export class PngPreview implements Preview {
  private currentUrl: string | null = null;

  /// Mounts an `<img>` with bytes converted to an object URL. The
  /// `content` param here is the JSON-array string of bytes (the
  /// IPC layer hands us `number[]`); we Uint8Array-ify it before
  /// blobbing.
  mount(host: HTMLElement, content: string): void {
    this.dispose();
    host.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "structure-preview-png";

    let bytes: Uint8Array;
    try {
      const arr = JSON.parse(content);
      if (!Array.isArray(arr)) throw new Error("not an array");
      bytes = Uint8Array.from(arr);
    } catch (err) {
      wrap.innerHTML = `
        <div class="structure-preview-error">
          <strong>Image data invalid.</strong>
          <pre>${escapeHtml(String(err))}</pre>
        </div>
      `;
      host.appendChild(wrap);
      return;
    }

    const blob = new Blob([bytes as BlobPart]);
    this.currentUrl = URL.createObjectURL(blob);

    const img = document.createElement("img");
    img.src = this.currentUrl;
    img.style.maxWidth = "100%";
    img.style.maxHeight = "100%";
    img.style.objectFit = "contain";
    img.style.display = "block";
    img.style.margin = "0 auto";
    img.alt = "Image preview";
    wrap.appendChild(img);
    host.appendChild(wrap);
  }

  update(host: HTMLElement, content: string): void {
    this.mount(host, content);
  }

  dispose(): void {
    if (this.currentUrl) {
      URL.revokeObjectURL(this.currentUrl);
      this.currentUrl = null;
    }
  }
}

// ─── CSV / TSV ─────────────────────────────────────────

// NOT SheetJS on purpose: an *editable* view must round-trip untouched
// cells byte-faithfully, and SheetJS parses to typed values ("3e-06"
// becomes 0.000003, big ints lose precision). Cells stay raw strings.

/// RFC 4180-ish parser: quoted fields, escaped quotes (""), embedded
/// delimiters/newlines inside quotes, LF / CRLF / bare-CR row breaks.
/// A trailing newline does not produce a phantom empty row.
export function parseCsv(text: string, delim = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  const endCell = () => {
    row.push(cell);
    cell = "";
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"' && cell === "") {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === delim) {
      endCell();
      i++;
      continue;
    }
    if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
      i++;
      continue;
    }
    if (ch === "\n") {
      endRow();
      i++;
      continue;
    }
    cell += ch;
    i++;
  }
  if (cell !== "" || row.length > 0) endRow();
  return rows;
}

/// Minimal-quoting serializer: a cell is quoted only when it contains
/// the delimiter, a quote, or a newline. Unnecessary quotes present in
/// the original file are normalized away — values are preserved exactly.
export function serializeCsv(
  rows: string[][],
  opts: { delim?: string; eol?: string } = {},
): string {
  const delim = opts.delim ?? ",";
  const eol = opts.eol ?? "\n";
  const esc = (s: string) =>
    s.includes(delim) || s.includes('"') || s.includes("\n") || s.includes("\r")
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  return rows.map((r) => r.map(esc).join(delim)).join(eol);
}

const CSV_MAX_RENDER_ROWS = 500;

/// Editable spreadsheet-style view over a CSV/TSV file. Renders the
/// same table chrome as XlsxPreview; every cell is contentEditable.
/// A committed cell edit (blur / Enter) re-serializes the FULL matrix
/// — including rows beyond the render cap — and reports the new text
/// via `ctx.onEdit`; the StructureEditor owns dirty state and ⌘S.
export class CsvPreview implements Preview {
  private rows: string[][] = [];
  private delim = ",";
  private eol = "\n";
  private trailingEol = false;
  private onEdit: ((text: string) => void) | null = null;

  mount(host: HTMLElement, content: string, ctx?: PreviewCtx): void {
    this.onEdit = ctx?.onEdit ?? null;
    this.delim = (ctx?.path ?? "").toLowerCase().endsWith(".tsv") ? "\t" : ",";
    this.eol = content.includes("\r\n") ? "\r\n" : "\n";
    this.trailingEol = /\r?\n$/.test(content);
    this.rows = parseCsv(content, this.delim);

    host.innerHTML = "";
    const root = document.createElement("div");
    root.className = "structure-preview-csv structure-preview-xlsx";
    const grid = document.createElement("div");
    grid.className = "structure-preview-xlsx-grid";
    const table = document.createElement("table");
    table.className = "structure-preview-xlsx-table structure-preview-csv-table";
    const tbody = document.createElement("tbody");

    const maxCols = this.rows.reduce((m, r) => Math.max(m, r.length), 0);
    const limit = Math.min(this.rows.length, CSV_MAX_RENDER_ROWS);
    for (let r = 0; r < limit; r++) {
      const tr = document.createElement("tr");
      for (let c = 0; c < maxCols; c++) {
        const cell = document.createElement(r === 0 ? "th" : "td");
        // plaintext-only is a WebKit original — rich paste degrades to text.
        cell.setAttribute("contenteditable", "plaintext-only");
        cell.dataset.r = String(r);
        cell.dataset.c = String(c);
        cell.textContent = this.rows[r][c] ?? "";
        tr.appendChild(cell);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    grid.appendChild(table);
    root.appendChild(grid);
    if (this.rows.length > limit) {
      const more = document.createElement("div");
      more.className = "structure-preview-xlsx-more";
      more.textContent = `… ${this.rows.length - limit} more rows not shown (edits still save the full file)`;
      grid.appendChild(more);
    }
    host.appendChild(root);

    table.addEventListener("focusout", (e) => {
      const cell = e.target as HTMLElement;
      if (cell.dataset?.r !== undefined) this.commit(cell);
    });
    table.addEventListener("keydown", (e) => {
      const cell = e.target as HTMLElement;
      if (cell.dataset?.r === undefined) return;
      if (e.key === "Enter") {
        e.preventDefault();
        cell.blur(); // focusout commits
      } else if (e.key === "Escape") {
        const r = Number(cell.dataset.r);
        const c = Number(cell.dataset.c);
        cell.textContent = this.rows[r]?.[c] ?? "";
        cell.blur();
        e.stopPropagation(); // don't let Esc also close the editor
      }
    });
  }

  update(host: HTMLElement, content: string, ctx?: PreviewCtx): void {
    this.mount(host, content, ctx);
  }

  dispose(): void {
    this.onEdit = null;
    this.rows = [];
  }

  private commit(cell: HTMLElement): void {
    const r = Number(cell.dataset.r);
    const c = Number(cell.dataset.c);
    const row = this.rows[r];
    if (!row) return;
    // innerText maps <br> → \n; a trailing one is contentEditable noise.
    // (jsdom has no innerText — fall back to textContent there.)
    const val = (cell.innerText ?? cell.textContent ?? "").replace(/\n$/, "");
    const old = row[c] ?? "";
    if (old === val) return; // ragged-row padding cells stay virtual until edited
    while (row.length <= c) row.push("");
    row[c] = val;
    const text =
      serializeCsv(this.rows, { delim: this.delim, eol: this.eol }) +
      (this.trailingEol ? this.eol : "");
    this.onEdit?.(text);
  }
}

// ─── XLSX ──────────────────────────────────────────────

const XLSX_MAX_BYTES = 25 * 1024 * 1024;

export class XlsxPreview implements Preview {
  private host: HTMLElement | null = null;
  private tabsEl: HTMLElement | null = null;
  private gridEl: HTMLElement | null = null;
  private workbook: import("xlsx").WorkBook | null = null;
  private activeSheet: string | null = null;
  private disposed = false;

  private readyResolve: (() => void) | null = null;
  public ready: Promise<void> = Promise.resolve();

  mount(host: HTMLElement, content: string): void {
    this.host = host;
    this.disposed = false;
    this.ready = new Promise((resolve) => {
      this.readyResolve = resolve;
    });
    const finish = () => {
      this.readyResolve?.();
      this.readyResolve = null;
    };

    host.innerHTML = "";
    const root = document.createElement("div");
    root.className = "structure-preview-xlsx";
    this.tabsEl = document.createElement("div");
    this.tabsEl.className = "structure-preview-xlsx-tabs";
    this.gridEl = document.createElement("div");
    this.gridEl.className = "structure-preview-xlsx-grid";
    root.appendChild(this.tabsEl);
    root.appendChild(this.gridEl);
    host.appendChild(root);

    const bytes = decodeBytes(content);
    if (!bytes) {
      this.renderPlaceholder("No se pudieron leer los bytes del archivo.");
      finish();
      return;
    }
    if (bytes.length > XLSX_MAX_BYTES) {
      this.renderPlaceholder(
        `Archivo demasiado grande para previsualizar (${formatMB(bytes.length)}).`,
      );
      finish();
      return;
    }

    import("xlsx")
      .then((XLSX) => {
        if (this.disposed) {
          finish();
          return;
        }
        try {
          const wb = XLSX.read(bytes, { type: "array" });
          this.workbook = wb;
          const names = wb.SheetNames;
          if (names.length === 0) {
            this.renderPlaceholder("Workbook vacío.");
            finish();
            return;
          }
          this.activeSheet = names[0];
          this.renderTabs(names, XLSX);
          this.renderActiveSheet(XLSX);
        } catch (err) {
          this.renderPlaceholder(`Error parseando XLSX: ${err}`);
        }
        finish();
      })
      .catch((err) => {
        this.renderPlaceholder(`Error cargando XLSX: ${err}`);
        finish();
      });
  }

  update(host: HTMLElement, content: string): void {
    this.mount(host, content);
  }

  dispose(): void {
    this.disposed = true;
    this.host = null;
    this.tabsEl = null;
    this.gridEl = null;
    this.workbook = null;
    this.activeSheet = null;
  }

  private renderPlaceholder(msg: string): void {
    if (!this.host) return;
    this.host.innerHTML = `<div class="structure-preview-xlsx-placeholder">${escapeHtml(msg)}</div>`;
  }

  private renderTabs(names: string[], XLSX: typeof import("xlsx")): void {
    if (!this.tabsEl) return;
    this.tabsEl.innerHTML = "";
    if (names.length <= 1) {
      this.tabsEl.hidden = true;
      return;
    }
    this.tabsEl.hidden = false;
    for (const name of names) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "structure-preview-xlsx-tab";
      if (name === this.activeSheet) btn.classList.add("active");
      btn.textContent = name;
      btn.addEventListener("click", () => {
        if (name === this.activeSheet) return;
        this.activeSheet = name;
        if (!this.tabsEl) return;
        for (const el of this.tabsEl.querySelectorAll(".structure-preview-xlsx-tab")) {
          el.classList.toggle("active", el.textContent === name);
        }
        // Re-arm ready so tests can await the re-render.
        this.ready = new Promise((resolve) => {
          this.readyResolve = resolve;
        });
        const finish = () => {
          this.readyResolve?.();
          this.readyResolve = null;
        };
        import("xlsx")
          .then((XLSXInner) => {
            if (!this.disposed) this.renderActiveSheet(XLSXInner);
            finish();
          })
          .catch(finish);
      });
      this.tabsEl.appendChild(btn);
    }
    // suppress unused-param lint — XLSX is passed for future consistency
    void XLSX;
  }

  private renderActiveSheet(XLSX: typeof import("xlsx")): void {
    if (!this.gridEl || !this.workbook || !this.activeSheet) return;
    const sheet = this.workbook.Sheets[this.activeSheet];
    if (!sheet) {
      this.gridEl.innerHTML = "";
      return;
    }
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: false,
      defval: "",
    });
    const table = document.createElement("table");
    table.className = "structure-preview-xlsx-table";
    const tbody = document.createElement("tbody");
    const limit = Math.min(rows.length, 500);
    for (let r = 0; r < limit; r++) {
      const tr = document.createElement("tr");
      const row = (rows[r] as unknown[]) ?? [];
      for (let c = 0; c < row.length; c++) {
        const cell = document.createElement(r === 0 ? "th" : "td");
        cell.textContent = String(row[c] ?? "");
        tr.appendChild(cell);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    this.gridEl.innerHTML = "";
    this.gridEl.appendChild(table);
    if (rows.length > limit) {
      const more = document.createElement("div");
      more.className = "structure-preview-xlsx-more";
      more.textContent = `… ${rows.length - limit} filas más no mostradas`;
      this.gridEl.appendChild(more);
    }
  }
}

// ─── DOCX ──────────────────────────────────────────────

// Word documents are zipped XML; even modestly-sized files (with
// embedded images) can balloon. 25 MB matches the xlsx ceiling and is
// far above anything a human writes by hand.
const DOCX_MAX_BYTES = 25 * 1024 * 1024;

/// Read-only docx renderer. Uses `mammoth` (dynamic-imported to keep
/// it out of the main bundle) to convert OOXML → HTML. Editing is not
/// supported — docx round-trips are lossy and out of scope.
export class DocxPreview implements Preview {
  private host: HTMLElement | null = null;
  private disposed = false;

  private readyResolve: (() => void) | null = null;
  public ready: Promise<void> = Promise.resolve();

  mount(host: HTMLElement, content: string): void {
    this.host = host;
    this.disposed = false;
    this.ready = new Promise((resolve) => {
      this.readyResolve = resolve;
    });
    const finish = () => {
      this.readyResolve?.();
      this.readyResolve = null;
    };

    host.innerHTML = "";
    const root = document.createElement("div");
    root.className = "structure-preview-docx";
    host.appendChild(root);

    const bytes = decodeBytes(content);
    if (!bytes) {
      this.renderPlaceholder("No se pudieron leer los bytes del archivo.");
      finish();
      return;
    }
    if (bytes.length > DOCX_MAX_BYTES) {
      this.renderPlaceholder(
        `Archivo demasiado grande para previsualizar (${formatMB(bytes.length)}).`,
      );
      finish();
      return;
    }

    // mammoth wants an ArrayBuffer; copy to avoid SharedArrayBuffer
    // edge cases when bytes is a view onto a larger buffer.
    const ab = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;

    // mammoth ships no TS types; browser entry exposes `convertToHtml`.
    import(/* @vite-ignore */ "mammoth/mammoth.browser.js")
      .then(async (mod: any) => {
        const mammoth = mod.default ?? mod;
        if (this.disposed) {
          finish();
          return;
        }
        try {
          const result = await mammoth.convertToHtml({ arrayBuffer: ab });
          if (this.disposed) {
            finish();
            return;
          }
          root.innerHTML = result.value || "<em>Documento vacío.</em>";
        } catch (err) {
          this.renderPlaceholder(`Error parseando DOCX: ${err}`);
        }
        finish();
      })
      .catch((err) => {
        this.renderPlaceholder(`Error cargando DOCX: ${err}`);
        finish();
      });
  }

  update(host: HTMLElement, content: string): void {
    this.mount(host, content);
  }

  dispose(): void {
    this.disposed = true;
    this.host = null;
  }

  private renderPlaceholder(msg: string): void {
    if (!this.host) return;
    this.host.innerHTML = `<div class="structure-preview-docx-placeholder">${escapeHtml(msg)}</div>`;
  }
}

// ─── PDF ───────────────────────────────────────────────

// WKWebView (macOS) and WebView2 (Windows) both render PDFs natively
// inside an <iframe src="blob:…">, so we sidestep PDF.js entirely. The
// 50 MB ceiling matches what those engines comfortably handle without
// jank; bigger files get a "edit externally" placeholder.
const PDF_MAX_BYTES = 50 * 1024 * 1024;

export class PdfPreview implements Preview {
  private host: HTMLElement | null = null;
  private blobUrl: string | null = null;

  mount(host: HTMLElement, content: string): void {
    this.host = host;
    host.innerHTML = "";

    const bytes = decodeBytes(content);
    if (!bytes) {
      this.renderPlaceholder("No se pudieron leer los bytes del archivo.");
      return;
    }
    if (bytes.length > PDF_MAX_BYTES) {
      this.renderPlaceholder(
        `Archivo demasiado grande para previsualizar (${formatMB(bytes.length)}).`,
      );
      return;
    }

    // Revoke any prior URL before minting a new one. Same-instance
    // remount is rare (we usually dispose first) but cheap to guard.
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
    const blob = new Blob([bytes], { type: "application/pdf" });
    this.blobUrl = URL.createObjectURL(blob);

    const root = document.createElement("div");
    root.className = "structure-preview-pdf";
    const iframe = document.createElement("iframe");
    iframe.className = "structure-preview-pdf-frame";
    iframe.src = this.blobUrl;
    iframe.title = "PDF preview";
    root.appendChild(iframe);
    host.appendChild(root);
  }

  update(host: HTMLElement, content: string): void {
    this.mount(host, content);
  }

  dispose(): void {
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = null;
    }
    this.host = null;
  }

  private renderPlaceholder(msg: string): void {
    if (!this.host) return;
    this.host.innerHTML = `<div class="structure-preview-pdf-placeholder">${escapeHtml(msg)}</div>`;
  }
}

function decodeBytes(content: string): Uint8Array | null {
  try {
    const arr = JSON.parse(content) as number[];
    if (!Array.isArray(arr)) return null;
    return Uint8Array.from(arr);
  } catch {
    return null;
  }
}

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
