// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

const { openUrl } = vi.hoisted(() => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

import { renderBeacon, renderLoading, stateDotColor, isHttpUrl } from "./panel";
import type { BeaconState } from "../api";

describe("renderLoading", () => {
  it("renders a loading notice", () => {
    const root = document.createElement("div");
    renderLoading(root);
    const el = root.querySelector(".beacon-notice.beacon-loading");
    expect(el).not.toBeNull();
    expect(el?.textContent).toContain("Loading");
  });
});

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
  it("maps Actions run states to color classes", () => {
    expect(stateDotColor("success")).toBe("ok");
    expect(stateDotColor("in_progress")).toBe("busy");
    expect(stateDotColor("queued")).toBe("busy");
    expect(stateDotColor("failure")).toBe("bad");
    expect(stateDotColor("timed_out")).toBe("bad");
    expect(stateDotColor("cancelled")).toBe("idle");
    expect(stateDotColor("skipped")).toBe("idle");
    expect(stateDotColor("anything-else")).toBe("idle");
  });
});

type Run = Extract<BeaconState, { kind: "ok" }>["runs"][number];
function run(over: Partial<Run> = {}): Run {
  return {
    name: "Release macOS",
    state: "success",
    run_number: 42,
    branch: "main",
    sha: "abc1234",
    actor: "karluiz",
    url: "https://github.com/o/r/actions/runs/1",
    updated_at: "2026-06-26T00:00:00Z",
    ...over,
  };
}

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

  it("renders empty state when no workflows", () => {
    renderBeacon(root, { kind: "ok", repo: "o/r", runs: [] });
    expect(root.textContent).toContain("No workflows");
  });

  it("renders a sub-repo picker and fires onPick with the dir path", () => {
    const picked: string[] = [];
    renderBeacon(
      root,
      {
        kind: "repos",
        dirs: [
          { path: "/x/backend", repo: "o/backend" },
          { path: "/x/frontend", repo: "o/frontend" },
        ],
      },
      (p) => picked.push(p),
    );
    const cards = root.querySelectorAll(".rail-row");
    expect(cards.length).toBe(2);
    expect(root.textContent).toContain("2 sub-repos found");
    (cards[1] as HTMLElement).click();
    expect(picked).toEqual(["/x/frontend"]);
  });

  it("renders error message", () => {
    renderBeacon(root, { kind: "error", message: "boom" });
    expect(root.textContent).toContain("boom");
    expect(root.querySelector(".beacon-notice.beacon-error")).not.toBeNull();
  });

  it("renders one row per workflow run with a status spine", () => {
    renderBeacon(root, {
      kind: "ok",
      repo: "o/r",
      runs: [
        run({ name: "Release macOS", state: "success" }),
        run({ name: "Release Windows", state: "in_progress", url: null }),
      ],
    });
    const rows = root.querySelectorAll(".rail-row");
    expect(rows.length).toBe(2);
    expect(root.querySelector('.rail-row[data-spine="ok"]')).not.toBeNull();
    expect(root.querySelector('.rail-row[data-spine="run"]')).not.toBeNull();
    expect(root.textContent).toContain("Release macOS");
    expect(root.textContent).toContain("#42");
    expect(root.textContent).toContain("abc1234");
  });

  it("does NOT produce a clickable link for a javascript: url", () => {
    renderBeacon(root, {
      kind: "ok",
      repo: "o/r",
      runs: [run({ url: "javascript:alert(1)" })],
    });
    expect(root.querySelector('.rail-row[role="link"]')).toBeNull();
    const all = root.querySelectorAll("[href]");
    for (const el of all) {
      expect(el.getAttribute("href")).not.toContain("javascript:");
    }
    expect(root.innerHTML).not.toContain("javascript:");
  });

  it("does NOT produce a clickable link when url is null", () => {
    renderBeacon(root, {
      kind: "ok",
      repo: "o/r",
      runs: [run({ url: null })],
    });
    expect(root.querySelector('.rail-row[role="link"]')).toBeNull();
  });

  it("produces a clickable row for an https:// url", () => {
    renderBeacon(root, {
      kind: "ok",
      repo: "o/r",
      runs: [run({ url: "https://github.com/o/r/actions/runs/9" })],
    });
    const link = root.querySelector('.rail-row[role="link"]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute("role")).toBe("link");
    expect(link?.getAttribute("tabindex")).toBe("0");
    expect(link?.getAttribute("href")).toBeNull();
  });
});
