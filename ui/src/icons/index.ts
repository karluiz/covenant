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
  /** Flame — momentum/streak indicator (Pulse hero). Lucide `flame`. */
  flame: (o?: IconOptions): string =>
    svg(
      `<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>`,
      o,
    ),

  /** Robot — used historically for operator/agent. Kept for back-compat;
   * new operator-context call sites should prefer `headphones`. */
  bot: (o?: IconOptions): string =>
    svg(
      `<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>`,
      o,
    ),

  /** Headphones — primary glyph for "operator" (the switchboard
   * metaphor: a person at a console driving the session). Replaces
   * `bot` in operator chips, the Set-operator menu entry, and the
   * convergence inbox empty state. */
  headphones: (o?: IconOptions): string =>
    svg(
      `<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H4a1 1 0 0 1-1-1v-9a9 9 0 0 1 18 0v9a1 1 0 0 1-1 1h-2a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>`,
      o,
    ),

  /** Robot with slash — operator excluded from AOM. Used on tab pills
   * to indicate "AOM is on globally but this tab is staying manual". */
  botOff: (o?: IconOptions): string =>
    svg(
      `<path d="M22 22 2 2"/><path d="M9 13v2"/><path d="M14 17H7a2 2 0 0 1-2-2v-5"/><path d="M19 14a2 2 0 0 0 2-2V8H10"/><path d="M11 4H8V2"/><path d="M12 4h4v4"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/>`,
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

  /** Zap with slash — tab excluded from AOM. Mirrors `botOff` but
   * uses the zap glyph so AOM-scoped surfaces stay consistent with
   * the status bar / banner. */
  zapOff: (o?: IconOptions): string =>
    svg(
      `<path d="M22 22 2 2"/><polyline points="13 2 7 9.5"/><polyline points="11 22 12 15"/><path d="M9.5 9.5 3 14h6"/><path d="M14.5 14.5 21 10h-6"/>`,
      o,
    ),

  /** Link / chain — cross-session correlation. */
  link2: (o?: IconOptions): string =>
    svg(
      `<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" x2="16" y1="12" y2="12"/>`,
      o,
    ),

  /** Search — magnifier for filter inputs. Lucide `search`. */
  search: (o?: IconOptions): string =>
    svg(`<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>`, o),

  /** Maximize — expand / fullscreen. */
  maximize: (o?: IconOptions): string =>
    svg(
      `<polyline points="15 3 21 3 21 9"/>` +
      `<polyline points="9 21 3 21 3 15"/>` +
      `<line x1="21" y1="3" x2="14" y2="10"/>` +
      `<line x1="3" y1="21" x2="10" y2="14"/>`,
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

  /** Download — export / save to disk. Lucide `download`. */
  download: (o?: IconOptions): string =>
    svg(
      `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>`,
      o,
    ),

  /** Upload — import / load from disk. Lucide `upload`. */
  upload: (o?: IconOptions): string =>
    svg(
      `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>`,
      o,
    ),

  /** Git-compare — review working-tree changes (diff). Lucide `git-compare`. */
  gitCompare: (o?: IconOptions): string =>
    svg(
      `<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M11 18H8a2 2 0 0 1-2-2V9"/>`,
      o,
    ),

  /** Eye — toggle visibility of hidden / gitignored items. */
  eye: (o?: IconOptions): string =>
    svg(
      `<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>`,
      o,
    ),

  /** Eye-off — value is currently revealed; click hides. Lucide `eye-off`. */
  eyeOff: (o?: IconOptions): string =>
    svg(
      `<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>`,
      o,
    ),

  /** Star (filled) — marks the default / starred item. Lucide `star`. */
  star: (o?: IconOptions): string => {
    const size = o?.size ?? 16;
    const cls = o?.className ? ` class="${o.className}"` : "";
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="${o?.strokeWidth ?? 1.5}" stroke-linecap="round" stroke-linejoin="round"${cls} aria-hidden="true"><path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.69 21.348a.53.53 0 0 1-.771-.56l.882-5.139a2.122 2.122 0 0 0-.611-1.879L2.453 10.13a.53.53 0 0 1 .294-.904l5.166-.755a2.122 2.122 0 0 0 1.597-1.16z"/></svg>`;
  },

  /** Sparkles — AI-assisted suggestion / help. */
  sparkles: (o?: IconOptions): string =>
    svg(
      `<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.582a.5.5 0 0 1 0 .962L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>`,
      o,
    ),

  /** Refresh / regenerate — re-run a generation. */
  refresh: (o?: IconOptions): string =>
    svg(
      `<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>`,
      o,
    ),

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

  /** Folder plus — new group. */
  folderPlus: (o?: IconOptions): string =>
    svg(
      `<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="M12 10v6"/><path d="M9 13h6"/>`,
      o,
    ),

  /** Copy. */
  copy: (o?: IconOptions): string =>
    svg(
      `<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>`,
      o,
    ),

  /** Play — thin outlined right-pointing triangle, rounded corners. */
  play: (o?: IconOptions): string =>
    svg(`<polygon points="7 5 19 12 7 19 7 5"/>`, o),

  /** History — clock with counter-clockwise arrow. Used for Recall. */
  history: (o?: IconOptions): string =>
    svg(
      `<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>`,
      o,
    ),

  /** Globe — internal browser launcher. */
  globe: (o?: IconOptions): string =>
    svg(
      `<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>`,
      o,
    ),

  /** Terminal — generic. */
  terminal: (o?: IconOptions): string =>
    svg(
      `<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>`,
      o,
    ),

  /** Split right — two side-by-side panes. */
  splitRight: (o?: IconOptions): string =>
    svg(
      `<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/>`,
      o,
    ),

  /** Split down — two stacked panes. */
  splitDown: (o?: IconOptions): string =>
    svg(
      `<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 12h18"/>`,
      o,
    ),

  /** Chevron right — disclosure triangle. Rotated 90° via CSS for
   * "expanded" state (no separate `chevronDown` icon needed). */
  chevronRight: (o?: IconOptions): string =>
    svg(`<path d="m9 18 6-6-6-6"/>`, o),

  /** Chevrons-down-up — collapse-all affordance. */
  chevronsDownUp: (o?: IconOptions): string =>
    svg(`<path d="m7 20 5-5 5 5"/><path d="m7 4 5 5 5-5"/>`, o),

  /** Chevrons-up-down — expand-all affordance (inverse of collapse-all). */
  chevronsUpDown: (o?: IconOptions): string =>
    svg(`<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>`, o),

  /** External link — arrow escaping a box. Beacon "open on GitHub". */
  externalLink: (o?: IconOptions): string =>
    svg(
      `<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"/>`,
      o,
    ),

  /** Panel-left — toggle left sidebar (Lucide-style). */
  panelLeft: (o?: IconOptions): string =>
    svg(`<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>`, o),

  /** Panel-right — toggle right sidebar. */
  panelRight: (o?: IconOptions): string =>
    svg(`<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>`, o),

  /** Panel-left-open — left sidebar is currently collapsed; click expands. */
  panelLeftOpen: (o?: IconOptions): string =>
    svg(
      `<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m14 9 3 3-3 3"/>`,
      o,
    ),

  /** Panel-left-close — left sidebar is currently expanded; click collapses. */
  panelLeftClose: (o?: IconOptions): string =>
    svg(
      `<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m16 15-3-3 3-3"/>`,
      o,
    ),

  /** Panel-right-open — right sidebar is currently collapsed; click expands. */
  panelRightOpen: (o?: IconOptions): string =>
    svg(
      `<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/><path d="m10 15-3-3 3-3"/>`,
      o,
    ),

  /** Panel-right-close — right sidebar is currently expanded; click collapses. */
  panelRightClose: (o?: IconOptions): string =>
    svg(
      `<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/><path d="m8 9 3 3-3 3"/>`,
      o,
    ),

  /** File — generic file. Used by the Structure tree for non-dir entries. */
  fileText: (o?: IconOptions): string =>
    svg(
      `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>`,
      o,
    ),

  /** File-pen — drafts / write spec. Lucide `file-pen`. */
  filePen: (o?: IconOptions): string =>
    svg(
      `<path d="M12.5 22H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v9.5"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M13.378 15.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"/>`,
      o,
    ),

  /** Open folder — expanded directory in the tree. */
  folderOpen: (o?: IconOptions): string =>
    svg(
      `<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>`,
      o,
    ),

  /** Curly braces — config / json / structured data. */
  braces: (o?: IconOptions): string =>
    svg(
      `<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>`,
      o,
    ),

  /** Code file — generic source code. */
  fileCode: (o?: IconOptions): string =>
    svg(
      `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="m9 13-2 2 2 2"/><path d="m15 13 2 2-2 2"/>`,
      o,
    ),

  /** Image file — png / svg / jpg / gif. */
  image: (o?: IconOptions): string =>
    svg(
      `<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>`,
      o,
    ),

  /** Gear / cog — dotfile config (.eslintrc, .prettierrc, etc.). */
  gear: (o?: IconOptions): string =>
    svg(
      `<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>`,
      o,
    ),

  /** Terminal-in-square — shell scripts. */
  terminalSquare: (o?: IconOptions): string =>
    svg(
      `<path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>`,
      o,
    ),

  /** Database — sql files. */
  database: (o?: IconOptions): string =>
    svg(
      `<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>`,
      o,
    ),

  /** Markdown mark. */
  markdown: (o?: IconOptions): string =>
    svg(
      `<rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 14V10l2 2 2-2v4"/><path d="M16 10v4"/><path d="m14 13 2 2 2-2"/>`,
      o,
    ),

  /** Boxes — node_modules / vendored deps. */
  boxes: (o?: IconOptions): string =>
    svg(
      `<path d="M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z"/><path d="m7 16.5-4.74-2.85"/><path d="m7 16.5 5-3"/><path d="M7 16.5v5.17"/><path d="M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z"/><path d="m17 16.5-5-3"/><path d="m17 16.5 4.74-2.85"/><path d="M17 16.5v5.17"/><path d="M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8Z"/><path d="M12 8 7.26 5.15"/><path d="m12 8 4.74-2.85"/><path d="M12 13.5V8"/>`,
      o,
    ),

  /** GitHub mark — .github folder. */
  github: (o?: IconOptions): string =>
    svg(
      `<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 1 5 1 5 1c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 8c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>`,
      o,
    ),

  /** Package box — package.json / package-lock. */
  packageBox: (o?: IconOptions): string =>
    svg(
      `<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>`,
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

  /** Notepad with text lines — project notes panel trigger.
   * Lucide `notepad-text` — better metaphor than a bare clipboard
   * since the panel holds notes/commands/docs, not a copy action. */
  clipboard: (o?: IconOptions): string =>
    svg(
      `<path d="M8 2v4"/><path d="M12 2v4"/><path d="M16 2v4"/><rect width="16" height="18" x="4" y="4" rx="2"/><path d="M8 10h6"/><path d="M8 14h8"/><path d="M8 18h5"/>`,
      o,
    ),
  messageCircle: (o?: IconOptions): string =>
    svg(
      `<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>`,
      o,
    ),

  /** Alert-triangle — escalation / warning. Lucide `triangle-alert`. */
  alertTriangle: (o?: IconOptions): string =>
    svg(
      `<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>`,
      o,
    ),

  /** Checklist — tasks / todos. Lucide `list-checked`. */
  checklist: (o?: IconOptions): string =>
    svg(
      `<path d="M10 6H3v12h14V9"/><path d="M10 3v7a2 2 0 0 0 2 2h8V5a2 2 0 0 0-2-2h-8Z"/><path d="m9 11 2 2 4-4"/>`,
      o,
    ),

  /** List view — Lucide `list`. */
  listView: (o?: IconOptions): string =>
    svg(
      `<line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/>`,
      o,
    ),

  /** Board / kanban view — Lucide `columns-3`. */
  boardView: (o?: IconOptions): string =>
    svg(
      `<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="M15 3v18"/>`,
      o,
    ),

  /** Check mark — done / complete. Lucide `check`. */
  check: (o?: IconOptions): string =>
    svg(
      `<polyline points="20 6 9 17 4 12"/>`,
      o,
    ),

  /** Square (outline) — unchecked checkbox. Lucide `square`. */
  square: (o?: IconOptions): string =>
    svg(
      `<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>`,
      o,
    ),

  /** Vertical menu (three dots) — more options. Lucide `more-vertical`. */
  moreVertical: (o?: IconOptions): string =>
    svg(
      `<circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/>`,
      o,
    ),

  /** Note with text — description/notes. Lucide `note-text`. */
  noteText: (o?: IconOptions): string =>
    svg(
      `<path d="M8 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect width="8" height="1" x="8" y="11" rx="0.5"/><rect width="8" height="1" x="8" y="15" rx="0.5"/><path d="M8 9h4"/>`,
      o,
    ),

  /** Radio tower / signal — Beacon deployments sidebar. Lucide `radio-tower`. */
  radioTower: (o?: IconOptions): string =>
    svg(
      `<path d="M4.9 16.1C1 12.2 1 5.8 4.9 1.9"/><path d="M7.8 4.7a6.14 6.14 0 0 0-.8 7.5"/><circle cx="12" cy="9" r="2"/><path d="M16.2 4.8c2 2 2.26 5.11.8 7.47"/><path d="M19.1 1.9a9.96 9.96 0 0 1 0 14.1"/><path d="M9.5 18h5"/><path d="m8 22 4-11 4 11"/>`,
      o,
    ),

  /** Crescent moon — Somnus (REST client) panel. */
  moon: (o?: IconOptions): string =>
    svg(`<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>`, o),

  /** Save (floppy disk) — persist to a collection. Lucide `save`. */
  save: (o?: IconOptions): string =>
    svg(
      `<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V3"/>`,
      o,
    ),

  /** More-horizontal — three dots, row-hover overflow menu trigger. Lucide `more-horizontal`. */
  moreHorizontal: (o?: IconOptions): string =>
    svg(
      `<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>`,
      o,
    ),

  /** Power button — toggle active state for environments. Lucide `power`. */
  power: (o?: IconOptions): string =>
    svg(
      `<path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" x2="12" y1="2" y2="12"/>`,
      o,
    ),
};
