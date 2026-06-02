// PiPanel — slide-in overlay that hosts a PiChatView for the duration
// of one Pi session. PI-5 MVP: lets the user open Pi end-to-end via
// keybinding without requiring the full TabManager integration (which
// reshapes the Tab interface and ships in PI-6).
//
// Lifecycle:
//   open()  → spawn a Pi session, mount PiChatView, slide in
//   close() → destroy view, close backend session, slide out, unmount
//
// The panel is mounted lazily — the singleton is created on first
// open() and reused thereafter. Calling open() while already open is a
// no-op (focuses the input instead).

import type { SessionId } from "../../api";
import { spawnPiSession } from "../../api";
import { PiChatView } from "./view";

export interface PiPanelOptions {
  /// Optional cwd hint passed to spawnPiSession. Typically the active
  /// tab's cwd so Pi starts in a useful directory.
  cwd?: string | null;
  /// Optional provider/model overrides. Defaults to whatever `pi` picks
  /// based on its own config.
  provider?: string;
  model?: string;
}

export class PiPanel {
  private overlay: HTMLElement | null = null;
  private view: PiChatView | null = null;
  private sessionId: SessionId | null = null;
  /// Inflight spawn promise — guards against parallel open() calls
  /// racing to spawn two backend sessions.
  private opening: Promise<void> | null = null;

  isOpen(): boolean {
    return this.overlay !== null && !this.overlay.hidden;
  }

  async open(opts: PiPanelOptions = {}): Promise<void> {
    if (this.opening) return this.opening;
    if (this.isOpen()) {
      this.focusInput();
      return;
    }
    this.opening = this.openInner(opts).finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async openInner(opts: PiPanelOptions): Promise<void> {
    this.mountChrome();
    const body = this.overlay!.querySelector<HTMLElement>(".pi-panel-body")!;
    const status = this.overlay!.querySelector<HTMLElement>(".pi-panel-spawn-status")!;
    status.textContent = "Spawning pi…";
    try {
      this.sessionId = await spawnPiSession({
        cwd: opts.cwd ?? undefined,
        provider: opts.provider,
        model: opts.model,
      });
    } catch (err) {
      status.textContent = `Could not start Pi: ${String(err)}`;
      status.dataset.kind = "error";
      return;
    }
    status.remove();
    this.view = new PiChatView({
      sessionId: this.sessionId,
      host: body,
      onClose: () => void this.close(),
      cwd: opts.cwd ?? null,
    });
    this.focusInput();
  }

  async close(): Promise<void> {
    if (!this.overlay) return;
    const view = this.view;
    const id = this.sessionId;
    // Tear down DOM eagerly so the slide-out animation can play; the
    // backend close is fire-and-forget so a slow session doesn't block.
    this.overlay.classList.add("pi-panel-closing");
    this.view = null;
    this.sessionId = null;
    setTimeout(() => {
      this.overlay?.remove();
      this.overlay = null;
    }, 150);
    try {
      if (view) await view.closeSession();
      else if (id) {
        const { closePiSession } = await import("../../api");
        await closePiSession(id);
      }
    } catch {
      /* already closed */
    }
  }

  /// Toggle helper for the keybinding entry point.
  async toggle(opts: PiPanelOptions = {}): Promise<void> {
    if (this.isOpen()) await this.close();
    else await this.open(opts);
  }

  private mountChrome(): void {
    const overlay = document.createElement("div");
    overlay.className = "pi-panel-overlay pi-panel-opening";
    overlay.innerHTML = `
      <div class="pi-panel" role="dialog" aria-label="Pi coding agent">
        <button type="button" class="pi-panel-close" aria-label="Close Pi">×</button>
        <div class="pi-panel-spawn-status">Spawning pi…</div>
        <div class="pi-panel-body"></div>
      </div>
    `;
    const close = overlay.querySelector<HTMLButtonElement>(".pi-panel-close")!;
    close.addEventListener("click", () => void this.close());
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void this.close();
      }
    });
    document.body.appendChild(overlay);
    // Let the browser process the initial paint so the slide-in
    // transition actually animates from off-screen → on-screen.
    requestAnimationFrame(() => overlay.classList.remove("pi-panel-opening"));
    this.overlay = overlay;
  }

  private focusInput(): void {
    const ta = this.overlay?.querySelector<HTMLTextAreaElement>(".pi-chat-textarea");
    ta?.focus();
  }
}

/// Singleton getter — keeps state across keybinding presses without
/// having to thread the instance through every caller.
let _instance: PiPanel | null = null;
export function getPiPanel(): PiPanel {
  if (!_instance) _instance = new PiPanel();
  return _instance;
}
