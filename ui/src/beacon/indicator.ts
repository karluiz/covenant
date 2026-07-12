// Titlebar beacon live indicator — ambient GitHub Actions state on the
// #titlebar-beacon icon: amber pulse while any run is busy, persistent
// red on an unacknowledged failure, brief green flash when a busy repo
// goes all-green. Polls on its own only while the Beacon panel is
// closed; the open panel's 25s poll feeds it via feed() instead.

import { beaconWorkflowRuns, type BeaconState } from "../api";
import { stateDotColor } from "./panel";

// ponytail: reuses beacon_workflow_runs, which is N+1 on the backend (one
// call per workflow, ≤26/tick on workflow-heavy repos). If ambient traffic
// ever matters, add a single-call /actions/runs aggregate endpoint and/or
// stretch the interval — the indicator only needs busy/fail/ok.
const POLL_MS = 45_000;
const OK_FLASH_MS = 5_000;

export type Aggregate = "quiet" | "busy" | "fail" | "ok";

/// Collapse a runs list into one icon state. `ackedFailId` is a high-water
/// mark: opening the panel acks the highest failed run id visible, and only
/// a NEWER failure (GitHub run ids are monotonic) re-flags — an older,
/// already-seen failure resurfacing at the top of the list stays quiet.
/// `wasBusy` turns the busy→all-green edge into a brief "ok" flash.
export function aggregateRuns(
  runs: { id: number; state: string }[],
  ackedFailId: number | null,
  wasBusy: boolean,
): { agg: Aggregate; newestFailId: number | null } {
  const busy = runs.some((r) => stateDotColor(r.state) === "busy");
  const failIds = runs.filter((r) => stateDotColor(r.state) === "bad").map((r) => r.id);
  const newestFailId = failIds.length ? Math.max(...failIds) : null;
  if (busy) return { agg: "busy", newestFailId };
  if (newestFailId != null && (ackedFailId == null || newestFailId > ackedFailId)) {
    return { agg: "fail", newestFailId };
  }
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
    this.syncCwd();
    this.apply(state);
  }

  /// New repo context — old acks and busy-edge state don't apply. Called
  /// from BOTH entry points (own poll and panel feed) so a tab switch while
  /// the panel is open can't carry stale ack/wasBusy into the new repo.
  private syncCwd(): string | null {
    const cwd = this.getCwd();
    if (cwd !== this.lastCwd) {
      this.lastCwd = cwd;
      this.ackedFailId = null;
      this.wasBusy = false;
    }
    return cwd;
  }

  private async poll(): Promise<void> {
    if (this.panelOpen) return;
    const cwd = this.syncCwd();
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
