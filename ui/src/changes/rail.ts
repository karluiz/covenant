import type { Changes, FileChange } from "../api";

export interface RailHandlers {
  onSelect(path: string, staged: boolean): void;
  onStage(path: string): void;
  onUnstage(path: string): void;
  onStageAll?(paths: string[]): void;
  onUnstageAll?(paths: string[]): void;
}

export function splitPath(p: string): [dir: string, name: string] {
  const i = p.lastIndexOf("/");
  return i === -1 ? ["", p] : [p.slice(0, i), p.slice(i + 1)];
}

const STATUS_LETTER: Record<FileChange["status"], string> = {
  modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "A",
};

/// Lockfiles read as "generated" instead of a noisy +NNN count.
const GENERATED = new Set(["Cargo.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"]);

export function isGenerated(path: string): boolean {
  return GENERATED.has(splitPath(path)[1]);
}

export function countsLabel(f: FileChange): string {
  if (f.binary) return "binary";
  if (isGenerated(f.path)) return "generated";
  if (f.added === 0 && f.removed === 0) return f.status === "untracked" ? "new" : "—";
  const parts: string[] = [];
  if (f.added > 0) parts.push(`+${f.added}`);
  if (f.removed > 0) parts.push(`−${f.removed}`);
  return parts.join(" ");
}

/// 5-cell GitHub-style diffstat: green cells proportional to adds, red to dels.
export function diffBlocks(f: FileChange): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "cd-blocks";
  const total = f.added + f.removed;
  const cells = 5;
  const a = total ? Math.round((f.added / total) * cells) : 0;
  const d = total ? (f.removed > 0 ? Math.max(1, cells - a) : 0) : 0;
  for (let i = 0; i < cells; i++) {
    const c = document.createElement("i");
    if (i < a) c.className = "cd-blocks--a";
    else if (i < a + d) c.className = "cd-blocks--d";
    wrap.appendChild(c);
  }
  return wrap;
}

function row(f: FileChange, staged: boolean, h: RailHandlers): HTMLElement {
  const el = document.createElement("div");
  el.className = "cd-file";
  el.dataset.path = f.path;
  el.addEventListener("click", () => h.onSelect(f.path, staged));

  const [dir, base] = splitPath(f.path);

  const status = document.createElement("span");
  status.className = `cd-status cd-status--${f.status}`;
  status.textContent = STATUS_LETTER[f.status];
  el.appendChild(status);

  const name = document.createElement("span");
  name.className = "cd-file-name";
  name.textContent = base;
  el.appendChild(name);

  const meta = document.createElement("span");
  meta.className = "cd-file-meta";
  const counts = document.createElement("span");
  counts.className = "cd-counts";
  counts.textContent = countsLabel(f);
  meta.appendChild(counts);
  if (!f.binary && !isGenerated(f.path)) meta.appendChild(diffBlocks(f));
  el.appendChild(meta);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cd-stage-btn";
  btn.textContent = staged ? "−" : "+";
  btn.setAttribute("aria-label", staged ? "Unstage" : "Stage");
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    staged ? h.onUnstage(f.path) : h.onStage(f.path);
  });
  el.appendChild(btn);

  const dirEl = document.createElement("span");
  dirEl.className = "cd-file-dir";
  const bdi = document.createElement("bdi");
  bdi.textContent = dir ? `${dir}/` : "·";
  dirEl.appendChild(bdi);
  el.appendChild(dirEl);

  return el;
}

function group(title: string, files: FileChange[], staged: boolean, h: RailHandlers): HTMLElement {
  const g = document.createElement("div");
  g.className = "cd-group";

  const hd = document.createElement("div");
  hd.className = "cd-group-hd";
  const t = document.createElement("span");
  t.className = "cd-group-title";
  t.textContent = title;
  const n = document.createElement("span");
  n.className = "cd-group-n";
  n.textContent = String(files.length);
  t.appendChild(n);
  hd.appendChild(t);

  if (files.length > 0) {
    const act = document.createElement("button");
    act.type = "button";
    act.className = "cd-group-act";
    act.textContent = staged ? "Unstage all" : "Stage all";
    act.addEventListener("click", () => {
      const paths = files.map((f) => f.path);
      staged ? h.onUnstageAll?.(paths) : h.onStageAll?.(paths);
    });
    hd.appendChild(act);
  }
  g.appendChild(hd);

  if (files.length === 0 && staged) {
    const empty = document.createElement("div");
    empty.className = "cd-group-empty";
    empty.textContent = "Nothing staged — commit takes everything";
    g.appendChild(empty);
  }

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
