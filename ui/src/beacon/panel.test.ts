// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

const { openUrl } = vi.hoisted(() => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

import { renderBeacon, renderLoading, stateDotColor, isHttpUrl, fmtDuration } from "./panel";
import type { RunDetail, RunDetailState } from "./panel";
import type { BeaconState, BeaconJob } from "../api";

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
    onToggle: vi.fn(),
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
    expect(root.querySelector(".rail-chevron.is-open")).not.toBeNull();
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
});
