// Cross-session finding toasts. Listens to the global Tauri event the
// karl-app cross_session watcher emits, renders a stack of slide-in
// toasts in the top-right of the workspace.
//
// Click → opens the agent panel pre-loaded with the finding so the
// user can drill in. Auto-dismiss after 12s; hover pauses the timer.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { recordGroupFinding } from "../convergence/findings";
import { Icons } from "../icons";

interface CrossSessionFinding {
  message: string;
  timestamp_unix_ms: number;
}

export interface GroupSupervisionFinding {
  group_id: string;
  operator_id: string;
  operator_name: string;
  message: string;
  timestamp_unix_ms: number;
}

interface ToastOptions {
  /// Called when the user clicks a cross-session finding toast. The
  /// finding is passed back so callers can route it (e.g. open the
  /// agent panel pre-filled).
  onClick: (finding: CrossSessionFinding) => void;
  /// Called when the user clicks a group-supervision finding toast.
  /// Distinct from `onClick` because the payload carries the attributing
  /// supervisor (`operator_name`/`operator_id`/`group_id`) that callers
  /// need to label the follow-up correctly — funneling it through the
  /// `CrossSessionFinding`-typed `onClick` would silently drop that
  /// attribution. Optional so existing callers aren't forced to handle
  /// it; unhandled clicks just dismiss the toast.
  onGroupSupervisionClick?: (finding: GroupSupervisionFinding) => void;
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
  private unlistenGroupSupervision?: UnlistenFn;

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
    this.unlistenGroupSupervision = await listen<GroupSupervisionFinding>(
      "group-supervision-finding",
      (event) => {
        // Retain it before showing it: the toast is 12s of visibility,
        // Convergence's group detail is where it stays readable.
        recordGroupFinding({
          groupId: event.payload.group_id,
          operatorName: event.payload.operator_name,
          message: event.payload.message,
          atUnixMs: event.payload.timestamp_unix_ms,
        });
        this.showGroupSupervision(event.payload);
      },
    );
  }

  stop(): void {
    if (this.unlisten) {
      this.unlisten();
      this.unlisten = undefined;
    }
    if (this.unlistenGroupSupervision) {
      this.unlistenGroupSupervision();
      this.unlistenGroupSupervision = undefined;
    }
  }

  /// Wire the shared auto-dismiss lifecycle onto a card: the 12s timer,
  /// hover pause (mouseleave rearms a fresh 12s), the ✕ close button,
  /// and a liveness bar along the bottom edge that drains in sync with
  /// the timer. Returns `dismiss` for the caller's click handler.
  private wireLifetime(card: HTMLElement): () => void {
    const life = document.createElement("span");
    life.className = "toast-life";
    card.appendChild(life);

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
      // The timer rearms to a fresh 12s — restart the drain from full.
      // The `animation` shorthand reset also wipes the inline duration,
      // so it is re-applied after every restart (the stylesheet carries
      // no duration; AUTO_DISMISS_MS is the single source of truth).
      life.style.animation = "none";
      void life.offsetWidth;
      life.style.animation = "";
      life.style.animationDuration = `${AUTO_DISMISS_MS}ms`;
    };
    card.addEventListener("mouseenter", () => {
      if (dismissTimer !== undefined) {
        window.clearTimeout(dismissTimer);
        dismissTimer = undefined;
      }
      life.style.animationPlayState = "paused";
    });
    card.addEventListener("mouseleave", armDismiss);
    card.querySelector<HTMLElement>(".toast-close")?.addEventListener(
      "click",
      (e) => {
        e.stopPropagation();
        dismiss();
      },
    );
    armDismiss();
    return dismiss;
  }

  /// Render an arbitrary informational toast (not driven by a backend
  /// event). Used for one-shot setup hints like "zsh-autosuggestions
  /// not detected — `brew install zsh-autosuggestions`".
  pushInfo(toast: InfoToast): void {
    // Dedupe: a repeated message while its toast is still visible would
    // stack identical cards (e.g. every tree refresh against a pruned
    // worktree). Refresh the existing card's lifetime instead.
    for (const el of this.container.querySelectorAll<HTMLElement>(".toast-info:not(.toast-leaving)")) {
      if (el.querySelector(".toast-msg")?.textContent === toast.message) {
        el.dispatchEvent(new Event("mouseenter"));
        el.dispatchEvent(new Event("mouseleave"));
        return;
      }
    }
    const card = document.createElement("button");
    card.type = "button";
    card.className = "toast toast-info";
    card.innerHTML = `
      <span class="toast-icon">${Icons.lightbulb({ size: 14 })}</span>
      <span class="toast-msg"></span>
      <span class="toast-close" aria-label="dismiss">${Icons.x({ size: 12 })}</span>
    `;
    card.querySelector<HTMLElement>(".toast-msg")!.textContent = toast.message;

    const dismiss = this.wireLifetime(card);
    card.addEventListener("click", () => {
      const result = toast.onClick?.();
      if (result !== false) dismiss();
    });

    this.container.appendChild(card);
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

    const dismiss = this.wireLifetime(card);
    card.addEventListener("click", () => {
      const result = toast.onClick?.();
      if (result !== false) dismiss();
    });

    this.container.appendChild(card);
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

    const dismiss = this.wireLifetime(card);
    card.addEventListener("click", () => {
      this.opts.onClick(finding);
      dismiss();
    });

    this.container.appendChild(card);
  }

  /// Render a group-supervision finding: same chrome as the cross-session
  /// toast, but the message is prefixed with the supervisor's name (from
  /// the payload — no lookup needed) so it arrives signed by the
  /// operator that made the call, same posture as Perception toasts.
  private showGroupSupervision(finding: GroupSupervisionFinding): void {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "toast";
    card.innerHTML = `
      <span class="toast-icon">${Icons.link2({ size: 14 })}</span>
      <span class="toast-msg"></span>
      <span class="toast-close" aria-label="dismiss">${Icons.x({ size: 12 })}</span>
    `;
    card.querySelector<HTMLElement>(".toast-msg")!.textContent =
      `${finding.operator_name}: ${finding.message}`;

    const dismiss = this.wireLifetime(card);
    card.addEventListener("click", () => {
      this.opts.onGroupSupervisionClick?.(finding);
      dismiss();
    });

    this.container.appendChild(card);
  }
}
