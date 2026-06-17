import type { Changes, FileChange } from "../api";

export interface RailHandlers {
  onSelect(path: string, staged: boolean): void;
  onStage(path: string): void;
  onUnstage(path: string): void;
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

const STATUS_LETTER: Record<FileChange["status"], string> = {
  modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "?",
};

function row(f: FileChange, staged: boolean, h: RailHandlers): HTMLElement {
  const el = document.createElement("div");
  el.className = "cd-file";
  el.dataset.path = f.path;
  el.addEventListener("click", () => h.onSelect(f.path, staged));

  const name = document.createElement("span");
  name.className = "cd-file-name";
  name.textContent = basename(f.path);
  el.appendChild(name);

  const status = document.createElement("span");
  status.className = `cd-status cd-status--${f.status}`;
  status.textContent = STATUS_LETTER[f.status];
  el.appendChild(status);

  const counts = document.createElement("span");
  counts.className = "cd-counts";
  counts.textContent = f.binary ? "binary" : `+${f.added} −${f.removed}`;
  el.appendChild(counts);

  const btn = document.createElement("button");
  btn.className = "cd-stage-btn";
  btn.textContent = staged ? "Unstage" : "Stage";
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    staged ? h.onUnstage(f.path) : h.onStage(f.path);
  });
  el.appendChild(btn);
  return el;
}

function group(title: string, files: FileChange[], staged: boolean, h: RailHandlers): HTMLElement {
  const g = document.createElement("div");
  g.className = "cd-group";
  const t = document.createElement("div");
  t.className = "cd-group-title";
  t.textContent = `${title} (${files.length})`;
  g.appendChild(t);
  for (const f of files) g.appendChild(row(f, staged, h));
  return g;
}

export function renderRail(changes: Changes, handlers: RailHandlers, filter = ""): HTMLElement {
  const f = filter.trim().toLowerCase();
  const match = (x: FileChange) => !f || x.path.toLowerCase().includes(f);
  const root = document.createElement("div");
  root.className = "cd-rail";
  root.appendChild(group("Staged", changes.staged.filter(match), true, handlers));
  root.appendChild(group("Unstaged", changes.unstaged.filter(match), false, handlers));
  return root;
}
