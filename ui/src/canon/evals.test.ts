import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { openDraftReview, openEvalPill, openEvalManager } from "./evals";
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

  it("writes an edited Rubric textarea value for a rubric-only draft", () => {
    const overlay = open();
    overlay.querySelectorAll<HTMLInputElement>(".canon-draft-item > input[type=checkbox]")[1]!.click();
    const textareas = overlay.querySelectorAll<HTMLTextAreaElement>("textarea");
    // draft 0: [0] scenario, [1] rubric
    textareas[1]!.value = "edited rubric";
    (overlay.querySelector(".canon-draft-write") as HTMLButtonElement).click();
    expect(canonWriteEvals).toHaveBeenCalledWith("/repo", "skill", "horizon", [
      { id: "refuses-a-dirty-tree", scenario: "s1", rubric: "edited rubric" },
    ], undefined);
  });

  it("renders a draft's criteria as a read-only list under the scenario, instead of a rubric field", () => {
    document.body.replaceChildren();
    const withCriteria = [
      {
        id: "refuses-a-dirty-tree",
        scenario: "s1",
        rubric: "",
        criteria: [
          { id: "stops", text: "stops before committing", points: 60 },
          { id: "reports", text: "reports the dirty files", points: 40 },
        ],
      },
    ];
    openDraftReview("/repo", "skill", "horizon", withCriteria, document.createElement("button"), () => {});
    const overlay = document.querySelector(".canon-draft-overlay") as HTMLElement;
    const items = overlay.querySelectorAll(".canon-draft-criteria-item");
    expect(items.length).toBe(2);
    expect(items[0]!.textContent).toContain("60");
    expect(items[0]!.textContent).toContain("stops before committing");
    // no editable rubric field when criteria are present
    expect(overlay.querySelectorAll("textarea").length).toBe(1); // scenario only

    (overlay.querySelector(".canon-draft-write") as HTMLButtonElement).click();
    expect(canonWriteEvals).toHaveBeenCalledWith("/repo", "skill", "horizon", [
      { id: "refuses-a-dirty-tree", scenario: "s1", rubric: "", criteria: withCriteria[0]!.criteria },
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

describe("openEvalPill", () => {
  beforeEach(() => document.body.replaceChildren());

  const tally = (el: HTMLElement): string =>
    el.querySelector(".canon-eval-pill-tally")!.textContent ?? "";

  it("starts at 0/N with a running dot and fills the bar as cases settle", () => {
    const p = openEvalPill("skill/horizon", "horizon", 2);
    expect(tally(p.element)).toBe("0/2");
    expect(p.element.querySelector(".canon-eval-pill-dot")!.className).toContain("is-running");
    p.setStatus("a", "pass", "refused correctly");
    expect(tally(p.element)).toBe("1/2");
    const fill = p.element.querySelector<HTMLElement>(".canon-eval-pill-bar > i")!;
    expect(fill.style.width).toBe("50%");
  });

  it("finish flips the tally to pass-rate, colors the dot, removes Stop", () => {
    const p = openEvalPill("skill/horizon", "horizon", 2);
    p.setStatus("a", "pass", "");
    p.setStatus("b", "fail", "pushed anyway");
    p.finish();
    expect(tally(p.element)).toBe("1/2 pass");
    expect(p.element.classList.contains("is-done")).toBe(true);
    expect(p.element.querySelector(".canon-eval-pill-dot")!.className).toContain("is-fail");
    expect(p.element.querySelector(".canon-eval-pill-stop")).toBeNull();
  });

  it("an all-green finish shows a pass dot and the full count", () => {
    const p = openEvalPill("skill/horizon", "horizon", 1);
    p.setStatus("a", "pass", "");
    p.finish();
    expect(tally(p.element)).toBe("1/1 pass");
    expect(p.element.querySelector(".canon-eval-pill-dot")!.className).toContain("is-pass");
    expect(p.tallyText()).toBe("1/1 pass");
  });

  it("counts lazily-discovered ids beyond the initial total (reload path)", () => {
    const p = openEvalPill("skill/horizon", "horizon", 0);
    p.setStatus("surprise", "pass", "");
    expect(tally(p.element)).toBe("1/1");
  });

  it("Stop cancels the backend run using the key's kind and name", () => {
    const p = openEvalPill("skill/horizon", "horizon", 1);
    (p.element.querySelector(".canon-eval-pill-stop") as HTMLButtonElement).click();
    expect(canonCancelEvals).toHaveBeenCalledWith("skill", "horizon");
  });

  it("Expand dispatches covenant:open-evals with the unit's coordinates", () => {
    const p = openEvalPill("skill/horizon", "horizon", 1, "/repo");
    const seen: unknown[] = [];
    const onOpen = (e: Event): void => { seen.push((e as CustomEvent).detail); };
    window.addEventListener("covenant:open-evals", onOpen);
    (p.element.querySelector(".canon-eval-pill-expand") as HTMLButtonElement).click();
    window.removeEventListener("covenant:open-evals", onOpen);
    expect(seen).toEqual([{ cwd: "/repo", kind: "skill", name: "horizon" }]);
  });

  it("× hides the pill; replaces a same-unit pill but stacks across units", () => {
    openEvalPill("skill/one", "one", 1);
    openEvalPill("skill/one", "one", 1);
    openEvalPill("skill/two", "two", 1);
    expect(document.querySelectorAll(".canon-eval-pill").length).toBe(2);
    const p = document.querySelector(`.canon-eval-pill[data-key="skill/two"]`)!;
    (p.querySelector(".canon-eval-pill-close") as HTMLButtonElement).click();
    expect(document.querySelectorAll(".canon-eval-pill").length).toBe(1);
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
