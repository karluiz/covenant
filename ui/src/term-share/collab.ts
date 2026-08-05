// Collaborative terminal-share desktop UI: the grant/deny toast that fires
// when a guest requests control, the per-session driver + roster state the
// tab strip reads back synchronously, and the revoke action.
//
// Mirrors ./share.ts's shape (module-level Maps + a CustomEvent so the tab
// strip can re-render without prop-drilling) since this is the same "local
// mirror of a backend store" pattern.

import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { pushConfirmToast, pushInfoToast } from "../notifications/toast";
import { isCollabShared } from "./share";

export interface RosterGuest {
  connId: number;
  login: string;
  avatar: string;
}
interface DriverEvt {
  sessionId: string;
  login: string | null;
}
interface RosterEvt {
  sessionId: string;
  guests: RosterGuest[];
}
interface RequestEvt {
  sessionId: string;
  connId: number;
  login: string;
  avatar: string;
}

const drivers = new Map<string, string>();
const rosters = new Map<string, RosterGuest[]>();
export const COLLAB_EVENT = "covenant:collab-changed";

function notify(): void {
  window.dispatchEvent(new CustomEvent(COLLAB_EVENT));
}

export function getDriver(sessionId: string): string | null {
  return drivers.get(sessionId) ?? null;
}
export function getGuestCount(sessionId: string): number {
  return rosters.get(sessionId)?.length ?? 0;
}
/// Logins of every guest currently in the roster, for tooltip copy. Empty
/// array (not null) when nobody's there — callers can join() it directly.
export function getGuestLogins(sessionId: string): string[] {
  return (rosters.get(sessionId) ?? []).map((g) => g.login);
}

/// Exported for tests; listeners feed these in production.
export const _collabState = {
  onDriver(e: DriverEvt): void {
    if (e.login === null) drivers.delete(e.sessionId);
    else drivers.set(e.sessionId, e.login);
    notify();
  },
  onRoster(e: RosterEvt): void {
    rosters.set(e.sessionId, e.guests);
    notify();
  },
};

export function revokeDriver(sessionId: string): void {
  void invoke("rc_revoke_driver", { sessionId }).catch((e) =>
    console.error("revoke driver failed", e),
  );
}

// ── Grant-request queue ──
//
// `pushConfirmToast` (toast.ts) is a singleton: a second confirm while one is
// showing just refocuses the existing card and silently drops the new one.
// The quit guard relies on that (mash ⌘Q → one card, not a stack), so
// toast.ts stays untouched — instead collab.ts owns a FIFO in front of it:
// only one collab request is ever "in flight" (shown as a toast) at a time,
// everything else queues behind it.
//
// Self-healed edge: if some OTHER, non-collab confirm toast (e.g. the quit
// guard) happens to be showing when we dequeue and call pushConfirmToast,
// the singleton swallows ours — there is no return signal from
// pushConfirmToast to detect that synchronously. Left unhandled,
// `inFlightRequest` would stay set with callbacks nobody can ever invoke:
// a permanent deadlock of every future request. `dequeueNextRequest` below
// schedules a DOM poll (`RETRY_DELAY_MS`) after pushing — if our card never
// actually rendered, it clears the wedge and retries at the front of the
// queue, which naturally keeps polling until the blocking toast is gone.
let pendingRequests: RequestEvt[] = [];
let inFlightRequest: RequestEvt | null = null;
const RETRY_DELAY_MS = 1500;

function sameRequest(a: RequestEvt, b: RequestEvt): boolean {
  return a.sessionId === b.sessionId && a.connId === b.connId;
}

/// A guest re-clicking "request control" while already queued or already
/// showing as the live toast must not stack a second card for the same
/// (sessionId, connId).
function isDuplicateRequest(e: RequestEvt): boolean {
  if (inFlightRequest && sameRequest(inFlightRequest, e)) return true;
  return pendingRequests.some((q) => sameRequest(q, e));
}

/// Checked at dequeue time (not eagerly, per the fix) — a guest can
/// disconnect while its request sits in the queue behind another. `rosters`
/// only reflects a session once a roster event has landed for it, so the
/// absence of an entry is "unknown", not "gone" — only a positive roster
/// snapshot that excludes the connId counts as evidence the guest left.
function guestStillPresent(e: RequestEvt): boolean {
  const roster = rosters.get(e.sessionId);
  if (!roster) return true;
  return roster.some((g) => g.connId === e.connId);
}

/// Pops the queue until it finds a request whose guest is still connected
/// (or the queue is empty), and shows that one as the live confirm toast.
function dequeueNextRequest(tabTitle: (sessionId: string) => string): void {
  inFlightRequest = null;
  while (pendingRequests.length > 0) {
    const next = pendingRequests.shift()!;
    if (!guestStillPresent(next)) continue;
    inFlightRequest = next;

    const message = `${next.login} wants control of ${tabTitle(next.sessionId)}`;
    // Guards against the retry timer firing after the guest already
    // confirmed/cancelled (toast.ts dismisses the card synchronously on
    // click, but the timer is only cleared from inside these callbacks) —
    // and against the callbacks firing after a retry already re-queued
    // `next` under a NEW inFlightRequest (a stale toast's buttons must be
    // a no-op at that point, not a double-dequeue).
    let settled = false;
    let retryTimer: ReturnType<typeof window.setTimeout> | undefined;
    const clearRetry = (): void => {
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
        retryTimer = undefined;
      }
    };

    pushConfirmToast({
      message,
      confirmLabel: "Grant control",
      cancelLabel: "Decline",
      onConfirm: () => {
        if (settled) return;
        settled = true;
        clearRetry();
        void invoke("rc_grant_driver", {
          sessionId: next.sessionId,
          connId: next.connId,
          login: next.login,
        }).catch((e) => console.error("grant failed", e));
        dequeueNextRequest(tabTitle);
      },
      // Decline stays a pure no-op toward the guest (no denial frame exists
      // on the guest page — see the deferred finding) beyond advancing our
      // own queue to whoever's next.
      onCancel: () => {
        if (settled) return;
        settled = true;
        clearRetry();
        dequeueNextRequest(tabTitle);
      },
    });

    // `pushConfirmToast` gives no signal of whether our card actually
    // rendered (the singleton silently swallows it if another confirm
    // toast — e.g. the quit guard — is already showing). Poll the DOM: if
    // no card carrying our message exists after the delay, our push was
    // swallowed. Clear the wedge and retry at the FRONT of the queue —
    // the retry naturally keeps polling for as long as the blocking toast
    // is up.
    retryTimer = window.setTimeout(() => {
      if (settled) return;
      const rendered = Array.from(
        document.querySelectorAll<HTMLElement>(".toast-confirm .toast-msg"),
      ).some((el) => el.textContent === message);
      if (rendered) return;
      settled = true;
      inFlightRequest = null;
      pendingRequests.unshift(next);
      dequeueNextRequest(tabTitle);
    }, RETRY_DELAY_MS);

    return;
  }
}

function handleGuestRequest(
  e: RequestEvt,
  tabTitle: (sessionId: string) => string,
): void {
  // I1: a forged/stale request naming a session that isn't (or is no
  // longer) collab-shared must never surface a grant-control toast — the
  // UI-side half of the relay-compromise defense (the desktop command
  // itself also refuses to grant in that case).
  if (!isCollabShared(e.sessionId)) return;
  if (isDuplicateRequest(e)) return;
  pendingRequests.push(e);
  if (!inFlightRequest) dequeueNextRequest(tabTitle);
}

/// Exported for tests — drives the queue directly so vitest doesn't need to
/// mock @tauri-apps/api/event to exercise it.
export const _requestQueue = {
  enqueue: handleGuestRequest,
  get pendingCount(): number {
    return pendingRequests.length;
  },
  get inFlight(): RequestEvt | null {
    return inFlightRequest;
  },
  /// Clears ALL module state (driver map, roster map, queue) — not just the
  /// queue's own fields. `guestStillPresent` reads `rosters` at dequeue
  /// time, so a roster left behind by an unrelated earlier test (e.g. one
  /// that ends with `rosters.set(sessionId, [])`) would otherwise make a
  /// same-named session look disconnected here.
  _resetForTest(): void {
    drivers.clear();
    rosters.clear();
    pendingRequests = [];
    inFlightRequest = null;
  },
};

/// One-time mount: Tauri event bridge + grant toast.
export function initCollabShare(tabTitle: (sessionId: string) => string): void {
  void listen<RequestEvt>("rc://guest/request", ({ payload }) =>
    handleGuestRequest(payload, tabTitle),
  );
  void listen<DriverEvt>("rc://guest/driver", ({ payload }) => {
    const had = drivers.get(payload.sessionId);
    _collabState.onDriver(payload);
    if (payload.login === null && had) pushInfoToast({ message: `${had} no longer has control` });
  });
  void listen<RosterEvt>("rc://guest/roster", ({ payload }) => _collabState.onRoster(payload));
}
