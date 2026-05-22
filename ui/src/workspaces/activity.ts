export interface BlockFinishedEvent {
  exitCode: number;
}

export interface ActivityState {
  unseenBlocks: number;
  hasFailure: boolean;
  hasAgentNote: boolean;
}

type Listener = (state: ActivityState) => void;

/// Per-workspace activity counter consumed by chip badges. The
/// LivePool wires one tracker per inactive workspace to its
/// TabManager's block-finished + agent-note streams. The tracker is
/// reset() whenever the workspace becomes active.
export class ActivityTracker {
  state: ActivityState = { unseenBlocks: 0, hasFailure: false, hasAgentNote: false };
  private listeners = new Set<Listener>();

  recordBlock(ev: BlockFinishedEvent): void {
    this.state = {
      ...this.state,
      unseenBlocks: this.state.unseenBlocks + 1,
      hasFailure: this.state.hasFailure || ev.exitCode !== 0,
    };
    this.emit();
  }

  recordAgentNote(): void {
    if (this.state.hasAgentNote) return;
    this.state = { ...this.state, hasAgentNote: true };
    this.emit();
  }

  reset(): void {
    this.state = { unseenBlocks: 0, hasFailure: false, hasAgentNote: false };
    this.emit();
  }

  onChange(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private emit(): void {
    for (const l of this.listeners) l(this.state);
  }
}
