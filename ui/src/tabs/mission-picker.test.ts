import { describe, expect, it } from "vitest";
import {
  canSubmit,
  effectivePath,
  initialState,
  selectCard,
  typeInput,
  type PickerState,
} from "./mission-picker";

const baseState = (overrides: Partial<PickerState> = {}): PickerState => ({
  ...initialState(null),
  loading: false,
  ...overrides,
});

describe("effectivePath", () => {
  it("returns card path when card is selected", () => {
    const s = baseState({ selected: { source: "card", path: "/a.md" }, inputValue: "/b.md" });
    expect(effectivePath(s)).toBe("/a.md"); // card wins over input
  });

  it("returns trimmed input when no card selected", () => {
    const s = baseState({ selected: null, inputValue: "  /c.md  " });
    expect(effectivePath(s)).toBe("/c.md");
  });

  it("returns null when both empty", () => {
    expect(effectivePath(baseState({ selected: null, inputValue: "" }))).toBeNull();
  });
});

describe("canSubmit", () => {
  it("false while loading", () => {
    expect(canSubmit(baseState({ loading: true, inputValue: "/x" }))).toBe(false);
  });

  it("false with no path and no card", () => {
    expect(canSubmit(baseState({ selected: null, inputValue: "" }))).toBe(false);
  });

  it("true with card selected", () => {
    expect(canSubmit(baseState({ selected: { source: "card", path: "/a" } }))).toBe(true);
  });

  it("true with input filled", () => {
    expect(canSubmit(baseState({ inputValue: "/path" }))).toBe(true);
  });
});

describe("selectCard / typeInput last-wins", () => {
  it("selectCard clears the input", () => {
    let s = typeInput(baseState(), "/typed.md");
    expect(s.selected).toEqual({ source: "input", path: "/typed.md" });
    s = selectCard(s, "/cards.md");
    expect(s.selected).toEqual({ source: "card", path: "/cards.md" });
    expect(s.inputValue).toBe("");
  });

  it("typeInput deselects card", () => {
    let s = selectCard(baseState(), "/cards.md");
    expect(s.selected?.source).toBe("card");
    s = typeInput(s, "/typed.md");
    expect(s.selected).toEqual({ source: "input", path: "/typed.md" });
  });

  it("typing only whitespace clears selection", () => {
    let s = typeInput(baseState(), "/x");
    s = typeInput(s, "   ");
    expect(s.selected).toBeNull();
  });
});

describe("initialState", () => {
  it("pre-selects the current mission path as a card", () => {
    const s = initialState("/cur.md");
    expect(s.selected).toEqual({ source: "card", path: "/cur.md" });
    expect(s.loading).toBe(true);
  });

  it("no selection when current is null", () => {
    expect(initialState(null).selected).toBeNull();
  });
});
