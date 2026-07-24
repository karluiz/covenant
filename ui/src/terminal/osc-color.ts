// OSC 10/11 color-query replies. Covenant's xterm themes keep
// `background` transparent so vibrancy / Special-Theme wallpaper shows
// through — but xterm's built-in query handler faithfully reports that
// transparent color, which parses as BLACK. Any TUI probing the ground
// with `ESC ] 11 ; ? ST` (cursor-agent, vim, delta…) then picks a dark
// palette on a visually light terminal. We answer the query with the
// *effective* ground color instead and suppress the built-in reply.

/// `#rgb` / `#rrggbb` → X11 `rgb:rrrr/gggg/bbbb` (16-bit per channel).
export function xColor(hex: string): string | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const ch = (i: number): string => {
    const b = h.slice(i * 2, i * 2 + 2).toLowerCase();
    return b + b;
  };
  return `rgb:${ch(0)}/${ch(1)}/${ch(2)}`;
}

/// Full reply sequence for an OSC 10 (foreground) / 11 (background)
/// `?` query, ST-terminated. Null when the color isn't plain hex.
export function oscColorReply(code: 10 | 11, hex: string): string | null {
  const c = xColor(hex);
  return c ? `\x1b]${code};${c}\x1b\\` : null;
}
