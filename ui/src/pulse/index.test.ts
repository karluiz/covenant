import { describe, it, expect, vi, beforeEach } from "vitest";

// The surface mounts the covenant page; stub it so the test is shell-only.
vi.mock("../score/page", () => ({ mountCovenantPage: vi.fn() }));

import { PulseSurface } from "./index";

describe("PulseSurface", () => {
  beforeEach(() => { document.body.innerHTML = ""; document.body.className = ""; });

  it("opens, mounts a frame, and closes on Escape", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const surface = new PulseSurface(host);

    expect(surface.isOpen).toBe(false);
    surface.open();
    expect(surface.isOpen).toBe(true);
    expect(host.querySelector(".pulse-frame")).not.toBeNull();
    expect(document.body.classList.contains("pulse-fullscreen")).toBe(true);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(surface.isOpen).toBe(false);
    expect(host.innerHTML).toBe("");
    expect(document.body.classList.contains("pulse-fullscreen")).toBe(false);
  });
});
