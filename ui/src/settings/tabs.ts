export type SettingsTab =
  | "providers" | "models" | "appearance" | "terminal"
  | "operators" | "updates" | "notifications" | "telegram"
  | "familiars" | "workspace" | "covenant";

const TAB_OF_SECTION: Record<string, SettingsTab> = {
  "sec-providers":     "providers",
  "sec-models":        "models",
  "sec-appearance":    "appearance",
  "sec-terminal":      "terminal",
  "sec-operators":     "operators",
  "sec-updates":       "updates",
  "sec-notifications": "notifications",
  "sec-telegram":      "telegram",
  "familiars-host":    "familiars",
  "sec-workspace":     "workspace",
  "sec-covenant":      "covenant",
};

export function activateTab(root: HTMLElement, tab: SettingsTab): void {
  root.querySelectorAll<HTMLElement>(".settings-section").forEach((s) => {
    const t = TAB_OF_SECTION[s.id];
    s.style.display = t === tab ? "" : "none";
  });
  root.querySelectorAll<HTMLAnchorElement>("[data-target]").forEach((a) => {
    const t = TAB_OF_SECTION[a.dataset.target ?? ""];
    a.classList.toggle("active", t === tab);
  });
}
