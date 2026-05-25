/// Derives the teammate panel's binding subtitle line from the set of
/// tabs the operator is currently bound to. Pure function — no DOM,
/// no manager access — so it's trivially unit-testable.
///
/// Phase 2 splits the voice into "driving X" (where the operator is the
/// primary writer) and "observing Y, Z" (where the operator is a
/// read-only subscriber). Mixed: "driving X · observing Y, Z".

export interface BoundTab {
  tabId: string;
  tabName: string;
  role: "driver" | "observer";
}

export interface BindingStatus {
  kind: "idle" | "active" | "driving-observing";
  /// Short, user-facing label rendered into the panel subtitle.
  label: string;
  /// Source data, in stable order, so callers can render the popover.
  tabs: BoundTab[];
}

const MAX_VISIBLE_NAMES = 3;

function formatNames(tabs: BoundTab[]): string {
  if (tabs.length <= MAX_VISIBLE_NAMES) {
    return tabs.map((t) => t.tabName).join(", ");
  }
  const head = tabs.slice(0, MAX_VISIBLE_NAMES).map((t) => t.tabName).join(", ");
  return `${head} +${tabs.length - MAX_VISIBLE_NAMES}`;
}

export function describeBindings(boundTabs: BoundTab[]): BindingStatus {
  if (boundTabs.length === 0) {
    return { kind: "idle", label: "idle", tabs: [] };
  }
  const driving = boundTabs.filter((t) => t.role === "driver");
  const observing = boundTabs.filter((t) => t.role === "observer");

  const parts: string[] = [];
  if (driving.length > 0) parts.push(`driving ${formatNames(driving)}`);
  if (observing.length > 0) parts.push(`observing ${formatNames(observing)}`);

  const kind: BindingStatus["kind"] =
    driving.length > 0 && observing.length > 0 ? "driving-observing" : "active";

  return { kind, label: parts.join(" · "), tabs: boundTabs };
}
