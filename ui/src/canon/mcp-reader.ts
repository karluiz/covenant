/** The MCP reader: a server's *capabilities*, not its config file.
 *
 *  The shared `openMarkdownReader` renders a unit's source as markdown, which
 *  for an MCP unit means a JSON file dumped into one full-width code fence —
 *  no wrap, no hierarchy, and none of the only thing worth opening the screen
 *  for: what the server can do. This reader parses the config into fields and
 *  puts the tool inventory front and center. The raw JSON stays, folded.
 */

import { mcpLocalTools, mcpProbeHttp, type McpToolInfo } from "../api";
import { Icons } from "../icons";

export type McpTransport = "stdio" | "http" | "unknown";

export interface McpConfig {
  transport: McpTransport;
  /** `command` + `args` joined for display ("covenant mcp-stdio"). */
  invocation: string;
  url: string;
  description: string;
  /** Env/header *keys* only — values are secrets by default. */
  envKeys: string[];
  headerKeys: string[];
  /** True for `covenant mcp-stdio`: the bridge into this very app, whose
   *  tools we can list in-process without spawning anything. */
  isSelf: boolean;
  /** Set when the file didn't parse — the reader falls back to raw. */
  parseError: string;
}

/** Parse an MCP unit's JSON into the fields the reader renders. Tolerant by
 *  design: a hand-edited config with an unknown shape still yields a usable
 *  card rather than an error page. */
export function parseMcpConfig(raw: string): McpConfig {
  const empty: McpConfig = {
    transport: "unknown", invocation: "", url: "", description: "",
    envKeys: [], headerKeys: [], isSelf: false, parseError: "",
  };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { ...empty, parseError: e instanceof Error ? e.message : String(e) };
  }
  if (typeof json !== "object" || json === null) {
    return { ...empty, parseError: "not a JSON object" };
  }
  const o = json as Record<string, unknown>;
  const command = typeof o.command === "string" ? o.command : "";
  const args = Array.isArray(o.args) ? o.args.filter((a): a is string => typeof a === "string") : [];
  const url = typeof o.url === "string" ? o.url : "";
  const declared = typeof o.type === "string" ? o.type : "";
  // `type` is advisory — plenty of configs omit it. Shape decides.
  const transport: McpTransport =
    declared === "stdio" || command ? "stdio"
    : declared === "http" || declared === "sse" || url ? "http"
    : "unknown";
  const keysOf = (v: unknown): string[] =>
    typeof v === "object" && v !== null ? Object.keys(v as Record<string, unknown>) : [];
  return {
    transport,
    invocation: [command, ...args].filter(Boolean).join(" "),
    url,
    description: typeof o.description === "string" ? o.description : "",
    envKeys: keysOf(o.env),
    headerKeys: keysOf(o.headers),
    isSelf: command === "covenant" && args.includes("mcp-stdio"),
    parseError: "",
  };
}

/** Why a server's tools can't be listed, in the user's terms. Null when they
 *  can. A stdio server we don't own would have to be spawned to be probed —
 *  a command-execution surface that needs a safety review, not a UI feature. */
export function unprobableReason(cfg: McpConfig): string | null {
  if (cfg.isSelf) return null;
  if (cfg.transport === "http" && cfg.url) return null;
  if (cfg.transport === "stdio") {
    return "Covenant only lists tools for HTTP servers and its own bridge. Probing this one means spawning its command, which needs a safety review.";
  }
  return "This config declares neither a command nor a URL, so there is nothing to ask.";
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

function pill(text: string, mod?: string, icon?: string): HTMLElement {
  const p = el("span", `mcp-pill${mod ? ` ${mod}` : ""}`);
  if (icon) {
    const i = el("span", "mcp-pill-icon");
    i.innerHTML = icon;
    p.append(i);
  }
  p.append(document.createTextNode(text));
  return p;
}

function band(label: string, count?: string): HTMLElement {
  const b = el("section", "mcp-band");
  const h = el("h2", "mcp-band-label", label);
  if (count) h.append(el("span", "mcp-band-count", count));
  b.append(h);
  return b;
}

/** dt/dd row for the identity grid. */
function specRow(dl: HTMLElement, label: string, value: Node): void {
  dl.append(el("dt", undefined, label));
  const dd = el("dd");
  dd.append(value);
  dl.append(dd);
}

function chips(values: string[]): HTMLElement {
  const box = el("div", "mcp-chips");
  for (const v of values) box.append(el("code", "mcp-chip", v));
  return box;
}

/** One expandable tool row: signature line, then its parameter table. */
function toolRow(t: McpToolInfo, index: number): HTMLElement {
  const row = el("div", "mcp-tool");
  row.dataset.open = "false";

  const head = el("button", "mcp-tool-head");
  head.type = "button";
  head.setAttribute("aria-expanded", "false");
  const panelId = `mcp-tool-panel-${index}`;
  head.setAttribute("aria-controls", panelId);

  const chev = el("span", "mcp-chev");
  chev.innerHTML = Icons.chevronRight({ size: 12 });
  head.append(chev, el("span", "mcp-tool-name", t.name), el("span", "mcp-tool-desc", t.description));
  head.append(pill(t.writes ? "writes" : "reads", t.writes ? "is-write" : "is-read"));

  const panel = el("div", "mcp-tool-panel");
  panel.id = panelId;
  panel.append(el("p", "mcp-tool-full", t.description));
  if (t.params.length === 0) {
    panel.append(el("p", "mcp-no-params", "no parameters"));
  } else {
    const table = el("table", "mcp-args");
    const thead = el("thead");
    const hr = el("tr");
    for (const h of ["Parameter", "Type", "Note"]) hr.append(el("th", undefined, h));
    thead.append(hr);
    const tbody = el("tbody");
    for (const p of t.params) {
      const tr = el("tr");
      tr.append(el("td", "mcp-arg", p.name));
      tr.append(el("td", "mcp-type", p.required ? p.ty : `${p.ty}?`));
      tr.append(el("td", undefined, p.doc || "—"));
      tbody.append(tr);
    }
    table.append(thead, tbody);
    const scroll = el("div", "mcp-args-scroll");
    scroll.append(table);
    panel.append(scroll);
  }

  head.addEventListener("click", () => {
    const open = row.dataset.open === "true";
    row.dataset.open = open ? "false" : "true";
    head.setAttribute("aria-expanded", open ? "false" : "true");
  });
  row.append(head, panel);
  return row;
}

/** Build the reader body for one parsed config + its tools. Exported for
 *  tests: the DOM is the deliverable, so it's what gets asserted. */
export function mcpReaderBody(name: string, cfg: McpConfig, raw: string): {
  body: HTMLElement;
  toolsBand: HTMLElement;
} {
  const body = el("div", "canon-reader-body mcp-reader-body");

  if (cfg.parseError) {
    const warn = band("Unreadable config");
    warn.append(el("p", "mcp-prose", `This file is not valid JSON (${cfg.parseError}). Showing it as-is.`));
    body.append(warn);
  }

  // ── identity ──
  const idBand = band("Server");
  const dl = el("dl", "mcp-spec");
  if (cfg.invocation) specRow(dl, "Invocation", el("code", "mcp-invoke", cfg.invocation));
  if (cfg.url) specRow(dl, "Endpoint", el("code", "mcp-invoke", cfg.url));
  if (cfg.description) specRow(dl, "What it is", el("p", "mcp-prose", cfg.description));
  if (cfg.envKeys.length) specRow(dl, "Environment", chips(cfg.envKeys));
  if (cfg.headerKeys.length) specRow(dl, "Headers", chips(cfg.headerKeys));
  if (dl.children.length === 0) {
    idBand.append(el("p", "mcp-prose", "This config declares no command, endpoint or description."));
  } else {
    idBand.append(dl);
  }
  body.append(idBand);

  // ── tools (filled async by openMcpReader) ──
  const toolsBand = band("Tools");
  body.append(toolsBand);

  // ── raw ──
  const rawBand = el("section", "mcp-band");
  const details = el("details", "mcp-raw");
  const summary = el("summary");
  const sChev = el("span", "mcp-chev");
  sChev.innerHTML = Icons.chevronRight({ size: 10 });
  summary.append(sChev, document.createTextNode("Raw config"));
  const pre = el("pre", undefined, raw.trim() || "(empty)");
  details.append(summary, pre);
  rawBand.append(details);
  body.append(rawBand);

  void name;
  return { body, toolsBand };
}

/** Render tools into the band: rows, or the reason there are none. */
export function fillTools(
  toolsBand: HTMLElement,
  tools: McpToolInfo[],
  reason: string | null,
  error?: string,
): void {
  const label = toolsBand.querySelector(".mcp-band-label");
  toolsBand.querySelectorAll(".mcp-tools, .mcp-prose, .mcp-note").forEach((n) => n.remove());
  if (error) {
    toolsBand.append(el("p", "mcp-note", error));
    return;
  }
  if (reason) {
    toolsBand.append(el("p", "mcp-note", reason));
    return;
  }
  if (tools.length === 0) {
    toolsBand.append(el("p", "mcp-note", "This server reports no tools."));
    return;
  }
  const writes = tools.filter((t) => t.writes).length;
  const parts = [`${tools.length}`, `${tools.length - writes} read`];
  if (writes) parts.push(`${writes} write`);
  const count = el("span", "mcp-band-count", parts.join(" · "));
  label?.querySelector(".mcp-band-count")?.remove();
  label?.append(count);

  const list = el("div", "mcp-tools");
  tools.forEach((t, i) => list.append(toolRow(t, i)));
  toolsBand.append(list);
}

/** Open the full-screen MCP reader for one unit. Mirrors
 *  `openMarkdownReader`'s shell (same overlay, same esc affordance) so the
 *  two screens feel like one component. */
export function openMcpReader(name: string, fetchRaw: () => Promise<string>): void {
  const overlay = el("div", "canon-reader mcp-reader");
  const head = el("header", "canon-reader-head");
  const headings = el("div", "canon-reader-headings");
  const title = el("span", "canon-reader-title", name);
  headings.append(title);
  const close = el("button", "canon-reader-close");
  close.type = "button";
  close.setAttribute("aria-label", "Close (Esc)");
  close.innerHTML = `<kbd class="settings-esc">esc</kbd>`;
  head.append(headings);
  const headPills = el("div", "mcp-head-pills");
  head.append(headPills, close);
  overlay.append(head);

  const loading = el("div", "canon-reader-body mcp-reader-body");
  loading.append(el("p", "mcp-note", "Loading…"));
  overlay.append(loading);

  const dismiss = (): void => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") dismiss(); };
  close.addEventListener("click", dismiss);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) dismiss(); });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);

  void fetchRaw()
    .then((raw) => {
      const cfg = parseMcpConfig(raw);
      const { body, toolsBand } = mcpReaderBody(name, cfg, raw);
      loading.replaceWith(body);
      if (cfg.transport !== "unknown") {
        headPills.append(pill(cfg.transport, undefined, Icons.radioTower({ size: 11 })));
      }

      const reason = unprobableReason(cfg);
      if (reason) {
        fillTools(toolsBand, [], reason);
        return;
      }
      fillTools(toolsBand, [], "Listing tools…");
      const probe = cfg.isSelf ? mcpLocalTools() : mcpProbeHttp(name, cfg.url, []);
      void probe
        .then((tools) => {
          fillTools(toolsBand, tools, null);
          headPills.querySelector(".mcp-pill.is-live")?.remove();
          headPills.append(pill(`${tools.length} tools`, "is-live"));
        })
        .catch((e) => fillTools(toolsBand, [], null, `Could not reach this server: ${String(e)}`));
    })
    .catch((e) => {
      loading.replaceChildren(el("p", "mcp-note", `Failed to load: ${String(e)}`));
    });
}
