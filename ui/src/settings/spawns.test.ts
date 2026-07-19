import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SpawnSpec } from "../spawns/types";

vi.mock("../spawns/api", () => ({
  listSpawns: vi.fn(),
  upsertSpawn: vi.fn(),
  deleteSpawn: vi.fn(),
}));
// renderSpawnsTab now also mounts the ACP agents section (Task 6), which
// reads/writes Settings via ../api — stub it so master-detail tests don't
// need real Tauri IPC.
vi.mock("../api", () => ({
  getSettings: vi.fn().mockResolvedValue({}),
  setSettings: vi.fn(),
}));
vi.mock("../tooltip/tooltip", () => ({ attachTooltip: vi.fn() }));

import { listSpawns, upsertSpawn, deleteSpawn } from "../spawns/api";
import { renderSpawnsTab } from "./spawns";

function spec(over: Partial<SpawnSpec>): SpawnSpec {
  return {
    id: "id", label: "Custom", icon: null, command: "", args: [],
    env: {}, cwd: null, default: false, ...over,
  };
}
const claude = (): SpawnSpec =>
  spec({
    id: "s-claude", label: "Claude", command: "claude",
    args: ["--dangerously-skip-permissions"], default: true,
  });
const codex = (): SpawnSpec =>
  spec({ id: "s-codex", label: "Codex", command: "codex" });

async function mount(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  await renderSpawnsTab(host);
  return host;
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = "";
  vi.mocked(listSpawns).mockReset().mockResolvedValue([claude(), codex()]);
  vi.mocked(upsertSpawn).mockReset().mockResolvedValue(undefined);
  vi.mocked(deleteSpawn).mockReset().mockResolvedValue(undefined);
});

describe("renderSpawnsTab (master-detail)", () => {
  it("renders one rail item per spawn with a star on the default", async () => {
    const host = await mount();
    const items = host.querySelectorAll(".spawns-md-item");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("Claude");
    expect(items[0]!.querySelector(".spawns-md-star")).not.toBeNull();
    expect(items[1]!.querySelector(".spawns-md-star")).toBeNull();
  });

  it("selects the default spawn initially and switches detail on rail click", async () => {
    const host = await mount();
    expect(host.querySelector<HTMLInputElement>('input[name="command"]')!.value).toBe("claude");
    host.querySelectorAll<HTMLButtonElement>(".spawns-md-item")[1]!.click();
    expect(host.querySelector<HTMLInputElement>('input[name="command"]')!.value).toBe("codex");
  });

  it("set default is exclusive: clears the previous default", async () => {
    const host = await mount();
    host.querySelectorAll<HTMLButtonElement>(".spawns-md-item")[1]!.click();
    host.querySelector<HTMLButtonElement>('[data-role="set-default"]')!.click();
    await flush();
    const calls = vi.mocked(upsertSpawn).mock.calls.map((c) => c[0]);
    expect(calls.find((s) => s.id === "s-claude")!.default).toBe(false);
    expect(calls.find((s) => s.id === "s-codex")!.default).toBe(true);
  });

  it("chip click appends its insert text to args and persists", async () => {
    const host = await mount();
    const args = host.querySelector<HTMLInputElement>('input[name="args"]')!;
    const chip = [...host.querySelectorAll<HTMLButtonElement>(".spawns-settings-chip")]
      .find((c) => c.textContent === "--continue")!;
    chip.click();
    await flush();
    expect(args.value).toBe("--dangerously-skip-permissions --continue");
    const calls = vi.mocked(upsertSpawn).mock.calls;
    expect(calls[calls.length - 1]![0].args).toEqual(
      ["--dangerously-skip-permissions", "--continue"],
    );
  });

  it("live preview composes command + args and tracks input", async () => {
    const host = await mount();
    const preview = host.querySelector('[data-role="preview"]')!;
    expect(preview.textContent).toContain("claude --dangerously-skip-permissions");
    const cmd = host.querySelector<HTMLInputElement>('input[name="command"]')!;
    cmd.value = "claude2";
    cmd.dispatchEvent(new Event("input", { bubbles: true }));
    expect(preview.textContent).toContain("claude2");
  });

  it("delete removes the spawn and selects a neighbor", async () => {
    const host = await mount();
    host.querySelector<HTMLButtonElement>('[data-role="delete"]')!.click();
    await flush();
    expect(vi.mocked(deleteSpawn)).toHaveBeenCalledWith("s-claude");
    expect(host.querySelectorAll(".spawns-md-item")).toHaveLength(1);
    expect(host.querySelector<HTMLInputElement>('input[name="command"]')!.value).toBe("codex");
  });

  it("add creates a draft, selects it, and persists it", async () => {
    const host = await mount();
    host.querySelector<HTMLButtonElement>(".spawns-md-add")!.click();
    await flush();
    expect(host.querySelectorAll(".spawns-md-item")).toHaveLength(3);
    expect(host.querySelector<HTMLInputElement>('input[name="command"]')!.value).toBe("");
    const calls = vi.mocked(upsertSpawn).mock.calls;
    expect(calls[calls.length - 1]![0].label).toBe("New spawn");
  });
});

describe("Launch as ACP tab", () => {
  const acpRow = (host: HTMLElement): HTMLElement =>
    host.querySelector<HTMLElement>('[data-role="acp"]')!;

  it("shows the row for ACP-capable executors, hides it otherwise", async () => {
    const host = await mount();
    expect(acpRow(host).hidden).toBe(false); // claude selected initially
    host.querySelectorAll<HTMLButtonElement>(".spawns-md-item")[1]!.click();
    expect(acpRow(host).hidden).toBe(true); // codex
  });

  it("toggling the checkbox persists acp: true", async () => {
    const host = await mount();
    const check = acpRow(host).querySelector<HTMLInputElement>("input")!;
    check.checked = true;
    check.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    const calls = vi.mocked(upsertSpawn).mock.calls;
    expect(calls[calls.length - 1]![0].acp).toBe(true);
  });

  it("editing the command to a non-ACP executor drops the flag on persist", async () => {
    vi.mocked(listSpawns).mockResolvedValue([
      spec({ id: "s-claude", label: "Claude", command: "claude", default: true, acp: true }),
    ]);
    const host = await mount();
    const cmd = host.querySelector<HTMLInputElement>('input[name="command"]')!;
    cmd.value = "codex";
    cmd.dispatchEvent(new Event("input", { bubbles: true }));
    expect(acpRow(host).hidden).toBe(true);
    cmd.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    const calls = vi.mocked(upsertSpawn).mock.calls;
    expect(calls[calls.length - 1]![0].acp).toBe(false);
  });
});

describe("Isolate in a worktree", () => {
  const wtRow = (host: HTMLElement): HTMLElement =>
    host.querySelector<HTMLElement>('[data-role="worktree"]')!;

  it("checks the box when worktree is absent (upgrading installs stay isolated)", async () => {
    const host = await mount();
    expect(wtRow(host).querySelector<HTMLInputElement>("input")!.checked).toBe(true);
  });

  it("unchecks the box when worktree: false was persisted", async () => {
    vi.mocked(listSpawns).mockResolvedValue([
      spec({ id: "s-claude", label: "Claude", command: "claude", default: true, worktree: false }),
    ]);
    const host = await mount();
    expect(wtRow(host).querySelector<HTMLInputElement>("input")!.checked).toBe(false);
  });

  it("toggling the checkbox persists worktree: false", async () => {
    const host = await mount();
    const check = wtRow(host).querySelector<HTMLInputElement>("input")!;
    check.checked = false;
    check.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    const calls = vi.mocked(upsertSpawn).mock.calls;
    expect(calls[calls.length - 1]![0].worktree).toBe(false);
  });
});

describe("ACP agents section mount", () => {
  it("survives master-detail re-renders (rail click / add / delete) and stays single", async () => {
    const host = await mount();
    expect(host.querySelectorAll(".acp-agents")).toHaveLength(1);

    // Rail click re-invokes the internal render() that used to wipe host.
    host.querySelectorAll<HTMLButtonElement>(".spawns-md-item")[1]!.click();
    expect(host.querySelectorAll(".acp-agents")).toHaveLength(1);

    // Add: re-render after async persist.
    host.querySelector<HTMLButtonElement>(".spawns-md-add")!.click();
    await flush();
    expect(host.querySelectorAll(".acp-agents")).toHaveLength(1);

    // Delete: re-render after async delete.
    host.querySelector<HTMLButtonElement>('[data-role="delete"]')!.click();
    await flush();
    expect(host.querySelectorAll(".acp-agents")).toHaveLength(1);
  });
});
