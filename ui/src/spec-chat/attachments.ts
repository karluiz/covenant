// Composer image attachments: normalize pasted/picked images to base64,
// downscaled to the largest edge the model actually benefits from.
// ponytail: paste + file picker only; native OS drag-drop needs a backend
// path-read command (webview can't read dropped paths) — add when asked.

export interface PendingAttachment {
  dataB64: string;
  mediaType: string;
  /** data: URL for the thumbnail chip. */
  previewUrl: string;
}

export const MAX_ATTACHMENTS = 5;
/** Anthropic's useful ceiling — larger images are downscaled server-side anyway. */
export const MAX_EDGE = 1568;

/** Canvas re-encode target: jpeg stays jpeg, everything else becomes png
 *  (toDataURL('image/webp') support varies by webview). */
export function encodeTarget(mediaType: string): 'image/png' | 'image/jpeg' {
  return mediaType === 'image/jpeg' ? 'image/jpeg' : 'image/png';
}

export function stripDataUrl(dataUrl: string): { mediaType: string; dataB64: string } | null {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
  return m ? { mediaType: m[1]!, dataB64: m[2]! } : null;
}

/** Scale (w,h) so the longest edge is ≤ maxEdge, never upscaling. */
export function fitWithin(w: number, h: number, maxEdge = MAX_EDGE): { w: number; h: number } {
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

/** Decode, downscale, and re-encode an image blob. Null for non-images or
 *  decode failures — callers just skip those. */
export async function toAttachment(blob: Blob): Promise<PendingAttachment | null> {
  if (!blob.type.startsWith('image/')) return null;
  try {
    const bmp = await createImageBitmap(blob);
    const { w, h } = fitWithin(bmp.width, bmp.height);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0, w, h);
    const previewUrl = canvas.toDataURL(encodeTarget(blob.type), 0.9);
    const parsed = stripDataUrl(previewUrl);
    return parsed ? { ...parsed, previewUrl } : null;
  } catch {
    return null;
  }
}

/** Pull image blobs out of a paste event's clipboard items. */
export function imagesFromClipboard(e: ClipboardEvent): Blob[] {
  const out: Blob[] = [];
  for (const item of Array.from(e.clipboardData?.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
}
