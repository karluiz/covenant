// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

const { openUrl } = vi.hoisted(() => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

import {
  renderBeacon,
  renderLoading,
  stateDotColor,
  isHttpUrl,
  fmtDuration,
  groupSteps,
  failedRunsToOpen,
} from "./panel";
import type { RunDetail, RunDetailState } from "./panel";
import type { BeaconState, BeaconJob, BeaconStep } from "../api";

const step = (name: string, over: Partial<BeaconStep> = {}): BeaconStep => ({
  name,
  state: "success",
  started_at: "2026-07-12T18:00:00Z",
  completed_at: "2026-07-12T18:00:10Z",
  ...over,
});

describe("groupSteps", () => {
  it("folds a LEADING run of Set up/Run actions steps as setup", () => {
    const g = groupSteps([
      step("Set up job"),
      step("Run actions/checkout@v4"),
      step("Install Tauri system dependencies"),
      step("Run pty + blocks tests"),
    ]);
    expect(g.setup.map((s) => s.name)).toEqual(["Set up job", "Run actions/checkout@v4"]);
    expect(g.work.map((s) => s.name)).toEqual([
      "Install Tauri system dependencies",
      "Run pty + blocks tests",
    ]);
    expect(g.post).toEqual([]);
    expect(g.setupFoldable).toBe(true);
  });

  it("folds trailing Post/Complete job steps as post; mid-list Run actions stays work", () => {
    const g = groupSteps([
      step("Set up job"),
      step("Build"),
      step("Run actions/upload-artifact@v4"),
      step("Post Setup Node"),
      step("Post Run actions/checkout@v4"),
      step("Complete job"),
    ]);
    expect(g.setup.map((s) => s.name)).toEqual(["Set up job"]);
    expect(g.work.map((s) => s.name)).toEqual(["Build", "Run actions/upload-artifact@v4"]);
    expect(g.post.map((s) => s.name)).toEqual([
      "Post Setup Node",
      "Post Run actions/checkout@v4",
      "Complete job",
    ]);
    expect(g.postFoldable).toBe(true);
  });

  it("a failed step inside a group makes it non-foldable — failures never hide", () => {
    const g = groupSteps([
      step("Set up job", { state: "failure" }),
      step("Build"),
    ]);
    expect(g.setup.length).toBe(1);
    expect(g.setupFoldable).toBe(false);
  });

  it("all-work list passes through", () => {
    const g = groupSteps([step("Build"), step("Test")]);
    expect(g.setup).toEqual([]);
    expect(g.post).toEqual([]);
    expect(g.work.length).toBe(2);
    expect(g.setupFoldable).toBe(false);
    expect(g.postFoldable).toBe(false);
  });
});

describe("failedRunsToOpen", () => {
  const r = (id: number, state: string) => ({ id, state });
  it("returns failed run ids not yet auto-opened", () => {
    expect(failedRunsToOpen([r(1, "failure"), r(2, "success"), r(3, "timed_out")], new Set())).toEqual([1, 3]);
    expect(failedRunsToOpen([r(1, "failure")], new Set([1]))).toEqual([]);
  });
  it("ignores busy runs and id 0", () => {
    expect(failedRunsToOpen([r(0, "failure"), r(2, "in_progress")], new Set())).toEqual([]);
  });
});

describe("renderLoading", () => {
  it("renders a loading notice", () => {
    const root = document.createElement("div");
    renderLoading(root);
    const el = root.querySelector(".rail-notice.is-loading");
    expect(el).not.toBeNull();
    expect(el?.textContent).toContain("Loading");
  });
});

describe("isHttpUrl", () => {
  it("accepts http and https URLs", () => {
    expect(isHttpUrl("https://example.com")).toBe(true);
    expect(isHttpUrl("http://example.com")).toBe(true);
  });

  it("rejects non-http schemes", () => {
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("ftp://example.com")).toBe(false);
    expect(isHttpUrl("data:text/html,<h1>x</h1>")).toBe(false);
  });

  it("rejects empty, null, and non-URL strings", () => {
    expect(isHttpUrl(null)).toBe(false);
    expect(isHttpUrl(undefined)).toBe(false);
    expect(isHttpUrl("")).toBe(false);
    expect(isHttpUrl("not a url")).toBe(false);
  });
});

describe("stateDotColor", () => {
  it("maps Actions run states to color classes", () => {
    expect(stateDotColor("success")).toBe("ok");
    expect(stateDotColor("in_progress")).toBe("busy");
    expect(stateDotColor("queued")).toBe("busy");
    expect(stateDotColor("failure")).toBe("bad");
    expect(stateDotColor("timed_out")).toBe("bad");
    expect(stateDotColor("cancelled")).toBe("idle");
    expect(stateDotColor("skipped")).toBe("idle");
    expect(stateDotColor("anything-else")).toBe("idle");
  });
});

type Run = Extract<BeaconState, { kind: "ok" }>["runs"][number];
function run(over: Partial<Run> = {}): Run {
  return {
    id: 1,
    name: "Release macOS",
    state: "success",
    run_number: 42,
    branch: "main",
    sha: "abc1234",
    actor: "karluiz",
    url: "https://github.com/o/r/actions/runs/1",
    updated_at: "2026-06-26T00:00:00Z",
    ...over,
  };
}

describe("renderBeacon", () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement("div");
  });

  it("renders sign-in prompt when not authed", () => {
    renderBeacon(root, { kind: "not_authed" });
    expect(root.textContent).toContain("Sign in with GitHub");
  });

  it("renders no-repo notice", () => {
    renderBeacon(root, { kind: "no_repo" });
    expect(root.textContent).toContain("No GitHub remote");
  });

  it("renders empty state when no workflows", () => {
    renderBeacon(root, { kind: "ok", repo: "o/r", runs: [] });
    expect(root.textContent).toContain("No workflows");
  });

  it("renders a sub-repo picker and fires onPick with the dir path", () => {
    const picked: string[] = [];
    renderBeacon(
      root,
      {
        kind: "repos",
        dirs: [
          { path: "/x/backend", repo: "o/backend" },
          { path: "/x/frontend", repo: "o/frontend" },
        ],
      },
      (p) => picked.push(p),
    );
    const cards = root.querySelectorAll(".rail-row");
    expect(cards.length).toBe(2);
    expect(root.textContent).toContain("2 sub-repos found");
    (cards[1] as HTMLElement).click();
    expect(picked).toEqual(["/x/frontend"]);
  });

  it("renders error message as a structured error state", () => {
    renderBeacon(root, { kind: "error", message: "boom" });
    expect(root.textContent).toContain("boom");
    expect(root.querySelector(".rail-empty.is-error")).not.toBeNull();
  });

  it("splits 'github: cause — remedy' into title/hint and offers Retry", () => {
    const retried: number[] = [];
    renderBeacon(
      root,
      {
        kind: "error",
        message: "github: forbidden — rate-limited or missing repo permission",
      },
      undefined,
      { onRetry: () => retried.push(1) },
    );
    expect(root.querySelector(".rail-empty-title")!.textContent).toBe(
      "forbidden",
    );
    expect(root.querySelector(".rail-empty-hint")!.textContent).toContain(
      "rate-limited",
    );
    const btn = root.querySelector(".rail-empty-btn") as HTMLButtonElement;
    expect(btn.textContent).toBe("Retry");
    btn.click();
    expect(retried).toEqual([1]);
  });

  it("offers Reconnect GitHub on auth errors", () => {
    const reconnected: number[] = [];
    renderBeacon(
      root,
      {
        kind: "error",
        message: "github: token invalid or expired — reconnect GitHub in Settings",
      },
      undefined,
      { onReconnect: () => reconnected.push(1), onRetry: () => {} },
    );
    const btns = [...root.querySelectorAll(".rail-empty-btn")].map(
      (b) => b.textContent,
    );
    expect(btns).toEqual(["Reconnect GitHub", "Retry"]);
    (root.querySelector(".rail-empty-btn") as HTMLButtonElement).click();
    expect(reconnected).toEqual([1]);
  });

  it("renders one row per workflow run with a status spine", () => {
    renderBeacon(root, {
      kind: "ok",
      repo: "o/r",
      runs: [
        run({ name: "Release macOS", state: "success" }),
        run({ name: "Release Windows", state: "in_progress", url: null }),
      ],
    });
    const rows = root.querySelectorAll(".rail-row");
    expect(rows.length).toBe(2);
    expect(root.querySelector('.rail-row[data-spine="ok"]')).not.toBeNull();
    expect(root.querySelector('.rail-row[data-spine="run"]')).not.toBeNull();
    expect(root.textContent).toContain("Release macOS");
    expect(root.textContent).toContain("#42");
    expect(root.textContent).toContain("abc1234");
  });

  it("does NOT produce a clickable link for a javascript: url", () => {
    renderBeacon(root, {
      kind: "ok",
      repo: "o/r",
      runs: [run({ url: "javascript:alert(1)" })],
    });
    expect(root.querySelector('.rail-row[role="link"]')).toBeNull();
    const all = root.querySelectorAll("[href]");
    for (const el of all) {
      expect(el.getAttribute("href")).not.toContain("javascript:");
    }
    expect(root.innerHTML).not.toContain("javascript:");
  });

  it("does NOT produce a clickable link when url is null", () => {
    renderBeacon(root, {
      kind: "ok",
      repo: "o/r",
      runs: [run({ url: null })],
    });
    expect(root.querySelector('.rail-row[role="link"]')).toBeNull();
  });

  it("produces a clickable row for an https:// url", () => {
    renderBeacon(root, {
      kind: "ok",
      repo: "o/r",
      runs: [run({ url: "https://github.com/o/r/actions/runs/9" })],
    });
    const link = root.querySelector('.rail-row[role="link"]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute("role")).toBe("link");
    expect(link?.getAttribute("tabindex")).toBe("0");
    expect(link?.getAttribute("href")).toBeNull();
  });

  it("opens the run URL via the ↗ action button", () => {
    openUrl.mockClear();
    renderBeacon(root, {
      kind: "ok",
      repo: "o/r",
      runs: [run({ url: "https://github.com/o/r/actions/runs/9" })],
    });
    const btn = root.querySelector<HTMLButtonElement>('[aria-label="Open on GitHub"]');
    expect(btn).not.toBeNull();
    btn!.click();
    expect(openUrl).toHaveBeenCalledWith("https://github.com/o/r/actions/runs/9");
  });
});

describe("fmtDuration", () => {
  it("formats seconds, minutes, hours", () => {
    const t0 = "2026-07-12T18:00:00Z";
    expect(fmtDuration(t0, "2026-07-12T18:00:41Z")).toBe("41s");
    expect(fmtDuration(t0, "2026-07-12T18:03:10Z")).toBe("3m10s");
    expect(fmtDuration(t0, "2026-07-12T19:05:00Z")).toBe("1h5m");
  });

  it("uses `now` for still-running spans and empties on bad input", () => {
    const t0 = "2026-07-12T18:00:00Z";
    const now = Date.parse("2026-07-12T18:00:30Z");
    expect(fmtDuration(t0, null, now)).toBe("30s");
    expect(fmtDuration(null, null)).toBe("");
    expect(fmtDuration("garbage", null)).toBe("");
  });
});

describe("run detail expansion", () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement("div");
    openUrl.mockClear();
  });

  const jobs: BeaconJob[] = [
    {
      id: 101,
      name: "build-sign-notarize",
      state: "in_progress",
      started_at: "2026-07-12T18:00:00Z",
      completed_at: null,
      steps: [
        { name: "Checkout", state: "success", started_at: "2026-07-12T18:00:01Z", completed_at: "2026-07-12T18:00:03Z" },
        { name: "Notarize", state: "in_progress", started_at: "2026-07-12T18:03:00Z", completed_at: null },
      ],
    },
  ];

  const okState: BeaconState = {
    kind: "ok",
    repo: "o/r",
    runs: [run({ id: 7, name: "Release macOS", state: "in_progress", url: "https://github.com/o/r/actions/runs/7" })],
  };

  const detail = (over: Partial<RunDetail> = {}): RunDetail => ({
    expanded: new Set<number>(),
    jobs: new Map<number, RunDetailState>(),
    folds: new Set<string>(),
    onToggle: vi.fn(),
    onToggleFold: vi.fn(),
    ...over,
  });

  it("row click toggles expansion instead of opening the URL", () => {
    const d = detail();
    renderBeacon(root, okState, undefined, undefined, undefined, d);
    (root.querySelector(".rail-row") as HTMLElement).click();
    expect(d.onToggle).toHaveBeenCalledWith(7);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("renders job and step rows when expanded", () => {
    const d = detail({
      expanded: new Set([7]),
      jobs: new Map<number, RunDetailState>([[7, { kind: "jobs", jobs }]]),
    });
    renderBeacon(root, okState, undefined, undefined, undefined, d);
    const jobNames = [...root.querySelectorAll(".rail-job-name")].map((e) => e.textContent);
    expect(jobNames).toEqual(["build-sign-notarize"]);
    const stepNames = [...root.querySelectorAll(".rail-step-name")].map((e) => e.textContent);
    expect(stepNames).toEqual(["Checkout", "Notarize"]);
    // Chevron marks the open state.
    expect(root.querySelector(".rail-chev.is-open")).not.toBeNull();
  });

  it("renders loading and error detail states", () => {
    const dLoading = detail({
      expanded: new Set([7]),
      jobs: new Map<number, RunDetailState>([[7, { kind: "loading" }]]),
    });
    renderBeacon(root, okState, undefined, undefined, undefined, dLoading);
    expect(root.querySelector(".rail-jobs-loading")).not.toBeNull();

    const dErr = detail({
      expanded: new Set([7]),
      jobs: new Map<number, RunDetailState>([[7, { kind: "error", message: "github: boom" }]]),
    });
    renderBeacon(root, okState, undefined, undefined, undefined, dErr);
    expect(root.querySelector(".rail-jobs-error")?.textContent).toContain("boom");
  });

  it("renders the run state as a pill in a single-line meta strip", () => {
    renderBeacon(root, okState, undefined, undefined, undefined, detail());
    const pill = root.querySelector(".rail-pill");
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toBe("in progress");
    expect(pill?.classList.contains("is-busy")).toBe(true);
    // ref is accent-tagged, actor is the truncating slot
    expect(root.querySelector(".rail-meta .is-ref")?.textContent).toBe("main");
    expect(root.querySelector(".rail-meta .is-actor")?.textContent).toBe("karluiz");
  });

  const taxJobs: BeaconJob[] = [
    {
      id: 101,
      name: "build",
      state: "in_progress",
      started_at: "2026-07-12T18:00:00Z",
      completed_at: null,
      steps: [
        { name: "Set up job", state: "success", started_at: "2026-07-12T18:00:00Z", completed_at: "2026-07-12T18:00:01Z" },
        { name: "Run actions/checkout@v4", state: "success", started_at: "2026-07-12T18:00:01Z", completed_at: "2026-07-12T18:00:03Z" },
        { name: "Build Tauri bundles", state: "in_progress", started_at: "2026-07-12T18:00:03Z", completed_at: null },
        { name: "Upload to release", state: "queued", started_at: null, completed_at: null },
        { name: "Post Run actions/checkout@v4", state: "queued", started_at: null, completed_at: null },
      ],
    },
  ];

  const taxDetail = (folds = new Set<string>()) =>
    detail({
      expanded: new Set([7]),
      jobs: new Map<number, RunDetailState>([[7, { kind: "jobs", jobs: taxJobs }]]),
      folds,
    });

  it("job header shows done/total counter and a progress bar", () => {
    renderBeacon(root, okState, undefined, undefined, undefined, taxDetail());
    expect(root.querySelector(".rail-job-count")?.textContent).toBe("2/5");
    const bar = root.querySelector<HTMLElement>(".rail-job-bar i");
    expect(bar).not.toBeNull();
    expect(bar!.style.width).toBe("40%");
  });

  it("ceremony steps fold to a summary row; clicking it fires onToggleFold", () => {
    const d = taxDetail();
    renderBeacon(root, okState, undefined, undefined, undefined, d);
    const folds = [...root.querySelectorAll(".rail-fold")];
    expect(folds.length).toBe(2); // setup + post
    expect(folds[0].textContent).toContain("setup · 2 steps");
    expect(folds[1].textContent).toContain("post · 1 step");
    // folded ceremony steps are not rendered as step rows
    const stepNames = [...root.querySelectorAll(".rail-step-name")].map((e) => e.textContent);
    expect(stepNames).toEqual(["Build Tauri bundles", "Upload to release"]);
    (folds[0] as HTMLElement).click();
    expect(d.onToggleFold).toHaveBeenCalledWith("7:101:setup");
  });

  it("an open fold renders its steps inline", () => {
    renderBeacon(root, okState, undefined, undefined, undefined, taxDetail(new Set(["7:101:setup"])));
    const stepNames = [...root.querySelectorAll(".rail-step-name")].map((e) => e.textContent);
    expect(stepNames).toEqual([
      "Set up job",
      "Run actions/checkout@v4",
      "Build Tauri bundles",
      "Upload to release",
    ]);
  });

  it("marks the running step as .is-now and pending durations as em-dash", () => {
    renderBeacon(root, okState, undefined, undefined, undefined, taxDetail());
    const now = root.querySelector(".rail-step.is-now .rail-step-name");
    expect(now?.textContent).toBe("Build Tauri bundles");
    const stepsAll = [...root.querySelectorAll(".rail-step")];
    const pendDur = stepsAll[stepsAll.length - 1]?.querySelector(".rail-step-dur");
    expect(pendDur?.textContent).toBe("—");
  });

  it("marks a failed step with .is-fail-step and never folds its group", () => {
    const failJobs: BeaconJob[] = [
      {
        id: 102,
        name: "manifest",
        state: "failure",
        started_at: "2026-07-12T18:00:00Z",
        completed_at: "2026-07-12T18:01:00Z",
        steps: [
          { name: "Set up job", state: "failure", started_at: "2026-07-12T18:00:00Z", completed_at: "2026-07-12T18:00:05Z" },
          { name: "Compose latest.json", state: "skipped", started_at: null, completed_at: null },
        ],
      },
    ];
    const d = detail({
      expanded: new Set([7]),
      jobs: new Map<number, RunDetailState>([[7, { kind: "jobs", jobs: failJobs }]]),
    });
    renderBeacon(root, okState, undefined, undefined, undefined, d);
    expect(root.querySelector(".rail-fold")).toBeNull(); // failed setup can't fold
    expect(root.querySelector(".rail-step.is-fail-step .rail-step-name")?.textContent).toBe("Set up job");
  });
});
