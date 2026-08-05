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

/// One-time mount: Tauri event bridge + grant toast.
export function initCollabShare(tabTitle: (sessionId: string) => string): void {
  void listen<RequestEvt>("rc://guest/request", ({ payload }) => {
    pushConfirmToast({
      message: `${payload.login} wants control of ${tabTitle(payload.sessionId)}`,
      confirmLabel: "Grant control",
      cancelLabel: "Decline",
      onConfirm: () => {
        void invoke("rc_grant_driver", {
          sessionId: payload.sessionId,
          connId: payload.connId,
          login: payload.login,
        }).catch((e) => console.error("grant failed", e));
      },
    });
  });
  void listen<DriverEvt>("rc://guest/driver", ({ payload }) => {
    const had = drivers.get(payload.sessionId);
    _collabState.onDriver(payload);
    if (payload.login === null && had) pushInfoToast({ message: `${had} no longer has control` });
  });
  void listen<RosterEvt>("rc://guest/roster", ({ payload }) => _collabState.onRoster(payload));
}
