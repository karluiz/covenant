// Cross-session finding toasts. Listens to the global Tauri event the
// karl-app cross_session watcher emits, renders a stack of slide-in
// toasts in the top-right of the workspace.
//
// Click → opens the agent panel pre-loaded with the finding so the
// user can drill in. Auto-dismiss after 12s; hover pauses the timer.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

interface CrossSessionFinding {
  message: string;
  timestamp_unix_ms: number;
}

interface ToastOptions {
  /// Called when the user clicks a toast. The finding is passed back so
  /// callers can route it (e.g. open the agent panel pre-filled).
  onClick: (finding: CrossSessionFinding) => void;
}

const AUTO_DISMISS_MS = 12_000;

export class ToastHost {
  private container: HTMLElement;
  private unlisten?: UnlistenFn;

  constructor(
    private readonly mountHost: HTMLElement,
    private readonly opts: ToastOptions,
  ) {
    this.container = document.createElement("div");
    this.container.className = "toast-host";
    this.mountHost.appendChild(this.container);
  }

  async start(): Promise<void> {
    this.unlisten = await listen<CrossSessionFinding>(
      "cross-session-finding",
      (event) => this.show(event.payload),
    );
  }

  stop(): void {
    if (this.unlisten) {
      this.unlisten();
      this.unlisten = undefined;
    }
  }

  private show(finding: CrossSessionFinding): void {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "toast";
    card.innerHTML = `
      <span class="toast-icon">🔗</span>
      <span class="toast-msg"></span>
      <span class="toast-close" aria-label="dismiss">×</span>
    `;
    card.querySelector<HTMLElement>(".toast-msg")!.textContent = finding.message;

    let dismissTimer: number | undefined;
    const dismiss = (): void => {
      if (dismissTimer !== undefined) {
        window.clearTimeout(dismissTimer);
        dismissTimer = undefined;
      }
      card.classList.add("toast-leaving");
      window.setTimeout(() => card.remove(), 180);
    };

    const armDismiss = (): void => {
      dismissTimer = window.setTimeout(dismiss, AUTO_DISMISS_MS);
    };

    card.addEventListener("mouseenter", () => {
      if (dismissTimer !== undefined) {
        window.clearTimeout(dismissTimer);
        dismissTimer = undefined;
      }
    });
    card.addEventListener("mouseleave", armDismiss);

    card.querySelector<HTMLElement>(".toast-close")!.addEventListener(
      "click",
      (e) => {
        e.stopPropagation();
        dismiss();
      },
    );

    card.addEventListener("click", () => {
      this.opts.onClick(finding);
      dismiss();
    });

    this.container.appendChild(card);
    armDismiss();
  }
}
