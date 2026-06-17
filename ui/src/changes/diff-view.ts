import type { FileDiff, Hunk } from "../api";

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderHunk(h: Hunk): HTMLElement {
  const wrap = el("div", "cd-hunk");
  if (h.header) wrap.appendChild(el("div", "cd-hunk-header", h.header));
  for (const line of h.lines) {
    const row = el("div", `cd-line cd-line--${line.kind}`);
    row.appendChild(el("span", "cd-num cd-num-old", line.oldNo === null ? "" : String(line.oldNo)));
    row.appendChild(el("span", "cd-num cd-num-new", line.newNo === null ? "" : String(line.newNo)));
    const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
    row.appendChild(el("span", "cd-marker", marker));
    row.appendChild(el("span", "cd-text", line.text));
    wrap.appendChild(row);
  }
  return wrap;
}

export function renderDiffBody(file: FileDiff): HTMLElement {
  const root = el("div", "cd-diff");
  root.dataset.path = file.path;
  const body = file.body;
  if (body.kind === "binary") {
    const kb = Math.max(1, Math.round(body.sizeBytes / 1024));
    root.appendChild(el("div", "cd-binary", `[binary] ${file.path} — ${kb} KB (no text diff)`));
    return root;
  }
  if (body.kind === "tooLarge") {
    root.appendChild(el("div", "cd-toolarge", `Diff too large to display (${body.lineCount} lines).`));
    return root;
  }
  for (const h of body.hunks) root.appendChild(renderHunk(h));
  return root;
}
