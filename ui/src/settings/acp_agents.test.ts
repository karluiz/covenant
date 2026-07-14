import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api", () => ({
  getSettings: vi.fn(),
  setSettings: vi.fn(),
}));
vi.mock("../tooltip/tooltip", () => ({ attachTooltip: vi.fn() }));

import { getSettings, setSettings } from "../api";
import { renderAcpAgentsSection } from "./acp_agents";

const settings = (over: object = {}) => ({ acp_executors: {}, ...over }) as never;
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function mount(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  await renderAcpAgentsSection(host);
  return host;
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.mocked(getSettings).mockReset().mockResolvedValue(settings());
  vi.mocked(setSettings).mockReset().mockResolvedValue(undefined);
});

describe("renderAcpAgentsSection", () => {
  it("renders one card per ACP executor with default trust selected", async () => {
    const host = await mount();
    const cards = host.querySelectorAll(".acp-agent-card");
    expect(cards.length).toBe(4); // claude, copilot, opencode, pi
    // copilot's unconfigured default is yolo (status quo), claude's is balanced
    const copilot = host.querySelector('[data-executor="copilot"]');
    expect(copilot?.querySelector('.acp-trust-seg [data-trust="yolo"][aria-pressed="true"]')).toBeTruthy();
    const claude = host.querySelector('[data-executor="claude"]');
    expect(claude?.querySelector('.acp-trust-seg [data-trust="balanced"][aria-pressed="true"]')).toBeTruthy();
  });

  it("persists a trust change via setSettings", async () => {
    const host = await mount();
    const yolo = host.querySelector<HTMLButtonElement>(
      '[data-executor="claude"] .acp-trust-seg [data-trust="yolo"]',
    );
    yolo?.click();
    await flush();
    expect(setSettings).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(setSettings).mock.calls[0][0] as {
      acp_executors: Record<string, { trust: string }>;
    };
    expect(saved.acp_executors.claude.trust).toBe("yolo");
  });

  it("shows thinking budget input only on the claude card", async () => {
    const host = await mount();
    expect(host.querySelector('[data-executor="claude"] .acp-thinking-input')).toBeTruthy();
    expect(host.querySelector('[data-executor="copilot"] .acp-thinking-input')).toBeNull();
  });

  it("hides the model input for pi", async () => {
    const host = await mount();
    expect(host.querySelector('[data-executor="pi"] .acp-model-input')).toBeNull();
    expect(host.querySelector('[data-executor="opencode"] .acp-model-input')).toBeTruthy();
  });
});
