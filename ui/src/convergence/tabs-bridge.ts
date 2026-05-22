import type { TabManager } from "../tabs/manager";
import type { ConvergenceTabBridge } from "./overlay";

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
    activateBySessionId: (id, _opts) =>
      manager.activateBySessionId(id as Parameters<typeof manager.activateBySessionId>[0]),
  };
}
