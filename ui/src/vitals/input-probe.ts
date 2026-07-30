/// Input-latency sampling — the terminal vital. Measures a keystroke's trip
/// to the screen: t0 = key handed to the PTY write → echo chunk ARRIVES
/// (aux_ms, isolates the PTY round-trip) → chunk parsed + painted
/// (value_ms). Pure state machine: the clock and the sample sink are
/// injected so the whole thing unit-tests without xterm. The tab manager
/// owns the glue (onData / output-chunk / rAF).
export const INPUT_SAMPLE_MIN_INTERVAL_MS = 1000;
export const INPUT_SAMPLE_TIMEOUT_MS = 1000;

/// One printable character = one candidate sample. Escape sequences,
/// control chars, and multi-char pastes never echo 1:1.
export function isPrintableKey(data: string): boolean {
  if (data.length !== 1) return false;
  const c = data.charCodeAt(0);
  return c >= 0x20 && c !== 0x7f;
}

export class InputLatencyProbe {
  private awaitingEcho = false;
  private t0 = 0;
  private sessionId: string | null = null;
  private lastSampleAt = -Infinity;

  constructor(
    private readonly hooks: {
      now(): number;
      onSample(valueMs: number, auxMs: number): void;
    },
  ) {}

  /// Call when a keystroke is written to the PTY of the ACTIVE tab.
  onKeystroke(sessionId: string, atPrompt: boolean, printable: boolean): void {
    if (this.awaitingEcho) return; // one measurement in flight
    if (!atPrompt || !printable) return;
    const now = this.hooks.now();
    if (now - this.lastSampleAt < INPUT_SAMPLE_MIN_INTERVAL_MS) return;
    this.awaitingEcho = true;
    this.t0 = now;
    this.sessionId = sessionId;
  }

  /// Call when an output chunk ARRIVES for a session (before term.write).
  /// Returns the completion callback to invoke once the chunk is PAINTED
  /// (write callback + rAF), or null when this chunk closes no sample.
  onOutputChunk(sessionId: string): (() => void) | null {
    if (!this.awaitingEcho || sessionId !== this.sessionId) return null;
    const now = this.hooks.now();
    this.awaitingEcho = false;
    if (now - this.t0 > INPUT_SAMPLE_TIMEOUT_MS) return null; // not an echo
    const aux = now - this.t0;
    this.lastSampleAt = now;
    const t0 = this.t0;
    return () => {
      const value = this.hooks.now() - t0;
      if (value <= INPUT_SAMPLE_TIMEOUT_MS) this.hooks.onSample(value, aux);
    };
  }

  /// Tab switch / pane hidden / session end — drop the in-flight sample.
  cancel(): void {
    this.awaitingEcho = false;
    this.sessionId = null;
  }
}
