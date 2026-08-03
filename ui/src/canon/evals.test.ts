import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { openDraftReview, openEvalProgressPanel } from "./evals";
import { canonWriteEvals } from "../api";

vi.mock("../api", () => ({
  canonDraftEvals: vi.fn().mockResolvedValue([]),
  canonListEvals: vi.fn().mockResolvedValue([]),
  canonRunEvals: vi.fn().mockResolvedValue(undefined),
  canonWriteEvals: vi.fn().mockResolvedValue(["kept-id"]),
  onCanonEvalProgress: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("../notifications/toast", () => ({ pushInfoToast: vi.fn() }));

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
    const checks = overlay.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    expect([...checks].every((c) => c.checked)).toBe(true);
    const write = overlay.querySelector(".canon-draft-write") as HTMLButtonElement;
    expect(write.textContent).toBe("Write 2 evals");
  });

  it("write button tracks the checked count and disables at zero", () => {
    const overlay = open();
    const checks = overlay.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    const write = overlay.querySelector(".canon-draft-write") as HTMLButtonElement;
    checks[0]!.click();
    expect(write.textContent).toBe("Write 1 eval");
    checks[1]!.click();
    expect(write.disabled).toBe(true);
  });

  it("writes only the checked drafts, with the edited textarea values", () => {
    const overlay = open();
    overlay.querySelectorAll<HTMLInputElement>("input[type=checkbox]")[1]!.click();
    const firstScenario = overlay.querySelector<HTMLTextAreaElement>("textarea")!;
    firstScenario.value = "edited scenario";
    (overlay.querySelector(".canon-draft-write") as HTMLButtonElement).click();
    expect(canonWriteEvals).toHaveBeenCalledWith("/repo", "skill", "horizon", [
      { id: "refuses-a-dirty-tree", scenario: "edited scenario", rubric: "r1" },
    ]);
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
    const p = openEvalProgressPanel("horizon", ["a", "b"]);
    expect(rowClasses(p.element)).toEqual([
      "canon-eval-progress-row is-pending",
      "canon-eval-progress-row is-pending",
    ]);
    expect(p.element.querySelector(".canon-eval-progress-tally")!.textContent).toBe("0/2");
  });

  it("tracks running → verdict per row and flips the tally to pass-rate", () => {
    const p = openEvalProgressPanel("horizon", ["a", "b"]);
    p.setStatus("a", "running", "");
    expect(rowClasses(p.element)[0]).toBe("canon-eval-progress-row is-running");
    p.setStatus("a", "pass", "refused correctly");
    p.setStatus("b", "fail", "pushed anyway");
    expect(rowClasses(p.element)).toEqual([
      "canon-eval-progress-row is-pass",
      "canon-eval-progress-row is-fail",
    ]);
    expect(p.element.querySelector(".canon-eval-progress-tally")!.textContent).toBe("1/2 pass");
    expect(p.element.textContent).toContain("pushed anyway");
  });

  it("finish marks unreached rows skipped, never fake-green", () => {
    const p = openEvalProgressPanel("horizon", ["a", "b"]);
    p.setStatus("a", "pass", "");
    p.finish();
    expect(rowClasses(p.element)[1]).toBe("canon-eval-progress-row is-skipped");
    expect(p.element.classList.contains("is-done")).toBe(true);
  });

  it("is single-instance and dismissible", () => {
    openEvalProgressPanel("one", ["a"]);
    const p2 = openEvalProgressPanel("two", ["b"]);
    expect(document.querySelectorAll(".canon-eval-progress").length).toBe(1);
    (p2.element.querySelector(".canon-eval-progress-close") as HTMLButtonElement).click();
    expect(document.querySelector(".canon-eval-progress")).toBeNull();
  });
});
