// Familiars registry — per-session map of which Familiar (if any)
// is bound to which terminal session. Populated by Task 32's
// spawn-on-operator-start flow; consumed by the status-bar
// indicator and anywhere else that needs to look up "the
// Familiar for this session".
//
// Stays a tiny module rather than living inside any class:
// - The status bar reads it on every active-tab change.
// - The tab manager writes to it after spawn.
// Decoupling keeps either side free to evolve.

const familiarBySession = new Map<string, string>();

const listeners = new Set<(sessionId: string, familiarId: string | null) => void>();

export function setFamiliarFor(sessionId: string, familiarId: string | null): void {
  if (familiarId === null) {
    familiarBySession.delete(sessionId);
  } else {
    familiarBySession.set(sessionId, familiarId);
  }
  for (const fn of listeners) {
    try { fn(sessionId, familiarId); } catch { /* listener errors are non-fatal */ }
  }
}

export function familiarFor(sessionId: string): string | null {
  return familiarBySession.get(sessionId) ?? null;
}

/// Subscribe to registry changes. Returns an unsubscribe function.
export function onFamiliarRegistryChange(
  fn: (sessionId: string, familiarId: string | null) => void,
): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
