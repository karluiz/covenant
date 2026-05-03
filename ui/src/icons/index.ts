// Lucide-sourced inline SVG icons (https://lucide.dev — MIT).
//
// Inlined as TS strings rather than imported from `lucide` so we ship
// only the icons we use, and so they live in the bundle without an
// extra HTTP request. Each icon uses `currentColor` so callers control
// hue via standard CSS color inheritance.
//
// Pattern: `Icons.name({ size, className })` returns an SVG string,
// suitable for `el.innerHTML = ...` (the contents are trusted — no
// user input flows through here).

export interface IconOptions {
  size?: number;
  className?: string;
  strokeWidth?: number;
}

function svg(paths: string, opts?: IconOptions): string {
  const size = opts?.size ?? 16;
  const sw = opts?.strokeWidth ?? 1.7;
  const cls = opts?.className ? ` class="${opts.className}"` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"${cls} aria-hidden="true">${paths}</svg>`;
}

export const Icons = {
  /** Robot — operator / autonomous agent. */
  bot: (o?: IconOptions): string =>
    svg(
      `<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>`,
      o,
    ),

  /** Lightbulb — fix / suggestion. */
  lightbulb: (o?: IconOptions): string =>
    svg(
      `<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>`,
      o,
    ),

  /** Target — mission / objective. Distinct from `lightbulb`
   * (suggestion) so the two concepts don't share an icon. */
  target: (o?: IconOptions): string =>
    svg(
      `<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>`,
      o,
    ),

  /** Zap (lightning bolt) — Autonomous Operator Mode. Reserved for
   * AOM surfaces ONLY (banner, status chip, splash). The Operator
   * (per-tab) keeps `bot`; this distinction matters because the user
   * needs to read the difference between "Operator is on for this
   * tab" and "the global AOM kicked in across all tabs". */
  zap: (o?: IconOptions): string =>
    svg(
      `<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>`,
      o,
    ),

  /** Link / chain — cross-session correlation. */
  link2: (o?: IconOptions): string =>
    svg(
      `<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" x2="16" y1="12" y2="12"/>`,
      o,
    ),

  /** Ban / no — used for the "no color" swatch. */
  ban: (o?: IconOptions): string =>
    svg(
      `<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>`,
      o,
    ),

  /** Plus — e.g. add to group. */
  plus: (o?: IconOptions): string =>
    svg(`<path d="M5 12h14"/><path d="M12 5v14"/>`, o),

  /** Arrow right — e.g. move to. */
  arrowRight: (o?: IconOptions): string =>
    svg(
      `<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>`,
      o,
    ),

  /** X — close / cancel. */
  x: (o?: IconOptions): string =>
    svg(`<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`, o),

  /** Trash — destructive. */
  trash: (o?: IconOptions): string =>
    svg(
      `<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>`,
      o,
    ),

  /** Pencil — rename / edit. */
  pencil: (o?: IconOptions): string =>
    svg(
      `<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>`,
      o,
    ),

  /** Folder — group / collection. */
  folder: (o?: IconOptions): string =>
    svg(
      `<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>`,
      o,
    ),

  /** Folder minus — ungroup. */
  folderMinus: (o?: IconOptions): string =>
    svg(
      `<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="M9 13h6"/>`,
      o,
    ),

  /** Copy. */
  copy: (o?: IconOptions): string =>
    svg(
      `<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>`,
      o,
    ),

  /** Terminal — generic. */
  terminal: (o?: IconOptions): string =>
    svg(
      `<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>`,
      o,
    ),

  /** Chevron right — disclosure triangle. Rotated 90° via CSS for
   * "expanded" state (no separate `chevronDown` icon needed). */
  chevronRight: (o?: IconOptions): string =>
    svg(`<path d="m9 18 6-6-6-6"/>`, o),

  /** File — generic file. Used by the Structure tree for non-dir entries. */
  fileText: (o?: IconOptions): string =>
    svg(
      `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>`,
      o,
    ),

  /** Covenant logo — the seal (ring), the prompt (chevron) and the
   * operator (offset dot). Monochrome, inherits color via currentColor.
   * Mirrors the geometry of the dock icon at 24×24. */
  covenant: (o?: IconOptions): string =>
    svg(
      `<circle cx="12" cy="12" r="9"/><polyline points="9.5 8.5 13 12 9.5 15.5"/><circle cx="15.6" cy="8.8" r="1.4" fill="currentColor" stroke="none"/>`,
      o,
    ),
};
