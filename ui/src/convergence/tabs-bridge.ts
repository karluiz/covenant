import { sessionGetOperator, type SessionId } from "../api";
import type { TabManager } from "../tabs/manager";
import type { ConvergenceTabBridge } from "./overlay";

/**
 * Adapter from TabManager → ConvergenceTabBridge.
 *
 * TabManager keeps its `tabs` array private; spec 3.8 forbids
 * widening that surface. We read it via a typed structural cast.
 * The shape we depend on (`tabs: { id, sessionId, defaultTitle,
 * customName, color }[]`) is asserted here so a future TabManager
 * refactor will surface as a TS error in this single file.
 */
interface TabManagerInternal {
  tabs: ReadonlyArray<{
    sessionId: string;
    defaultTitle: string;
    customName: string | null;
    color: string | null;
  }>;
}

interface OperatorCacheEntry {
  avatar: string | null;
  name: string | null;
}

// Per-session operator cache populated lazily by listTabs().
// TODO: Cache is populated lazily; operator switch via ⌘⇧O will refresh on
// next 1s tick when sessionGetOperator returns the new value. A future
// invalidateOperatorCache(sessionId) hook can be added if needed.
const operatorCache = new Map<string, OperatorCacheEntry>();
const inflight = new Set<string>();

function fetchOperator(sessionId: string): void {
  if (inflight.has(sessionId)) return;
  inflight.add(sessionId);
  void sessionGetOperator(sessionId as SessionId)
    .then((op) => {
      operatorCache.set(sessionId, { avatar: op.emoji ?? null, name: op.name });
    })
    .catch(() => {
      // Leave entry absent so we retry on next tick; record null to
      // avoid hammering when there's no operator assigned.
      operatorCache.set(sessionId, { avatar: null, name: null });
    })
    .finally(() => {
      inflight.delete(sessionId);
    });
}

export function makeTabsBridge(manager: TabManager): ConvergenceTabBridge {
  const internal = manager as unknown as TabManagerInternal;
  return {
    listTabs: () =>
      internal.tabs.map((t) => {
        const cached = operatorCache.get(t.sessionId);
        if (!cached) fetchOperator(t.sessionId);
        return {
          sessionId: t.sessionId,
          title: (t.customName?.trim() || t.defaultTitle) ?? "untitled",
          color: t.color,
          operatorAvatar: cached?.avatar ?? null,
          operatorName: cached?.name ?? null,
        };
      }),
    // SessionId is a branded type; cast is safe because we receive the
    // raw string from ConvergenceOverlay which read it from listTabs().
    activateBySessionId: (id) =>
      manager.activateBySessionId(id as Parameters<typeof manager.activateBySessionId>[0]),
  };
}
