/// Static command-palette action registry. Adding an action is one array
/// entry.
///
/// What is deliberately NOT here: new / rename / delete workspace, close
/// tab. Those used to be actions whose target was implicit
/// (`manager.activeId_()`), which is exactly why each one needed a second
/// surface to name its object. They are now row-scoped verbs in the palette
/// — the row under the cursor is the target (⌘E rename, ⌘⌫ destroy), and
/// create is the query itself (⌘⏎). An entry belongs here only when it has
/// no object at all.

import type { PaletteAction } from "./palette-items";

export function buildActions(): PaletteAction[] {
  return [
    {
      id: "open-vitals",
      title: "Vitals",
      run: () => {
        window.dispatchEvent(new CustomEvent("covenant:open-vitals"));
      },
    },
  ];
}
