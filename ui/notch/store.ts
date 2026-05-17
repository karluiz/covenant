export type ExecutorPhase =
  | { kind: "idle" }
  | { kind: "thinking" }
  | { kind: "running"; cmd: string }
  | { kind: "writing"; file: string }
  | { kind: "reading"; file: string }
  | { kind: "waiting"; reason: string }
  | { kind: "done"; summary?: string | null };

export interface PillInput {
  sessionId: string;
  tabLabel: string;
  tabColor: string;
  phase: ExecutorPhase;
}

export interface Pill extends PillInput {
  phaseStartedAt: number;
  lastEventAt: number;
  expandStickyUntil?: number;
  compact: boolean;
}

const DONE_TTL_MS = 2500;
const THINKING_STALE_MS = 8000;
const STICKY_MS = 8000;

export class StackStore {
  private map = new Map<string, Pill>();
  private listeners = new Set<() => void>();

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    this.listeners.forEach((fn) => fn());
  }

  apply(input: PillInput): void {
    const prev = this.map.get(input.sessionId);
    const samePhase =
      prev && JSON.stringify(prev.phase) === JSON.stringify(input.phase);
    const sameMeta =
      prev &&
      prev.tabLabel === input.tabLabel &&
      prev.tabColor === input.tabColor;
    const now = Date.now();
    const pill: Pill = {
      ...input,
      phaseStartedAt: samePhase ? prev!.phaseStartedAt : now,
      lastEventAt: now,
      expandStickyUntil: prev?.expandStickyUntil,
      compact: false,
    };
    this.map.set(input.sessionId, pill);
    this.recomputeCompact();
    // Skip re-render when nothing visible changed. lastEventAt-only updates
    // (e.g. every OutputChunk) would otherwise restart CSS animations and
    // make the pill flicker.
    if (prev && samePhase && sameMeta) return;
    this.emit();
  }

  expandSticky(sessionId: string): void {
    const p = this.map.get(sessionId);
    if (!p) return;
    p.expandStickyUntil = Date.now() + STICKY_MS;
    this.recomputeCompact();
    this.emit();
  }

  dismiss(sessionId: string): void {
    const p = this.map.get(sessionId);
    if (p && p.phase.kind === "done") {
      this.map.delete(sessionId);
      this.emit();
    }
  }

  /// Force-remove a pill regardless of phase. Used when the backend signals
  /// Idle (agent quit / returned to plain shell).
  drop(sessionId: string): void {
    if (this.map.delete(sessionId)) this.emit();
  }

  /** Remove Done pills past their TTL, and stale Thinking pills that
   * never got a follow-up state change (almost always scrollback replay
   * or restored sessions that aren't really doing anything). */
  gc(): void {
    const now = Date.now();
    let changed = false;
    for (const [k, p] of this.map) {
      if (p.phase.kind === "done" && now - p.phaseStartedAt > DONE_TTL_MS) {
        this.map.delete(k);
        changed = true;
      } else if (
        p.phase.kind === "thinking" &&
        now - p.lastEventAt > THINKING_STALE_MS
      ) {
        this.map.delete(k);
        changed = true;
      }
    }
    this.recomputeCompact();
    if (changed) this.emit();
  }

  pills(): Pill[] {
    return [...this.map.values()].sort(
      (a, b) => b.phaseStartedAt - a.phaseStartedAt,
    );
  }

  private recomputeCompact(): void {
    // Compact mode disabled — pills always render expanded. The shrink
    // animation read as a glitch ("error") in actual use, so the UX is
    // simpler with one consistent pill size.
    for (const p of this.map.values()) {
      p.compact = false;
    }
  }
}
