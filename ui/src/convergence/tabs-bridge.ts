import type { TabManager } from "../tabs/manager";
import type { ConvergenceTabBridge } from "./overlay";

/// Bridges the Convergence overlay to the live tab set. Uses the public
/// `TabManager.listSessionHints()` (one hint per live pane) — no casts,
/// no reaching into private fields. The previous version cast the
/// manager to an internal shape and read `tab.sessionId`, which Phase C
/// removed; that produced `session_id: undefined` and rejected the
/// snapshot. See spec 2026-06-06.
export function makeTabsBridge(manager: TabManager): ConvergenceTabBridge {
  return {
    listTabs: () =>
      manager.listSessionHints().map((h) => ({
        sessionId: h.sessionId,
        title: h.title,
        color: h.color,
        group: h.group,
        groupId: h.groupId,
        supervisor: h.supervisor,
      })),
    activateBySessionId: (id, _opts) =>
      manager.activateBySessionId(
        id as Parameters<typeof manager.activateBySessionId>[0],
      ),
    setGroupSupervisor: (groupId, operatorId) =>
      manager.setGroupSupervisor(groupId, operatorId),
    setGroupIntervene: (groupId, intervene) =>
      manager.setGroupIntervene(groupId, intervene),
  };
}
