import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mountCdPicker } from "./cd-picker";
import type { Terminal } from "@xterm/xterm";

vi.mock("../api", () => ({
  structureListDir: vi.fn(),
}));
vi.mock("../icons", () => ({
  Icons: { folder: () => "<svg></svg>" },
}));

import { structureListDir } from "../api";

const listDirMock = vi.mocked(structureListDir);

function makeTerm(): Terminal {
  // ponytail: only the fields position() touches
  return {
    rows: 40,
    buffer: { active: { cursorY: 5, type: "normal" } },
  } as unknown as Terminal;
}

const DIRS = [{ name: "claude-pasa", kind: "dir" }] as Awaited<
  ReturnType<typeof structureListDir>
>;

describe("cd-picker dismiss races", () => {
  let host: HTMLElement;
  const hooks = { writeBytes: vi.fn(), syncRecall: vi.fn() };

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    vi.useRealTimers();
    host.remove();
    vi.clearAllMocks();
  });

  async function showPicker(picker: ReturnType<typeof mountCdPicker>) {
    listDirMock.mockResolvedValue(DIRS);
    picker.update(true, "cd claude-pas", "/Users/x/Sources");
    await vi.advanceTimersByTimeAsync(150);
    expect(picker.visible).toBe(true);
  }

  it("Esc dismiss is not revived by a pending debounce timer", async () => {
    const picker = mountCdPicker(host, makeTerm(), hooks);
    await showPicker(picker);

    // one more keystroke arms a new debounce timer…
    picker.update(true, "cd claude-pasa", "/Users/x/Sources");
    // …then Esc dismisses before it fires
    expect(picker.handleKey("\x1b")).toBe(true);
    expect(picker.visible).toBe(false);

    await vi.advanceTimersByTimeAsync(300);
    expect(picker.visible).toBe(false); // BUG: timer survives hide() and re-renders
    picker.dispose();
  });

  it("Esc dismiss is not revived by an in-flight directory query", async () => {
    const picker = mountCdPicker(host, makeTerm(), hooks);
    await showPicker(picker);

    // keystroke → timer fires → IPC in flight (unresolved promise)
    let resolveLate!: (v: typeof DIRS) => void;
    listDirMock.mockImplementation(
      () => new Promise((r) => { resolveLate = r; }),
    );
    picker.update(true, "cd claude-pasa", "/Users/x/Sources");
    await vi.advanceTimersByTimeAsync(150); // query now in flight

    expect(picker.handleKey("\x1b")).toBe(true);
    expect(picker.visible).toBe(false);

    resolveLate(DIRS); // late IPC response lands after dismiss
    await vi.advanceTimersByTimeAsync(0);
    expect(picker.visible).toBe(false); // BUG: stale response re-renders
    picker.dispose();
  });
});
