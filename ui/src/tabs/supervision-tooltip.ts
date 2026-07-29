/// What the supervision eye on a group chip says on hover.
///
/// Pure so the composition — which segments appear, which are dropped, and
/// what an operator with nothing to say yet reads like — is testable
/// without a DOM. Built at HOVER time (the chip passes a thunk), because
/// findings land minutes after the chip was rendered and the chip does not
/// re-render for them.

import type { GroupFinding } from "../convergence/findings";
import type { TooltipContent } from "../tooltip/tooltip";

export interface SupervisionTooltipInput {
  /// `null` when the operator isn't in the renderer's cache yet.
  operatorName: string | null;
  /// The Phase 3 gate: an intervening supervisor may act on unpinned tabs.
  intervene: boolean;
  tabCount: number;
  /// Newest first — `groupFindings(groupId)`.
  findings: readonly GroupFinding[];
  nowMs: number;
}

/// Same shape as `agoLabel` in convergence/attention.ts, duplicated rather
/// than imported: pulling the attention module into the sidebar drags a
/// DOM-heavy renderer along for six lines of arithmetic.
function ago(sinceMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - sinceMs) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function supervisionTooltip(input: SupervisionTooltipInput): TooltipContent {
  const { operatorName, intervene, tabCount, findings, nowMs } = input;

  const segments = [
    intervene ? "Decides for you" : "Observes only",
    tabCount > 0 ? `${tabCount} ${tabCount === 1 ? "tab" : "tabs"}` : null,
    findings.length > 0
      ? `${findings.length} ${findings.length === 1 ? "finding" : "findings"}`
      : "no findings yet",
  ].filter((s): s is string => s !== null);

  const last = findings[0];

  return {
    title: operatorName ? `${operatorName} is supervising this group` : "Supervised",
    meta: segments.join(" · "),
    // Amber only for the mode that can WRITE. An observer is not a warning.
    metaTone: intervene ? "warn" : undefined,
    // No quote block at all when nothing has been said — an empty one reads
    // as a broken tooltip, not as silence.
    preview: last ? `“${last.message}” — ${ago(last.atUnixMs, nowMs)}` : undefined,
    hint: "Open group detail",
    kbd: "⌘⇧M",
  };
}
