import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { openDraftReview, openEvalProgressPanel, openEvalManager } from "./evals";
import { canonCancelEvals, canonDeleteEval, canonListEvals, canonUpdateEval, canonWriteEvals } from "../api";

vi.mock("../api", () => ({
  canonCancelEvals: vi.fn().mockResolvedValue(undefined),
  canonDeleteEval: vi.fn().mockResolvedValue(undefined),
  canonDraftEvals: vi.fn().mockResolvedValue([]),
  canonEvalDetail: vi.fn().mockRejectedValue(new Error("no run recorded")),
  canonListEvals: vi.fn().mockResolvedValue([]),
  canonRunEvals: vi.fn().mockResolvedValue(undefined),
  canonUpdateEval: vi.fn().mockResolvedValue(undefined),
  canonWriteEvals: vi.fn().mockResolvedValue(["kept-id"]),
  onCanonEvalProgress: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("../notifications/toast", () => ({ pushInfoToast: vi.fn() }));
// Auto-confirm: manager's Delete goes through the confirm card.
vi.mock("../workspaces/confirm-prompt", () => ({
  openConfirmPrompt: vi.fn(({ onConfirm }: { onConfirm: () => void }) => onConfirm()),
}));

const drafts = [
  { id: "refuses-a-dirty-tree", scenario: "s1", rubric: "r1" },
  { id: "never-skips-hooks", scenario: "s2", rubric: "r2" },
];

function open(): HTMLElement {
  openDraftReview("/repo", "skill", "horizon", drafts, document.createElement("button"), () => {});
  return document.querySelector(".canon-draft-overlay") as HTMLElement;
}

describe("openDraftReview", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    (canonWriteEvals as Mock).mockClear();
  });

  it("renders one editable card per draft, all included by default", () => {
    const overlay = open();
    expect(overlay.querySelectorAll(".canon-draft-item").length).toBe(2);
    const checks = overlay.querySelectorAll<HTMLInputElement>(".canon-draft-item > input[type=checkbox]");
    expect([...checks].every((c) => c.checked)).toBe(true);
    const write = overlay.querySelector(".canon-draft-write") as HTMLButtonElement;
    expect(write.textContent).toBe("Write 2 evals");
  });

  it("write button tracks the checked count and disables at zero", () => {
    const overlay = open();
    const checks = overlay.querySelectorAll<HTMLInputElement>(".canon-draft-item > input[type=checkbox]");
    const write = overlay.querySelector(".canon-draft-write") as HTMLButtonElement;
    checks[0]!.click();
    expect(write.textContent).toBe("Write 1 eval");
    checks[1]!.click();
    expect(write.disabled).toBe(true);
  });

  it("writes only the checked drafts, with edited textarea values and edited id", () => {
    const overlay = open();
    overlay.querySelectorAll<HTMLInputElement>(".canon-draft-item > input[type=checkbox]")[1]!.click();
    const idInput = overlay.querySelector<HTMLInputElement>(".canon-draft-item-id-input")!;
    idInput.value = "renamed-id";
    const firstScenario = overlay.querySelector<HTMLTextAreaElement>("textarea")!;
    firstScenario.value = "edited scenario";
    (overlay.querySelector(".canon-draft-write") as HTMLButtonElement).click();
    expect(canonWriteEvals).toHaveBeenCalledWith("/repo", "skill", "horizon", [
      { id: "renamed-id", scenario: "edited scenario", rubric: "r1" },
    ], undefined);
  });

  it("overwrite checkbox opts into clobbering existing ids", () => {
    const overlay = open();
    const overwrite = overlay.querySelector<HTMLInputElement>(".canon-draft-overwrite input")!;
    overwrite.click();
    (overlay.querySelector(".canon-draft-write") as HTMLButtonElement).click();
    expect((canonWriteEvals as Mock).mock.calls[0]![4]).toBe(true);
  });

  it("Discard closes without writing", () => {
    const overlay = open();
    (overlay.querySelector(".workspace-confirm-cancel") as HTMLButtonElement).click();
    expect(document.querySelector(".canon-draft-overlay")).toBeNull();
    expect(canonWriteEvals).not.toHaveBeenCalled();
  });
});

describe("openEvalProgressPanel", () => {
  beforeEach(() => document.body.replaceChildren());

  const rowClasses = (el: HTMLElement): string[] =>
    [...el.querySelectorAll(".canon-eval-progress-row")].map((r) => r.className);

  it("starts with one pending row per eval and a settled tally", () => {
    const p = openEvalProgressPanel("skill", "horizon", ["a", "b"]);
    expect(rowClasses(p.element)).toEqual([
      "canon-eval-progress-row is-pending",
      "canon-eval-progress-row is-pending",
    ]);
    expect(p.element.querySelector(".canon-eval-progress-tally")!.textContent).toBe("0/2");
  });

  it("tracks running → verdict per row and flips the tally to pass-rate", () => {
    const p = openEvalProgressPanel("skill", "horizon", ["a", "b"]);
    p.setStatus("a", "running", "");
    expect(rowClasses(p.element)[0]).toContain("is-running");
    p.setStatus("a", "pass", "refused correctly");
    p.setStatus("b", "fail", "pushed anyway");
    expect(rowClasses(p.element)[0]).toContain("is-pass");
    expect(rowClasses(p.element)[1]).toContain("is-fail");
    expect(p.element.querySelector(".canon-eval-progress-tally")!.textContent).toBe("1/2 pass");
    expect(p.element.textContent).toContain("pushed anyway");
  });

  it("shows the baseline arm and the with-arm duration", () => {
    const p = openEvalProgressPanel("skill", "horizon", ["a"]);
    p.setStatus("a", "running", "", "baseline");
    expect(p.element.textContent).toContain("baseline arm…");
    p.setStatus("a", "pass", "ok", "", 12_000);
    expect(p.element.querySelector(".canon-eval-progress-dur")!.textContent).toBe("12s");
  });

  it("creates rows lazily for unknown ids (relay reload path)", () => {
    const p = openEvalProgressPanel("skill", "horizon", []);
    p.setStatus("surprise", "running", "");
    expect(p.element.querySelectorAll(".canon-eval-progress-row").length).toBe(1);
    expect(p.element.textContent).toContain("surprise");
  });

  it("rows expand on click to show the full note", () => {
    const p = openEvalProgressPanel("skill", "horizon", ["a"]);
    const row = p.element.querySelector<HTMLElement>(".canon-eval-progress-row")!;
    row.click();
    expect(row.classList.contains("is-open")).toBe(true);
  });

  it("Stop cancels the backend run and disappears once done", () => {
    const p = openEvalProgressPanel("skill", "horizon", ["a"]);
    const stop = p.element.querySelector(".canon-eval-progress-stop") as HTMLButtonElement;
    stop.click();
    expect(canonCancelEvals).toHaveBeenCalledWith("skill", "horizon");
    p.finish();
    expect(p.element.querySelector(".canon-eval-progress-stop")).toBeNull();
  });

  it("finish marks unreached rows skipped, never fake-green", () => {
    const p = openEvalProgressPanel("skill", "horizon", ["a", "b"]);
    p.setStatus("a", "pass", "");
    p.finish();
    expect(rowClasses(p.element)[1]).toContain("is-skipped");
    expect(p.element.classList.contains("is-done")).toBe(true);
  });

  it("replaces a same-unit panel but stacks across units", () => {
    openEvalProgressPanel("skill", "one", ["a"]);
    openEvalProgressPanel("skill", "one", ["a"]);
    openEvalProgressPanel("skill", "two", ["b"]);
    expect(document.querySelectorAll(".canon-eval-progress").length).toBe(2);
    const p = document.querySelector(`.canon-eval-progress[data-key="skill/two"]`)!;
    (p.querySelector(".canon-eval-progress-close") as HTMLButtonElement).click();
    expect(document.querySelectorAll(".canon-eval-progress").length).toBe(1);
  });
});

describe("openEvalManager", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    (canonListEvals as Mock).mockResolvedValue([
      { id: "refuses-a-dirty-tree", scenario: "s1", rubric: "r1" },
    ]);
    (canonUpdateEval as Mock).mockClear();
    (canonDeleteEval as Mock).mockClear();
  });

  async function openMgr(): Promise<HTMLElement> {
    await openEvalManager("/repo", "skill", "horizon", () => {});
    return document.querySelector(".canon-eval-manager-overlay") as HTMLElement;
  }

  it("lists authored evals with editable fields", async () => {
    const overlay = await openMgr();
    expect(overlay.querySelectorAll(".canon-eval-manage-item").length).toBe(1);
    expect(overlay.textContent).toContain("refuses-a-dirty-tree");
  });

  it("Save persists the edited scenario/rubric via canon_update_eval", async () => {
    const overlay = await openMgr();
    const scenario = overlay.querySelector<HTMLTextAreaElement>("textarea")!;
    scenario.value = "tightened scenario";
    const save = [...overlay.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
    save.click();
    expect(canonUpdateEval).toHaveBeenCalledWith("/repo", "skill", "horizon", {
      id: "refuses-a-dirty-tree",
      scenario: "tightened scenario",
      rubric: "r1",
    });
  });

  it("Delete removes the eval after the confirm card", async () => {
    const overlay = await openMgr();
    const del = [...overlay.querySelectorAll("button")].find((b) => b.textContent === "Delete")!;
    del.click();
    expect(canonDeleteEval).toHaveBeenCalledWith("/repo", "skill", "horizon", "refuses-a-dirty-tree");
  });

  it("New eval adds an editable blank row with an id input", async () => {
    const overlay = await openMgr();
    const add = [...overlay.querySelectorAll("button")].find((b) => b.textContent === "New eval")!;
    add.click();
    expect(overlay.querySelectorAll(".canon-eval-manage-item").length).toBe(2);
    expect(overlay.querySelector(".canon-draft-item-id-input")).not.toBeNull();
  });
});
