import { Terminal } from "@xterm/xterm";
import { SerializeAddon } from "@xterm/addon-serialize";

/// Capture the full visible + scrollback buffer of `term` as an
/// ANSI-bearing string suitable for replay via `restoreSnapshot`.
/// Uses xterm.js's SerializeAddon under the hood — round-trip
/// fidelity is bounded by its semantics (no images, no in-progress
/// async writes; caller should await pending writes first).
export function serializeTab(term: Terminal): string {
  const addon = new SerializeAddon();
  term.loadAddon(addon);
  try {
    return addon.serialize();
  } finally {
    addon.dispose();
  }
}

/// Replay a snapshot string into a fresh terminal at its current
/// cursor position. Does NOT add a trailing newline; the next thing
/// written by the shell will continue on the current line.
export function restoreSnapshot(term: Terminal, snapshot: string): void {
  if (!snapshot) return;
  term.write(snapshot);
}
