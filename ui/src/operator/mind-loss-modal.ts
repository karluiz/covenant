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
      <h2 id="mind-loss-title">¿Borrar tab y su memoria del operador?</h2>
      <p>El operador acumuló <strong>${turns} turno${turns === 1 ? "" : "s"}</strong> de memoria desde ${escapeHtml(formatRelative(preview.updated_at_rfc3339))}.</p>
      <dl>
        <dt>Objetivo actual</dt><dd>${escapeHtml(preview.goal || "—")}</dd>
        <dt>Última creencia</dt><dd>${escapeHtml(truncate(preview.belief || "—", 200))}</dd>
      </dl>
      <p class="warn">Si borrás el tab, esta memoria se pierde permanentemente.</p>
      <div class="modal-actions">
        <button type="button" class="btn-cancel">Cancelar</button>
        <button type="button" class="btn-confirm danger">Borrar de todas formas</button>
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
  if (diffSec < 60) return `hace ${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `hace ${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `hace ${diffHr}h`;
  return `hace ${Math.floor(diffHr / 24)}d`;
}
