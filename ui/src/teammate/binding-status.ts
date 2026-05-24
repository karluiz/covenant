/// Derives the teammate panel's "active on …" subtitle line from the
/// set of tabs the operator is currently bound to. Pure function — no
/// DOM, no manager access — so it's trivially unit-testable.
///
/// Phase 1 ships with `role` always `"driver"` (single operator per
/// tab today). Phase 2 will introduce real observer rows, at which
/// point `describeBindings` will switch to the "driving X · observing
/// Y, Z" voice. Keeping the role field on the input now lets callers
/// (panel + manager) thread the right shape through without churn.

export interface BoundTab {
  tabId: string;
  tabName: string;
  /// Phase 1: always 'driver' (single-op-per-tab model). Phase 2 introduces 'observer'.
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
  if (boundTabs.length === 1) {
    return {
      kind: "active",
      label: `active on ${boundTabs[0].tabName}`,
      tabs: boundTabs,
    };
  }
  return {
    kind: "active",
    label: `active on ${boundTabs.length} tabs · ${formatNames(boundTabs)}`,
    tabs: boundTabs,
  };
}
