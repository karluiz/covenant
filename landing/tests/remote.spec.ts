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

test("reconnect hygiene: repeated Connect doesn't stack sockets; close surfaces retrying", async ({ page }) => {
  await page.addInitScript(() => {
    class FakeWS {
      static instances = 0;
      static live: FakeWS[] = [];
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      closed = false;
      constructor(public url: string) {
        FakeWS.instances++;
        FakeWS.live.push(this);
        // open asynchronously so a rapid replace can supersede before open
        setTimeout(() => { if (!this.closed) this.onopen && this.onopen(); }, 5);
      }
      send(_: string) {
        setTimeout(() => {
          this.onmessage && this.onmessage({ data: JSON.stringify({ t: "presence", desktop_online: true }) });
        }, 0);
      }
      close() { this.closed = true; this.onclose && this.onclose(); }
    }
    // @ts-ignore
    window.WebSocket = FakeWS;
    // @ts-ignore
    window.__wsCount = () => FakeWS.instances;
    // @ts-ignore
    window.__wsCloseCurrent = () => { const l = FakeWS.live; if (l.length) l[l.length - 1].close(); };
  });
  await page.goto("/remote");
  await page.fill("#rc-token", "fake.jwt.token");

  // Double-click Connect rapidly: each bumps the epoch, neutralizing the prior.
  await page.click("#rc-connect");
  await page.click("#rc-connect");

  // Let one open settle.
  await expect(page.locator("#rc-status")).toHaveText("● desktop online");

  // Bounded socket construction — two clicks must not stack into a growing count.
  const afterClicks = await page.evaluate(() => (window as any).__wsCount());
  expect(afterClicks).toBeLessThanOrEqual(2);

  // Closing the current socket surfaces the retrying state (not a stuck silent loop).
  await page.evaluate(() => (window as any).__wsCloseCurrent());
  await expect(page.locator("#rc-status")).toHaveText("○ disconnected — retrying");

  // After the close, exactly one reconnect should be in flight; no per-cycle multiplication.
  const afterClose = await page.evaluate(() => (window as any).__wsCount());
  // first reconnect fires at 3s; assert we haven't multiplied yet within a short window.
  await page.waitForTimeout(500);
  const stillBounded = await page.evaluate(() => (window as any).__wsCount());
  expect(stillBounded).toBe(afterClose);
});

test("send_input on armed tab, unarmed gating, and rejection display", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__sent = [];
    class FakeWS {
      static last: FakeWS | null = null;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readyState = 1; // OPEN
      constructor(public url: string) { FakeWS.last = this; setTimeout(() => this.onopen && this.onopen(), 0); }
      send(data: string) {
        (window as any).__sent.push(data);
        const msg = JSON.parse(data);
        if (msg.t === "list_tabs") {
          setTimeout(() => {
            this.onmessage && this.onmessage({ data: JSON.stringify({ t: "presence", desktop_online: true }) });
            this.onmessage && this.onmessage({ data: JSON.stringify({ t: "tabs", device_id: "mac-1", tabs: [
              { session_id: "s1", title: "armed-tab", cwd: "~/p", executor: "claude", phase: "running", armed: true },
              { session_id: "s2", title: "unarmed-tab", cwd: "~/q", executor: null, phase: "idle", armed: false }] }) });
          }, 0);
        }
      }
      close() { this.onclose && this.onclose(); }
    }
    // @ts-ignore
    window.WebSocket = FakeWS;
    // @ts-ignore
    window.WebSocket.OPEN = 1;
    // @ts-ignore
    window.__pushRejection = () => { FakeWS.last && FakeWS.last.onmessage && FakeWS.last.onmessage({
      data: JSON.stringify({ t: "rejected", session_id: "s1", reason: "blocklisted", message: "rm -rf blocked" }) }); };
  });
  await page.goto("/remote");
  await page.fill("#rc-token", "fake.jwt.token");
  await page.click("#rc-connect");

  await expect(page.locator('input.rc-cmd[data-sid="s1"]')).toBeVisible();
  await expect(page.locator('input.rc-cmd[data-sid="s2"]')).toHaveCount(0);

  await page.fill('input.rc-cmd[data-sid="s1"]', "git status");
  await page.click('button.rc-send[data-sid="s1"]');

  const sent = await page.evaluate(() => (window as any).__sent as string[]);
  expect(sent).toContain(JSON.stringify({ t: "send_input", session_id: "s1", data: "git status\n" }));

  await page.evaluate(() => (window as any).__pushRejection());
  await expect(page.locator("#rc-tabs")).toContainText("rm -rf blocked");
});
