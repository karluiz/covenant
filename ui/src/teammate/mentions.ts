/// File-mention helpers for the teammate chat composer.
///
/// - `MentionPopup`: floating multi-source picker anchored to a
///   `ComposerInput`. Opens on `@`, lists files / sessions / commands /
///   teammates, and inserts an atomic chip on selection.
/// - `expandMentions`: pure async transform that takes the raw composer
///   text + the tracked `token → payload` registry and produces the
///   final text sent to the operator, with file contents / command
///   excerpts / session excerpts inlined.

import type { ReadResult } from "../api";
import type { MentionHit, MentionSourcesDeps, Tab, Source } from "./mention-sources";
import { findMentions } from "./mention-sources";
import type { ComposerInput, ChipSpec } from "./composer-input";

export type FindFilesFn = (cwd: string, query: string, limit: number) => Promise<import("../api").FileHit[]>;
export type ReadFileFn  = (path: string, maxBytes?: number) => Promise<ReadResult>;

const FIND_DEBOUNCE_MS   = 120;
const POPUP_LIMIT        = 20;
const MAX_FILE_BYTES     = 256 * 1024;
const MAX_TOTAL_BYTES    = 512 * 1024;

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "all",       label: "All" },
  { id: "files",     label: "Files" },
  { id: "sessions",  label: "Sessions" },
  { id: "commands",  label: "Commands" },
  { id: "teammates", label: "Teammates" },
];

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

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

export type MentionPayload = MentionHit["payload"];
export type MentionRegistry = Map<string, MentionPayload>;

export interface BlockExcerpt {
  command: string;
  exit_code: number | null;
  cwd: string;
  plain_output: string;
}
export interface SessionExcerpt {
  cwd: string;
  shell: string;
  tab_index: number;
  recent: Array<{ command: string; exit_code: number | null; tail: string }>;
}
export interface ExpansionExtras {
  readBlock?:   (block_id: string) => Promise<BlockExcerpt>;
  readSession?: (session_id: string) => Promise<SessionExcerpt>;
}

export interface ExpandedMessage {
  text: string;
  /// Tokens of chips actually inlined (files: rel; others: token).
  attached: string[];
  skipped: { path: string; reason: string }[];
}

/// Back-compat helper retained for tests that exercise file-only flow:
/// find every `@token` whose token is a key in `mentions`, in first-seen
/// order, deduped. Accepts the legacy `Map<token, absPath>` shape.
export function collectMentionedPaths(text: string, mentions: Map<string, string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /(^|\s)@(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const abs = mentions.get(m[2]);
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

/// Walk every `@token` in `rawText` whose token is in `registry`, dedupe
/// by token, and dispatch per chip kind. Files are read+fenced (per-file
/// 256 KB + total 512 KB caps). Commands and sessions are fetched via
/// `extras.readBlock`/`extras.readSession`. Teammates emit a one-liner.
export async function expandMentions(
  rawText: string,
  registry: MentionRegistry,
  readFile?: ReadFileFn,
  extras: ExpansionExtras = {},
): Promise<ExpandedMessage> {
  const tokens = collectMentionedTokens(rawText, registry);
  if (tokens.length === 0) return { text: rawText, attached: [], skipped: [] };

  const sections: string[] = [];
  const attached: string[] = [];
  const skipped: ExpandedMessage["skipped"] = [];
  let totalBytes = 0;

  for (const token of tokens) {
    const payload = registry.get(token);
    if (!payload) continue;

    if (payload.kind === "files") {
      if (!readFile) { skipped.push({ path: token, reason: "skipped (no file reader)" }); continue; }
      let r: ReadResult;
      try {
        r = await readFile(payload.abs, MAX_FILE_BYTES);
      } catch (e) {
        skipped.push({ path: payload.rel, reason: `read error: ${(e as Error).message ?? String(e)}` });
        continue;
      }
      if (r.kind === "too_large") {
        skipped.push({ path: payload.rel, reason: `skipped (>${MAX_FILE_BYTES} bytes)` });
        continue;
      }
      if (!readResultUsable(r)) {
        skipped.push({ path: payload.rel, reason: "skipped (binary)" });
        continue;
      }
      const body = r.content ?? "";
      if (totalBytes + body.length > MAX_TOTAL_BYTES) {
        skipped.push({ path: payload.rel, reason: "skipped (mention bundle over 512KB)" });
        continue;
      }
      totalBytes += body.length;
      attached.push(payload.rel);
      sections.push("### " + payload.rel + "\n```" + langHint(payload.rel) + "\n" + body + "\n```");
      continue;
    }

    if (payload.kind === "commands") {
      if (!extras.readBlock) { skipped.push({ path: token, reason: "skipped (no block reader)" }); continue; }
      try {
        const b = await extras.readBlock(payload.block_id);
        const out = clipForBudget(b.plain_output, totalBytes);
        totalBytes += out.length;
        attached.push(token);
        const exit = b.exit_code === null ? "?" : String(b.exit_code);
        sections.push(
          "### command: " + b.command + "\n```text\n" +
          `$ ${b.command}\n(exit ${exit}, cwd ${b.cwd})\n\n` + out + "\n```",
        );
      } catch (e) {
        skipped.push({ path: token, reason: `read error: ${(e as Error).message ?? String(e)}` });
      }
      continue;
    }

    if (payload.kind === "sessions") {
      // Use the snapshot data captured at mention time for the header
      // (the backend's sessions table doesn't carry these columns).
      // Then enrich with recent blocks if the backend can supply them.
      const cwd = payload.cwd || "(unknown)";
      const lines: string[] = [];
      lines.push(`tab ${payload.tab_index} · ${payload.shell} · cwd ${cwd}`);
      if (payload.last_command) lines.push(`last: ${payload.last_command}`);
      lines.push("");
      let recentCount = 0;
      if (extras.readSession) {
        try {
          const s = await extras.readSession(payload.session_id);
          for (const b of s.recent) {
            const exit = b.exit_code === null ? "?" : String(b.exit_code);
            lines.push(`$ ${b.command}    (exit ${exit})`);
            if (b.tail.trim()) lines.push(b.tail.trimEnd());
            lines.push("");
            recentCount++;
          }
        } catch (e) {
          lines.push(`(could not read recent blocks: ${(e as Error).message ?? String(e)})`);
        }
      }
      if (recentCount === 0) lines.push(`(${payload.block_count} blocks, none readable)`);
      const body = clipForBudget(lines.join("\n").trimEnd(), totalBytes);
      totalBytes += body.length;
      attached.push(token);
      sections.push("### session: tab " + payload.tab_index + "\n```text\n" + body + "\n```");
      continue;
    }

    if (payload.kind === "teammates") {
      attached.push(token);
      sections.push(`teammate @${payload.name} (id=${payload.operator_id})`);
      continue;
    }
  }

  for (const s of skipped) sections.push("### " + s.path + "\n_" + s.reason + "_");

  if (sections.length === 0) return { text: rawText, attached, skipped };

  const out = rawText + "\n\n--- Mentioned ---\n" + sections.join("\n\n");
  return { text: out, attached, skipped };
}

function collectMentionedTokens(text: string, registry: MentionRegistry): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /(^|\s)@(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const tok = m[2];
    if (!registry.has(tok) || seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

function clipForBudget(body: string, used: number): string {
  const remaining = MAX_TOTAL_BYTES - used;
  if (remaining <= 0) return "";
  if (body.length <= remaining) return body;
  return body.slice(0, remaining) + "\n…(truncated)";
}

// ---------------------------------------------------------------------------
// Popup
// ---------------------------------------------------------------------------

interface PopupState {
  start: number;
  query: string;
  activeTab: Tab;
  hits: MentionHit[];
  selected: number;
  loading: boolean;
  cwd: string | null;
}

export interface MentionPopupDeps {
  input:   ComposerInput;
  anchor:  HTMLElement;
  getCwd:  () => string | null;
  sources: MentionSourcesDeps;
  onPick:  (chip: ChipSpec, hit: MentionHit) => void;
}

export class MentionPopup {
  private el: HTMLDivElement | null = null;
  private state: PopupState | null = null;
  private debounce: number | null = null;
  private reqId = 0;

  constructor(private deps: MentionPopupDeps) {
    deps.input.onInput(() => this.onInputChange());
    deps.input.onKeydown((e) => this.onKeyDown(e));
    // Note: no blur handler — mousedown handlers on rows call preventDefault.
  }

  isOpen(): boolean { return this.state !== null; }
  currentEl(): HTMLDivElement | null { return this.el; }
  destroy(): void { this.close(); }

  private onInputChange(): void {
    const m = this.deps.input.getActiveMention();
    if (!m) { this.close(); return; }
    const cwd = this.deps.getCwd();
    this.openOrUpdate({
      start: m.start, query: m.query,
      activeTab: this.state?.activeTab ?? "all",
      hits: this.state?.hits ?? [],
      selected: 0, loading: true, cwd,
    });
    this.scheduleFetch();
  }

  private scheduleFetch(): void {
    if (this.debounce !== null) window.clearTimeout(this.debounce);
    this.debounce = window.setTimeout(() => { void this.runFetch(); }, FIND_DEBOUNCE_MS);
  }

  private async runFetch(): Promise<void> {
    if (!this.state) return;
    const my = ++this.reqId;
    const { query, cwd, activeTab } = this.state;
    const hits = await findMentions({
      query, cwd, activeTab, limit: POPUP_LIMIT, deps: this.deps.sources,
    });
    if (my !== this.reqId || !this.state) return;
    this.state.hits = hits;
    this.state.loading = false;
    this.state.selected = 0;
    this.render();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (!this.state) return;
    const { hits } = this.state;
    if (e.key === "Escape") { e.preventDefault(); this.close(); return; }
    if (e.key === "ArrowDown" && hits.length) {
      e.preventDefault();
      this.state.selected = (this.state.selected + 1) % hits.length;
      this.render(); return;
    }
    if (e.key === "ArrowUp" && hits.length) {
      e.preventDefault();
      this.state.selected = (this.state.selected - 1 + hits.length) % hits.length;
      this.render(); return;
    }
    if ((e.key === "Enter" || e.key === "Tab") && hits.length && !e.shiftKey) {
      e.preventDefault();
      this.pick(hits[this.state.selected]); return;
    }
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      this.setTab(prevTab(this.state.activeTab)); return;
    }
  }

  private setTab(t: Tab): void {
    if (!this.state) return;
    this.state.activeTab = t;
    this.state.loading = true;
    this.state.hits = [];
    this.state.selected = 0;
    this.render();
    this.scheduleFetch();
  }

  private pick(hit: MentionHit): void {
    if (!this.state) return;
    const m = this.deps.input.getActiveMention();
    if (m) {
      const chip: ChipSpec = { kind: hit.kind, token: hit.token, label: hit.primary };
      this.deps.input.replaceQueryWithChip(m, chip, m.query);
      this.deps.onPick(chip, hit);
    }
    this.close();
  }

  private close(): void {
    if (this.debounce !== null) { window.clearTimeout(this.debounce); this.debounce = null; }
    this.state = null;
    if (this.el) { this.el.remove(); this.el = null; }
  }

  private openOrUpdate(next: PopupState): void {
    this.state = next;
    if (!this.el) {
      this.el = document.createElement("div");
      this.el.className = "tmt-mp";
      this.el.setAttribute("role", "listbox");
      this.deps.anchor.appendChild(this.el);
    }
    this.render();
  }

  private render(): void {
    if (!this.el || !this.state) return;
    const { hits, selected, loading, cwd, activeTab, query } = this.state;
    const header = TABS.map((t) =>
      `<div class="tmt-mp-tab${t.id === activeTab ? " is-active" : ""}" data-tab="${t.id}">${t.label}</div>`,
    ).join("");
    let body = "";
    if (loading && hits.length === 0) {
      body = `<div class="tmt-mp-empty">Searching…</div>`;
    } else if (hits.length === 0) {
      const msg = !cwd && (activeTab === "files" || activeTab === "all")
        ? "No matches. (No active session — file mentions unavailable.)"
        : `No matches${query ? ` for “${escapeHtml(query)}”` : ""}.`;
      body = `<div class="tmt-mp-empty">${msg}</div>`;
    } else {
      body = renderRows(hits, selected, activeTab);
    }
    this.el.innerHTML = `
      <div class="tmt-mp-header">${header}</div>
      <div class="tmt-mp-list">${body}</div>
      <div class="tmt-mp-foot">
        <span><kbd>↑↓</kbd> nav</span>
        <span><kbd>⇥</kbd>/<kbd>↵</kbd> insert</span>
        <span><kbd>esc</kbd> close</span>
      </div>
    `;
    this.el.querySelectorAll<HTMLElement>(".tmt-mp-tab").forEach((t) => {
      t.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.setTab(t.dataset.tab as Tab);
      });
    });
    this.el.querySelectorAll<HTMLElement>(".tmt-mp-row").forEach((row, idx) => {
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        if (this.state) { this.state.selected = idx; this.pick(this.state.hits[idx]); }
      });
    });
  }
}

function prevTab(t: Tab): Tab {
  const i = TABS.findIndex((x) => x.id === t);
  return TABS[(i - 1 + TABS.length) % TABS.length].id;
}

function renderRows(hits: MentionHit[], selected: number, tab: Tab): string {
  const parts: string[] = [];
  let lastGroup: Source | null = null;
  hits.forEach((h, i) => {
    if (tab === "all" && h.kind !== lastGroup) {
      parts.push(`<div class="tmt-mp-group">${labelFor(h.kind)}</div>`);
      lastGroup = h.kind;
    }
    parts.push(
      `<div class="tmt-mp-row tmt-mp-row--${h.kind}${i === selected ? " is-selected" : ""}" data-idx="${i}">
        <div class="tmt-mp-row__ico">${iconFor(h.kind)}</div>
        <div class="tmt-mp-row__main">
          <div class="tmt-mp-row__name">${highlight(h.primary, h.matchIndices)}</div>
          <div class="tmt-mp-row__meta">${escapeHtml(h.secondary)}</div>
        </div>
      </div>`,
    );
  });
  return parts.join("");
}

function labelFor(k: Source): string {
  return ({ files: "Files", sessions: "Sessions", commands: "Recent commands", teammates: "Teammates" } as const)[k];
}
function iconFor(k: Source): string {
  return ({ files: "⌗", sessions: "▮", commands: "$", teammates: "@" } as const)[k];
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
