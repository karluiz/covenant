// Single source of truth for keyboard shortcuts shown in the
// Shortcuts modal. The actual key handling lives in `main.ts`; this
// registry is for *display only*. If you add a binding in main.ts,
// add a row here too — and vice versa, treat a missing row as a
// discoverability bug.

export type ShortcutCategory =
  | "Navigation"
  | "Tabs"
  | "Panels"
  | "Operator & AI"
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
  { category: "Tabs", keys: ["⌘", "W"], label: "Close pane / tab", description: "Close the active pane in a split tab; close the tab when single-pane. Requires experimental.split_panes; behaves as close-tab when flag is off." },
  { category: "Tabs", keys: ["⌘", "⇧", "W"], label: "Close tab (escape hatch)", description: "Always closes the entire tab even when it has multiple panes." },
  { category: "Tabs", keys: ["⌘", "1–9"], label: "Jump to tab N", description: "Activate the Nth tab (1-indexed)." },
  { category: "Tabs", keys: ["⌘", "⇧", "{"], label: "Previous tab", description: "Cycle to the tab on the left." },
  { category: "Tabs", keys: ["⌘", "⇧", "}"], label: "Next tab", description: "Cycle to the tab on the right." },
  { category: "Tabs", keys: ["⌘", "⇧", "G"], label: "New tab group", description: "Create an empty group; drag tabs into it." },

  // Panels
  { category: "Panels", keys: ["⌘", ","], label: "Settings", description: "Open or toggle the settings page." },
  { category: "Panels", keys: ["⌘", "P"], label: "Recall palette", description: "Search command history (zsh import)." },
  { category: "Panels", keys: ["⌘", "F"], label: "Find in terminal", description: "Search the active terminal's scrollback. Enter = next, ⇧⏎ = previous, Esc = close." },
  { category: "Panels", keys: ["⌘", "⇧", "F"], label: "Global file search", description: "Search file contents in the active tab's cwd." },
  { category: "Panels", keys: ["⌘", "⇧", "M"], label: "Convergence Mode", description: "Full-window overlay with one tile per session." },
  { category: "Panels", keys: ["⌘", "/"], label: "Docs hub", description: "Open in-app documentation. ⌘? also works." },
  { category: "Panels", keys: ["⌘", "⇧", "K"], label: "Keyboard shortcuts", description: "Show this list." },
  { category: "Panels", keys: ["⌘", "⇧", "J"], label: "Project notes", description: "Open the per-group project notes panel (Jot)." },
  { category: "Panels", keys: ["⌘", "⇧", "N"], label: "Notch overlay", description: "Toggle the floating executor-status notch (global shortcut; works app-unfocused)." },
  { category: "Panels", keys: ["⌘", "⇧", "I"], label: "Capabilities", description: "Browse Skills / Commands / Hooks / MCPs across Claude, Copilot, opencode, Shared." },
  { category: "Panels", keys: ["⌘", "⇧", "P"], label: "Workspace picker", description: "Toggle the workspace switcher popover: pick, rename, duplicate, recolor, delete." },
  { category: "Panels", keys: ["⌘", "⇧", "V"], label: "Release log", description: "Open version history / release notes." },
  { category: "Tabs", keys: ["⌘", "⌥", "⇧", "P"], label: "New Pi tab", description: "Create a permanent Pi RPC tab in the tabbar." },
  { category: "Tabs", keys: ["⌘", "⌥", "⇧", "C"], label: "New Copilot (ACP) tab", description: "Create a structured Copilot chat tab wired to a copilot --acp session." },
  { category: "Tabs", keys: ["⌘", "⌥", "N"], label: "New workspace", description: "Create a new workspace and switch to it. The outgoing workspace's PTYs are killed and respawned from manifest on next switch." },
  { category: "Tabs", keys: ["⌘", "D"], label: "Split right", description: "Add a second pane to the right of the active pane. Requires experimental.split_panes." },
  { category: "Tabs", keys: ["⌘", "\\"], label: "Split down", description: "Add a second pane below the active pane. Requires experimental.split_panes." },
  { category: "Tabs", keys: ["⌘", "["], label: "Focus previous pane", description: "Move focus to the other pane in a split tab." },
  { category: "Tabs", keys: ["⌘", "]"], label: "Focus next pane", description: "Move focus to the other pane in a split tab." },
  { category: "Tabs", keys: ["⌘", "⇧", "]"], label: "Swap panes", description: "Exchange the two panes' positions." },

  // Operator & AI — agent-driven features (super-agent, operators, mission, familiars)
  { category: "Operator & AI", keys: ["⌘", "K"], label: "Super-agent", description: "Toggle the agent chat panel." },
  { category: "Operator & AI", keys: ["⌘", "O"], label: "Operator decisions", description: "Toggle the operator decisions log for the active tab." },
  { category: "Operator & AI", keys: ["⌘", "⇧", "O"], label: "Operator picker", description: "Pick an operator preset (style, budget, autonomy) for the active tab." },
  { category: "Operator & AI", keys: ["⌘", "M"], label: "Mission picker", description: "Open the mission picker — set or edit the active tab's mission." },
  { category: "Operator & AI", keys: ["⌘", "N"], label: "Spec-chat", description: "Open the spec-chat panel to draft specs and plans." },
  { category: "Operator & AI", keys: ["⌘", "⇧", "D"], label: "Drafts tab", description: "Open Project Notes for the active group on the Drafts tab." },

  // AOM — autonomous overnight mode
  { category: "AOM", keys: ["⌘", "⇧", "A"], label: "Toggle AOM", description: "Start or stop autonomous overnight mode." },
  { category: "AOM", keys: ["⌘", "⇧", "E"], label: "Exclude / include active tab", description: "While AOM is running, keep the active tab manual or include it again." },
  { category: "AOM", keys: ["⌘", "⇧", "R"], label: "AOM report", description: "Open the read-only report for the most recent AOM session." },

  // Navigation / view
  { category: "Navigation", keys: ["⌘", "+"], label: "Zoom in", description: "Increase UI zoom." },
  { category: "Navigation", keys: ["⌘", "−"], label: "Zoom out", description: "Decrease UI zoom." },
  { category: "Navigation", keys: ["⌘", "0"], label: "Reset zoom", description: "Restore zoom to 100%." },

  // Misc
  { category: "Misc", keys: ["⌘", "⇧", "."], label: "Kill foreground process", description: "Terminate the active tab's foreground process tree when Ctrl+C is swallowed." },
  { category: "Misc", keys: ["Esc"], label: "Close modal / overlay", description: "Closes the topmost panel; routes to terminal otherwise." },
];

export const CATEGORY_ORDER: ShortcutCategory[] = [
  "Operator & AI",
  "Panels",
  "Tabs",
  "AOM",
  "Navigation",
  "Misc",
];
