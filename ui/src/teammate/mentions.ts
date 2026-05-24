/// File-mention helpers for the teammate chat composer.
///
/// - `MentionPopup`: floating picker anchored to a text input. Opens on
///   `@`, fuzzy-searches files in the active session cwd, and inserts
///   `@<relpath> ` tokens on selection.
/// - `expandMentions`: pure async transform that takes the raw composer
///   text + the tracked `token → absPath` map and produces the final
///   text sent to the operator, with file contents inlined.

import type { FileHit, ReadResult } from "../api";

export type FindFilesFn = (cwd: string, query: string, limit: number) => Promise<FileHit[]>;
export type ReadFileFn  = (path: string, maxBytes?: number) => Promise<ReadResult>;

const MENTION_LIMIT      = 20;
const FIND_DEBOUNCE_MS   = 120;
const MAX_FILE_BYTES     = 256 * 1024;
const MAX_TOTAL_BYTES    = 512 * 1024;

/// Returns the active `@token` (without the `@`) directly to the left of
/// `caret` in `value`, or null if the caret isn't inside one. A mention
/// starts at index 0 or after whitespace, and contains no whitespace.
export function activeMentionAt(value: string, caret: number): { start: number; query: string } | null {
  if (caret <= 0) return null;
  let i = caret - 1;
  while (i >= 0) {
    const ch = value[i];
    if (ch === "@") {
      const prev = i === 0 ? " " : value[i - 1];
      if (/\s/.test(prev) || i === 0) return { start: i, query: value.slice(i + 1, caret) };
      return null;
    }
    if (/\s/.test(ch)) return null;
    i--;
  }
  return null;
}

/// Detect a likely text file from a `ReadResult` (the backend already
/// reports `kind: "binary" | "too_large"`).
export function readResultUsable(r: ReadResult): boolean {
  return r.kind === "text" && typeof r.content === "string";
}

const LANG_BY_EXT: Record<string, string> = {
  ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", rs: "rust", py: "python",
  go: "go", rb: "ruby", java: "java", kt: "kotlin", swift: "swift",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp",
  sh: "bash", bash: "bash", zsh: "bash", fish: "fish",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml", md: "md",
  html: "html", css: "css", scss: "scss", sql: "sql",
};

function langHint(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "";
  return LANG_BY_EXT[path.slice(dot + 1).toLowerCase()] ?? "";
}

/// Find every `@token` in `text` whose token is a key in `mentions`,
/// in first-occurrence order, deduped.
export function collectMentionedPaths(text: string, mentions: Map<string, string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // Match @ preceded by start-of-string or whitespace, then non-whitespace.
  const re = /(^|\s)@(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const token = m[2];
    const abs = mentions.get(token);
    if (!abs) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

export interface ExpandedMessage {
  text: string;
  attached: string[];           // relpaths actually inlined
  skipped: { path: string; reason: string }[];
}

/// Read each mentioned file and append a fenced block per file to
/// `rawText`. Respects per-file (256 KB) and total (512 KB) caps.
export async function expandMentions(
  rawText: string,
  mentions: Map<string, string>,
  readFile: ReadFileFn,
): Promise<ExpandedMessage> {
  const paths = collectMentionedPaths(rawText, mentions);
  if (paths.length === 0) return { text: rawText, attached: [], skipped: [] };

  // Reverse-lookup token (relpath) for nicer headings.
  const tokenByAbs = new Map<string, string>();
  for (const [tok, abs] of mentions) {
    if (!tokenByAbs.has(abs)) tokenByAbs.set(abs, tok);
  }

  const sections: string[] = [];
  const attached: string[] = [];
  const skipped: ExpandedMessage["skipped"] = [];
  let total = 0;

  for (const abs of paths) {
    const rel = tokenByAbs.get(abs) ?? abs;
    let r: ReadResult;
    try {
      r = await readFile(abs, MAX_FILE_BYTES);
    } catch (e) {
      skipped.push({ path: rel, reason: `read error: ${(e as Error).message ?? String(e)}` });
      continue;
    }
    if (r.kind === "too_large") {
      skipped.push({ path: rel, reason: `skipped (>${MAX_FILE_BYTES} bytes)` });
      continue;
    }
    if (!readResultUsable(r)) {
      skipped.push({ path: rel, reason: "skipped (binary)" });
      continue;
    }
    const body = r.content ?? "";
    if (total + body.length > MAX_TOTAL_BYTES) {
      skipped.push({ path: rel, reason: "skipped (mention bundle over 512KB)" });
      continue;
    }
    total += body.length;
    attached.push(rel);
    sections.push("### " + rel + "\n```" + langHint(rel) + "\n" + body + "\n```");
  }

  for (const s of skipped) sections.push("### " + s.path + "\n_" + s.reason + "_");

  if (sections.length === 0) return { text: rawText, attached, skipped };

  const out = rawText + "\n\n--- Mentioned files ---\n" + sections.join("\n\n");
  return { text: out, attached, skipped };
}

// ---------------------------------------------------------------------------
// Popup
// ---------------------------------------------------------------------------

export interface MentionPopupDeps {
  input:              HTMLInputElement;
  anchor:             HTMLElement;             // composer container (positioning context)
  getCwd:             () => string | null;
  findFiles:          FindFilesFn;
  /// Called when the user picks a hit. The popup has already replaced
  /// the `@query` token in the input with `@<relpath> ` and moved the
  /// caret past the trailing space.
  onPick:             (token: string, absPath: string) => void;
}

interface PopupState {
  start: number;          // index of '@' in input.value
  query: string;
  hits:  FileHit[];
  selected: number;
  loading: boolean;
  cwd: string;
}

export class MentionPopup {
  private deps: MentionPopupDeps;
  private el: HTMLElement | null = null;
  private state: PopupState | null = null;
  private debounceTimer: number | null = null;
  private reqId = 0;

  constructor(deps: MentionPopupDeps) {
    this.deps = deps;
    this.deps.input.addEventListener("input",   () => this.onInputChange());
    this.deps.input.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.deps.input.addEventListener("blur",    () => {
      // Delay close so a mousedown on a hit can still register.
      setTimeout(() => this.close(), 120);
    });
  }

  /// Visible for tests.
  isOpen(): boolean { return this.state !== null; }
  currentEl(): HTMLElement | null { return this.el; }

  destroy(): void {
    this.close();
  }

  private onInputChange(): void {
    const input = this.deps.input;
    const m = activeMentionAt(input.value, input.selectionStart ?? input.value.length);
    if (!m) { this.close(); return; }

    const cwd = this.deps.getCwd();
    if (!cwd) {
      this.openOrUpdate({ start: m.start, query: m.query, hits: [], selected: 0, loading: false, cwd: "" });
      return;
    }

    this.openOrUpdate({ start: m.start, query: m.query, hits: this.state?.hits ?? [], selected: 0, loading: true, cwd });
    this.scheduleFetch();
  }

  private scheduleFetch(): void {
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => { void this.runFetch(); }, FIND_DEBOUNCE_MS);
  }

  private async runFetch(): Promise<void> {
    if (!this.state) return;
    const myId = ++this.reqId;
    const { cwd, query } = this.state;
    let hits: FileHit[] = [];
    try {
      hits = await this.deps.findFiles(cwd, query, MENTION_LIMIT);
    } catch (e) {
      console.error("mention findFiles failed", e);
    }
    if (myId !== this.reqId || !this.state) return;
    this.state.hits = hits;
    this.state.loading = false;
    this.state.selected = 0;
    this.render();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (!this.state) return;
    if (e.key === "Escape") {
      e.preventDefault(); this.close(); return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (this.state.hits.length === 0) return;
      this.state.selected = (this.state.selected + 1) % this.state.hits.length;
      this.render();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (this.state.hits.length === 0) return;
      this.state.selected = (this.state.selected - 1 + this.state.hits.length) % this.state.hits.length;
      this.render();
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      if (this.state.hits.length === 0) {
        if (e.key === "Enter") return;     // let the form submit
        e.preventDefault(); this.close(); return;
      }
      e.preventDefault();
      this.pick(this.state.hits[this.state.selected]);
      return;
    }
  }

  private openOrUpdate(next: PopupState): void {
    this.state = next;
    if (!this.el) {
      this.el = document.createElement("div");
      this.el.className = "teammate-mention-popup";
      this.el.setAttribute("role", "listbox");
      this.deps.anchor.appendChild(this.el);
    }
    this.render();
  }

  private render(): void {
    if (!this.el || !this.state) return;
    const { hits, selected, loading, cwd } = this.state;
    this.el.innerHTML = "";

    if (!cwd) {
      const empty = document.createElement("div");
      empty.className = "teammate-mention-empty";
      empty.textContent = "No active session — file mentions unavailable.";
      this.el.append(empty);
      return;
    }
    if (loading && hits.length === 0) {
      const l = document.createElement("div");
      l.className = "teammate-mention-empty";
      l.textContent = "Searching…";
      this.el.append(l);
      return;
    }
    if (hits.length === 0) {
      const e = document.createElement("div");
      e.className = "teammate-mention-empty";
      e.textContent = "No matching files.";
      this.el.append(e);
      return;
    }

    hits.forEach((hit, i) => {
      const row = document.createElement("div");
      row.className = "teammate-mention-row" + (i === selected ? " is-selected" : "");
      row.setAttribute("role", "option");
      row.dataset.path = hit.rel_path;
      row.innerHTML = highlight(hit.rel_path, hit.match_indices);
      row.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        this.pick(hit);
      });
      this.el!.append(row);
    });
  }

  private pick(hit: FileHit): void {
    if (!this.state) return;
    const input = this.deps.input;
    const before = input.value.slice(0, this.state.start);
    const caret  = input.selectionStart ?? input.value.length;
    const after  = input.value.slice(caret);
    const token  = "@" + hit.rel_path + " ";
    input.value = before + token + after;
    const newCaret = before.length + token.length;
    input.setSelectionRange(newCaret, newCaret);
    this.deps.onPick(hit.rel_path, hit.path);
    this.close();
    input.focus();
  }

  close(): void {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.state = null;
    if (this.el) {
      this.el.remove();
      this.el = null;
    }
  }
}

function highlight(text: string, indices: number[]): string {
  if (indices.length === 0) return escapeHtml(text);
  const set = new Set(indices);
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = escapeHtml(text[i]);
    out += set.has(i) ? "<b>" + ch + "</b>" : ch;
  }
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
