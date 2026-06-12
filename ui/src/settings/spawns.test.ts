import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SpawnSpec } from "../spawns/types";

vi.mock("../spawns/api", () => ({
  listSpawns: vi.fn(),
  upsertSpawn: vi.fn(),
  deleteSpawn: vi.fn(),
}));

import { listSpawns, upsertSpawn, deleteSpawn } from "../spawns/api";
import { renderSpawnsTab } from "./spawns";

function spec(over: Partial<SpawnSpec>): SpawnSpec {
  return {
    id: "id", label: "Custom", icon: null, command: "", args: [],
    model: null, env: {}, cwd: null, default: false, ...over,
  };
}
const claude = (): SpawnSpec =>
  spec({
    id: "s-claude", label: "Claude", command: "claude",
    args: ["--dangerously-skip-permissions"], model: "fable-5", default: true,
  });
const codex = (): SpawnSpec =>
  spec({ id: "s-codex", label: "Codex", command: "codex", model: "gpt-5" });

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
