import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { EvalsCockpit } from "./evals-cockpit";
import {
  canonCancelEvals, canonEvalDetail, canonListEvalRuns, canonListEvals,
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
  { kind: "command", name: "green", passed: 2, total: 2, at_ms: Date.now() - 7_200_000 },
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
      expect(document.querySelector(".evc-pre")).not.toBeNull();
    });
    expect(canonEvalDetail).toHaveBeenCalledWith("/repo", "skill", "horizon", "dirty-tree");
    expect(document.querySelector(".evc-pre")!.textContent).toContain("I refuse");
    expect(document.querySelector(".evc-verdict-pass")!.textContent).toBe("Pass");
    expect(document.querySelector(".evc-verdict-meta")!.textContent).toContain("baseline fail");
    // Baseline tab swaps in the control arm's transcript.
    const baselineTab = [...document.querySelectorAll(".evc-tab")].find((t) => t.textContent === "Baseline")!;
    (baselineTab as HTMLButtonElement).click();
    expect(document.querySelector(".evc-pre")!.textContent).toContain("pushing now");
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
