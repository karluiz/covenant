// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

const { openUrl } = vi.hoisted(() => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

import { renderBeacon, stateDotColor, isHttpUrl } from "./panel";

describe("isHttpUrl", () => {
  it("accepts http and https URLs", () => {
    expect(isHttpUrl("https://example.com")).toBe(true);
    expect(isHttpUrl("http://example.com")).toBe(true);
  });

  it("rejects non-http schemes", () => {
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("ftp://example.com")).toBe(false);
    expect(isHttpUrl("data:text/html,<h1>x</h1>")).toBe(false);
  });

  it("rejects empty, null, and non-URL strings", () => {
    expect(isHttpUrl(null)).toBe(false);
    expect(isHttpUrl(undefined)).toBe(false);
    expect(isHttpUrl("")).toBe(false);
    expect(isHttpUrl("not a url")).toBe(false);
  });
});

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
    expect(root.querySelector(".beacon-notice.beacon-error")).not.toBeNull();
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

  it("does NOT produce a clickable link for a javascript: target_url", () => {
    renderBeacon(root, {
      kind: "ok",
      repo: "o/r",
      envs: [
        { environment: "production", state: "success", description: null, target_url: "javascript:alert(1)", sha: "abc1234", creator: null, updated_at: "2026-06-26T00:00:00Z" },
      ],
    });
    expect(root.querySelector(".beacon-env-link")).toBeNull();
    // No element should carry the dangerous href
    const all = root.querySelectorAll("[href]");
    for (const el of all) {
      expect(el.getAttribute("href")).not.toContain("javascript:");
    }
    // No attribute anywhere should contain the javascript: payload
    expect(root.innerHTML).not.toContain("javascript:");
  });

  it("does NOT produce a clickable link when target_url is null", () => {
    renderBeacon(root, {
      kind: "ok",
      repo: "o/r",
      envs: [
        { environment: "preview", state: "in_progress", description: null, target_url: null, sha: "def5678", creator: null, updated_at: "2026-06-26T00:00:00Z" },
      ],
    });
    expect(root.querySelector(".beacon-env-link")).toBeNull();
  });

  it("produces a clickable element for an https:// target_url", () => {
    renderBeacon(root, {
      kind: "ok",
      repo: "o/r",
      envs: [
        { environment: "production", state: "success", description: null, target_url: "https://app.example.com", sha: "abc1234", creator: null, updated_at: "2026-06-26T00:00:00Z" },
      ],
    });
    const link = root.querySelector(".beacon-env-link");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("role")).toBe("link");
    expect(link?.getAttribute("tabindex")).toBe("0");
    // Must not expose the raw URL in an href
    expect(link?.getAttribute("href")).toBeNull();
  });
});
