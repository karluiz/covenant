import type { TabManager } from "../tabs/manager";
import type { ConvergenceTabBridge } from "./overlay";

/// Bridges the Convergence overlay to the live tab set. Uses the public
/// `TabManager.listSessionHints()` (one hint per live pane) — no casts,
/// no reaching into private fields. The previous version cast the
/// manager to an internal shape and read `tab.sessionId`, which Phase C
/// removed; that produced `session_id: undefined` and rejected the
/// snapshot. See spec 2026-06-06.
///
/// `switchWorkspace` is optional so tests can build a bridge without the
/// workspace layer; without it, a row for another workspace's agent
/// still selects, it just can't be jumped to.
export function makeTabsBridge(
  manager: TabManager,
  switchWorkspace?: (workspaceId: string) => Promise<void>,
): ConvergenceTabBridge {
  return {
    listTabs: () =>
      manager.listSessionHints().map((h) => ({
        sessionId: h.sessionId,
        title: h.title,
        color: h.color,
        group: h.group,
        groupId: h.groupId,
        supervisor: h.supervisor,
        workspace: h.workspace ?? null,
      })),
    activeSessionId: () => manager.activeSessionId(),
    activateBySessionId: (id, _opts) => {
      if (
        manager.activateBySessionId(
          id as Parameters<typeof manager.activateBySessionId>[0],
        )
      ) {
        return true;
      }
      // Not in the live workspace — the tab is hibernated somewhere else.
      // Switch there first, then land on it. Async, so the overlay's
      // close-on-true contract can't wait for it: report the jump as
      // taken and let the switch finish behind the closing overlay.
      const wsId = manager.workspaceIdForSession(id);
      if (!wsId || !switchWorkspace) return false;
      void switchWorkspace(wsId)
        .then(() =>
          manager.activateBySessionId(
            id as Parameters<typeof manager.activateBySessionId>[0],
          ),
        )
        .catch((err) => console.warn("[convergence] workspace jump failed", err));
      return true;
    },
    setGroupSupervisor: (groupId, operatorId) =>
      manager.setGroupSupervisor(groupId, operatorId),
    setGroupIntervene: (groupId, intervene) =>
      manager.setGroupIntervene(groupId, intervene),
  };
}
