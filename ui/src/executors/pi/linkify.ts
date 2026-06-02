// Linkify plain text into clickable URLs + file paths for the Pi panel.
//
// The Pi chat view renders agent output into its own DOM via
// `.textContent`, which never passes through xterm's link providers (those
// operate on the terminal buffer). So URLs and file paths printed by Pi —
// e.g. `write ~/Sources/groowcity/banner-option1.html` — render as inert
// text. This module re-implements the linkification at the DOM level:
//
//   - `https?://…`        → opens in the OS browser (`openUrl`)
//   - `~/… · ./… · /abs…` → resolved + opened in the Covenant editor
//
// Path detection mirrors `tabs/manager.ts`'s xterm PATH_RE but additionally
// honors a leading `~` (home-relative paths are common in agent output).

import { openUrl } from "@tauri-apps/plugin-opener";
import { resolveExistingPath } from "../../api";

export interface LinkifyContext {
  /// Working directory used to resolve relative paths. `null` when unknown.
  cwd: string | null;
  /// Open an absolute path in the Covenant editor (optionally at a line).
  openPath: (absPath: string, line?: number) => void;
}

// One combined matcher so URLs and paths are tokenized in a single pass and
// can't overlap. A trailing `:line` / `:line:col` suffix is captured as part
// of the path so editor jump-to-line works.
// Path arm mirrors the xterm matcher in `tabs/manager.ts` (optional `./`,
// `../`, or absolute prefix) plus a leading `~/`, and crucially requires at
// least one *internal* `/segment` — so bare relative paths like
// `src/components/Chat/ChatOverlay.tsx` are caught while lone filenames are
// not (too many false positives in prose).
const TOKEN_RE =
  /(https?:\/\/[^\s<>"'`)\]]+)|((?:~\/|\.{0,2}\/)?[A-Za-z0-9_@.\-]+(?:\/[A-Za-z0-9_@.\-]+)+(?::\d+(?::\d+)?)?)/g;

// Punctuation that commonly trails a path/URL in prose but isn't part of it.
const TRAILING = /[.,;:)\]}>'"]+$/;

function handleUrlClick(raw: string): void {
  void openUrl(raw).catch((err) => console.error("openUrl failed", err));
}

function handlePathClick(raw: string, ctx: LinkifyContext): void {
  const colonSplit = raw.match(/^(.*?)(?::(\d+)(?::\d+)?)?$/);
  const pathPart = colonSplit?.[1] ?? raw;
  const lineNum = colonSplit?.[2] ? Number(colonSplit[2]) : undefined;
  void resolveExistingPath(pathPart, ctx.cwd)
    .then((abs) => {
      if (abs) ctx.openPath(abs, lineNum);
    })
    .catch(() => {
      /* path didn't resolve — leave the click inert */
    });
}

/// Replace `el`'s contents with `text`, rendering any URLs / file paths as
/// clickable elements. Safe to call repeatedly (used during streaming) — it
/// fully rebuilds the element's children each time.
export function setLinkifiedText(
  el: HTMLElement,
  text: string,
  ctx: LinkifyContext,
): void {
  el.replaceChildren();
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const idx = m.index ?? 0;
    const rawMatch = m[0];
    // Don't let trailing punctuation get swallowed into the link target.
    const trimmed = rawMatch.replace(TRAILING, "");
    if (trimmed.length < 3) continue;

    if (idx > last) {
      el.appendChild(document.createTextNode(text.slice(last, idx)));
    }

    const isUrl = m[1] !== undefined;
    const a = document.createElement("span");
    a.className = isUrl ? "pi-link pi-link-url" : "pi-link pi-link-path";
    a.textContent = trimmed;
    a.setAttribute("role", "link");
    a.tabIndex = 0;
    const activate = (): void => {
      if (isUrl) handleUrlClick(trimmed);
      else handlePathClick(trimmed, ctx);
    };
    a.addEventListener("click", (e) => {
      e.preventDefault();
      activate();
    });
    a.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate();
      }
    });
    el.appendChild(a);

    // Re-emit any trailing punctuation we stripped from the link as text.
    const tail = rawMatch.slice(trimmed.length);
    if (tail) el.appendChild(document.createTextNode(tail));

    last = idx + rawMatch.length;
  }
  if (last < text.length) {
    el.appendChild(document.createTextNode(text.slice(last)));
  }
}
