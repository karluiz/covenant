import type { MindPreview } from "../api";

export interface MindLossModalOptions {
  preview: MindPreview;
  onConfirm: () => void;
  onCancel: () => void;
}

/// Spec 3.20 phase 6: warn the user before destroying a tab whose
/// operator mind has accumulated turns. Cancel is the default-focused
/// action so Enter/Esc keeps the tab.
export function openMindLossModal(opts: MindLossModalOptions): void {
  const { preview, onConfirm, onCancel } = opts;

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay mind-loss-overlay";
  const turns = preview.turn_count;
  overlay.innerHTML = `
    <div class="modal mind-loss-modal" role="dialog" aria-modal="true" aria-labelledby="mind-loss-title">
      <h2 id="mind-loss-title">Delete tab and its operator memory?</h2>
      <p>The operator accumulated <strong>${turns} turn${turns === 1 ? "" : "s"}</strong> of memory since ${escapeHtml(formatRelative(preview.updated_at_rfc3339))}.</p>
      <dl>
        <dt>Current goal</dt><dd>${escapeHtml(preview.goal || "—")}</dd>
        <dt>Last belief</dt><dd>${escapeHtml(truncate(preview.belief || "—", 200))}</dd>
      </dl>
      <p class="warn">If you delete the tab, this memory is lost permanently.</p>
      <div class="modal-actions">
        <button type="button" class="btn-cancel">Cancel</button>
        <button type="button" class="btn-confirm danger">Delete anyway</button>
      </div>
    </div>
  `;

  const cancelBtn = overlay.querySelector(".btn-cancel") as HTMLButtonElement;
  const confirmBtn = overlay.querySelector(".btn-confirm") as HTMLButtonElement;

  function close(): void {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      onCancel();
    }
  }

  cancelBtn.addEventListener("click", () => {
    close();
    onCancel();
  });
  confirmBtn.addEventListener("click", () => {
    close();
    onConfirm();
  });
  document.addEventListener("keydown", onKey);

  document.body.appendChild(overlay);
  // Default focus on Cancelar so Enter cancels (safer default).
  cancelBtn.focus();
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "…";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
