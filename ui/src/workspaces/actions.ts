/// Static command-palette action registry. Adding an action is one
/// array entry. Rename and delete are delegated to callbacks the host
/// supplies (the switcher owns the prompt UI), defaulting to no-ops.

import type { TabManager } from "../tabs/manager";
import type { WorkspaceManager } from "./manager";
import type { PaletteAction } from "./palette-items";

export function buildActions(
  manager: WorkspaceManager,
  tabManager: TabManager,
  onRenameWorkspace?: (id: string) => void,
  onDeleteWorkspace?: (id: string) => void,
): PaletteAction[] {
  return [
    {
      id: "new-workspace",
      title: "New workspace",
      run: async () => {
        const name = `Workspace ${manager.list().length + 1}`;
        const id = manager.create(name);
        await manager.switchTo(id);
      },
    },
    {
      id: "rename-workspace",
      title: "Rename current workspace",
      run: () => onRenameWorkspace?.(manager.activeId_()),
    },
    {
      id: "delete-workspace",
      title: "Delete current workspace",
      run: () => onDeleteWorkspace?.(manager.activeId_()),
    },
    {
      id: "close-tab",
      title: "Close current tab",
      run: () => tabManager.closeActiveTab(),
    },
  ];
}
