import type { FileDiff, Hunk } from "../api";
import { highlightInto } from "./highlight";

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderHunk(h: Hunk, path: string): HTMLElement {
  const wrap = el("div", "cd-hunk");
  if (h.header) wrap.appendChild(el("div", "cd-hunk-header", h.header));
  for (const line of h.lines) {
    const row = el("div", `cd-line cd-line--${line.kind}`);
    row.appendChild(el("span", "cd-num cd-num-old", line.oldNo === null ? "" : String(line.oldNo)));
    row.appendChild(el("span", "cd-num cd-num-new", line.newNo === null ? "" : String(line.newNo)));
    const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
    row.appendChild(el("span", "cd-marker", marker));
    const textSpan = el("span", "cd-text", line.text);
    highlightInto(textSpan, line.text, path);
    row.appendChild(textSpan);
    wrap.appendChild(row);
  }
  return wrap;
}

export function renderDiffBody(file: FileDiff): HTMLElement {
  const root = el("div", "cd-diff");
  root.dataset.path = file.path;
  const body = file.body;
  if (body.kind === "binary") {
    const sizeLabel = body.sizeBytes > 0
      ? `— ${Math.round(body.sizeBytes / 1024)} KB (no text diff)`
      : `— binary (no text diff)`;
    root.appendChild(el("div", "cd-binary", `[binary] ${file.path} ${sizeLabel}`));
    return root;
  }
  if (body.kind === "tooLarge") {
    root.appendChild(el("div", "cd-toolarge", `Diff too large to display (more than ${body.lineCount} lines).`));
    return root;
  }
  for (const h of body.hunks) root.appendChild(renderHunk(h, file.path));
  return root;
}
