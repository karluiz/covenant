/// Vitals — full-screen terminal-speed dashboard (repaint / switch / input
/// / boot; read Repaint first — it is the one that tracks felt lag),
/// comparing releases from locally persisted samples. Mirrors
/// WorktreesSurface (ui/src/worktrees/index.ts): a fixed overlay the
/// terminal keeps focus behind, Escape captured on the capture phase.
/// Data access is injected (VitalsDataSource) so the page unit-tests
/// without Tauri and stays decoupled from api.ts.
import "./vitals.css";
import { attachTooltip } from "../tooltip/tooltip";

export interface VitalsSummaryRow {
  metric: string;
  app_version: string;
  n: number;
  p50: number;
  p95: number;
  max: number;
  first_seen: number;
}

export interface VitalsWorstRow {
  ts: number;
  app_version: string;
  value_ms: number;
  aux_ms: number | null;
  detail: string | null;
}

export interface VitalsDailyRow {
  day: string;
  p95: number;
  n: number;
}

export interface VitalsDataSource {
  summary(days: number): Promise<VitalsSummaryRow[]>;
  worst(metric: string, limit: number): Promise<VitalsWorstRow[]>;
  daily(metric: string, days: number): Promise<VitalsDailyRow[]>;
  currentVersion(): Promise<string>;
}

// `repaint` leads: it is the metric that tracked perceived lag in
// measurement, while `switch` covers only activate()'s own synchronous work.
const METRICS = ["repaint", "switch", "input", "boot"] as const;
type Metric = (typeof METRICS)[number];

const METRIC_LABEL: Record<Metric, string> = {
  repaint: "Repaint",
  switch: "Switch",
  input: "Input",
  boot: "Boot",
};
// Each string states exactly what the number covers. The previous wording
// ("click → terminal revealed and painted") promised the click and the paint,
// and the metric contained neither.
const METRIC_HELP: Record<Metric, string> = {
  repaint:
    "Tab switch, felt: activation start → the revealed pane's first painted frame. Aux column = how long the click waited for the main thread.",
  switch:
    "Activation logic only: activate()'s own synchronous work — no click wait, no repaint. Typically 10-15ms even when a switch feels slow, so read Repaint first.",
  input: "Keystroke round trip: key → PTY echo painted. Samples over 1s are discarded, not recorded.",
  boot: "Launch → first shell prompt of the active tab.",
};

const SUMMARY_DAYS = 90;
const DAILY_DAYS = 30;
const WORST_LIMIT = 10;

export class VitalsSurface {
  private host: HTMLElement;
  private source: VitalsDataSource;
  private open_ = false;
  private version = "";
  private summaryRows: VitalsSummaryRow[] = [];
  private worstRows: VitalsWorstRow[] = [];
  private daily = new Map<Metric, VitalsDailyRow[]>();

  private onKey = (e: KeyboardEvent): void => {
    if (this.open_ && e.key === "Escape") { e.preventDefault(); this.close(); }
  };

  constructor(host: HTMLElement, source: VitalsDataSource) {
    this.host = host;
    this.source = source;
  }

  isOpen(): boolean { return this.open_; }

  async open(): Promise<void> {
    if (this.open_) return;
    this.open_ = true;
    document.body.classList.add("vitals-fullscreen");
    document.addEventListener("keydown", this.onKey, true);
    this.mountShell();
    await this.refresh();
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    document.removeEventListener("keydown", this.onKey, true);
    document.body.classList.remove("vitals-fullscreen");
    this.host.innerHTML = "";
    this.summaryRows = [];
    this.worstRows = [];
    this.daily.clear();
  }

  private async refresh(): Promise<void> {
    try {
      const [summary, version, worst, dailies] = await Promise.all([
        this.source.summary(SUMMARY_DAYS).catch(() => [] as VitalsSummaryRow[]),
        this.source.currentVersion().catch(() => ""),
        // Worst by REPAINT, not by switch: the switch metric's tail is
        // dominated by cheap-but-noisy activations, while repaint is the
        // number that corresponds to a switch the user felt.
        this.source.worst("repaint", WORST_LIMIT).catch(() => [] as VitalsWorstRow[]),
        Promise.all(
          METRICS.map((m) => this.source.daily(m, DAILY_DAYS).catch(() => [] as VitalsDailyRow[])),
        ),
      ]);
      this.summaryRows = summary;
      this.version = version;
      this.worstRows = worst;
      this.daily = new Map(METRICS.map((m, i) => [m, dailies[i] ?? []]));
    } catch {
      /* a wedged backend renders as the empty state */
    }
    if (this.open_) this.render();
  }

  // Page shell reuses WorktreesSurface's generic frame/header classes
  // (wt-frame / wt-header / wt-title / wt-header-spacer / wt-close —
  // worktrees.css is loaded globally by main.ts); vitals.css only styles
  // the vt-* content below it.
  private mountShell(): void {
    this.host.innerHTML = "";
    const frame = document.createElement("div");
    frame.className = "wt-frame vt-frame";

    const header = document.createElement("div");
    header.className = "wt-header";
    const title = document.createElement("span");
    title.className = "wt-title";
    title.textContent = "Vitals";
    const spacer = document.createElement("span");
    spacer.className = "wt-header-spacer";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "wt-close";
    close.setAttribute("aria-label", "Close (Esc)");
    close.innerHTML = `<kbd class="settings-esc">esc</kbd>`;
    close.addEventListener("click", () => this.close());
    header.append(title, spacer, close);

    const body = document.createElement("div");
    body.className = "vt-body";

    frame.append(header, body);
    this.host.appendChild(frame);
  }

  private render(): void {
    const body = this.host.querySelector(".vt-body");
    if (!body) return;
    body.innerHTML = "";

    if (this.summaryRows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "vt-empty";
      empty.textContent =
        "No vitals recorded yet — switch tabs, type at a prompt, and relaunch to collect samples.";
      body.appendChild(empty);
      return;
    }

    body.appendChild(this.renderCards());
    body.appendChild(this.renderByVersion());
    if (this.worstRows.length > 0) body.appendChild(this.renderWorst());
  }

  /// Four metric cards — p50 / p95 / n for the running version, each with
  /// a 30-day daily-p95 sparkline.
  private renderCards(): HTMLElement {
    const cards = document.createElement("div");
    cards.className = "vt-cards";
    for (const metric of METRICS) {
      const row = this.summaryRows.find(
        (r) => r.metric === metric && r.app_version === this.version,
      );
      const card = document.createElement("div");
      card.className = "vt-card";

      const name = document.createElement("div");
      name.className = "vt-card-name";
      name.textContent = METRIC_LABEL[metric];
      attachTooltip(name, METRIC_HELP[metric]);

      const stats = document.createElement("div");
      stats.className = "vt-card-stats";
      const p50 = document.createElement("span");
      p50.className = "vt-card-p50";
      p50.textContent = row ? String(Math.round(row.p50)) : "—";
      const unit = document.createElement("span");
      unit.className = "vt-card-unit";
      unit.textContent = "ms p50";
      stats.append(p50, unit);

      const sub = document.createElement("div");
      sub.className = "vt-card-sub";
      sub.textContent = row
        ? `p95 ${Math.round(row.p95)} ms · ${row.n} ${row.n === 1 ? "sample" : "samples"}`
        : "no samples this version";

      card.append(name, stats, sub);
      const series = this.daily.get(metric) ?? [];
      if (series.length > 0) card.appendChild(sparkline(series));
      cards.appendChild(card);
    }
    return cards;
  }

  /// By-version comparison — rows are versions newest-first (by first_seen),
  /// one `p50 / p95 (n)` cell per metric.
  private renderByVersion(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "vt-section";
    wrap.appendChild(sectionLabel(`By version · last ${SUMMARY_DAYS} days`));

    const firstSeen = new Map<string, number>();
    for (const r of this.summaryRows) {
      const cur = firstSeen.get(r.app_version);
      if (cur === undefined || r.first_seen < cur) firstSeen.set(r.app_version, r.first_seen);
    }
    const versions = [...firstSeen.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);

    const table = document.createElement("table");
    table.className = "vt-table";
    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    hr.appendChild(th("Version"));
    for (const metric of METRICS) {
      const cell = th(`${METRIC_LABEL[metric]} p50 / p95 (n)`, "vt-num");
      attachTooltip(cell, METRIC_HELP[metric]);
      hr.appendChild(cell);
    }
    thead.appendChild(hr);
    const tbody = document.createElement("tbody");
    for (const version of versions) {
      const tr = document.createElement("tr");
      const ver = td(version);
      if (version === this.version) ver.classList.add("vt-ver-current");
      tr.appendChild(ver);
      for (const metric of METRICS) {
        const row = this.summaryRows.find(
          (r) => r.metric === metric && r.app_version === version,
        );
        tr.appendChild(
          td(row ? `${Math.round(row.p50)} / ${Math.round(row.p95)} (${row.n})` : "—", "vt-num"),
        );
      }
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    wrap.appendChild(table);
    return wrap;
  }

  /// Slowest switches — the tail worth investigating, with the activation
  /// breadcrumb fields parsed out of the JSON detail column.
  private renderWorst(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "vt-section";
    wrap.appendChild(sectionLabel("Slowest switches"));

    const table = document.createElement("table");
    table.className = "vt-table";
    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    hr.appendChild(th("Time"));
    hr.appendChild(th("Version"));
    hr.appendChild(th("ms", "vt-num"));
    const aux = th("Queued ms", "vt-num");
    attachTooltip(aux, "How long the click waited for the main thread before activation started.");
    hr.appendChild(aux);
    const kind = th("Tab");
    attachTooltip(kind, "Tab kind — shell, acp, pi or browser. All kinds are recorded.");
    hr.appendChild(kind);
    hr.appendChild(th("Hidden output", "vt-num"));
    hr.appendChild(th("Cols Δ", "vt-num"));
    hr.appendChild(th("Fit ms", "vt-num"));
    thead.appendChild(hr);

    const tbody = document.createElement("tbody");
    for (const row of this.worstRows) {
      const detail = parseDetail(row.detail);
      const tr = document.createElement("tr");
      tr.appendChild(td(formatLocalTime(row.ts)));
      tr.appendChild(td(row.app_version));
      tr.appendChild(td(String(Math.round(row.value_ms)), "vt-num"));
      tr.appendChild(td(row.aux_ms === null ? "—" : String(Math.round(row.aux_ms)), "vt-num"));
      tr.appendChild(td(typeof detail["kind"] === "string" ? String(detail["kind"]) : "—"));
      tr.appendChild(td(formatBytesField(detail["hiddenOutputBytes"]), "vt-num"));
      tr.appendChild(td(formatNumberField(detail["colsDelta"]), "vt-num"));
      tr.appendChild(td(formatNumberField(detail["fitMs"]), "vt-num"));
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    wrap.appendChild(table);
    return wrap;
  }
}

/// Min-max normalized daily-p95 polyline, 120×28, no chart lib.
function sparkline(series: VitalsDailyRow[]): SVGSVGElement {
  const W = 120;
  const H = 28;
  const PAD = 3;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "vt-spark");
  svg.setAttribute("width", String(W));
  svg.setAttribute("height", String(H));
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const values = series.map((r) => r.p95);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const points = values
    .map((v, i) => {
      const x = values.length === 1 ? W / 2 : PAD + (i / (values.length - 1)) * (W - PAD * 2);
      const t = span === 0 ? 0.5 : (v - min) / span;
      const y = PAD + (1 - t) * (H - PAD * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const line = document.createElementNS(ns, "polyline");
  line.setAttribute("points", points);
  line.setAttribute("vector-effect", "non-scaling-stroke");
  svg.appendChild(line);
  return svg;
}

/// Uppercase mono section label — same treatment as the worktrees detail.
function sectionLabel(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "vt-seclabel";
  el.textContent = text;
  return el;
}

function th(text: string, cls = ""): HTMLTableCellElement {
  const el = document.createElement("th");
  if (cls) el.className = cls;
  el.textContent = text;
  return el;
}

function td(text: string, cls = ""): HTMLTableCellElement {
  const el = document.createElement("td");
  if (cls) el.className = cls;
  el.textContent = text;
  return el;
}

function parseDetail(detail: string | null): Record<string, unknown> {
  if (!detail) return {};
  try {
    const v: unknown = JSON.parse(detail);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function formatNumberField(v: unknown): string {
  return typeof v === "number" && Number.isFinite(v) ? String(Math.round(v)) : "—";
}

function formatBytesField(v: unknown): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  if (v >= 1_048_576) return `${(v / 1_048_576).toFixed(1)} MB`;
  if (v >= 1024) return `${Math.round(v / 1024)} KB`;
  return `${Math.round(v)} B`;
}

function formatLocalTime(tsMs: number): string {
  return new Date(tsMs).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
