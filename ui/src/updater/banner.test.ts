// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./check", () => ({
  installAndRelaunch: vi.fn(() => Promise.resolve()),
}));

import type { Update } from "@tauri-apps/plugin-updater";
import { showUpdateBanner } from "./banner";

// ponytail: only version/body are read by the banner
const update = { version: "9.9.9", body: "- notes" } as unknown as Update;

function mountTitlebar(): HTMLElement {
  document.body.innerHTML = `
    <header id="app-titlebar">
      <div id="app-titlebar-center">
        <span id="app-titlebar-brand">COVENANT</span>
      </div>
    </header>`;
  return document.getElementById("app-titlebar-center")!;
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.body.className = "";
});

describe("showUpdateBanner", () => {
  it("mounts the capsule into the titlebar center", () => {
    mountTitlebar();
    showUpdateBanner(update);
    const banner = document.getElementById("covenant-update-banner");
    expect(banner?.parentElement?.id).toBe("app-titlebar-center");
    expect(banner?.textContent).toContain("v9.9.9");
  });

  it("adopts an existing RC presence dot into the capsule's left edge", () => {
    const center = mountTitlebar();
    const dot = document.createElement("button");
    dot.id = "rc-presence-dot";
    center.appendChild(dot);

    showUpdateBanner(update);

    const banner = document.getElementById("covenant-update-banner")!;
    expect(dot.parentElement).toBe(banner);
    expect(banner.firstElementChild).toBe(dot);
  });

  it("returns the adopted dot to the titlebar center on dismiss", () => {
    const center = mountTitlebar();
    const dot = document.createElement("button");
    dot.id = "rc-presence-dot";
    center.appendChild(dot);

    showUpdateBanner(update);
    document
      .querySelector<HTMLButtonElement>(".update-banner__dismiss")!
      .click();

    expect(document.getElementById("covenant-update-banner")).toBeNull();
    expect(dot.parentElement).toBe(center);
  });
});
