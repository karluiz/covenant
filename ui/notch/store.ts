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
  expandStickyUntil?: number;
  compact: boolean;
}

const STABLE_MS = 5000;
const COMPACT_THRESHOLD = 4;
const DONE_TTL_MS = 2500;
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
    const pill: Pill = {
      ...input,
      phaseStartedAt: samePhase ? prev!.phaseStartedAt : Date.now(),
      expandStickyUntil: prev?.expandStickyUntil,
      compact: false,
    };
    this.map.set(input.sessionId, pill);
    this.recomputeCompact();
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

  /** Remove Done pills past TTL. Call on a 500ms timer in main.ts. */
  gc(): void {
    const now = Date.now();
    let changed = false;
    for (const [k, p] of this.map) {
      if (p.phase.kind === "done" && now - p.phaseStartedAt > DONE_TTL_MS) {
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
    const now = Date.now();
    const arr = [...this.map.values()];
    const nonWaiting = arr.filter((p) => p.phase.kind !== "waiting");
    const overflow = nonWaiting.length >= COMPACT_THRESHOLD;
    for (const p of arr) {
      if (p.phase.kind === "waiting") {
        p.compact = false;
        continue;
      }
      if (p.expandStickyUntil && now < p.expandStickyUntil) {
        p.compact = false;
        continue;
      }
      const stable = now - p.phaseStartedAt > STABLE_MS;
      p.compact = overflow || stable;
    }
  }
}
