// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

const { openUrl, resolveExistingPath } = vi.hoisted(() => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
  resolveExistingPath: vi.fn().mockResolvedValue("/abs/resolved"),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
vi.mock("../../api", () => ({ resolveExistingPath }));

import { setLinkifiedText } from "./linkify";

function ctx() {
  return { cwd: "/work", openPath: vi.fn() };
}

describe("setLinkifiedText", () => {
  it("renders a URL as a clickable link that opens in the browser", () => {
    const el = document.createElement("div");
    setLinkifiedText(el, "see https://example.com/foo for details", ctx());
    const link = el.querySelector(".pi-link-url") as HTMLElement;
    expect(link).not.toBeNull();
    expect(link.textContent).toBe("https://example.com/foo");
    link.click();
    expect(openUrl).toHaveBeenCalledWith("https://example.com/foo");
  });

  it("renders a file path as a clickable link that resolves + opens", async () => {
    const c = ctx();
    const el = document.createElement("div");
    setLinkifiedText(el, "write ~/Sources/groowcity/banner-option1.html", c);
    const link = el.querySelector(".pi-link-path") as HTMLElement;
    expect(link).not.toBeNull();
    expect(link.textContent).toBe("~/Sources/groowcity/banner-option1.html");
    link.click();
    expect(resolveExistingPath).toHaveBeenCalledWith(
      "~/Sources/groowcity/banner-option1.html",
      "/work",
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(c.openPath).toHaveBeenCalledWith("/abs/resolved", undefined);
  });

  it("links a bare relative path (no leading slash)", async () => {
    const c = ctx();
    const el = document.createElement("div");
    setLinkifiedText(el, "Update(src/components/Chat/ChatOverlay.tsx)", c);
    const link = el.querySelector(".pi-link-path") as HTMLElement;
    expect(link).not.toBeNull();
    expect(link.textContent).toBe("src/components/Chat/ChatOverlay.tsx");
    link.click();
    expect(resolveExistingPath).toHaveBeenCalledWith(
      "src/components/Chat/ChatOverlay.tsx",
      "/work",
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(c.openPath).toHaveBeenCalledWith("/abs/resolved", undefined);
  });

  it("captures a :line suffix and forwards it to the editor", async () => {
    const c = ctx();
    const el = document.createElement("div");
    setLinkifiedText(el, "at /src/app.ts:42 here", c);
    (el.querySelector(".pi-link-path") as HTMLElement).click();
    expect(resolveExistingPath).toHaveBeenCalledWith("/src/app.ts", "/work");
    await Promise.resolve();
    await Promise.resolve();
    expect(c.openPath).toHaveBeenCalledWith("/abs/resolved", 42);
  });

  it("leaves trailing punctuation outside the link target", () => {
    const el = document.createElement("div");
    setLinkifiedText(el, "(see /a/b/c.txt).", ctx());
    const link = el.querySelector(".pi-link-path") as HTMLElement;
    expect(link.textContent).toBe("/a/b/c.txt");
    expect(el.textContent).toBe("(see /a/b/c.txt).");
  });

  it("does not linkify bare prose", () => {
    const el = document.createElement("div");
    setLinkifiedText(el, "just some words here", ctx());
    expect(el.querySelector(".pi-link")).toBeNull();
    expect(el.textContent).toBe("just some words here");
  });
});
