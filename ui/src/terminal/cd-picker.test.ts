import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mountCdPicker } from "./cd-picker";
import type { Terminal } from "@xterm/xterm";

vi.mock("../api", () => ({
  structureListDir: vi.fn(),
  recentCwds: vi.fn(async () => []),
}));
vi.mock("../icons", () => ({
  Icons: { folder: () => "<svg></svg>", fileText: () => "<svg></svg>" },
}));

import { structureListDir, recentCwds } from "../api";

const listDirMock = vi.mocked(structureListDir);

function makeTerm(): Terminal {
  // ponytail: only the fields position() touches
  return {
    rows: 40,
    buffer: { active: { cursorY: 5, type: "normal" } },
    _core: { _renderService: { dimensions: { css: { cell: { height: 17 } } } } },
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
    await vi.advanceTimersByTimeAsync(0);
    expect(picker.visible).toBe(true);
  }

  const written = () =>
    hooks.writeBytes.mock.calls.map((c) => new TextDecoder().decode(c[0] as Uint8Array));

  it("Esc dismiss is not revived by an in-flight directory query", async () => {
    const picker = mountCdPicker(host, makeTerm(), hooks);
    await showPicker(picker);

    // keystroke crossing into an uncached dir → IPC in flight (unresolved)
    let resolveLate!: (v: typeof DIRS) => void;
    listDirMock.mockImplementation(
      () => new Promise((r) => { resolveLate = r; }),
    );
    picker.update(true, "cd claude-pasa/", "/Users/x/Sources");
    await vi.advanceTimersByTimeAsync(0); // query now in flight

    expect(picker.handleKey("\x1b")).toBe(true);
    expect(picker.visible).toBe(false);

    resolveLate(DIRS); // late IPC response lands after dismiss
    await vi.advanceTimersByTimeAsync(0);
    expect(picker.visible).toBe(false); // BUG: stale response re-renders
    picker.dispose();
  });

  it("an unarmed picker forwards Enter and Up to the shell", async () => {
    const picker = mountCdPicker(host, makeTerm(), hooks);
    listDirMock.mockResolvedValue(DIRS);
    // `cd ~` resolves to an empty prefix, so every child of home is listed.
    picker.update(true, "cd ~", "/Users/x/Sources");
    await vi.advanceTimersByTimeAsync(0);
    expect(picker.visible).toBe(true);

    expect(picker.handleKey("\r")).toBe(false); // ⏎ submits `cd ~` verbatim
    expect(written()).toEqual([]); // nothing was picked for the user
    expect(picker.handleKey("\x1b[A")).toBe(false); // ↑ is still history
    expect(picker.visible).toBe(false); // …and history will replace the line
    picker.dispose();
  });

  it("Tab arms the picker; Enter then inserts the path without running it", async () => {
    const picker = mountCdPicker(host, makeTerm(), hooks);
    await showPicker(picker);

    expect(picker.handleKey("\t")).toBe(true); // arm
    expect(picker.handleKey("\r")).toBe(true); // now ours
    expect(written()[0]).toBe("\x15cd /Users/x/Sources/claude-pasa/");
    expect(written()[0]).not.toContain("\n"); // the user still owns Return
    expect(hooks.syncRecall).toHaveBeenCalledWith("\x15cd /Users/x/Sources/claude-pasa/");
    picker.dispose();
  });

  // zsh runs with application cursor keys on, so its arrows are ESC O A/B.
  it.each([["\x1b[B", "\x1b[A"], ["\x1bOB", "\x1bOA"]])(
    "navigates with both arrow encodings (%j)",
    async (down, up) => {
      const picker = mountCdPicker(host, makeTerm(), hooks);
      listDirMock.mockResolvedValue([
        { name: "docs", path: "/x", kind: "dir", is_symlink: false },
        { name: "dist", path: "/x", kind: "dir", is_symlink: false },
      ] as Awaited<ReturnType<typeof structureListDir>>);
      picker.update(true, "cd d", "/Users/x/Sources");
      await vi.advanceTimersByTimeAsync(0);

      expect(picker.handleKey(down)).toBe(true); // arms on the first press
      expect(picker.visible).toBe(true); // …and does NOT reach the shell
      expect(host.querySelectorAll(".cd-picker-row.is-active").length).toBe(1);
      expect(picker.handleKey(down)).toBe(true); // moves to the second row
      expect(picker.handleKey(up)).toBe(true);
      expect(picker.handleKey("\r")).toBe(true);
      expect(written()[0]).toContain("/docs/"); // back on row 0
      picker.dispose();
    },
  );

  it("Esc disarms first, then dismisses", async () => {
    const picker = mountCdPicker(host, makeTerm(), hooks);
    await showPicker(picker);

    picker.handleKey("\x1b[B"); // ↓ arms
    expect(picker.handleKey("\x1b")).toBe(true);
    expect(picker.visible).toBe(true); // disarmed, still informative
    expect(picker.handleKey("\r")).toBe(false); // back to the shell
    expect(picker.handleKey("\x1b")).toBe(true);
    expect(picker.visible).toBe(false);
    picker.dispose();
  });

  it("reads a directory once, not once per keystroke", async () => {
    const picker = mountCdPicker(host, makeTerm(), hooks);
    await showPicker(picker);
    expect(listDirMock).toHaveBeenCalledTimes(1);

    picker.update(true, "cd claude-pasa", "/Users/x/Sources"); // same dir, longer prefix
    await vi.advanceTimersByTimeAsync(0);
    expect(listDirMock).toHaveBeenCalledTimes(1); // filtered locally
    expect(picker.visible).toBe(true);

    picker.update(true, "cd claude-pasa/", "/Users/x/Sources"); // crossing into the child
    await vi.advanceTimersByTimeAsync(0);
    expect(listDirMock).toHaveBeenCalledTimes(2); // one IPC per level

    picker.reset(); // a new prompt may see a changed filesystem
    picker.update(true, "cd claude-pas", "/Users/x/Sources");
    await vi.advanceTimersByTimeAsync(0);
    expect(listDirMock).toHaveBeenCalledTimes(3);
    picker.dispose();
  });

  it("emphasizes the matched run and keeps the path in real case", async () => {
    const picker = mountCdPicker(host, makeTerm(), hooks);
    listDirMock.mockResolvedValue([
      { name: "soporte-ti-Knowledgebase", path: "/x", kind: "dir", is_symlink: false },
    ] as Awaited<ReturnType<typeof structureListDir>>);
    picker.update(true, "cd knowledge", "/Users/x/Sources");
    await vi.advanceTimersByTimeAsync(0);

    // mid-name match: exactly the typed run is emphasized, in the dir's own
    // casing (typed "knowledge", the directory spells it "Knowledge")
    expect(host.querySelector(".cd-picker-row b")?.textContent).toBe("Knowledge");
    expect(host.querySelector(".cd-picker-row span")?.textContent).toBe("soporte-ti-Knowledgebase");
    expect(host.querySelector(".cd-picker-path")?.textContent).toBe("~/Sources"); // not uppercased
    expect(host.querySelector(".cd-picker-count")?.textContent).toBe("1");
    expect(host.querySelector(".cd-picker-keys")?.textContent).toBe("tab to complete");

    picker.handleKey("\t");
    expect(host.querySelector(".cd-picker-keys")?.textContent).toBe("⏎ insert · esc cancel");
    picker.dispose();
  });

  it("a dir named like markup stays text", async () => {
    const picker = mountCdPicker(host, makeTerm(), hooks);
    listDirMock.mockResolvedValue([
      { name: "<img src=x>", path: "/x", kind: "dir", is_symlink: false },
    ] as Awaited<ReturnType<typeof structureListDir>>);
    picker.update(true, "cd <img", "/Users/x/Sources");
    await vi.advanceTimersByTimeAsync(0);

    const span = host.querySelector(".cd-picker-row span");
    expect(span?.textContent).toBe("<img src=x>");
    expect(span?.querySelector("img")).toBeNull(); // emphasis path must not parse HTML
    picker.dispose();
  });

  it("completes a non-cd verb without clobbering the earlier args", async () => {
    const picker = mountCdPicker(host, makeTerm(), hooks);
    listDirMock.mockResolvedValue([
      { name: "notes.md", path: "/x", kind: "file", is_symlink: false },
    ] as Awaited<ReturnType<typeof structureListDir>>);
    picker.update(true, "cp -r src/ note", "/Users/x/Sources");
    await vi.advanceTimersByTimeAsync(0);
    expect(picker.visible).toBe(true); // a file is a candidate for `cp`

    picker.handleKey("\t");
    picker.handleKey("\r");
    // earlier args survive, and a FILE gets no trailing slash
    expect(written()[0]).toBe("\x15cp -r src/ /Users/x/Sources/notes.md");
    expect(picker.visible).toBe(false); // a file is a terminal choice
    picker.dispose();
  });

  it("`cd` never offers files, and an unlisted verb never opens", async () => {
    const picker = mountCdPicker(host, makeTerm(), hooks);
    listDirMock.mockResolvedValue([
      { name: "notes.md", path: "/x", kind: "file", is_symlink: false },
    ] as Awaited<ReturnType<typeof structureListDir>>);
    picker.update(true, "cd note", "/Users/x/Sources");
    await vi.advanceTimersByTimeAsync(0);
    expect(picker.visible).toBe(false);

    picker.update(true, "git note", "/Users/x/Sources");
    await vi.advanceTimersByTimeAsync(0);
    expect(picker.visible).toBe(false);
    picker.dispose();
  });

  it("ranks the directory you actually work in above the alphabet", async () => {
    vi.mocked(recentCwds).mockResolvedValue([
      { path: "/Users/x/Sources/second", count: 40, last_used_unix_ms: Date.now() },
    ]);
    const picker = mountCdPicker(host, makeTerm(), hooks);
    listDirMock.mockResolvedValue([
      { name: "first", path: "/x", kind: "dir", is_symlink: false },
      { name: "second", path: "/x", kind: "dir", is_symlink: false },
    ] as Awaited<ReturnType<typeof structureListDir>>);

    picker.update(true, "cd ", "/Users/x/Sources"); // kicks off the visits fetch
    await vi.advanceTimersByTimeAsync(0);
    picker.update(true, "cd ", "/Users/x/Sources"); // re-filter with visits loaded
    await vi.advanceTimersByTimeAsync(0);

    const names = [...host.querySelectorAll(".cd-picker-row span")].map((n) => n.textContent);
    expect(names).toEqual(["second", "first"]);
    expect(vi.mocked(recentCwds).mock.calls.length).toBe(1); // fetched once, not per keystroke
    picker.dispose();
  });

  it("clears the input line — the 8px inset lives on .xterm, not on host", async () => {
    Object.defineProperty(host, "clientHeight", { value: 400, configurable: true });
    const xterm = document.createElement("div");
    xterm.className = "xterm";
    xterm.style.paddingTop = "8px";
    host.appendChild(xterm);

    const picker = mountCdPicker(host, makeTerm(), hooks);
    await showPicker(picker);

    // padTop(8) + (cursorY 5 + 1) * cellH(17); reading host's padding gives 102
    expect(host.querySelector<HTMLElement>(".cd-picker")?.style.top).toBe("110px");
    picker.dispose();
  });
});
