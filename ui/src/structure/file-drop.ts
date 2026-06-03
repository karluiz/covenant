// Native OS file drag-drop into the file tree.
//
// In Tauri 2 a real OS file drop is a WINDOW-level event, not an HTML5
// DnD event — the webview's HTML5 `drop` never fires for files dragged
// from Finder. So we subscribe to `getCurrentWebview().onDragDropEvent`,
// which gives us `enter` / `over` / `drop` / `leave` with the pointer
// `position` (physical pixels) and, on drop, the absolute `paths`.
//
// We hit-test the position against the tree's DOM to find the target
// folder, highlight it while hovering, and copy the dropped paths in on
// drop. Drops outside the tree (terminal, other panels) are ignored.

import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { StructureTree } from "./tree";

/// Wire native file-drop into `tree`. Returns a cleanup function that
/// detaches the listener.
export function attachFileDrop(tree: StructureTree): () => void {
  let highlighted: HTMLElement | null = null;

  const clearHighlight = (): void => {
    if (highlighted) {
      highlighted.classList.remove("structure-drop-target");
      highlighted = null;
    }
  };

  const setHighlight = (el: HTMLElement): void => {
    if (highlighted === el) return;
    clearHighlight();
    el.classList.add("structure-drop-target");
    highlighted = el;
  };

  // Tauri 2's onDragDropEvent already reports the pointer in logical (CSS)
  // pixels, which is exactly what elementFromPoint expects — do NOT divide
  // by devicePixelRatio (that mis-hits on Retina/dpr>1 displays).
  const targetAt = (position: { x: number; y: number }) => {
    if (!tree.isVisible()) return null;
    const el = document.elementFromPoint(position.x, position.y);
    return tree.resolveDropTarget(el);
  };

  const unlisten = getCurrentWebview().onDragDropEvent((event) => {
    const p = event.payload;
    switch (p.type) {
      case "enter":
      case "over": {
        const target = targetAt(p.position);
        if (target) setHighlight(target.highlight);
        else clearHighlight();
        break;
      }
      case "drop": {
        const target = targetAt(p.position);
        clearHighlight();
        if (target && p.paths.length > 0) {
          void tree.ingestDrop(p.paths, target.dir);
        }
        break;
      }
      case "leave":
        clearHighlight();
        break;
    }
  });

  return () => {
    clearHighlight();
    void unlisten.then((un) => un());
  };
}
