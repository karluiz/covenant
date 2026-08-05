import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { EvalsCockpit, runScoreLabel, scoreSummary } from "./evals-cockpit";
import {
  canonCancelEvals, canonEvalDetail, canonListEvalRuns, canonListEvals, canonRunEvals,
} from "../api";

vi.mock("../api", () => ({
  canonCancelEvals: vi.fn().mockResolvedValue(undefined),
  canonDeleteEval: vi.fn().mockResolvedValue(undefined),
  canonDraftEvals: vi.fn().mockResolvedValue([]),
  canonEvalDetail: vi.fn().mockRejectedValue(new Error("no run recorded")),
  canonListEvalRuns: vi.fn().mockResolvedValue({ live: [], history: [] }),
  canonListEvals: vi.fn().mockResolvedValue([]),
  canonRunEvals: vi.fn().mockResolvedValue(undefined),
  canonUpdateEval: vi.fn().mockResolvedValue(undefined),
  canonWriteEvals: vi.fn().mockResolvedValue([]),
  onCanonEvalProgress: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("../notifications/toast", () => ({ pushInfoToast: vi.fn() }));
vi.mock("../workspaces/confirm-prompt", () => ({ openConfirmPrompt: vi.fn() }));

const liveRun = {
  run_id: "01RUN",
  kind: "skill",
  name: "horizon",
  cwd: "/repo",
  started_at_ms: Date.now() - 60_000,
  done: false,
  cancelled: false,
  cases: [
    { eval_id: "dirty-tree", status: "pass", reason: "refused", arm: "", duration_ms: 41_000, started_at_ms: 1 },
    { eval_id: "no-push", status: "running", reason: "", arm: "baseline", duration_ms: null, started_at_ms: Date.now() },
    { eval_id: "later", status: "pending", reason: "", arm: "", duration_ms: null, started_at_ms: null },
  ],
};

const history = [
  // Legacy record (pre-`cases`) — falls back to the unit's last recorded state.
  { kind: "command", name: "green", passed: 2, total: 2, at_ms: Date.now() - 7_200_000, cases: [] },
  // Two runs of the same unit, each carrying its own per-case verdicts.
  // The newer one carries a weighted-criteria score; the older predates it.
  {
    kind: "skill", name: "horizon", passed: 2, total: 2, at_ms: Date.now() - 3_600_000,
    score: 180, max_score: 200,
    cases: [
      { eval_id: "dirty-tree", pass: true, reason: "newer refusal", duration_ms: 30_000 },
      { eval_id: "no-push", pass: true, reason: "held the push", duration_ms: 20_000 },
    ],
  },
  {
    kind: "skill", name: "horizon", passed: 1, total: 2, at_ms: Date.now() - 14_400_000,
    cases: [
      { eval_id: "dirty-tree", pass: false, reason: "pushed anyway", duration_ms: 55_000 },
      { eval_id: "no-push", pass: true, reason: "held the push", duration_ms: 21_000 },
    ],
  },
];

const detail = {
  eval_id: "dirty-tree",
  scenario: "release with a dirty tree",
  rubric: "must refuse",
  pass: true,
  reason: "refused and said why",
  ran_at_ms: Date.now(),
  duration_ms: 41_000,
  baseline_pass: false,
  executor_model: "sonnet",
  judge_model: "judge-x",
  transcript: "I refuse: the tree is dirty.",
  baseline_transcript: "sure, pushing now",
};

async function openCockpit(): Promise<EvalsCockpit> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const c = new EvalsCockpit(host);
  await c.open("/repo");
  return c;
}

describe("scoreSummary", () => {
  it("computes pct, baseline pct and lift", () => {
    const d = {
      score: 75, max_score: 100, baseline_score: 15,
      criteria: [{ id: "a", pass: true, reason: "", points: 75 }],
    } as never;
    expect(scoreSummary(d)).toEqual({ pct: 75, basePct: 15, lift: 60 });
  });

  it("is null for legacy details and lift null without baseline", () => {
    expect(scoreSummary({ score: 0, max_score: 0 } as never)).toBeNull();
    expect(scoreSummary({ score: 50, max_score: 100, baseline_score: null } as never))
      .toEqual({ pct: 50, basePct: null, lift: null });
  });
});

describe("runScoreLabel", () => {
  it("renders pct only when criteria data exists", () => {
    expect(runScoreLabel({ score: 150, max_score: 200 } as never)).toBe("75%");
    expect(runScoreLabel({ score: 0, max_score: 0 } as never)).toBe("");
  });
});

describe("EvalsCockpit", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    document.body.className = "";
    (canonListEvalRuns as Mock).mockResolvedValue({ live: [liveRun], history });
    (canonEvalDetail as Mock).mockClear();
    (canonEvalDetail as Mock).mockResolvedValue(detail);
    (canonCancelEvals as Mock).mockClear();
    (canonListEvals as Mock).mockClear();
  });

  it("renders RUNNING and HISTORY rail sections and auto-selects the live run", async () => {
    const c = await openCockpit();
    const sections = [...document.querySelectorAll(".evc-section")].map((s) => s.textContent);
    expect(sections).toEqual(["Running", "History"]); // uppercased via CSS, not string
    expect(document.querySelector(".evc-run-row.is-selected")!.textContent).toContain("horizon");
    // Case rows come from the registry snapshot: pass dot, live elapsed, pending dash.
    const cases = document.querySelectorAll(".evc-case");
    expect(cases.length).toBe(3);
    expect(cases[0]!.querySelector(".evc-dot")!.className).toContain("is-pass");
    expect(cases[0]!.querySelector(".evc-case-dur")!.textContent).toBe("41s");
    expect(cases[1]!.textContent).toContain("baseline arm");
    expect(cases[2]!.querySelector(".evc-case-dur")!.textContent).toBe("—");
    c.close();
  });

  it("selecting a settled case loads the transcript tabs and verdict strip", async () => {
    const c = await openCockpit();
    (document.querySelectorAll(".evc-case")[0] as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(document.querySelector(".evc-md")).not.toBeNull();
    });
    expect(canonEvalDetail).toHaveBeenCalledWith("/repo", "skill", "horizon", "dirty-tree");
    // Markdown preview is the default; Source swaps in the raw pre.
    expect(document.querySelector(".evc-md")!.textContent).toContain("I refuse");
    expect(document.querySelector(".evc-pre")).toBeNull();
    const srcBtn = [...document.querySelectorAll(".evc-md-mode")].find((b) => b.textContent === "Source")!;
    (srcBtn as HTMLButtonElement).click();
    expect(document.querySelector(".evc-md")).toBeNull();
    expect(document.querySelector(".evc-pre")!.textContent).toContain("I refuse");
    expect(document.querySelector(".evc-verdict-pass")!.textContent).toBe("Pass");
    expect(document.querySelector(".evc-verdict-meta")!.textContent).toContain("baseline fail");
    // Baseline tab swaps in the control arm's transcript (source view sticks).
    const baselineTab = [...document.querySelectorAll(".evc-tab")].find((t) => t.textContent === "Baseline")!;
    (baselineTab as HTMLButtonElement).click();
    expect(document.querySelector(".evc-pre")!.textContent).toContain("pushing now");
    c.close();
  });

  it("each history row shows its own run's verdicts, not the unit's last state", async () => {
    const c = await openCockpit();
    const rows = [...document.querySelectorAll(".evc-run-row")].filter((r) =>
      r.textContent!.includes("horizon") && r.textContent!.includes("pass"));
    // Older horizon run (1/2 pass) — its own cases, no fetch of authored evals.
    const older = rows.find((r) => r.textContent!.includes("1/2"))!;
    (older as HTMLButtonElement).click();
    let dots = [...document.querySelectorAll(".evc-case .evc-dot")].map((d) => d.className);
    expect(dots[0]).toContain("is-fail");
    expect(canonListEvals).not.toHaveBeenCalled();
    // Newer horizon run (2/2 pass) — all green.
    const newer = rows.find((r) => r.textContent!.includes("2/2"))!;
    (newer as HTMLButtonElement).click();
    dots = [...document.querySelectorAll(".evc-case .evc-dot")].map((d) => d.className);
    expect(dots[0]).toContain("is-pass");
    c.close();
  });

  it("history rows show a score chip only when weighted-criteria data exists", async () => {
    const c = await openCockpit();
    const rows = [...document.querySelectorAll(".evc-run-row")].filter((r) =>
      r.textContent!.includes("horizon") && r.textContent!.includes("pass"));
    const newer = rows.find((r) => r.textContent!.includes("2/2"))!;
    const older = rows.find((r) => r.textContent!.includes("1/2"))!;
    expect(newer.textContent).toContain("90%");
    expect(older.textContent).not.toMatch(/%/);
    c.close();
  });

  it("retrying a case runs just that eval id without changing the current selection", async () => {
    const c = await openCockpit();
    (document.querySelectorAll(".evc-case")[2] as HTMLButtonElement).click(); // select "later"
    expect(document.querySelectorAll(".evc-case")[2]!.classList.contains("is-selected")).toBe(true);
    const retry = document.querySelectorAll(".evc-case")[0]!.querySelector(".evc-case-retry") as HTMLElement;
    retry.click();
    expect(canonRunEvals).toHaveBeenCalledWith("/repo", "skill", "horizon", { only: "dirty-tree" });
    expect(document.querySelectorAll(".evc-case")[2]!.classList.contains("is-selected")).toBe(true);
    expect(document.querySelectorAll(".evc-case")[0]!.classList.contains("is-selected")).toBe(false);
    c.close();
  });

  it("a superseded run's case shows the recorded reason and a retention note", async () => {
    const c = await openCockpit();
    const older = [...document.querySelectorAll(".evc-run-row")].find((r) =>
      r.textContent!.includes("1/2"))!;
    (older as HTMLButtonElement).click();
    (document.querySelectorAll(".evc-case")[0] as HTMLButtonElement).click();
    expect(document.querySelector(".evc-detail")!.textContent).toContain("pushed anyway");
    expect(document.querySelector(".evc-retention-note")).not.toBeNull();
    expect(document.querySelector(".evc-verdict-fail")!.textContent).toBe("Fail");
    expect(canonEvalDetail).not.toHaveBeenCalled();
    c.close();
  });

  it("the latest run's cases still open the full transcript detail", async () => {
    const c = await openCockpit();
    const newer = [...document.querySelectorAll(".evc-run-row")].find((r) =>
      r.textContent!.includes("horizon") && r.textContent!.includes("2/2"))!;
    (newer as HTMLButtonElement).click();
    (document.querySelectorAll(".evc-case")[0] as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(document.querySelector(".evc-md")).not.toBeNull();
    });
    expect(canonEvalDetail).toHaveBeenCalledWith("/repo", "skill", "horizon", "dirty-tree");
    c.close();
  });

  it("a running case shows a placeholder instead of a stale transcript", async () => {
    const c = await openCockpit();
    (document.querySelectorAll(".evc-case")[1] as HTMLButtonElement).click();
    expect(document.querySelector(".evc-detail")!.textContent).toContain("Running");
    expect(canonEvalDetail).not.toHaveBeenCalled();
    c.close();
  });

  it("Stop cancels the selected live run", async () => {
    const c = await openCockpit();
    (document.querySelector(".evc-stop") as HTMLButtonElement).click();
    expect(canonCancelEvals).toHaveBeenCalledWith("skill", "horizon");
    c.close();
  });

  it("selecting a history unit lists its authored evals", async () => {
    (canonListEvals as Mock).mockResolvedValue([{ id: "g1", scenario: "s", rubric: "r" }]);
    const c = await openCockpit();
    const historyRow = [...document.querySelectorAll(".evc-run-row")].find((r) => r.textContent!.includes("green"))!;
    (historyRow as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(document.querySelector(".evc-case-id")!.textContent).toBe("g1");
    });
    expect(canonListEvals).toHaveBeenCalledWith("/repo", "command", "green");
    c.close();
  });

  it("Escape closes and clears the fullscreen state", async () => {
    const c = await openCockpit();
    expect(document.body.classList.contains("evals-fullscreen")).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(c.isOpen).toBe(false);
    expect(document.body.classList.contains("evals-fullscreen")).toBe(false);
  });
});
