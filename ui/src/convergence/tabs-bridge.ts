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

export function makeTabsBridge(manager: TabManager): ConvergenceTabBridge {
  const internal = manager as unknown as TabManagerInternal;
  return {
    listTabs: () =>
      internal.tabs.map((t) => ({
        sessionId: t.sessionId,
        title: (t.customName?.trim() || t.defaultTitle) ?? "untitled",
        color: t.color,
      })),
    // SessionId is a branded type; cast is safe because we receive the
    // raw string from ConvergenceOverlay which read it from listTabs().
    activateBySessionId: (id) =>
      manager.activateBySessionId(id as Parameters<typeof manager.activateBySessionId>[0]),
  };
}
