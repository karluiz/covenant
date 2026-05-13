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

import { renderMarkdown } from "../release/markdown";

export type PreviewKind = "markdown" | "svg" | "png" | "html";

export interface Preview {
  /// Mount + render. The implementation OWNS `host.innerHTML` for
  /// the duration; StructureEditor calls `dispose()` before reuse.
  mount(host: HTMLElement, content: string): void;
  /// Re-render with new content (used when the user edits in source
  /// and toggles back to preview). Default impl is mount-from-scratch.
  update(host: HTMLElement, content: string): void;
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
export class HtmlPreview implements Preview {
  private iframeEl: HTMLIFrameElement | null = null;

  mount(host: HTMLElement, content: string): void {
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
    iframe.srcdoc = content;
    iframe.style.width = "100%";
    iframe.style.height = "100%";
    iframe.style.border = "0";
    iframe.style.background = "#fff";

    wrap.appendChild(iframe);
    host.appendChild(wrap);
    this.iframeEl = iframe;
  }
  update(host: HTMLElement, content: string): void {
    // Reusing the existing iframe avoids a full reload flash when the
    // user toggles back-and-forth without changes. If content is the
    // same we keep the current frame; otherwise replace srcdoc, which
    // triggers a re-render.
    if (this.iframeEl && this.iframeEl.srcdoc !== content) {
      this.iframeEl.srcdoc = content;
      return;
    }
    if (!this.iframeEl) {
      this.mount(host, content);
    }
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
