// Registry of UI indicators the user can show/hide from
// Settings → Appearance → Indicators. Adding a new toggleable
// indicator is a single entry here — no other code changes.
//
// `selector` must target the indicator's root element(s). Hiding is
// applied via an injected stylesheet (see applyIndicatorVisibility)
// rather than el.hidden, because the status bar rebuilds its chip DOM
// on every render and would wipe a JS-set flag.

export interface Indicator {
  id: string;
  label: string;
  group: string;
  selector: string;
}

export const INDICATORS: Indicator[] = [
  // Titlebar (right cluster)
  { id: "blocks", label: "Blocks", group: "Titlebar", selector: "#titlebar-view-blocks" },
  { id: "files", label: "Files", group: "Titlebar", selector: "#titlebar-view-files" },
  { id: "activity", label: "Activity", group: "Titlebar", selector: "#titlebar-view-activity" },
  { id: "recall", label: "Recall", group: "Titlebar", selector: "#titlebar-view-recall" },
  { id: "notes", label: "Project notes", group: "Titlebar", selector: "#titlebar-project-notes" },
  { id: "teammate", label: "Teammate chat", group: "Titlebar", selector: "#titlebar-view-teammate" },
  { id: "tasker", label: "Tasker", group: "Titlebar", selector: "#titlebar-tasker" },
  { id: "resources", label: "Resources", group: "Titlebar", selector: "#titlebar-resources" },
  { id: "beacon", label: "Beacon", group: "Titlebar", selector: "#titlebar-beacon" },
  { id: "cdlc", label: "CDLC", group: "Titlebar", selector: "#titlebar-cdlc" },
  { id: "browser", label: "Browser", group: "Titlebar", selector: "#titlebar-browser" },

  // Left titlebar widgets
  { id: "spawns", label: "Spawns chip", group: "Left titlebar", selector: "#spawns-chip-mount" },
  { id: "workspace", label: "Workspace switcher", group: "Left titlebar", selector: ".workspace-chip" },

  // Status bar chips
  { id: "sb-git", label: "Git", group: "Status bar", selector: ".status-git" },
  { id: "sb-operator", label: "Operator", group: "Status bar", selector: ".status-chip-operator" },
  { id: "sb-mission", label: "Mission", group: "Status bar", selector: ".status-mission" },
  { id: "sb-executor", label: "Executor", group: "Status bar", selector: ".status-executor" },
  { id: "sb-aom", label: "AOM", group: "Status bar", selector: ".status-aom" },
];

const STYLE_ID = "indicator-overrides";

export function buildIndicatorCss(hidden: string[]): string {
  const ids = new Set(hidden);
  return INDICATORS.filter((i) => ids.has(i.id))
    .map((i) => `${i.selector}{display:none!important}`)
    .join("\n");
}

// ponytail: hiding a titlebar button while its panel is open just removes
// the toggle affordance; the panel stays until closed elsewhere. Force-close
// is the upgrade if anyone asks.
export function applyIndicatorVisibility(hidden: string[]): void {
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = buildIndicatorCss(hidden);
}
