import { describe, expect, it } from "vitest";
import {
  initialState,
  filterSpecs,
  selectCard,
  typeInput,
  effectivePath,
  canSubmit,
  navigate,
  type PageState,
} from "./page";

const specs = [
  { id: "3.10", title: "Mission Drafts", goal: "write specs", path: "/p/3.10.md", updated_at: "" },
  { id: "3.11", title: "Mission Picker Integration", goal: "picker", path: "/p/3.11.md", updated_at: "" },
  { id: "3.14", title: "Escalation Visibility", goal: "see escalations", path: "/p/3.14.md", updated_at: "" },
];

function withSpecs(): PageState {
  return { ...initialState(null), specs, drafts: [], superpowers: [], loading: false };
}

describe("MissionPage state", () => {
  it("filterSpecs matches by id, title, and goal (case-insensitive)", () => {
    const s = withSpecs();
    expect(filterSpecs(s.specs, "3.11").map(x => x.id)).toEqual(["3.11"]);
    expect(filterSpecs(s.specs, "ESCAL").map(x => x.id)).toEqual(["3.14"]);
    expect(filterSpecs(s.specs, "specs").map(x => x.id)).toEqual(["3.10"]);
    expect(filterSpecs(s.specs, "").length).toBe(3);
  });

  it("selectCard sets selected and clears input", () => {
    const s = typeInput(withSpecs(), "/free/path.md");
    const next = selectCard(s, "/p/3.11.md");
    expect(next.selected).toEqual({ source: "card", path: "/p/3.11.md" });
    expect(next.inputValue).toBe("");
  });

  it("typeInput deselects any card and tracks input", () => {
    const s = selectCard(withSpecs(), "/p/3.10.md");
    const next = typeInput(s, "/free/path.md");
    expect(next.selected).toEqual({ source: "input", path: "/free/path.md" });
    expect(next.inputValue).toBe("/free/path.md");
  });

  it("canSubmit is false while loading and true with selection or input", () => {
    const loading = { ...withSpecs(), loading: true };
    expect(canSubmit(loading)).toBe(false);
    expect(canSubmit(withSpecs())).toBe(false);
    expect(canSubmit(selectCard(withSpecs(), "/p/3.10.md"))).toBe(true);
    expect(canSubmit(typeInput(withSpecs(), "/x.md"))).toBe(true);
  });

  it("effectivePath: card wins over input", () => {
    let s = typeInput(withSpecs(), "/free/path.md");
    s = selectCard(s, "/p/3.11.md");
    expect(effectivePath(s)).toBe("/p/3.11.md");
  });

  it("navigate cycles through filtered specs", () => {
    const s = withSpecs();
    const a = navigate(s, 1, s.specs);
    expect(a.selected?.path).toBe("/p/3.10.md");
    const b = navigate(a, 1, s.specs);
    expect(b.selected?.path).toBe("/p/3.11.md");
    const c = navigate(b, -1, s.specs);
    expect(c.selected?.path).toBe("/p/3.10.md");
  });
});
