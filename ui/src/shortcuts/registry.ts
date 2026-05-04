// Single source of truth for keyboard shortcuts shown in the
// Shortcuts modal. The actual key handling lives in `main.ts`; this
// registry is for *display only*. If you add a binding in main.ts,
// add a row here too — and vice versa, treat a missing row as a
// discoverability bug.

export type ShortcutCategory =
  | "Navigation"
  | "Tabs"
  | "Panels"
  | "AOM"
  | "Misc";

export interface ShortcutEntry {
  keys: string[]; // each token rendered as a <kbd>
  label: string;
  description: string;
  category: ShortcutCategory;
}

export const SHORTCUTS: ShortcutEntry[] = [
  // Tabs
  { category: "Tabs", keys: ["⌘", "T"], label: "New tab", description: "Open a fresh terminal session." },
  { category: "Tabs", keys: ["⌘", "W"], label: "Close tab", description: "Close the active session." },
  { category: "Tabs", keys: ["⌘", "1–9"], label: "Jump to tab N", description: "Activate the Nth tab (1-indexed)." },
  { category: "Tabs", keys: ["⌘", "⇧", "{"], label: "Previous tab", description: "Cycle to the tab on the left." },
  { category: "Tabs", keys: ["⌘", "⇧", "}"], label: "Next tab", description: "Cycle to the tab on the right." },
  { category: "Tabs", keys: ["⌘", "⇧", "G"], label: "New tab group", description: "Create an empty group; drag tabs into it." },

  // Panels
  { category: "Panels", keys: ["⌘", ","], label: "Settings", description: "Open or toggle the settings page." },
  { category: "Panels", keys: ["⌘", "K"], label: "Super-agent", description: "Toggle the agent chat panel." },
  { category: "Panels", keys: ["⌘", "O"], label: "Operator decisions", description: "Toggle the operator decisions log." },
  { category: "Panels", keys: ["⌘", "P"], label: "Recall palette", description: "Search command history (zsh import)." },
  { category: "Panels", keys: ["⌘", "⇧", "F"], label: "Global file search", description: "Search file contents in the active tab's cwd." },
  { category: "Panels", keys: ["⌘", "⌥", "O"], label: "Convergence Mode", description: "Full-window overlay with one tile per session." },
  { category: "Panels", keys: ["⌘", "⇧", "V"], label: "Release log", description: "Show the version history / changelog." },
  { category: "Panels", keys: ["⌘", "/"], label: "Docs hub", description: "Open in-app documentation. ⌘? also works." },
  { category: "Panels", keys: ["⌘", "⇧", "K"], label: "Keyboard shortcuts", description: "Show this list." },

  // AOM
  { category: "AOM", keys: ["⌘", "⇧", "A"], label: "Toggle AOM", description: "Start or stop autonomous overnight mode." },
  { category: "AOM", keys: ["⌘", "⇧", "R"], label: "AOM morning report", description: "Read-only digest of the most recent AOM run." },
  { category: "AOM", keys: ["⌘", "⇧", "E"], label: "Toggle AOM for active tab", description: "Include/exclude the active tab from AOM. Visible feedback via the tab's bot badge (slashed = excluded)." },

  // Navigation / view
  { category: "Navigation", keys: ["⌘", "+"], label: "Zoom in", description: "Increase UI zoom." },
  { category: "Navigation", keys: ["⌘", "−"], label: "Zoom out", description: "Decrease UI zoom." },
  { category: "Navigation", keys: ["⌘", "0"], label: "Reset zoom", description: "Restore zoom to 100%." },

  // Misc
  { category: "Misc", keys: ["Esc"], label: "Close modal / overlay", description: "Closes the topmost panel; routes to terminal otherwise." },
];

export const CATEGORY_ORDER: ShortcutCategory[] = [
  "Panels",
  "Tabs",
  "AOM",
  "Navigation",
  "Misc",
];
