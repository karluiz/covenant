import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { canPublish, createDebouncedSaver, buildBody, parseBody } from "./wizard";

// ---------------------------------------------------------------------------
// canPublish
// ---------------------------------------------------------------------------
describe("canPublish", () => {
  it("returns false when values map is empty", () => {
    expect(canPublish(new Map())).toBe(false);
  });

  it("returns false when only Goal is set", () => {
    const v = new Map([["Goal", "Do the thing"]]);
    expect(canPublish(v)).toBe(false);
  });

  it("returns false when Goal + Acceptance criteria are set but Complexity is missing", () => {
    const v = new Map([
      ["Goal", "Do the thing"],
      ["Acceptance criteria", "- [ ] it works"],
    ]);
    expect(canPublish(v)).toBe(false);
  });

  it("returns true when all three required fields have content", () => {
    const v = new Map([
      ["Goal", "Do the thing"],
      ["Acceptance criteria", "- [ ] it works"],
      ["Complexity", "small"],
    ]);
    expect(canPublish(v)).toBe(true);
  });

  it("returns false when required fields are whitespace only", () => {
    const v = new Map([
      ["Goal", "   "],
      ["Acceptance criteria", "\t"],
      ["Complexity", " "],
    ]);
    expect(canPublish(v)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createDebouncedSaver
// ---------------------------------------------------------------------------
describe("createDebouncedSaver", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("does NOT call save before delay elapses", () => {
    const save = vi.fn();
    const d = createDebouncedSaver(500, save);
    d.trigger();
    vi.advanceTimersByTime(499);
    expect(save).not.toHaveBeenCalled();
  });

  it("calls save exactly once after delay elapses", () => {
    const save = vi.fn();
    const d = createDebouncedSaver(500, save);
    d.trigger();
    vi.advanceTimersByTime(500);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("coalesces rapid triggers into a single save call", () => {
    const save = vi.fn();
    const d = createDebouncedSaver(500, save);
    d.trigger();
    vi.advanceTimersByTime(100);
    d.trigger();
    vi.advanceTimersByTime(100);
    d.trigger();
    vi.advanceTimersByTime(500);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("flush() calls save immediately when pending", () => {
    const save = vi.fn();
    const d = createDebouncedSaver(500, save);
    d.trigger();
    d.flush();
    expect(save).toHaveBeenCalledTimes(1);
    // Advancing time should NOT call it again.
    vi.advanceTimersByTime(1000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("flush() is a no-op when nothing is pending", () => {
    const save = vi.fn();
    const d = createDebouncedSaver(500, save);
    d.flush();
    expect(save).not.toHaveBeenCalled();
  });

  it("cancel() prevents the pending call", () => {
    const save = vi.fn();
    const d = createDebouncedSaver(500, save);
    d.trigger();
    d.cancel();
    vi.advanceTimersByTime(1000);
    expect(save).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// buildBody / parseBody roundtrip
// ---------------------------------------------------------------------------
describe("buildBody", () => {
  const KEYS = ["Goal", "Acceptance criteria", "Complexity"];

  it("emits the # Draft — <title> heading", () => {
    const body = buildBody("My Feature", new Map(), KEYS);
    expect(body).toMatch(/^# Draft — My Feature/);
  });

  it("emits ## section headings in order", () => {
    const body = buildBody("T", new Map(), KEYS);
    const headings = [...body.matchAll(/^## (.+)$/gm)].map(m => m[1]);
    expect(headings).toEqual(KEYS);
  });

  it("includes section values in the output", () => {
    const values = new Map([
      ["Goal", "Ship it"],
      ["Acceptance criteria", "- [ ] passes"],
      ["Complexity", "medium"],
    ]);
    const body = buildBody("T", values, KEYS);
    expect(body).toContain("Ship it");
    expect(body).toContain("- [ ] passes");
    expect(body).toContain("medium");
  });
});

describe("parseBody", () => {
  it("handles empty body without crashing", () => {
    const result = parseBody("");
    expect(result.size).toBe(0);
  });

  it("handles body with no ## sections", () => {
    const result = parseBody("# Draft — Title\n\nsome random text");
    expect(result.size).toBe(0);
  });

  it("roundtrips through buildBody", () => {
    const KEYS = ["Goal", "Acceptance criteria", "Complexity"];
    const values = new Map([
      ["Goal", "Ship it"],
      ["Acceptance criteria", "- [ ] passes"],
      ["Complexity", "large"],
    ]);
    const body = buildBody("My title", values, KEYS);
    const parsed = parseBody(body);
    for (const key of KEYS) {
      expect(parsed.get(key)).toBe(values.get(key));
    }
  });

  it("parses multiple sections correctly", () => {
    const body = "## Goal\nDo X\n## Complexity\nsmall\n";
    const parsed = parseBody(body);
    expect(parsed.get("Goal")).toBe("Do X");
    expect(parsed.get("Complexity")).toBe("small");
  });
});
