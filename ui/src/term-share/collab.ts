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
// Known accepted edge (not fixed here): if some OTHER, non-collab confirm
// toast (e.g. the quit guard) happens to be showing when we dequeue and call
// pushConfirmToast, the singleton still swallows ours — there is no return
// signal from pushConfirmToast to detect that and retry. Rare in practice
// (quit guard is a one-shot on ⌘Q) and out of scope: fixing it needs a
// richer contract on the shared toast host, not queueing logic in here.
let pendingRequests: RequestEvt[] = [];
let inFlightRequest: RequestEvt | null = null;

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
    pushConfirmToast({
      message: `${next.login} wants control of ${tabTitle(next.sessionId)}`,
      confirmLabel: "Grant control",
      cancelLabel: "Decline",
      onConfirm: () => {
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
      onCancel: () => dequeueNextRequest(tabTitle),
    });
    return;
  }
}

function handleGuestRequest(
  e: RequestEvt,
  tabTitle: (sessionId: string) => string,
): void {
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
