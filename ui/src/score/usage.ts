import type { AgentCell, ModelCell, ModelSource, SpecBreakdown } from "./api";
import { estimateCostUsd, fmtCostUsd } from "./pricing";

const AGENT_COLORS: Record<string, string> = {
  claude_code: "#3fb950",
  codex:       "#f0883e",
  copilot:     "#a371f7",
  opencode:    "#f85149",
  pi:          "#39d0d8",
  internal:    "#d2a8ff",
  shell:       "#6e7681",
};

export function renderAgentBars(
  host: HTMLElement,
  cells: AgentCell[],
  onPick: (agent: string) => void,
): void {
  host.innerHTML = "";
  if (cells.length === 0) {
    host.innerHTML = `<div class="cov-empty">No agent activity yet</div>`;
    return;
  }
  const max = Math.max(1, ...cells.map((c) => c.prompts));
  for (const c of cells) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "cov-row";
    const color = AGENT_COLORS[c.agent] ?? "#7d8590";
    row.innerHTML = `
      <span class="cov-dot" style="background:${color}"></span>
      <span class="cov-row-label">${escapeHtml(c.agent)}</span>
      <span class="cov-row-bar"><span style="width:${(c.prompts / max) * 100}%;background:${color}"></span></span>
      <span class="cov-row-val">${c.prompts}p · ${(c.share * 100).toFixed(0)}%</span>
    `;
    row.addEventListener("click", () => onPick(c.agent));
    host.appendChild(row);
  }
}

export function renderSpecsCard(host: HTMLElement, br: SpecBreakdown): void {
  const items = br.recent.map((r) => {
    const name = r.path.split("/").pop() ?? r.path;
    const when = new Date(r.ts_ms).toLocaleDateString();
    return `<li><span class="cov-spec-name">${escapeHtml(name)}</span><span class="cov-spec-when">${when}</span></li>`;
  }).join("");
  host.innerHTML = `
    <div class="cov-specs-total">${br.total}</div>
    <div class="cov-specs-sub">specs created (current filter)</div>
    <ul class="cov-specs-list">${items || "<li class=\"cov-empty\">none yet</li>"}</ul>
  `;
}

export function renderModelsCard(
  host: HTMLElement,
  source: ModelSource,
  cells: ModelCell[],
  onToggle: (next: ModelSource) => void,
): void {
  const isExternal = source === "external";
  // Estimated $ per row from the static price table; unpriced models show
  // "—" and are excluded from the total (footer flags how many).
  let totalUsd = 0;
  let unpriced = 0;
  const rows = cells.map((c) => {
    const cost = estimateCostUsd(c);
    if (cost == null) unpriced++;
    else totalUsd += cost;
    return `
    <tr>
      ${isExternal ? `<td>${escapeHtml(c.agent ?? "—")}</td>` : ""}
      <td><code>${escapeHtml(c.model)}</code></td>
      <td>${c.calls}</td>
      <td>${c.input_tokens.toLocaleString()}${c.cache_read ? ` <span class="cov-dim">(${c.cache_read.toLocaleString()} cache)</span>` : ""}</td>
      <td>${c.output_tokens.toLocaleString()}</td>
      <td class="cov-cost">${fmtCostUsd(cost)}</td>
    </tr>
  `;
  }).join("");
  const totalLine = cells.length
    ? `<div class="cov-cost-total">est. total <b>${fmtCostUsd(totalUsd)}</b>${unpriced ? ` <span class="cov-dim">· ${unpriced} unpriced model${unpriced === 1 ? "" : "s"} excluded</span>` : ""} <span class="cov-dim">· static list rates</span></div>`
    : "";
  host.innerHTML = `
    <div class="cov-toggle">
      <button type="button" data-src="internal" class="${!isExternal ? "active" : ""}">Covenant</button>
      <button type="button" data-src="external" class="${isExternal ? "active" : ""}">External</button>
    </div>
    <table class="cov-model-table">
      <thead><tr>
        ${isExternal ? "<th>Agent</th>" : ""}
        <th>Model</th><th>Calls</th><th>Input</th><th>Output</th><th>Est. $</th>
      </tr></thead>
      <tbody>${rows || `<tr><td colspan="${isExternal ? 6 : 5}" class="cov-empty">No usage</td></tr>`}</tbody>
    </table>
    ${totalLine}
  `;
  host.querySelectorAll<HTMLButtonElement>(".cov-toggle button").forEach((b) => {
    b.addEventListener("click", () => onToggle(b.dataset.src as ModelSource));
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
