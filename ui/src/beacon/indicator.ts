// Titlebar beacon live indicator — ambient GitHub Actions state on the
// #titlebar-beacon icon: amber pulse while any run is busy, persistent
// red on an unacknowledged failure, brief green flash when a busy repo
// goes all-green. Polls on its own only while the Beacon panel is
// closed; the open panel's 25s poll feeds it via feed() instead.

import { beaconWorkflowRuns, type BeaconState } from "../api";
import { stateDotColor } from "./panel";

const POLL_MS = 45_000;
const OK_FLASH_MS = 5_000;

export type Aggregate = "quiet" | "busy" | "fail" | "ok";

/// Collapse a runs list into one icon state. `ackedFailId` is the newest
/// failed run the user has already seen (opening the panel acks it);
/// `wasBusy` turns the busy→all-green edge into a brief "ok" flash.
export function aggregateRuns(
  runs: { id: number; state: string }[],
  ackedFailId: number | null,
  wasBusy: boolean,
): { agg: Aggregate; newestFailId: number | null } {
  const busy = runs.some((r) => stateDotColor(r.state) === "busy");
  // Runs arrive most-recently-updated first — the first bad one is newest.
  const newestFailId = runs.find((r) => stateDotColor(r.state) === "bad")?.id ?? null;
  if (busy) return { agg: "busy", newestFailId };
  if (newestFailId != null && newestFailId !== ackedFailId) return { agg: "fail", newestFailId };
  if (wasBusy) return { agg: "ok", newestFailId };
  return { agg: "quiet", newestFailId };
}

export class BeaconIndicator {
  private timer: number | null = null;
  private okTimer: number | null = null;
  private panelOpen = false;
  private wasBusy = false;
  private ackedFailId: number | null = null;
  private lastFailId: number | null = null;
  private lastCwd: string | null = null;

  constructor(
    private btn: HTMLElement,
    private getCwd: () => string | null,
  ) {}

  start(): void {
    this.stop();
    this.timer = window.setInterval(() => void this.poll(), POLL_MS);
    void this.poll();
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  /// Panel open: ack the visible failure and pause our poll (the panel's
  /// own 25s poll calls feed()). Close: resume polling.
  setPanelOpen(open: boolean): void {
    this.panelOpen = open;
    if (open) {
      this.ackedFailId = this.lastFailId;
      this.btn.classList.remove("is-fail");
      this.stop();
    } else {
      this.start();
    }
  }

  /// State pushed from the open panel's poll.
  feed(state: BeaconState): void {
    this.apply(state);
  }

  private async poll(): Promise<void> {
    if (this.panelOpen) return;
    const cwd = this.getCwd();
    if (cwd !== this.lastCwd) {
      // New repo context — old acks don't apply.
      this.lastCwd = cwd;
      this.ackedFailId = null;
      this.wasBusy = false;
    }
    if (!cwd) {
      this.setClasses("quiet");
      return;
    }
    try {
      this.apply(await beaconWorkflowRuns(cwd));
    } catch {
      this.setClasses("quiet"); // indicator never surfaces errors
    }
  }

  private apply(state: BeaconState): void {
    if (state.kind !== "ok") {
      this.wasBusy = false;
      this.setClasses("quiet");
      return;
    }
    const { agg, newestFailId } = aggregateRuns(state.runs, this.ackedFailId, this.wasBusy);
    this.lastFailId = newestFailId;
    this.wasBusy = agg === "busy";
    this.setClasses(agg);
  }

  private setClasses(agg: Aggregate): void {
    this.btn.classList.toggle("is-busy", agg === "busy");
    this.btn.classList.toggle("is-fail", agg === "fail");
    if (this.okTimer !== null) {
      window.clearTimeout(this.okTimer);
      this.okTimer = null;
    }
    this.btn.classList.toggle("is-ok", agg === "ok");
    if (agg === "ok") {
      this.okTimer = window.setTimeout(() => {
        this.btn.classList.remove("is-ok");
        this.okTimer = null;
      }, OK_FLASH_MS);
    }
  }
}
