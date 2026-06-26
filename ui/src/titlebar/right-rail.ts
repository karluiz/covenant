/// Targets that live IN the right rail. The Browser/globe button is
/// intentionally NOT a RailTarget — it toggles a main-area browser tab and is
/// not governed by the fold (see main.ts `toggleBrowser`).
export type RailTarget =
  | "blocks"
  | "structure"
  | "activity"
  | "recall"
  | "notes"
  | "cdlc"
  | "teammate"
  | "tasker"
  | "resources"
  | "beacon";

/// Side-effects the controller drives. Implementations live in main.ts and
/// know nothing about each other — the controller sequences them. Keeping this
/// an interface is what makes the controller unit-testable without the DOM.
export interface RailAdapters {
  /// Show the target's panel/view. Must NOT do exclusivity or highlighting.
  open(target: RailTarget): void;
  /// Hide the target's panel/view (idempotent). Must NOT restore other state.
  close(target: RailTarget): void;
  /// Collapse/expand the right rail (body class + persistence + refit).
  setFolded(folded: boolean): void;
  /// Light exactly one rail button, or none when target is null. Must not
  /// touch the globe button.
  highlight(target: RailTarget | null): void;
}

/// Single source of truth for "what is the right rail showing." `null` == folded.
export class RightRailController {
  private current: RailTarget | null;
  private last: RailTarget;

  constructor(
    private readonly adapters: RailAdapters,
    initial: RailTarget | null,
    /// Seeds the "last shown" target that toggleFold() restores when unfolding.
    /// Defaults to `initial` (or "blocks"). Pass the persisted view explicitly
    /// so a reload-while-folded restores that view, not just "blocks".
    lastSeed: RailTarget = initial ?? "blocks",
  ) {
    this.current = initial;
    this.last = lastSeed;
  }

  get target(): RailTarget | null {
    return this.current;
  }

  /// Click handler for every rail button: open it, or fold if it's already active.
  toggle(target: RailTarget): void {
    this.setTarget(this.current === target ? null : target);
  }

  /// The fold button: collapse what's open, or restore the last target.
  toggleFold(): void {
    this.setTarget(this.current === null ? this.last : null);
  }

  /// External request to open a target (group-chip, ⌘⇧J, draft flows).
  open(target: RailTarget): void {
    this.setTarget(target);
  }

  /// A panel closed itself (its own close button or an external close event).
  /// Sync controller state without calling close() again.
  handleExternalClose(target: RailTarget): void {
    if (this.current === target) this.setTarget(null, true);
  }

  /// A tab reported its underlying view (blocks<->structure). Update the
  /// highlight in place, only when a view is currently the rail target.
  syncView(view: "blocks" | "structure"): void {
    if (this.current === view) return;
    if (this.current === "blocks" || this.current === "structure") {
      this.current = view;
      this.last = view;
      this.adapters.highlight(view);
    }
  }

  /// The one mutation path. `skipClose` is set when the old target already
  /// closed itself (avoids a re-entrant double-close).
  private setTarget(next: RailTarget | null, skipClose = false): void {
    if (this.current === next) return;
    if (this.current !== null && !skipClose) this.adapters.close(this.current);
    if (next !== null) this.adapters.open(next);
    this.adapters.setFolded(next === null);
    this.adapters.highlight(next);
    if (next !== null) this.last = next;
    this.current = next;
  }
}
