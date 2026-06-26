import { describe, it, expect, beforeEach } from "vitest";
import { renderBeacon, stateDotColor } from "./panel";

describe("stateDotColor", () => {
  it("maps deployment states to color classes", () => {
    expect(stateDotColor("success")).toBe("ok");
    expect(stateDotColor("in_progress")).toBe("busy");
    expect(stateDotColor("pending")).toBe("busy");
    expect(stateDotColor("failure")).toBe("bad");
    expect(stateDotColor("error")).toBe("bad");
    expect(stateDotColor("inactive")).toBe("idle");
    expect(stateDotColor("anything-else")).toBe("idle");
  });
});

describe("renderBeacon", () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement("div");
  });

  it("renders sign-in prompt when not authed", () => {
    renderBeacon(root, { kind: "not_authed" });
    expect(root.textContent).toContain("Sign in with GitHub");
  });

  it("renders no-repo notice", () => {
    renderBeacon(root, { kind: "no_repo" });
    expect(root.textContent).toContain("No GitHub remote");
  });

  it("renders empty state when no deployments", () => {
    renderBeacon(root, { kind: "ok", repo: "o/r", envs: [] });
    expect(root.textContent).toContain("No deployments");
  });

  it("renders error message", () => {
    renderBeacon(root, { kind: "error", message: "boom" });
    expect(root.textContent).toContain("boom");
  });

  it("renders one card per environment with a state dot", () => {
    renderBeacon(root, {
      kind: "ok",
      repo: "o/r",
      envs: [
        { environment: "production", state: "success", description: null, target_url: "https://x", sha: "abc1234", creator: "karluiz", updated_at: "2026-06-26T00:00:00Z" },
        { environment: "preview", state: "in_progress", description: null, target_url: null, sha: "def5678", creator: null, updated_at: "2026-06-26T00:00:00Z" },
      ],
    });
    const cards = root.querySelectorAll(".beacon-env");
    expect(cards.length).toBe(2);
    expect(root.querySelector(".beacon-dot.ok")).not.toBeNull();
    expect(root.querySelector(".beacon-dot.busy")).not.toBeNull();
    expect(root.textContent).toContain("production");
    expect(root.textContent).toContain("abc1234");
  });
});
