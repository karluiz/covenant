// SVG → PNG rasterization for the structure editor's quick-export
// button. Pure-ish: builds a transient <canvas>, draws the SVG via
// an Image, returns the PNG bytes. No DOM coupling beyond the
// canvas it creates and discards.
//
// Why Canvas (and not resvg in Rust)? For hand-authored or
// Figma-exported SVGs (the common case), the browser path is
// pixel-perfect and adds zero deps. If we ever need higher
// fidelity (advanced filters, font fallback control), swap the
// guts of this module — the signature stays.

export type PngScale = 1 | 2 | 3;

const SCALE_STORAGE_KEY = "structure-png-scale";

export interface PngExportResult {
  bytes: Uint8Array;
  /// Final pixel dimensions on disk (already multiplied by scale).
  width: number;
  height: number;
}

/// Rasterize `svgText` to a PNG blob at `scale`× the SVG's natural
/// dimensions. Rejects when the SVG is malformed (no usable
/// dimensions) or when `toBlob` fails.
export async function svgToPng(
  svgText: string,
  scale: PngScale,
): Promise<PngExportResult> {
  const { width: nativeW, height: nativeH } = parseSvgDimensions(svgText);
  if (nativeW <= 0 || nativeH <= 0) {
    throw new Error("SVG has no usable dimensions (missing width/height/viewBox)");
  }

  const targetW = Math.round(nativeW * scale);
  const targetH = Math.round(nativeH * scale);

  // data: URL avoids the Blob → object-URL dance and dodges any
  // network-y CSP rule that future-us might add for blob URLs.
  // base64 is mandatory because raw SVG can contain `#` and other
  // chars that break a `utf8,…` data URL across browsers.
  const dataUrl =
    "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svgText)));

  const img = new Image();
  img.src = dataUrl;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("SVG failed to load as image"));
  });

  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");
  // Transparent background by default — `clearRect` is implicit on a
  // fresh canvas, so this is just for clarity. We do NOT fillRect.
  ctx.drawImage(img, 0, 0, targetW, targetH);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) throw new Error("canvas.toBlob returned null");

  const buf = await blob.arrayBuffer();
  return { bytes: new Uint8Array(buf), width: targetW, height: targetH };
}

/// Read the persisted scale, defaulting to 2× when nothing is set or
/// the stored value is junk.
export function loadSvgScale(): PngScale {
  try {
    const raw = window.localStorage.getItem(SCALE_STORAGE_KEY);
    if (raw === "1" || raw === "2" || raw === "3") {
      return Number(raw) as PngScale;
    }
  } catch {
    // Private mode / disabled storage — fall through to default.
  }
  return 2;
}

export function saveSvgScale(scale: PngScale): void {
  try {
    window.localStorage.setItem(SCALE_STORAGE_KEY, String(scale));
  } catch {
    /* storage disabled — silently drop, user just loses persistence */
  }
}

/// Pull width/height out of an SVG. Prefers explicit `width`/`height`
/// attributes; falls back to `viewBox` when those are missing or
/// non-numeric (common for Figma exports). Returns `(0, 0)` when no
/// usable size is found — callers reject in that case.
function parseSvgDimensions(svgText: string): { width: number; height: number } {
  const parsed = new DOMParser().parseFromString(svgText, "image/svg+xml");
  if (parsed.querySelector("parsererror")) return { width: 0, height: 0 };
  const root = parsed.documentElement;
  if (!root || root.nodeName.toLowerCase() !== "svg") {
    return { width: 0, height: 0 };
  }

  const w = parseFloat(root.getAttribute("width") ?? "");
  const h = parseFloat(root.getAttribute("height") ?? "");
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
    return { width: w, height: h };
  }

  const vb = (root.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/);
  if (vb.length === 4) {
    const vbW = parseFloat(vb[2]);
    const vbH = parseFloat(vb[3]);
    if (Number.isFinite(vbW) && Number.isFinite(vbH) && vbW > 0 && vbH > 0) {
      return { width: vbW, height: vbH };
    }
  }
  return { width: 0, height: 0 };
}
