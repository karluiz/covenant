import type { SomnusAuth, SomnusBodyMode, SomnusDraft, SomnusEnvironment } from "../api";
import { Icons } from "../icons";
import { attachTooltip } from "../tooltip/tooltip";
import { CustomSelect } from "../ui/select";
import { parseCurl } from "./curl";
import { emptyDraft, parseForm, queryRows, serializeForm, withQueryRows } from "./draft";

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export type ComposerTab = "params" | "auth" | "headers" | "body";
const TABS: [ComposerTab, string][] = [
  ["params", "Params"],
  ["auth", "Auth"],
  ["headers", "Headers"],
  ["body", "Body"],
];

interface KvRow {
  row: HTMLElement;
  key: HTMLInputElement;
  val: HTMLInputElement;
}

export interface ComposerOpts {
  onSend: () => void;
  onSave: () => void;
  onDirty: () => void;
  onEnvChange: (id: string | null) => void;
}

export class RequestComposer {
  readonly element: HTMLElement;
  private methodSel: CustomSelect;
  private urlInput: HTMLInputElement;
  private sendBtn: HTMLButtonElement;
  private envSel: CustomSelect;
  private warnEl: HTMLElement;
  private tabBtns = new Map<ComposerTab, { btn: HTMLButtonElement; badge: HTMLElement }>();
  private paramsHost!: HTMLElement;
  private headersHost!: HTMLElement;
  private formHost!: HTMLElement;
  private paramRows: KvRow[] = [];
  private headerRows: KvRow[] = [];
  private formRows: KvRow[] = [];
  private bodyArea: HTMLTextAreaElement;
  private bodyModeSel: CustomSelect;
  private authTypeSel: CustomSelect;
  private authFields: HTMLElement;
  private auth: SomnusAuth = { type: "none" };
  private syncing = false;
  private sending = false;

  constructor(private opts: ComposerOpts) {
    this.element = document.createElement("div");
    this.element.className = "somnus-composer";

    // ── method / url / send ──
    const line = document.createElement("div");
    line.className = "somnus-line";
    this.methodSel = new CustomSelect({
      className: "somnus-method",
      ariaLabel: "HTTP method",
      value: "GET",
      options: METHODS.map((m) => ({ value: m, label: m })),
      onChange: () => this.opts.onDirty(),
    });
    this.urlInput = document.createElement("input");
    this.urlInput.className = "rail-search somnus-url";
    this.urlInput.type = "text";
    this.urlInput.placeholder = "https://{{base_url}}/…  (or paste a curl command)";
    this.urlInput.spellcheck = false;
    this.urlInput.addEventListener("input", () => {
      this.syncSendEnabled();
      if (!this.syncing) {
        this.syncing = true;
        this.renderParamRows(queryRows(this.urlInput.value));
        this.syncing = false;
      }
      this.updateBadges();
      this.opts.onDirty();
    });
    this.urlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !this.sendBtn.disabled) this.opts.onSend();
    });
    this.urlInput.addEventListener("paste", (e) => {
      const text = e.clipboardData?.getData("text/plain") ?? "";
      const parsed = parseCurl(text);
      if (!parsed) return;
      e.preventDefault();
      this.setDraft({
        ...emptyDraft(),
        method: METHODS.includes(parsed.method) ? parsed.method : "GET",
        url: parsed.url,
        headers: parsed.headers,
        body: parsed.body ?? "",
        body_mode: parsed.body ? "text" : "none",
      });
      this.opts.onDirty();
    });
    this.sendBtn = document.createElement("button");
    this.sendBtn.className = "somnus-send";
    this.sendBtn.type = "button";
    this.sendBtn.textContent = "Send";
    this.sendBtn.disabled = true;
    this.sendBtn.addEventListener("click", () => this.opts.onSend());
    const saveBtn = document.createElement("button");
    saveBtn.className = "rail-btn somnus-save";
    saveBtn.type = "button";
    saveBtn.setAttribute("aria-label", "Save to collection (⌘S)");
    saveBtn.innerHTML = Icons.save({ size: 15 });
    attachTooltip(saveBtn, "Save to collection (⌘S)");
    saveBtn.addEventListener("click", () => this.opts.onSave());
    line.append(this.methodSel.element, this.urlInput, this.sendBtn, saveBtn);

    // ── environment row ──
    const envLine = document.createElement("div");
    envLine.className = "somnus-envline";
    this.envSel = new CustomSelect({
      className: "somnus-envsel",
      ariaLabel: "Active environment",
      value: "",
      options: [{ value: "", label: "No environment" }],
      onChange: (v) => this.opts.onEnvChange(v || null),
    });
    envLine.append(this.envSel.element);

    this.warnEl = document.createElement("div");
    this.warnEl.className = "somnus-var-warn hidden";

    // ── tabs ──
    const controls = document.createElement("div");
    controls.className = "rail-controls";
    const tabs = document.createElement("div");
    tabs.className = "rail-tabs somnus-tabs";
    for (const [id, label] of TABS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rail-tab";
      btn.dataset.tab = id;
      const text = document.createElement("span");
      text.textContent = label;
      const badge = document.createElement("span");
      badge.className = "somnus-badge";
      btn.append(text, badge);
      btn.addEventListener("click", () => this.setTab(id));
      tabs.append(btn);
      this.tabBtns.set(id, { btn, badge });
    }
    controls.append(tabs);

    // ── panes ──
    const paramsPane = document.createElement("div");
    paramsPane.className = "somnus-pane somnus-pane-params";
    this.paramsHost = document.createElement("div");
    this.paramsHost.className = "somnus-kv";
    paramsPane.append(this.paramsHost, this.addRowButton("+ param", () => {
      this.addKvRow(this.paramRows, this.paramsHost, "", "", () => this.paramsChanged());
    }));

    const authPane = document.createElement("div");
    authPane.className = "somnus-pane somnus-pane-auth";
    this.authTypeSel = new CustomSelect({
      className: "somnus-authsel",
      ariaLabel: "Auth type",
      value: "none",
      options: [
        { value: "none", label: "None" },
        { value: "bearer", label: "Bearer token" },
        { value: "basic", label: "Basic auth" },
        { value: "apikey", label: "API key" },
      ],
      onChange: (v) => {
        this.auth = this.defaultAuth(v);
        this.renderAuthFields();
        this.updateBadges();
        this.opts.onDirty();
      },
    });
    this.authFields = document.createElement("div");
    this.authFields.className = "somnus-auth-fields";
    authPane.append(this.authTypeSel.element, this.authFields);

    const headersPane = document.createElement("div");
    headersPane.className = "somnus-pane somnus-pane-headers";
    this.headersHost = document.createElement("div");
    this.headersHost.className = "somnus-kv";
    headersPane.append(this.headersHost, this.addRowButton("+ header", () => {
      this.addKvRow(this.headerRows, this.headersHost, "", "", () => {
        this.updateBadges();
        this.opts.onDirty();
      });
    }));

    const bodyPane = document.createElement("div");
    bodyPane.className = "somnus-pane somnus-pane-body";
    const bodyBar = document.createElement("div");
    bodyBar.className = "somnus-bodybar";
    this.bodyModeSel = new CustomSelect({
      className: "somnus-bodymode",
      ariaLabel: "Body mode",
      value: "none",
      options: [
        { value: "none", label: "None" },
        { value: "json", label: "JSON" },
        { value: "text", label: "Text" },
        { value: "form", label: "Form URL-encoded" },
      ],
      onChange: () => {
        this.renderBodyMode();
        this.updateBadges();
        this.opts.onDirty();
      },
    });
    const formatBtn = document.createElement("button");
    formatBtn.type = "button";
    formatBtn.className = "rail-btn somnus-format";
    formatBtn.textContent = "Format";
    formatBtn.addEventListener("click", () => {
      try {
        this.bodyArea.value = JSON.stringify(JSON.parse(this.bodyArea.value), null, 2);
        this.opts.onDirty();
      } catch {
        // not JSON — leave as-is
      }
    });
    bodyBar.append(this.bodyModeSel.element, formatBtn);
    this.bodyArea = document.createElement("textarea");
    this.bodyArea.className = "somnus-bodybox";
    this.bodyArea.placeholder = "Request body";
    this.bodyArea.spellcheck = false;
    this.bodyArea.addEventListener("input", () => {
      this.updateBadges();
      this.opts.onDirty();
    });
    this.formHost = document.createElement("div");
    this.formHost.className = "somnus-kv somnus-form";
    const bodyHint = document.createElement("div");
    bodyHint.className = "rail-notice somnus-body-hint";
    bodyHint.textContent = "This request sends no body.";
    bodyPane.append(
      bodyBar,
      this.bodyArea,
      this.formHost,
      this.addRowButton("+ field", () => {
        this.addKvRow(this.formRows, this.formHost, "", "", () => this.formChanged());
      }),
      bodyHint,
    );

    this.element.append(line, envLine, this.warnEl, controls, paramsPane, authPane, headersPane, bodyPane);
    this.setTab("params");
    this.renderBodyMode();
    this.renderAuthFields();
    this.updateBadges();
  }

  // ── public API ──

  getDraft(): SomnusDraft {
    return {
      method: this.methodSel.value,
      url: this.urlInput.value.trim(),
      headers: this.rowsValues(this.headerRows),
      body: this.bodyArea.value,
      body_mode: this.bodyModeSel.value as SomnusBodyMode,
      auth: this.readAuth(),
    };
  }

  setDraft(d: SomnusDraft): void {
    this.syncing = true;
    this.methodSel.value = METHODS.includes(d.method) ? d.method : "GET";
    this.urlInput.value = d.url;
    this.renderKvRows(this.headerRows, this.headersHost, d.headers, () => {
      this.updateBadges();
      this.opts.onDirty();
    });
    this.bodyArea.value = d.body;
    this.bodyModeSel.value = d.body_mode;
    this.auth = { ...d.auth };
    this.authTypeSel.value = d.auth.type;
    this.renderAuthFields();
    this.renderParamRows(queryRows(d.url));
    this.renderBodyMode();
    this.syncing = false;
    this.syncSendEnabled();
    this.updateBadges();
  }

  setEnvs(envs: SomnusEnvironment[], activeId: string | null): void {
    this.envSel.setOptions(
      [{ value: "", label: "No environment" }, ...envs.map((e) => ({ value: e.id, label: e.name }))],
      activeId ?? "",
    );
  }

  markUnresolved(missing: string[], urlAffected: boolean): void {
    this.warnEl.classList.toggle("hidden", missing.length === 0);
    this.warnEl.textContent = missing.length ? `Unresolved: ${missing.join(", ")}` : "";
    this.urlInput.classList.toggle("is-unresolved", urlAffected && missing.length > 0);
  }

  setSending(b: boolean): void {
    this.sending = b;
    this.sendBtn.textContent = b ? "…" : "Send";
    this.syncSendEnabled();
  }

  focusUrl(): void {
    this.urlInput.focus();
  }

  // ── internals ──

  private syncSendEnabled(): void {
    this.sendBtn.disabled = this.sending || this.urlInput.value.trim() === "";
  }

  private setTab(tab: ComposerTab): void {
    for (const [id, { btn }] of this.tabBtns) {
      btn.classList.toggle("is-active", id === tab);
      this.element.classList.toggle(`somnus-tab-${id}`, id === tab);
    }
  }

  private addRowButton(label: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "somnus-add-row";
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }

  private addKvRow(
    rows: KvRow[],
    host: HTMLElement,
    k: string,
    v: string,
    onEdit: () => void,
  ): void {
    const row = document.createElement("div");
    row.className = "somnus-kv-row";
    const key = document.createElement("input");
    key.className = "rail-search";
    key.type = "text";
    key.placeholder = "Key";
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
    rm.setAttribute("aria-label", "Remove");
    rm.innerHTML = Icons.x({ size: 13 });
    rm.addEventListener("click", () => {
      row.remove();
      const i = rows.findIndex((r) => r.row === row);
      if (i !== -1) rows.splice(i, 1);
      onEdit();
    });
    key.addEventListener("input", onEdit);
    val.addEventListener("input", onEdit);
    row.append(key, val, rm);
    host.append(row);
    rows.push({ row, key, val });
  }

  private renderKvRows(
    rows: KvRow[],
    host: HTMLElement,
    values: [string, string][],
    onEdit: () => void,
  ): void {
    host.replaceChildren();
    rows.length = 0;
    for (const [k, v] of values) this.addKvRow(rows, host, k, v, onEdit);
    if (rows.length === 0) this.addKvRow(rows, host, "", "", onEdit);
  }

  private rowsValues(rows: KvRow[]): [string, string][] {
    const out: [string, string][] = [];
    for (const r of rows) {
      if (r.key.value.trim()) out.push([r.key.value.trim(), r.val.value]);
    }
    return out;
  }

  private renderParamRows(values: [string, string][]): void {
    this.renderKvRows(this.paramRows, this.paramsHost, values, () => this.paramsChanged());
  }

  private paramsChanged(): void {
    if (this.syncing) return;
    this.syncing = true;
    this.urlInput.value = withQueryRows(this.urlInput.value, this.rowsValues(this.paramRows));
    this.syncing = false;
    this.syncSendEnabled();
    this.updateBadges();
    this.opts.onDirty();
  }

  private formChanged(): void {
    if (this.syncing) return;
    this.bodyArea.value = serializeForm(this.rowsValues(this.formRows));
    this.updateBadges();
    this.opts.onDirty();
  }

  private renderBodyMode(): void {
    const mode = this.bodyModeSel.value as SomnusBodyMode;
    this.element.classList.toggle("somnus-body-none", mode === "none");
    this.element.classList.toggle("somnus-body-form", mode === "form");
    this.element.classList.toggle("somnus-body-json", mode === "json");
    this.element.classList.toggle("somnus-body-text", mode === "text");
    if (mode === "form") {
      this.syncing = true;
      this.renderKvRows(this.formRows, this.formHost, parseForm(this.bodyArea.value), () =>
        this.formChanged(),
      );
      this.syncing = false;
    }
  }

  private defaultAuth(type: string): SomnusAuth {
    switch (type) {
      case "bearer":
        return { type: "bearer", token: "" };
      case "basic":
        return { type: "basic", username: "", password: "" };
      case "apikey":
        return { type: "apikey", key: "", value: "", placement: "header" };
      default:
        return { type: "none" };
    }
  }

  private authInput(placeholder: string, value: string, password: boolean, onEdit: (v: string) => void): HTMLInputElement {
    const i = document.createElement("input");
    i.className = "rail-search";
    i.type = password ? "password" : "text";
    i.placeholder = placeholder;
    i.spellcheck = false;
    i.value = value;
    i.addEventListener("input", () => {
      onEdit(i.value);
      this.updateBadges();
      this.opts.onDirty();
    });
    return i;
  }

  private renderAuthFields(): void {
    this.authFields.replaceChildren();
    const a = this.auth;
    if (a.type === "bearer") {
      this.authFields.append(this.authInput("Token", a.token, false, (v) => (a.token = v)));
    } else if (a.type === "basic") {
      this.authFields.append(
        this.authInput("Username", a.username, false, (v) => (a.username = v)),
        this.authInput("Password", a.password, true, (v) => (a.password = v)),
      );
    } else if (a.type === "apikey") {
      const placementSel = new CustomSelect({
        className: "somnus-apikey-placement",
        ariaLabel: "API key placement",
        value: a.placement,
        options: [
          { value: "header", label: "Header" },
          { value: "query", label: "Query param" },
        ],
        onChange: (v) => {
          a.placement = v === "query" ? "query" : "header";
          this.opts.onDirty();
        },
      });
      this.authFields.append(
        this.authInput("Key", a.key, false, (v) => (a.key = v)),
        this.authInput("Value", a.value, false, (v) => (a.value = v)),
        placementSel.element,
      );
    }
  }

  private readAuth(): SomnusAuth {
    // `this.auth` is mutated in place by the field listeners — hand out a
    // copy so callers never hold a live reference into composer state.
    return { ...this.auth };
  }

  private updateBadges(): void {
    const set = (tab: ComposerTab, text: string) => {
      const t = this.tabBtns.get(tab);
      if (t) t.badge.textContent = text;
    };
    const params = queryRows(this.urlInput.value).length;
    set("params", params > 0 ? String(params) : "");
    const headers = this.rowsValues(this.headerRows).length;
    set("headers", headers > 0 ? String(headers) : "");
    set("auth", this.auth.type !== "none" ? "●" : "");
    const mode = this.bodyModeSel.value;
    set("body", mode !== "none" && this.bodyArea.value ? "●" : "");
  }
}
