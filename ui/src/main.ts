// M0 round-trip: mount xterm.js, spawn a backend PTY session, pipe bytes
// in both directions. No blocks, no tabs, no agent — just a working
// terminal so we can verify the substrate before moving to M1.

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

import {
  closeSession,
  resizeSession,
  spawnSession,
  writeToSession,
} from "./api";

async function bootTerminal(): Promise<void> {
  const host = document.getElementById("terminal");
  if (!host) throw new Error("missing #terminal mount node");

  const term = new Terminal({
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    cursorStyle: "block",
    allowProposedApi: true,
    convertEol: false,
    scrollback: 10_000,
    theme: {
      background: "#0b0d10",
      foreground: "#d6d8db",
      cursor: "#7aa2f7",
      cursorAccent: "#0b0d10",
      selectionBackground: "#2a3148",
    },
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);

  // WebGL renderer is optional; fall back silently if the GPU path isn't
  // available (e.g. headless / virtual display).
  try {
    term.loadAddon(new WebglAddon());
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("WebGL renderer unavailable, using canvas fallback", err);
  }

  fit.fit();

  const id = await spawnSession((chunk) => term.write(chunk));

  // Sync the backend PTY to the actual grid the front-end ended up with.
  await resizeSession(id, term.cols, term.rows);

  const encoder = new TextEncoder();
  term.onData((data) => {
    void writeToSession(id, encoder.encode(data)).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("write failed", err);
    });
  });

  term.onResize(({ cols, rows }) => {
    void resizeSession(id, cols, rows).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("resize failed", err);
    });
  });

  const onWindowResize = (): void => fit.fit();
  window.addEventListener("resize", onWindowResize);

  window.addEventListener("beforeunload", () => {
    window.removeEventListener("resize", onWindowResize);
    void closeSession(id);
  });

  term.focus();
}

void bootTerminal().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("karl-terminal boot failed", err);
  const host = document.getElementById("terminal");
  if (host) {
    host.textContent = `boot failed: ${String(err)}`;
  }
});
