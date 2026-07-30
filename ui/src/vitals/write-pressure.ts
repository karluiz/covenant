/// Global terminal write pressure over a trailing window.
///
/// Why: the switch vitals record `hiddenOutputBytes` for the tab being
/// activated, and on the four slowest real 0.11.6-era samples that was 0 B —
/// which reads as "buffered output is not the trigger". That inference has a
/// hole: the user reports the freeze happening specifically when several
/// agents are running, and pressure in the OTHER tabs (including the one on
/// screen) was never measured. This closes that hole, so the correlation can
/// be tested against real data instead of argued.
///
/// Bucketed ring so `add` stays O(1) and the read is O(buckets): every write
/// path funnels through here, including hot streaming output.

const BUCKET_MS = 100;
const BUCKETS = 50; // 5s window

interface Bucket {
  stamp: number; // bucket index this slot holds, -1 when unused
  bytes: number;
  writers: Set<string>;
}

export class WritePressure {
  private readonly buckets: Bucket[];
  constructor(private readonly now: () => number = () => performance.now()) {
    this.buckets = Array.from({ length: BUCKETS }, () => ({
      stamp: -1,
      bytes: 0,
      writers: new Set<string>(),
    }));
  }

  /// Record bytes delivered to one session's terminal.
  add(sessionId: string, bytes: number): void {
    const idx = Math.floor(this.now() / BUCKET_MS);
    const slot = this.buckets[idx % BUCKETS];
    if (slot.stamp !== idx) {
      slot.stamp = idx;
      slot.bytes = 0;
      slot.writers.clear();
    }
    slot.bytes += bytes;
    slot.writers.add(sessionId);
  }

  /// Bytes written across ALL sessions in the trailing `ms`.
  bytesInLast(ms: number): number {
    return this.reduce(ms, (acc, slot) => acc + slot.bytes, 0);
  }

  /// How many distinct sessions produced output in the trailing `ms` — the
  /// "how many agents were talking at once" number.
  writersInLast(ms: number): number {
    const seen = new Set<string>();
    this.reduce(ms, (_acc, slot) => {
      for (const w of slot.writers) seen.add(w);
      return 0;
    }, 0);
    return seen.size;
  }

  private reduce<T>(ms: number, fn: (acc: T, slot: Bucket) => T, init: T): T {
    const newest = Math.floor(this.now() / BUCKET_MS);
    const oldest = newest - Math.ceil(ms / BUCKET_MS);
    let acc = init;
    for (const slot of this.buckets) {
      if (slot.stamp < 0 || slot.stamp <= oldest || slot.stamp > newest) continue;
      acc = fn(acc, slot);
    }
    return acc;
  }
}
