// Cross-session finding toasts. Listens to the global Tauri event the
// karl-app cross_session watcher emits, renders a stack of slide-in
// toasts in the top-right of the workspace.
//
// Click → opens the agent panel pre-loaded with the finding so the
// user can drill in. Auto-dismiss after 12s; hover pauses the timer.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { Icons } from "../icons";

interface CrossSessionFinding {
  message: string;
  timestamp_unix_ms: number;
}

interface ToastOptions {
  /// Called when the user clicks a toast. The finding is passed back so
  /// callers can route it (e.g. open the agent panel pre-filled).
  onClick: (finding: CrossSessionFinding) => void;
}

export interface InfoToast {
  message: string;
  /// Optional handler invoked when the user clicks the card. Returning
  /// `false` prevents auto-dismiss; everything else dismisses.
  onClick?: () => void | boolean;
}

export interface PerceptionToast {
  /// WHO answered — the effective operator's name ("Default", "Raven").
  operatorName: string;
  /// The option as rendered in the prompt, e.g. `1. Yes`.
  optionLabel: string;
  /// What it was about — command first line, or the tool kind.
  subject: string;
  /// Click → jump to the tab that was answered.
  onClick?: () => void | boolean;
}

/// Pure formatter so the signature copy is testable: the WHO is rendered
/// separately (uppercase, accented); this builds the rest.
export function formatPerceptionToast(t: PerceptionToast): string {
  const subject = t.subject ? ` · ${t.subject}` : "";
  return ` answered "${t.optionLabel}"${subject}`;
}

export function pushPerceptionToast(toast: PerceptionToast): void {
  SHARED?.pushPerception(toast);
}

export interface ConfirmToast {
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  /// Called when the user backs out via Cancel instead of confirming.
  /// Optional — most callers have nothing to undo (their disable-the-button
  /// guard, if any, was never taken in the first place).
  onCancel?: () => void;
}

const AUTO_DISMISS_MS = 12_000;

/// Module-level reference set by main.ts after the global ToastHost
/// is constructed. Lets any code (Settings save, operator save, etc.)
/// surface info toasts via `pushInfoToast` without prop-drilling.
let SHARED: ToastHost | null = null;

export function setSharedToastHost(host: ToastHost): void {
  SHARED = host;
}

/// Convenience: surface an info toast through the shared host.
/// Silently no-ops if main.ts hasn't registered the host yet (e.g.
/// during early boot) — feedback that early in the lifecycle isn't
/// worth crashing for.
export function pushInfoToast(toast: InfoToast): void {
  SHARED?.pushInfo(toast);
}

/// Convenience: surface a confirm toast (two buttons, no auto-dismiss)
/// through the shared host.
export function pushConfirmToast(toast: ConfirmToast): void {
  SHARED?.pushConfirm(toast);
}

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

  /// Render an arbitrary informational toast (not driven by a backend
  /// event). Used for one-shot setup hints like "zsh-autosuggestions
  /// not detected — `brew install zsh-autosuggestions`".
  pushInfo(toast: InfoToast): void {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "toast toast-info";
    card.innerHTML = `
      <span class="toast-icon">${Icons.lightbulb({ size: 14 })}</span>
      <span class="toast-msg"></span>
      <span class="toast-close" aria-label="dismiss">${Icons.x({ size: 12 })}</span>
    `;
    card.querySelector<HTMLElement>(".toast-msg")!.textContent = toast.message;

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
      const result = toast.onClick?.();
      if (result !== false) dismiss();
    });

    this.container.appendChild(card);
    armDismiss();
  }

  /// Render a Perception signature toast: WHO answered, what, and on
  /// which command. The operator name leads — the whole point is that
  /// every auto-answer arrives signed by the authority that made it.
  pushPerception(toast: PerceptionToast): void {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "toast toast-perception";
    card.innerHTML = `
      <span class="toast-icon">${Icons.headphones({ size: 14 })}</span>
      <span class="toast-msg"><span class="toast-perception-who"></span><span class="toast-perception-what"></span></span>
      <span class="toast-close" aria-label="dismiss">${Icons.x({ size: 12 })}</span>
    `;
    card.querySelector<HTMLElement>(".toast-perception-who")!.textContent =
      toast.operatorName;
    card.querySelector<HTMLElement>(".toast-perception-what")!.textContent =
      formatPerceptionToast(toast);

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
      const result = toast.onClick?.();
      if (result !== false) dismiss();
    });

    this.container.appendChild(card);
    armDismiss();
  }

  /// Render a confirmation toast: message + Cancel/Confirm buttons, no
  /// auto-dismiss. Used to guard destructive one-shots like quit (⌘Q).
  /// Only one confirm toast lives at a time — a repeated trigger (mashing
  /// ⌘Q) re-focuses the existing card instead of stacking.
  pushConfirm(toast: ConfirmToast): void {
    const existing = this.container.querySelector<HTMLElement>(".toast-confirm");
    if (existing) {
      existing.querySelector<HTMLButtonElement>(".toast-btn-confirm")?.focus();
      return;
    }

    const card = document.createElement("div");
    card.className = "toast toast-confirm";
    card.innerHTML = `
      <span class="toast-icon">${Icons.lightbulb({ size: 14 })}</span>
      <div class="toast-confirm-body">
        <span class="toast-msg"></span>
        <div class="toast-actions">
          <button type="button" class="toast-btn toast-btn-cancel"></button>
          <button type="button" class="toast-btn toast-btn-confirm"></button>
        </div>
      </div>
    `;
    card.querySelector<HTMLElement>(".toast-msg")!.textContent = toast.message;
    card.querySelector<HTMLElement>(".toast-btn-cancel")!.textContent =
      toast.cancelLabel ?? "Cancel";
    card.querySelector<HTMLElement>(".toast-btn-confirm")!.textContent =
      toast.confirmLabel ?? "Quit";

    const dismiss = (): void => {
      card.classList.add("toast-leaving");
      window.setTimeout(() => card.remove(), 180);
    };

    card.querySelector<HTMLElement>(".toast-btn-cancel")!.addEventListener(
      "click",
      () => {
        dismiss();
        toast.onCancel?.();
      },
    );
    card.querySelector<HTMLElement>(".toast-btn-confirm")!.addEventListener(
      "click",
      () => {
        dismiss();
        toast.onConfirm();
      },
    );

    this.container.appendChild(card);
    card.querySelector<HTMLButtonElement>(".toast-btn-confirm")?.focus();
  }

  private show(finding: CrossSessionFinding): void {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "toast";
    card.innerHTML = `
      <span class="toast-icon">${Icons.link2({ size: 14 })}</span>
      <span class="toast-msg"></span>
      <span class="toast-close" aria-label="dismiss">${Icons.x({ size: 12 })}</span>
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
