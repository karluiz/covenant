import type { MindPreview } from "../api";
import { openConfirmPrompt } from "../workspaces/confirm-prompt";

export interface MindLossModalOptions {
  preview: MindPreview;
  onConfirm: () => void;
  onCancel: () => void;
}

/// Spec 3.20 phase 6: warn the user before destroying a tab whose
/// operator mind has accumulated turns. Rendered via the standard
/// confirm card (DESIGN.md: destructive confirms use the palette
/// language). Cancel is focused so Enter/Esc keeps the tab.
export function openMindLossModal(opts: MindLossModalOptions): void {
  const { preview, onConfirm, onCancel } = opts;
  const turns = preview.turn_count;
  openConfirmPrompt({
    label: "Operator memory",
    title: "Delete tab and its operator memory?",
    message: `The operator accumulated ${turns} turn${turns === 1 ? "" : "s"} of memory since ${formatRelative(preview.updated_at_rfc3339)}.`,
    detail: [
      ["Current goal", preview.goal || "—"],
      ["Last belief", truncate(preview.belief || "—", 200)],
    ],
    warn: "If you delete the tab, this memory is lost permanently.",
    confirmText: "Delete anyway",
    focusCancel: true,
    onConfirm,
    onCancel,
  });
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "…";
}

function formatRelative(rfc: string): string {
  const then = new Date(rfc).getTime();
  if (isNaN(then)) return rfc;
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}
