/// Buffered, fire-and-forget sink for UI vitals. Never throws into the
/// hot paths that call record(); a wedged backend loses vitals, never
/// frames. No timer while the buffer is empty (idle cost zero).
export type VitalMetric = "switch" | "input" | "boot";

export interface VitalEvent {
  metric: VitalMetric;
  value_ms: number;
  aux_ms: number | null;
  detail: Record<string, unknown> | null;
}

export const VITALS_FLUSH_MS = 5000;
export const VITALS_BUFFER_CAP = 500;

export class VitalsCollector {
  private buffer: VitalEvent[] = [];
  private timer: number | null = null;

  constructor(private readonly send: (events: VitalEvent[]) => Promise<void>) {}

  record(
    metric: VitalMetric,
    valueMs: number,
    auxMs: number | null = null,
    detail: Record<string, unknown> | null = null,
  ): void {
    if (this.buffer.length >= VITALS_BUFFER_CAP) this.buffer.shift();
    this.buffer.push({ metric, value_ms: valueMs, aux_ms: auxMs, detail });
    if (this.timer === null) {
      this.timer = window.setTimeout(() => this.flush(), VITALS_FLUSH_MS);
    }
  }

  flush(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      void this.send(batch).catch(() => {});
    } catch {
      /* never propagate into the caller */
    }
  }

  dispose(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.buffer = [];
  }
}
