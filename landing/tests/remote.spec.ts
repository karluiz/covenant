import { test, expect } from "@playwright/test";

test("renders sorted tab list (armed first) and presence", async ({ page }) => {
  await page.addInitScript(() => {
    class FakeWS {
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readyState = 1; // OPEN
      constructor(public url: string) { setTimeout(() => this.onopen && this.onopen(), 0); }
      send(_: string) {
        setTimeout(() => {
          this.onmessage && this.onmessage({ data: JSON.stringify({ t: "presence", desktop_online: true }) });
          this.onmessage && this.onmessage({ data: JSON.stringify({ t: "tabs", device_id: "mac-1", tabs: [
            { session_id: "s1", title: "Zeta › unarmed", cwd: "~/z", executor: null, phase: "idle", armed: false },
            { session_id: "s2", title: "Alpha › armed", cwd: "~/a", executor: "claude", phase: "running", armed: true }] }) });
        }, 0);
      }
      close() { this.onclose && this.onclose(); }
    }
    // @ts-ignore
    window.WebSocket = FakeWS;
    // @ts-ignore
    window.WebSocket.OPEN = 1;
  });
  await page.goto("/remote");
  await page.fill("#rc-token", "fake.jwt.token");
  await page.click("#rc-connect");
  await expect(page.locator("#rc-status")).toHaveText("1 active · 1 idle");
  const rows = page.locator("#rc-list button.rc-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute("data-sid", "s2"); // armed first
  await expect(rows.nth(1)).toHaveAttribute("data-sid", "s1");
  await expect(rows.nth(0)).toContainText("running"); // phase tone, executor dropped from the row
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
        // 100ms gives Playwright time to fire both clicks before any socket opens
        setTimeout(() => { if (!this.closed) this.onopen && this.onopen(); }, 100);
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

  await page.click("#rc-connect");
  await page.click("#rc-connect");

  await expect(page.locator("#rc-status")).toHaveText("no tabs");

  await page.evaluate(() => (window as any).__wsCloseCurrent());
  await expect(page.locator("#rc-status")).toHaveText("disconnected — retrying");

  const afterClose = await page.evaluate(() => (window as any).__wsCount());
  await page.waitForTimeout(500);
  const stillBounded = await page.evaluate(() => (window as any).__wsCount());
  expect(stillBounded).toBe(afterClose);
});

test("auto-selects first armed tab, mirrors it, and switches mirror on selection change", async ({ page }) => {
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
              { session_id: "s1", title: "A › first", cwd: "~/a", executor: "claude", phase: "running", armed: true },
              { session_id: "s2", title: "B › second", cwd: "~/b", executor: null, phase: "idle", armed: true }] }) });
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
    window.__pushScreen = () => { FakeWS.last && FakeWS.last.onmessage && FakeWS.last.onmessage({
      data: JSON.stringify({ t: "mirror_screen", session_id: "s1", screen: "HELLO-MIRROR" }) }); };
  });
  await page.goto("/remote");
  await page.fill("#rc-token", "fake.jwt.token");
  await page.click("#rc-connect");

  // Auto-selection of s1 (first armed, sorted) starts its mirror.
  await expect(page.locator('input.rc-cmd[data-sid="s1"]')).toBeVisible();
  let sent = await page.evaluate(() => (window as any).__sent as string[]);
  expect(sent).toContain(JSON.stringify({ t: "mirror_start", session_id: "s1" }));
  await expect(page.locator("#rc-detail-mirror")).not.toHaveClass(/hidden/);

  await page.evaluate(() => (window as any).__pushScreen());
  await expect(page.locator("#rc-mirror-term")).toContainText("HELLO", { timeout: 5000 });

  // Switching selection stops s1 and starts s2.
  await page.click('button.rc-row[data-sid="s2"]');
  sent = await page.evaluate(() => (window as any).__sent as string[]);
  expect(sent).toContain(JSON.stringify({ t: "mirror_stop", session_id: "s1" }));
  expect(sent).toContain(JSON.stringify({ t: "mirror_start", session_id: "s2" }));
  await expect(page.locator('input.rc-cmd[data-sid="s2"]')).toBeVisible();
});

test("unarmed selection shows arm hint, no controls, and stops the mirror", async ({ page }) => {
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
              { session_id: "s1", title: "A › armed", cwd: "~/a", executor: "claude", phase: "running", armed: true },
              { session_id: "s2", title: "B › unarmed", cwd: "~/b", executor: null, phase: "idle", armed: false }] }) });
          }, 0);
        }
      }
      close() { this.onclose && this.onclose(); }
    }
    // @ts-ignore
    window.WebSocket = FakeWS;
    // @ts-ignore
    window.WebSocket.OPEN = 1;
  });
  await page.goto("/remote");
  await page.fill("#rc-token", "fake.jwt.token");
  await page.click("#rc-connect");

  await expect(page.locator('input.rc-cmd[data-sid="s1"]')).toBeVisible();

  await page.click('button.rc-row[data-sid="s2"]');
  await expect(page.locator("#rc-detail")).toContainText("Arm this tab on the desktop to control it.");
  await expect(page.locator("input.rc-cmd")).toHaveCount(0);
  await expect(page.locator("#rc-detail-mirror")).toHaveClass(/hidden/);

  const sent = await page.evaluate(() => (window as any).__sent as string[]);
  expect(sent).toContain(JSON.stringify({ t: "mirror_stop", session_id: "s1" }));
});

test("send_input from the detail pane and rejection display", async ({ page }) => {
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
              { session_id: "s1", title: "armed-tab", cwd: "~/p", executor: "claude", phase: "running", armed: true }] }) });
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
  await page.fill('input.rc-cmd[data-sid="s1"]', "git status");
  await page.click('button.rc-send[data-sid="s1"]');

  const sent = await page.evaluate(() => (window as any).__sent as string[]);
  expect(sent).toContain(JSON.stringify({ t: "send_input", session_id: "s1", data: "git status\n" }));

  await page.evaluate(() => (window as any).__pushRejection());
  await expect(page.locator("#rc-detail")).toContainText("rm -rf blocked");
});

test("Focus/Close in the detail pane push lifecycle frames", async ({ page }) => {
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
              { session_id: "s1", title: "armed-tab", cwd: "~/p", executor: "claude", phase: "running", armed: true }] }) });
          }, 0);
        }
      }
      close() { this.onclose && this.onclose(); }
    }
    // @ts-ignore
    window.WebSocket = FakeWS;
    // @ts-ignore
    window.WebSocket.OPEN = 1;
  });
  await page.goto("/remote");
  await page.fill("#rc-token", "fake.jwt.token");
  await page.click("#rc-connect");

  await expect(page.locator('button.rc-focus[data-sid="s1"]')).toBeVisible();
  await page.click('button.rc-focus[data-sid="s1"]');
  await page.click('button.rc-close[data-sid="s1"]');

  const sent = await page.evaluate(() => (window as any).__sent as string[]);
  expect(sent).toContain(JSON.stringify({ t: "focus_tab", session_id: "s1" }));
  expect(sent).toContain(JSON.stringify({ t: "close_tab", session_id: "s1" }));
});

test("New Tab button sends open_tab and shows open_not_allowed rejection", async ({ page }) => {
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
    window.__pushOpenReject = () => { FakeWS.last && FakeWS.last.onmessage && FakeWS.last.onmessage({
      data: JSON.stringify({ t: "rejected", session_id: "", reason: "open_not_allowed", message: "remote tab creation is disabled on the desktop" }) }); };
  });
  await page.goto("/remote");
  await page.fill("#rc-token", "fake.jwt.token");
  await page.click("#rc-connect");
  await expect(page.locator("#rc-status")).toHaveText("no tabs");

  await page.click("#rc-new-tab");
  const sent = await page.evaluate(() => (window as any).__sent as string[]);
  expect(sent).toContain(JSON.stringify({ t: "open_tab" }));

  await page.evaluate(() => (window as any).__pushOpenReject());
  await expect(page.locator("#rc-open-error")).toHaveText("remote tab creation is disabled on the desktop");
});

test("preserves input focus and caret across an unsolicited frame", async ({ page }) => {
  await page.addInitScript(() => {
    class FakeWS {
      static last: FakeWS | null = null;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readyState = 1; // OPEN
      constructor(public url: string) { FakeWS.last = this; setTimeout(() => this.onopen && this.onopen(), 0); }
      send(data: string) {
        const msg = JSON.parse(data);
        if (msg.t === "list_tabs") {
          setTimeout(() => {
            this.onmessage && this.onmessage({ data: JSON.stringify({ t: "presence", desktop_online: true }) });
            this.onmessage && this.onmessage({ data: JSON.stringify({ t: "tabs", device_id: "mac-1", tabs: [
              { session_id: "s1", title: "armed-tab", cwd: "~/p", executor: "claude", phase: "running", armed: true }] }) });
          }, 0);
        }
      }
      close() { this.onclose && this.onclose(); }
    }
    // @ts-ignore
    window.WebSocket = FakeWS;
    // @ts-ignore
    window.WebSocket.OPEN = 1;
  });
  await page.goto("/remote");
  await page.fill("#rc-token", "fake");
  await page.click("#rc-connect");

  const input = page.locator('input.rc-cmd[data-sid="s1"]');
  await input.click();
  await input.fill("git stat");
  await page.evaluate(() => {
    const el = document.querySelector('input.rc-cmd[data-sid="s1"]') as HTMLInputElement;
    el.setSelectionRange(3, 3);
  });

  // Push an UNSOLICITED frame that triggers a render() / innerHTML rebuild.
  await page.evaluate(() => {
    (window as any).WebSocket.last.onmessage({ data: JSON.stringify({ t: "presence", desktop_online: true }) });
  });

  await expect(input).toBeFocused();
  await expect(input).toHaveValue("git stat");
  const caret = await page.evaluate(() => (document.activeElement as HTMLInputElement).selectionStart);
  expect(caret).toBe(3);
});

test("token row collapses when online and 'change token' re-expands it", async ({ page }) => {
  await page.addInitScript(() => {
    class FakeWS {
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readyState = 1; // OPEN
      constructor(public url: string) { setTimeout(() => this.onopen && this.onopen(), 0); }
      send(data: string) {
        const msg = JSON.parse(data);
        if (msg.t === "list_tabs") {
          setTimeout(() => {
            this.onmessage && this.onmessage({ data: JSON.stringify({ t: "presence", desktop_online: true }) });
          }, 0);
        }
      }
      close() { this.onclose && this.onclose(); }
    }
    // @ts-ignore
    window.WebSocket = FakeWS;
    // @ts-ignore
    window.WebSocket.OPEN = 1;
  });
  await page.goto("/remote");
  await page.fill("#rc-token", "fake.jwt.token");
  await page.click("#rc-connect");
  await expect(page.locator("#rc-status")).toHaveText("no tabs");

  await expect(page.locator("#rc-token-row")).toHaveClass(/hidden/);
  await expect(page.locator("#rc-token-toggle")).toBeVisible();

  await page.click("#rc-token-toggle");
  await expect(page.locator("#rc-token-row")).not.toHaveClass(/hidden/);
  await expect(page.locator("#rc-token")).toBeFocused();
});

test("mobile: list-first navigation, mirror starts in detail view and stops on back", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
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
              { session_id: "s1", title: "armed-tab", cwd: "~/p", executor: "claude", phase: "running", armed: true }] }) });
          }, 0);
        }
      }
      close() { this.onclose && this.onclose(); }
    }
    // @ts-ignore
    window.WebSocket = FakeWS;
    // @ts-ignore
    window.WebSocket.OPEN = 1;
  });
  await page.goto("/remote");
  await page.fill("#rc-token", "fake.jwt.token");
  await page.click("#rc-connect");

  // List view by default; auto-selection must NOT start a mirror while detail is hidden.
  await expect(page.locator('button.rc-row[data-sid="s1"]')).toBeVisible();
  await expect(page.locator("#rc-detail")).toBeHidden();
  let sent = await page.evaluate(() => (window as any).__sent as string[]);
  expect(sent).not.toContain(JSON.stringify({ t: "mirror_start", session_id: "s1" }));

  // Tap → detail view, mirror starts, back button visible.
  await page.click('button.rc-row[data-sid="s1"]');
  await expect(page.locator("#rc-detail")).toBeVisible();
  await expect(page.locator("#rc-list")).toBeHidden();
  await expect(page.locator("#rc-back")).toBeVisible();
  sent = await page.evaluate(() => (window as any).__sent as string[]);
  expect(sent).toContain(JSON.stringify({ t: "mirror_start", session_id: "s1" }));

  // Back → list view, mirror stops.
  await page.click("#rc-back");
  await expect(page.locator("#rc-list")).toBeVisible();
  await expect(page.locator("#rc-detail")).toBeHidden();
  sent = await page.evaluate(() => (window as any).__sent as string[]);
  expect(sent).toContain(JSON.stringify({ t: "mirror_stop", session_id: "s1" }));
});

test("desktop offline→online cycle restarts mirror without reselect", async ({ page }) => {
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
              { session_id: "s1", title: "armed-tab", cwd: "~/p", executor: "claude", phase: "running", armed: true }] }) });
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
    window.__pushFrame = (frame: object) => {
      FakeWS.last && FakeWS.last.onmessage && FakeWS.last.onmessage({ data: JSON.stringify(frame) });
    };
  });
  await page.goto("/remote");
  await page.fill("#rc-token", "fake.jwt.token");
  await page.click("#rc-connect");

  // Initial mirror starts.
  await expect(page.locator('input.rc-cmd[data-sid="s1"]')).toBeVisible();
  let sent = await page.evaluate(() => (window as any).__sent as string[]);
  expect(sent).toContain(JSON.stringify({ t: "mirror_start", session_id: "s1" }));

  // Desktop goes offline — mirror must stop.
  await page.evaluate(() => (window as any).__pushFrame({ t: "presence", desktop_online: false }));
  sent = await page.evaluate(() => (window as any).__sent as string[]);
  expect(sent).toContain(JSON.stringify({ t: "mirror_stop", session_id: "s1" }));

  // Snapshot sent count before online event.
  const countBeforeOnline = await page.evaluate(() => ((window as any).__sent as string[]).length);

  // Desktop comes back online + fresh tabs frame.
  await page.evaluate(() => {
    (window as any).__pushFrame({ t: "presence", desktop_online: true });
    (window as any).__pushFrame({ t: "tabs", device_id: "mac-1", tabs: [
      { session_id: "s1", title: "armed-tab", cwd: "~/p", executor: "claude", phase: "running", armed: true }] });
  });

  // A second mirror_start must appear after countBeforeOnline.
  sent = await page.evaluate(() => (window as any).__sent as string[]);
  const restartsSent = sent.slice(countBeforeOnline);
  expect(restartsSent).toContain(JSON.stringify({ t: "mirror_start", session_id: "s1" }));
});

test("a token the relay refuses (handshake never opens) is named, not hidden behind 'retrying'", async ({ page }) => {
  await page.addInitScript(() => {
    // A 401 from the relay: the browser errors + closes without ever opening.
    class FakeWS {
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readyState = 3;
      constructor(public url: string) { setTimeout(() => this.onclose && this.onclose(), 0); }
      send(_: string) {}
      close() {}
    }
    // @ts-ignore
    window.WebSocket = FakeWS;
    // @ts-ignore
    window.WebSocket.OPEN = 1;
  });
  await page.goto("/remote");
  await page.fill("#rc-token", "expired.jwt.token");
  await page.click("#rc-connect");
  // First failure is indistinguishable from a network blip; the second names it.
  await expect(page.locator("#rc-status")).toHaveText(/token rejected/, { timeout: 10_000 });
  // And a refused token is never persisted.
  expect(await page.evaluate(() => localStorage.getItem("covenant_rc_token"))).toBeNull();
});

// ---- redesign: quick keys, group folding, filter ----

function armedTabsScript() {
  (window as any).__sent = [];
  class FakeWS {
    static last: FakeWS | null = null;
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readyState = 1;
    constructor(public url: string) { FakeWS.last = this; setTimeout(() => this.onopen && this.onopen(), 0); }
    send(data: string) {
      (window as any).__sent.push(data);
      if (JSON.parse(data).t === "list_tabs") setTimeout(() => {
        this.onmessage && this.onmessage({ data: JSON.stringify({ t: "presence", desktop_online: true }) });
        this.onmessage && this.onmessage({ data: JSON.stringify({ t: "tabs", device_id: "mac-1", tabs: [
          { session_id: "s1", title: "COVENANT › agent-alpha", cwd: "~/a", executor: "claude", phase: "waiting", armed: true },
          { session_id: "s2", title: "COVENANT › agent-beta", cwd: "~/b", executor: "claude", phase: "running", armed: false },
          { session_id: "d1", title: "DRAMA › damn", cwd: "~/d", executor: null, phase: "idle", armed: false }] }) });
      }, 0);
    }
    close() { this.onclose && this.onclose(); }
  }
  // @ts-ignore
  window.WebSocket = FakeWS; // @ts-ignore
  window.WebSocket.OPEN = 1;
}

test("quick-key row sends whitelisted keystrokes as send_keys, never a command", async ({ page }) => {
  await page.addInitScript(armedTabsScript);
  await page.goto("/remote");
  await page.fill("#rc-token", "fake.jwt.token");
  await page.click("#rc-connect");
  // s1 (waiting, armed) auto-selects; its quick keys are shown.
  await expect(page.locator('button.rc-key[data-key="y"][data-sid="s1"]')).toBeVisible();
  await page.click('button.rc-key[data-key="y"][data-sid="s1"]');
  await page.click('button.rc-key[data-key="esc"][data-sid="s1"]');
  await page.click('button.rc-key[data-key="ctrl-c"][data-sid="s1"]');
  const sent = await page.evaluate(() => (window as any).__sent as string[]);
  expect(sent).toContain(JSON.stringify({ t: "send_keys", session_id: "s1", data: "y" }));
  expect(sent).toContain(JSON.stringify({ t: "send_keys", session_id: "s1", data: "esc" }));
  expect(sent).toContain(JSON.stringify({ t: "send_keys", session_id: "s1", data: "ctrl-c" }));
  // No send_input ever fired from a key press.
  expect(sent.every((s) => !s.includes('"send_input"'))).toBe(true);
});

test("groups fold and unfold; ordering floats the group with the waiting tab up", async ({ page }) => {
  await page.addInitScript(armedTabsScript);
  await page.goto("/remote");
  await page.fill("#rc-token", "fake.jwt.token");
  await page.click("#rc-connect");
  // COVENANT holds the waiting tab, so its header comes before DRAMA.
  const heads = page.locator("#rc-list button.rc-group-head");
  await expect(heads.nth(0)).toContainText("COVENANT");
  await expect(heads.nth(1)).toContainText("DRAMA");
  // Three rows visible.
  await expect(page.locator("#rc-list button.rc-row")).toHaveCount(3);
  // Fold COVENANT: its two rows disappear (only DRAMA's remains).
  await page.click('button.rc-group-head[data-group="COVENANT"]');
  await expect(page.locator("#rc-list button.rc-row")).toHaveCount(1);
});

test("filter narrows the list by leaf/group/executor", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__sent = [];
    class FakeWS {
      static last: FakeWS | null = null;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null; onerror: (() => void) | null = null;
      readyState = 1;
      constructor(public url: string) { FakeWS.last = this; setTimeout(() => this.onopen && this.onopen(), 0); }
      send(data: string) {
        (window as any).__sent.push(data);
        if (JSON.parse(data).t === "list_tabs") setTimeout(() => {
          this.onmessage && this.onmessage({ data: JSON.stringify({ t: "presence", desktop_online: true }) });
          const tabs = Array.from({ length: 12 }, (_, i) => ({
            session_id: "s" + i, title: (i === 0 ? "DRAMA › damn" : "COVENANT › agent-" + i),
            cwd: "~/x", executor: null, phase: "idle", armed: false }));
          this.onmessage && this.onmessage({ data: JSON.stringify({ t: "tabs", device_id: "mac-1", tabs }) });
        }, 0);
      }
      close() { this.onclose && this.onclose(); }
    }
    // @ts-ignore
    window.WebSocket = FakeWS; // @ts-ignore
    window.WebSocket.OPEN = 1;
  });
  await page.goto("/remote");
  await page.fill("#rc-token", "fake.jwt.token");
  await page.click("#rc-connect");
  // 12 tabs -> filter is shown.
  await expect(page.locator("#rc-filter")).toBeVisible();
  await expect(page.locator("#rc-list button.rc-row")).toHaveCount(12);
  await page.fill("#rc-filter", "damn");
  await expect(page.locator("#rc-list button.rc-row")).toHaveCount(1);
});

test("a wide source terminal does not push the detail pane off-screen", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => {
    (window as any).__sent = [];
    class FakeWS {
      static last: FakeWS | null = null;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null; onerror: (() => void) | null = null;
      readyState = 1;
      constructor(public url: string) { FakeWS.last = this; setTimeout(() => this.onopen && this.onopen(), 0); }
      send(data: string) {
        (window as any).__sent.push(data);
        if (JSON.parse(data).t === "list_tabs") setTimeout(() => {
          this.onmessage && this.onmessage({ data: JSON.stringify({ t: "presence", desktop_online: true }) });
          this.onmessage && this.onmessage({ data: JSON.stringify({ t: "tabs", device_id: "mac-1", tabs: [
            { session_id: "s1", title: "COVENANT › wide", cwd: "~/w", executor: "claude", phase: "running", armed: true }] }) });
        }, 0);
      }
      close() { this.onclose && this.onclose(); }
    }
    // @ts-ignore
    window.WebSocket = FakeWS; // @ts-ignore
    window.WebSocket.OPEN = 1; // @ts-ignore
    window.__pushWide = () => { FakeWS.last && FakeWS.last.onmessage && FakeWS.last.onmessage({
      data: JSON.stringify({ t: "mirror_screen", session_id: "s1", screen: "X".repeat(213) + "\n" + "Y".repeat(213), cols: 213, rows: 50 }) }); };
  });
  await page.goto("/remote");
  await page.fill("#rc-token", "fake.jwt.token");
  await page.click("#rc-connect");
  await expect(page.locator('input.rc-cmd[data-sid="s1"]')).toBeVisible();
  await page.evaluate(() => (window as any).__pushWide());
  // Give the scale transform a beat.
  await page.waitForTimeout(200);
  // The page must not scroll sideways, and the detail pane must fit the viewport.
  const overflow = await page.evaluate(() => ({
    bodyScroll: document.documentElement.scrollWidth - window.innerWidth,
    detailRight: document.getElementById("rc-detail")!.getBoundingClientRect().right,
    inner: window.innerWidth,
  }));
  expect(overflow.bodyScroll).toBeLessThanOrEqual(1);
  expect(overflow.detailRight).toBeLessThanOrEqual(overflow.inner + 1);
  // The Send button is fully within the viewport (was clipped before the fix).
  const sendBox = await page.locator("button.rc-send").boundingBox();
  expect(sendBox!.x + sendBox!.width).toBeLessThanOrEqual(overflow.inner + 1);
});
