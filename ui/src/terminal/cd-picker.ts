import type { Terminal } from "@xterm/xterm";
import { structureListDir, type DirEntry } from "../api";
import { Icons } from "../icons";
import { homeFromCwd, resolveCdArg, filterDirs, parseCdLine } from "./cd-resolve";

const DEBOUNCE_MS = 120;

// POSIX single-quote escaping: ' -> '\''
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface CdPicker {
  readonly visible: boolean;
  update(bare: boolean, line: string, cwd: string | null): void;
  handleKey(data: string): boolean;
  reset(): void;
  dispose(): void;
}

export interface CdPickerHooks {
  writeBytes: (b: Uint8Array) => void;
  syncRecall: (s: string) => void;
}

// ponytail: docked at the bottom of the term pane via CSS — no cursor anchoring,
// so the xterm `term` handle is no longer needed.
export function mountCdPicker(host: HTMLElement, _term: Terminal, hooks: CdPickerHooks): CdPicker {
  const enc = new TextEncoder();
  const el = document.createElement("div");
  el.className = "cd-picker";
  el.hidden = true;
  const header = document.createElement("div");
  header.className = "cd-picker-header";
  const list = document.createElement("div");
  list.className = "cd-picker-list";
  el.append(header, list);
  host.appendChild(el);

  let visible = false;
  let listDirAbs = ""; // resolved absolute dir currently being listed
  let entries: DirEntry[] = [];
  let active = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let queryId = 0; // guards against out-of-order async results

  const hide = (): void => {
    el.hidden = true;
    visible = false;
    entries = [];
    active = 0;
  };

  const render = (listDir: string): void => {
    listDirAbs = listDir;
    header.textContent = `CURRENT LOCATION · ${listDir}`;
    list.innerHTML = "";
    entries.forEach((e, i) => {
      const row = document.createElement("div");
      row.className = "cd-picker-row" + (i === active ? " is-active" : "");
      row.innerHTML = Icons.folder({ size: 14 });
      const span = document.createElement("span");
      span.textContent = e.name; // escape: a dir named `<foo>` must not parse as HTML
      row.appendChild(span);
      row.addEventListener("mousemove", () => {
        if (active !== i) { active = i; paint(); }
      });
      row.addEventListener("mousedown", (ev) => { ev.preventDefault(); select(); });
      list.appendChild(row);
    });
    el.hidden = false;
    visible = true;
  };

  const paint = (): void => {
    [...list.children].forEach((c, i) => c.classList.toggle("is-active", i === active));
  };

  const select = (): void => {
    const e = entries[active];
    if (!e) return;
    // Emit the RESOLVED ABSOLUTE path, single-quoted, so filesystem names
    // with shell metacharacters/spaces can't inject or split args.
    const target = `${listDirAbs.replace(/\/+$/, "")}/${e.name}`; // root "/" stays "/etc" etc.
    const seq = `\x15cd ${shq(target)}\n`; // ^U kill line, retype canonical cd, run
    hooks.writeBytes(enc.encode(seq));
    hooks.syncRecall(seq);
    reset();
  };

  const runQuery = (listDir: string, prefix: string): void => {
    const id = ++queryId;
    void structureListDir(listDir, true) // showIgnored: dotfiles are valid cd targets
      .then((all) => {
        if (id !== queryId) return; // a newer keystroke superseded this
        entries = filterDirs(all, prefix);
        active = 0;
        if (entries.length === 0) { hide(); return; }
        render(listDir);
      })
      .catch(() => { if (id === queryId) hide(); }); // bad/partial path → silent hide
  };

  const cancel = (): void => {
    if (timer) { clearTimeout(timer); timer = null; }
    queryId++; // invalidate any in-flight async query
  };

  const reset = (): void => {
    cancel();
    hide();
  };

  return {
    get visible() { return visible; },
    update(bare, line, cwd): void {
      const arg = bare ? parseCdLine(line) : null;
      if (arg === null) { cancel(); if (visible) hide(); return; }
      const resolved = resolveCdArg(arg, cwd, homeFromCwd(cwd));
      if (!resolved) { cancel(); if (visible) hide(); return; }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => runQuery(resolved.listDir, resolved.prefix), DEBOUNCE_MS);
    },
    handleKey(data): boolean {
      if (!visible) return false;
      if (data === "\x1b[A") { active = Math.max(0, active - 1); paint(); return true; }
      if (data === "\x1b[B") { active = Math.min(entries.length - 1, active + 1); paint(); return true; }
      if (data === "\r") { select(); return true; }
      if (data === "\x1b") { hide(); return true; }
      return false;
    },
    reset,
    dispose(): void {
      cancel(); // clear timer + invalidate in-flight async before detaching
      el.remove();
    },
  };
}
