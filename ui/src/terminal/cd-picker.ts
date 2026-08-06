import type { Terminal } from "@xterm/xterm";
import { structureListDir, recentCwds, type DirEntry } from "../api";
import { Icons } from "../icons";
import {
  homeFromCwd, resolveCdArg, filterDirs, matchAt, parsePathLine, frecency,
} from "./cd-resolve";

// POSIX single-quote escaping: ' -> '\''
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// zsh's ZLE turns on application cursor keys (DECCKM), so xterm emits ESC O A/B
// there and ESC [ A/B only in normal mode. Matching just one form meant the
// arrow fell through to the shell, which cleared Recall's shadow buffer and
// closed the picker — the keys it claims to own never reached it.
const isUp = (d: string): boolean => d === "\x1b[A" || d === "\x1bOA";
const isDown = (d: string): boolean => d === "\x1b[B" || d === "\x1bOB";

/**
 * Backslash-escape for a path the user will keep typing on. shq() can't be
 * used for that: `cd '/a/b/'c` is broken quoting the moment another character
 * lands after the closing quote, and the whole point of inserting a trailing
 * slash is that the next keystroke continues the path.
 */
export function shesc(s: string): string {
  return s.replace(/([^A-Za-z0-9_@%+=:,./-])/g, "\\$1");
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

export function mountCdPicker(host: HTMLElement, term: Terminal, hooks: CdPickerHooks): CdPicker {
  const enc = new TextEncoder();
  const el = document.createElement("div");
  el.className = "cd-picker";
  el.hidden = true;
  const header = document.createElement("div");
  header.className = "cd-picker-header";
  // Three parts, built once: the directory in its real case, how many match,
  // and which key does what. The old single line uppercased the whole thing —
  // a path is a case-bearing identifier, so shouting it makes it unverifiable.
  const hPath = document.createElement("span");
  hPath.className = "cd-picker-path";
  const hCount = document.createElement("span");
  hCount.className = "cd-picker-count";
  const hKeys = document.createElement("span");
  hKeys.className = "cd-picker-keys";
  header.append(hPath, hCount, hKeys);
  const list = document.createElement("div");
  list.className = "cd-picker-list";
  el.append(header, list);
  host.appendChild(el);

  let visible = false;
  let listDirAbs = ""; // resolved absolute dir currently being listed
  let entries: DirEntry[] = [];
  // -1 = nothing selected. An unarmed picker must have no candidate: `cd ~`
  // resolves to an empty prefix, and with active=0 its Return picked the first
  // child of home instead of going home.
  let active = -1;
  // The picker only owns ↑/↓/⏎/Esc once the user reached for it (Tab or ↓).
  // Until then it is informational and every key belongs to the shell — ↑ is
  // history, ⏎ submits the line as typed.
  let armed = false;
  let queryId = 0; // guards against out-of-order async results
  let matchPrefix = ""; // what the user typed of the name — drives the emphasis
  let homeAbs: string | null = null; // to render `~/x` instead of /Users/you/x
  // listDir -> full readdir. Only the *prefix* changes while a path is typed,
  // so one IPC per directory level is enough; the rest filters locally, which
  // is what let the debounce go. Cleared on reset(), i.e. once per prompt.
  const listings = new Map<string, DirEntry[]>();
  let dirsOnly = true; // the verb decides: `cd` wants directories, `cat` doesn't
  let linePrefix = ""; // everything before the token — select() retypes from it
  // path -> frecency, from the cwd of past blocks. Fetched once per app run:
  // it only shifts as commands finish, and a stale row costs an ordering, not
  // a wrong candidate. ponytail: refresh on reset() if that ever matters.
  let visits: Map<string, number> | null = null;
  const loadVisits = (): void => {
    if (visits) return;
    visits = new Map(); // set first: no second in-flight request while this one runs
    void recentCwds(300)
      .then((rows) => {
        const now = Date.now();
        visits = new Map(rows.map((r) => [r.path, frecency(r.count, r.last_used_unix_ms, now)]));
      })
      .catch(() => {}); // no history → alphabetical, which is what it was before
  };
  const rank = (e: DirEntry): number =>
    visits?.get(`${listDirAbs.replace(/\/+$/, "")}/${e.name}`) ?? 0;

  const hide = (): void => {
    el.hidden = true;
    visible = false;
    entries = [];
    active = -1;
    armed = false;
  };

  /** `/Users/you/src` → `~/src`. Exact segment match only, so /Users/you2 stays. */
  const tilde = (p: string): string =>
    homeAbs && (p === homeAbs || p.startsWith(`${homeAbs}/`)) ? `~${p.slice(homeAbs.length)}` : p;

  const render = (listDir: string): void => {
    listDirAbs = listDir;
    hPath.textContent = tilde(listDir);
    hCount.textContent = `${entries.length}`;
    hKeys.textContent = armed ? "⏎ insert · esc cancel" : "tab to complete";
    list.innerHTML = "";
    entries.forEach((e, i) => {
      const row = document.createElement("div");
      row.className = "cd-picker-row" + (i === active ? " is-active" : "");
      row.innerHTML = e.kind === "dir" ? Icons.folder({ size: 14 }) : Icons.fileText({ size: 14 });
      const span = document.createElement("span");
      // Emphasize the matched run so you can see WHY a row matched and what is
      // left to type. Still built from text nodes, never innerHTML: a directory
      // named `<foo>` must not parse as markup.
      const at = matchAt(e.name, matchPrefix);
      if (at < 0) {
        span.textContent = e.name;
      } else {
        const hit = document.createElement("b");
        hit.textContent = e.name.slice(at, at + matchPrefix.length);
        span.append(
          document.createTextNode(e.name.slice(0, at)),
          hit,
          document.createTextNode(e.name.slice(at + matchPrefix.length)),
        );
      }
      row.appendChild(span);
      // Only track hover once armed. Highlighting a row the unarmed picker
      // won't act on is a lie — and arming on hover would let a mouse that
      // happens to rest here change what Return does.
      row.addEventListener("mousemove", () => {
        if (armed && active !== i) { active = i; paint(); }
      });
      row.addEventListener("mousedown", (ev) => { ev.preventDefault(); select(); });
      list.appendChild(row);
    });
    el.hidden = false;
    visible = true;
    position();
  };

  // Anchor to the shell input line (cursor row) and flip above it when the
  // prompt sits too low to fit the list below — so what you type stays visible.
  const position = (): void => {
    // ponytail: reads xterm's private renderer cell height, same accessor
    // prompt-detect.ts uses — host.clientHeight/term.rows drifts from the
    // real row height and misaligns the picker over multiple rows.
    const core = (term as unknown as {
      _core?: {
        _renderService?: { dimensions?: { css?: { cell?: { height?: number; width?: number } } } };
      };
    })._core;
    const cell = core?._renderService?.dimensions?.css?.cell;
    const cellH = cell?.height ?? host.clientHeight / term.rows;
    // The terminal's 8px inset lives on the `.xterm` child, not on host
    // (`.tab-terminal` is padding: 0). Read it there — reading host gave 0
    // and the picker landed 8px high, clipping the input line it must clear.
    const pad = getComputedStyle(host.querySelector(".xterm") ?? host);
    const padTop = parseFloat(pad.paddingTop) || 0;
    const cursorY = term.buffer.active.cursorY; // 0-based row within viewport

    // Anchor left to the start of the name being typed, not to the pane edge:
    // edge-to-edge gave a 60px folder name the visual weight of a dialog. The
    // element sizes to content (CSS), so clamp against its measured width.
    const cellW = cell?.width ?? 8;
    const padLeft = parseFloat(pad.paddingLeft) || 0;
    const nameStart = Math.max(0, term.buffer.active.cursorX - matchPrefix.length);
    const wanted = padLeft + nameStart * cellW;
    const room = host.clientWidth - el.offsetWidth - padLeft;
    el.style.left = `${Math.max(padLeft, Math.min(wanted, Math.max(padLeft, room)))}px`;
    const lineBottom = padTop + (cursorY + 1) * cellH; // px to bottom of the input line
    const below = host.clientHeight - lineBottom;
    const maxH = Math.round(host.clientHeight * 0.4);
    if (below >= 140) {
      el.style.top = `${lineBottom}px`;
      el.style.bottom = "auto";
      el.style.maxHeight = `${Math.min(maxH, below)}px`;
    } else {
      el.style.top = "auto";
      el.style.bottom = `${host.clientHeight - padTop - cursorY * cellH}px`; // above the line
      el.style.maxHeight = `${Math.min(maxH, padTop + cursorY * cellH)}px`;
    }
  };

  const paint = (): void => {
    hKeys.textContent = armed ? "⏎ insert · esc cancel" : "tab to complete"; // arming changes the legend
    el.classList.toggle("is-armed", armed); // accent stripe: whose keys these are, at a glance
    [...list.children].forEach((c, i) => {
      c.classList.toggle("is-active", i === active);
      // list scrolls (maxHeight 40% of the pane); keep the cursor on screen.
      // Optional call: jsdom has no scrollIntoView.
      if (i === active) (c as HTMLElement).scrollIntoView?.({ block: "nearest" });
    });
  };

  /** Filter a cached listing and render, or hide when nothing matches. */
  const show = (listDir: string, prefix: string): void => {
    const all = listings.get(listDir);
    if (!all) { runQuery(listDir, prefix); return; }
    matchPrefix = prefix;
    listDirAbs = listDir; // rank() resolves candidates against it — set before filtering
    entries = filterDirs(all, prefix, { dirsOnly, rank });
    active = armed && entries.length > 0 ? 0 : -1;
    if (entries.length === 0) { hide(); return; }
    render(listDir);
  };

  // Insert the path, don't run it: the user still owns Return. A trailing
  // slash means the very next query lists the children, so drilling into
  // a/b/c is one keystroke per level instead of one command per level.
  const select = (): void => {
    const e = entries[active];
    if (!e) return;
    // Emit the RESOLVED ABSOLUTE path, backslash-escaped, so filesystem names
    // with shell metacharacters/spaces can't inject or split args.
    const target = `${listDirAbs.replace(/\/+$/, "")}/${e.name}`; // root "/" stays "/etc" etc.
    // Retype the line from its own prefix, replacing only the token being
    // completed — so `cp a b` keeps `cp a ` and other verbs work at all. A
    // directory gets the trailing slash that makes the next query its children;
    // a file is a terminal choice.
    const isDir = e.kind === "dir";
    const seq = `\x15${linePrefix}${shesc(target)}${isDir ? "/" : ""}`; // ^U kill line — no newline
    hooks.writeBytes(enc.encode(seq));
    hooks.syncRecall(seq);
    // Disarm: the line now names the target, so Return belongs to the shell
    // again. Re-list from the new directory ourselves — the synthetic write
    // above never passes through onData, so no update() is coming.
    armed = false;
    if (!isDir) { hide(); return; }
    linePrefix = seq.slice(1); // the next token starts after what we just typed
    show(target, "");
  };

  const runQuery = (listDir: string, prefix: string): void => {
    const id = ++queryId;
    void structureListDir(listDir, true) // showIgnored: dotfiles are valid cd targets
      .then((all) => {
        if (id !== queryId) return; // a newer keystroke superseded this
        listings.set(listDir, all);
        show(listDir, prefix);
      })
      .catch(() => { if (id === queryId) hide(); }); // bad/partial path → silent hide
  };

  const cancel = (): void => {
    queryId++; // invalidate any in-flight async query
  };

  const reset = (): void => {
    cancel();
    listings.clear(); // a new prompt may see a changed filesystem
    hide();
  };

  return {
    get visible() { return visible; },
    update(bare, line, cwd): void {
      const parsed = bare ? parsePathLine(line) : null;
      if (!parsed) { cancel(); if (visible) hide(); return; }
      loadVisits();
      dirsOnly = parsed.dirsOnly;
      linePrefix = parsed.linePrefix;
      homeAbs = homeFromCwd(cwd);
      const resolved = resolveCdArg(parsed.arg, cwd, homeAbs);
      if (!resolved) { cancel(); if (visible) hide(); return; }
      show(resolved.listDir, resolved.prefix); // cached dir → instant, no IPC
    },
    handleKey(data): boolean {
      if (!visible) return false;
      // ↓ and Tab are the two keys that already mean "complete this" — either
      // one arms the picker. Everything else stays the shell's until then.
      if (isDown(data)) {
        if (!armed) { armed = true; active = 0; } else { active = Math.min(entries.length - 1, active + 1); }
        paint();
        return true;
      }
      if (data === "\t") {
        if (!armed) { armed = true; active = 0; paint(); } else { select(); }
        return true;
      }
      if (!armed) {
        // The shell is about to replace the line from history — our candidate
        // list describes a line that will no longer exist.
        if (isUp(data)) hide();
        // reset, not hide: an in-flight query would otherwise re-render the
        // picker after the user dismissed it.
        if (data === "\x1b") { reset(); return true; }
        return false; // ↑ history, ⏎ submit, anything else: not ours
      }
      if (isUp(data)) { active = Math.max(0, active - 1); paint(); return true; }
      if (data === "\r") { select(); return true; }
      if (data === "\x1b") { armed = false; active = -1; paint(); return true; } // disarm; a second Esc dismisses
      return false;
    },
    reset,
    dispose(): void {
      cancel(); // clear timer + invalidate in-flight async before detaching
      el.remove();
    },
  };
}
