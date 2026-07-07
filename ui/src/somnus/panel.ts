import {
  somnusHistory,
  somnusHistoryClear,
  somnusHistoryDelete,
  somnusSend,
  type SomnusHistoryEntry,
  type SomnusRequest,
  type SomnusResponse,
} from "../api";
import { Icons } from "../icons";
import { attachTooltip } from "../tooltip/tooltip";
import { parseCurl } from "./curl";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/// Map an attempt outcome to a rail-row `data-spine` value.
export function statusSpine(status: number | null, error: string | null): string {
  if (error !== null || status === null) return "fail";
  return status < 400 ? "ok" : "fail";
}

export function fmtSize(bytes: number | null): string {
  if (bytes === null || Number.isNaN(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fmtDuration(ms: number | null): string {
  if (ms === null) return "";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/// Pretty-print JSON bodies for display; pass through anything unparsable.
export function prettyBody(body: string): string {
  const t = body.trim();
  if (!t || (t[0] !== "{" && t[0] !== "[")) return body;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return body;
  }
}

export function relTimeMs(unixMs: number): string {
  const s = Math.max(0, Math.round((Date.now() - unixMs) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function isSendableUrl(u: string): boolean {
  try {
    const parsed = new URL(u.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

interface HeaderRow {
  row: HTMLElement;
  key: HTMLInputElement;
  val: HTMLInputElement;
}

export class SomnusPanel {
  private root: HTMLElement;
  private methodSel: HTMLSelectElement;
  private urlInput: HTMLInputElement;
  private sendBtn: HTMLButtonElement;
  private expandBtn: HTMLButtonElement;
  private tabHeadersBtn: HTMLButtonElement;
  private tabBodyBtn: HTMLButtonElement;
  private headersHost: HTMLElement;
  private bodyArea: HTMLTextAreaElement;
  private responseHost: HTMLElement;
  private historyHost: HTMLElement;
  private headerRows: HeaderRow[] = [];
  private activeTab: "headers" | "body" = "headers";
  private sending = false;
  private loadedHistory = false;
  private expanded = false;
  private expandTooltipDetach: () => void;
  private onEsc = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.expanded) {
      e.stopPropagation();
      this.setExpanded(false);
    }
  };

  constructor(
    host: HTMLElement,
    private opts: { onClose: () => void },
  ) {
    this.root = document.createElement("div");
    this.root.className = "rail-panel";

    // ── Header ──
    const header = document.createElement("div");
    header.className = "rail-header";
    const titleWrap = document.createElement("div");
    titleWrap.className = "rail-title";
    const dot = document.createElement("span");
    dot.className = "rail-dot is-idle";
    const label = document.createElement("span");
    label.className = "rail-title-label";
    label.textContent = "Somnus";
    titleWrap.append(dot, label);

    const actions = document.createElement("div");
    actions.className = "rail-actions";
    this.expandBtn = document.createElement("button");
    this.expandBtn.className = "rail-btn";
    this.expandBtn.setAttribute("aria-label", "Expand");
    this.expandBtn.innerHTML = Icons.maximize({ size: 15 });
    this.expandBtn.addEventListener("click", () => this.setExpanded(!this.expanded));
    this.expandTooltipDetach = attachTooltip(this.expandBtn, "Expand");
    const clearBtn = document.createElement("button");
    clearBtn.className = "rail-btn";
    clearBtn.setAttribute("aria-label", "Clear history");
    clearBtn.innerHTML = Icons.trash({ size: 15 });
    clearBtn.addEventListener("click", () => {
      if (!confirm("Clear all Somnus history?")) return;
      void somnusHistoryClear()
        .then(() => this.refreshHistory())
        .catch((e) => console.error("somnus clear failed", e));
    });
    attachTooltip(clearBtn, "Clear history");
    const close = document.createElement("button");
    close.className = "rail-btn";
    close.setAttribute("aria-label", "Close");
    close.innerHTML = Icons.x({ size: 15 });
    close.addEventListener("click", () => this.opts.onClose());
    attachTooltip(close, "Close");
    actions.append(this.expandBtn, clearBtn, close);
    header.append(titleWrap, actions);

    // ── Composer ──
    const composer = document.createElement("div");
    composer.className = "somnus-composer";

    const line = document.createElement("div");
    line.className = "somnus-line";
    this.methodSel = document.createElement("select");
    this.methodSel.className = "rail-select somnus-method";
    for (const m of METHODS) {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m;
      this.methodSel.append(opt);
    }
    this.methodSel.addEventListener("change", () => this.syncBodyEnabled());
    this.urlInput = document.createElement("input");
    this.urlInput.className = "rail-search somnus-url";
    this.urlInput.type = "text";
    this.urlInput.placeholder = "https://api.example.com/…  (or paste a curl command)";
    this.urlInput.spellcheck = false;
    this.urlInput.addEventListener("input", () => this.syncSendEnabled());
    this.urlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !this.sendBtn.disabled) void this.send();
    });
    this.urlInput.addEventListener("paste", (e) => {
      const text = e.clipboardData?.getData("text/plain") ?? "";
      const parsed = parseCurl(text);
      if (!parsed) return;
      e.preventDefault();
      this.loadRequest({
        method: parsed.method,
        url: parsed.url,
        headers: parsed.headers,
        body: parsed.body,
      });
    });
    this.sendBtn = document.createElement("button");
    this.sendBtn.className = "somnus-send";
    this.sendBtn.type = "button";
    this.sendBtn.textContent = "Send";
    this.sendBtn.disabled = true;
    this.sendBtn.addEventListener("click", () => void this.send());
    line.append(this.methodSel, this.urlInput, this.sendBtn);

    const controls = document.createElement("div");
    controls.className = "rail-controls";
    const tabs = document.createElement("div");
    tabs.className = "rail-tabs somnus-tabs";
    this.tabHeadersBtn = document.createElement("button");
    this.tabHeadersBtn.type = "button";
    this.tabHeadersBtn.className = "rail-tab";
    this.tabHeadersBtn.textContent = "Headers";
    this.tabHeadersBtn.dataset.tab = "headers";
    this.tabHeadersBtn.addEventListener("click", () => this.setTab("headers"));
    this.tabBodyBtn = document.createElement("button");
    this.tabBodyBtn.type = "button";
    this.tabBodyBtn.className = "rail-tab";
    this.tabBodyBtn.textContent = "Body";
    this.tabBodyBtn.dataset.tab = "body";
    this.tabBodyBtn.addEventListener("click", () => this.setTab("body"));
    tabs.append(this.tabHeadersBtn, this.tabBodyBtn);
    controls.append(tabs);

    this.headersHost = document.createElement("div");
    this.headersHost.className = "somnus-headers";
    const addHeader = document.createElement("button");
    addHeader.type = "button";
    addHeader.className = "somnus-add-header";
    addHeader.textContent = "+ header";
    addHeader.addEventListener("click", () => this.addHeaderRow("", ""));

    this.bodyArea = document.createElement("textarea");
    this.bodyArea.className = "somnus-bodybox";
    this.bodyArea.placeholder = "Request body";
    this.bodyArea.spellcheck = false;

    composer.append(line, controls, this.headersHost, addHeader, this.bodyArea);

    // ── Scroller: response + history ──
    const body = document.createElement("div");
    body.className = "rail-body";
    this.responseHost = document.createElement("div");
    this.responseHost.className = "somnus-response";
    this.historyHost = document.createElement("div");
    this.historyHost.className = "somnus-history";
    body.append(this.responseHost, this.historyHost);

    this.root.append(header, composer, body);
    host.replaceChildren(this.root);

    this.addHeaderRow("", "");
    this.setTab("headers");
    this.syncBodyEnabled();
  }

  /// Called when the panel opens.
  render(): void {
    if (!this.loadedHistory) void this.refreshHistory();
  }

  /// Called when the panel hides. Also drops fullscreen if active.
  close(): void {
    this.setExpanded(false);
  }

  // ── Composer state ──

  private setTab(tab: "headers" | "body"): void {
    this.activeTab = tab;
    this.tabHeadersBtn.classList.toggle("is-active", tab === "headers");
    this.tabBodyBtn.classList.toggle("is-active", tab === "body");
    this.root.classList.toggle("somnus-tab-headers", tab === "headers");
    this.root.classList.toggle("somnus-tab-body", tab === "body");
  }

  private syncBodyEnabled(): void {
    const enabled = BODY_METHODS.has(this.methodSel.value);
    this.bodyArea.disabled = !enabled;
    this.tabBodyBtn.disabled = !enabled;
    if (!enabled && this.activeTab === "body") this.setTab("headers");
  }

  private syncSendEnabled(): void {
    this.sendBtn.disabled = this.sending || !isSendableUrl(this.urlInput.value);
  }

  private addHeaderRow(k: string, v: string): void {
    const row = document.createElement("div");
    row.className = "somnus-header-row";
    const key = document.createElement("input");
    key.className = "rail-search";
    key.type = "text";
    key.placeholder = "Header";
    key.spellcheck = false;
    key.value = k;
    const val = document.createElement("input");
    val.className = "rail-search";
    val.type = "text";
    val.placeholder = "Value";
    val.spellcheck = false;
    val.value = v;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "rail-btn";
    rm.setAttribute("aria-label", "Remove header");
    rm.innerHTML = Icons.x({ size: 13 });
    rm.addEventListener("click", () => {
      row.remove();
      this.headerRows = this.headerRows.filter((r) => r.row !== row);
    });
    row.append(key, val, rm);
    this.headersHost.append(row);
    this.headerRows.push({ row, key, val });
  }

  private currentRequest(): SomnusRequest {
    const headers: [string, string][] = [];
    for (const r of this.headerRows) {
      const k = r.key.value.trim();
      if (k) headers.push([k, r.val.value]);
    }
    const method = this.methodSel.value;
    return {
      method,
      url: this.urlInput.value.trim(),
      headers,
      body: BODY_METHODS.has(method) && this.bodyArea.value ? this.bodyArea.value : null,
    };
  }

  private loadRequest(req: {
    method: string;
    url: string;
    headers: [string, string][];
    body: string | null;
  }): void {
    this.methodSel.value = METHODS.includes(req.method) ? req.method : "GET";
    this.urlInput.value = req.url;
    this.headersHost.replaceChildren();
    this.headerRows = [];
    for (const [k, v] of req.headers) this.addHeaderRow(k, v);
    if (this.headerRows.length === 0) this.addHeaderRow("", "");
    this.bodyArea.value = req.body ?? "";
    this.syncBodyEnabled();
    this.syncSendEnabled();
    if (req.body) this.setTab("body");
  }

  // ── Send / response ──

  private async send(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    this.sendBtn.textContent = "…";
    this.syncSendEnabled();
    const req = this.currentRequest();
    try {
      const resp = await somnusSend(req);
      this.renderResponse(resp);
    } catch (e) {
      this.renderError(String(e));
    } finally {
      this.sending = false;
      this.sendBtn.textContent = "Send";
      this.syncSendEnabled();
      void this.refreshHistory();
    }
  }

  private renderResponse(resp: SomnusResponse): void {
    this.responseHost.replaceChildren();
    const status = document.createElement("div");
    status.className = "somnus-resp-status";
    status.setAttribute("data-spine", statusSpine(resp.status, null));
    status.textContent = [
      `${resp.status} ${resp.status_text}`.trim(),
      fmtDuration(resp.duration_ms),
      fmtSize(resp.size_bytes),
    ]
      .filter(Boolean)
      .join(" · ");
    this.responseHost.append(status);

    if (resp.headers.length) {
      const det = document.createElement("details");
      det.className = "somnus-resp-headers";
      const sum = document.createElement("summary");
      sum.textContent = `Response headers (${resp.headers.length})`;
      det.append(sum);
      const list = document.createElement("pre");
      list.textContent = resp.headers.map(([k, v]) => `${k}: ${v}`).join("\n");
      det.append(list);
      this.responseHost.append(det);
    }

    if (resp.body_binary) {
      const note = document.createElement("div");
      note.className = "rail-notice";
      note.textContent = `binary (${fmtSize(resp.size_bytes)})`;
      this.responseHost.append(note);
    } else {
      if (resp.body_truncated) {
        const note = document.createElement("div");
        note.className = "rail-notice";
        note.textContent = "Response truncated at 2 MB";
        this.responseHost.append(note);
      }
      const pre = document.createElement("pre");
      pre.className = "somnus-resp-body";
      pre.textContent = prettyBody(resp.body);
      this.responseHost.append(pre);
    }
  }

  private renderError(message: string): void {
    this.responseHost.replaceChildren();
    const clean = message.replace(/^somnus:\s*/i, "");
    const dash = clean.indexOf(" — ");
    const el = document.createElement("div");
    el.className = "rail-empty is-error";
    el.innerHTML =
      Icons.alertTriangle({ size: 24 }) +
      `<div class="rail-empty-title"></div>` +
      `<div class="rail-empty-hint"></div>`;
    const titleEl = el.querySelector(".rail-empty-title");
    const hintEl = el.querySelector(".rail-empty-hint");
    if (titleEl) titleEl.textContent = dash === -1 ? clean : clean.slice(0, dash);
    if (hintEl) hintEl.textContent = dash === -1 ? "" : clean.slice(dash + 3);
    this.responseHost.append(el);
  }

  // ── History ──

  private async refreshHistory(): Promise<void> {
    try {
      const rows = await somnusHistory(50);
      this.loadedHistory = true;
      this.renderHistory(rows);
    } catch (e) {
      console.error("somnus history load failed", e);
    }
  }

  private renderHistory(rows: SomnusHistoryEntry[]): void {
    this.historyHost.replaceChildren();
    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "rail-notice";
      empty.textContent = "Sent requests will appear here.";
      this.historyHost.append(empty);
      return;
    }
    for (const entry of rows) {
      const row = document.createElement("div");
      row.className = "rail-row";
      row.setAttribute("data-spine", statusSpine(entry.status, entry.error));
      row.setAttribute("role", "button");
      row.setAttribute("tabindex", "0");

      const line = document.createElement("div");
      line.className = "rail-row-line";
      const name = document.createElement("span");
      name.className = "rail-name";
      name.textContent = entry.url;
      const when = document.createElement("span");
      when.className = "rail-when";
      when.textContent = relTimeMs(entry.created_at_unix_ms);
      line.append(name, when);

      const meta = document.createElement("div");
      meta.className = "rail-meta";
      const bits = [
        entry.method,
        entry.error ? "network error" : entry.status !== null ? String(entry.status) : "",
        fmtDuration(entry.duration_ms),
      ].filter(Boolean);
      meta.textContent = bits.join(" · ");
      row.append(line, meta);

      const del = document.createElement("button");
      del.type = "button";
      del.className = "rail-row-action";
      del.setAttribute("aria-label", "Delete entry");
      del.innerHTML = Icons.trash({ size: 13 });
      attachTooltip(del, "Delete entry");
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        void somnusHistoryDelete(entry.id)
          .then(() => this.refreshHistory())
          .catch((err) => console.error("somnus delete failed", err));
      });
      row.append(del);

      const load = (): void => this.loadEntry(entry);
      row.addEventListener("click", load);
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") load();
      });
      this.historyHost.append(row);
    }
  }

  private loadEntry(entry: SomnusHistoryEntry): void {
    this.loadRequest({
      method: entry.method,
      url: entry.url,
      headers: entry.req_headers,
      body: entry.req_body,
    });
    if (entry.error) {
      this.renderError(entry.error);
    } else if (entry.status !== null) {
      this.renderResponse({
        status: entry.status,
        status_text: "",
        headers: entry.resp_headers,
        body: entry.resp_body ?? "",
        body_truncated: false,
        body_binary: entry.resp_body === null,
        duration_ms: entry.duration_ms ?? 0,
        size_bytes: entry.size_bytes ?? 0,
      });
    }
  }

  // ── Fullscreen ──

  private setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    document.body.classList.toggle("somnus-expanded", expanded);
    this.expandBtn.innerHTML = expanded
      ? Icons.chevronsDownUp({ size: 15 })
      : Icons.maximize({ size: 15 });
    this.expandTooltipDetach();
    this.expandTooltipDetach = attachTooltip(this.expandBtn, expanded ? "Collapse" : "Expand");
    if (expanded) window.addEventListener("keydown", this.onEsc, true);
    else window.removeEventListener("keydown", this.onEsc, true);
  }
}
