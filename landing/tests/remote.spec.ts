import { test, expect } from "@playwright/test";

test("renders tabs and presence from relay frames", async ({ page }) => {
  await page.addInitScript(() => {
    class FakeWS {
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public url: string) { setTimeout(() => this.onopen && this.onopen(), 0); }
      send(_: string) {
        setTimeout(() => {
          this.onmessage && this.onmessage({ data: JSON.stringify({ t: "presence", desktop_online: true }) });
          this.onmessage && this.onmessage({ data: JSON.stringify({ t: "tabs", device_id: "mac-1", tabs: [
            { session_id: "s1", title: "build", cwd: "~/proj", executor: "claude", phase: "running", armed: false }] }) });
        }, 0);
      }
      close() { this.onclose && this.onclose(); }
    }
    // @ts-ignore
    window.WebSocket = FakeWS;
  });
  await page.goto("/remote");
  await page.fill("#rc-token", "fake.jwt.token");
  await page.click("#rc-connect");
  await expect(page.locator("#rc-status")).toHaveText("● desktop online");
  await expect(page.locator("#rc-tabs")).toContainText("build");
  await expect(page.locator("#rc-tabs")).toContainText("claude");
  await expect(page.locator("#rc-tabs")).toContainText("~/proj");
});
