// M1 layout: terminal on the left, block sidebar on the right.
// Both panels are driven by a single backend session — bytes flow to
// xterm verbatim while the same chunks feed the OSC 133 parser, whose
// events populate the sidebar.

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
import { BlockManager } from "./blocks/manager";

async function bootTerminal(): Promise<void> {
  const termHost = document.getElementById("terminal");
  const blocksHost = document.getElementById("blocks");
  if (!termHost || !blocksHost) {
    throw new Error("missing #terminal or #blocks mount node");
  }

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
  term.open(termHost);

  try {
    term.loadAddon(new WebglAddon());
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("WebGL renderer unavailable, using canvas fallback", err);
  }

  fit.fit();

  const blocks = new BlockManager(blocksHost);

  const id = await spawnSession({
    onOutput: (chunk) => term.write(chunk),
    onBlockEvent: (event) => blocks.handleEvent(event),
  });

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
  const termHost = document.getElementById("terminal");
  if (termHost) {
    termHost.textContent = `boot failed: ${String(err)}`;
  }
});
