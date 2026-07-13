import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../score/api", () => ({
  scoreSummaryFiltered: vi.fn().mockResolvedValue({
    total_prompts: 78293, total_commits: 20365, today_prompts: 727, today_commits: 3,
    current_streak: 58, longest_streak: 58, total_tokens: 327131903, total_specs: 12,
  }),
}));

import { renderPulseSummary } from "./pulse-summary";

describe("renderPulseSummary", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("renders streak/today/total and wires Open Pulse", async () => {
    const host = document.createElement("div");
    const onOpen = vi.fn();
    await renderPulseSummary(host, onOpen);
    expect(host.textContent).toContain("58");     // streak
    expect(host.textContent).toContain("727");    // today
    expect(host.textContent).toContain("78,293"); // total prompts
    const btn = host.querySelector<HTMLButtonElement>(".pulse-open-btn")!;
    expect(btn).not.toBeNull();
    btn.click();
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
