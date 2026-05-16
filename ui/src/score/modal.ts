import { scoreHeatmap, scoreSummary, type DailyCell, type Summary }
  from "./api";

function intensityClass(prompts: number): string {
  if (prompts === 0) return "";
  if (prompts <= 5) return "l1";
  if (prompts <= 15) return "l2";
  if (prompts <= 40) return "l3";
  return "l4";
}

function renderHeatmap(cells: DailyCell[]): HTMLElement {
  const byDay = new Map<string, number>();
  for (const c of cells) byDay.set(c.day, c.prompts);

  const grid = document.createElement("div");
  grid.className = "score-heatmap";

  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - 52 * 7 - today.getDay());

  for (let week = 0; week < 53; week++) {
    for (let day = 0; day < 7; day++) {
      const d = new Date(start);
      d.setDate(start.getDate() + week * 7 + day);
      const key = d.toISOString().slice(0, 10);
      const count = byDay.get(key) ?? 0;
      const cell = document.createElement("div");
      cell.className = `score-cell ${intensityClass(count)}`.trim();
      cell.title = `${key} — ${count} prompts`;
      grid.appendChild(cell);
    }
  }
  return grid;
}

export async function openScoreModal(): Promise<void> {
  const existing = document.querySelector(".score-modal-backdrop");
  if (existing) { existing.remove(); return; }

  const [summary, cells]: [Summary, DailyCell[]] =
    await Promise.all([scoreSummary(), scoreHeatmap()]);

  const back = document.createElement("div");
  back.className = "score-modal-backdrop";
  back.addEventListener("click", (e) => {
    if (e.target === back) back.remove();
  });

  const modal = document.createElement("div");
  modal.className = "score-modal";
  modal.innerHTML = `
    <h3>Covenant Score</h3>
    <div class="sub">Tracking local · No sincronizado</div>
    <div class="score-stat-row">
      <div class="score-stat"><div class="v">${summary.total_prompts}</div>
        <div class="l">Total prompts</div></div>
      <div class="score-stat"><div class="v">${summary.today_prompts}</div>
        <div class="l">Today</div></div>
      <div class="score-stat"><div class="v">${summary.current_streak}d</div>
        <div class="l">Current streak</div></div>
      <div class="score-stat"><div class="v">${summary.total_commits}</div>
        <div class="l">Total commits</div></div>
    </div>
    <div class="score-heatmap-wrap"></div>
    <div class="score-legend">
      <span>Less</span>
      <span class="score-cell"></span>
      <span class="score-cell l1"></span>
      <span class="score-cell l2"></span>
      <span class="score-cell l3"></span>
      <span class="score-cell l4"></span>
      <span>More</span>
    </div>
    <div class="score-cta">
      <div class="text">
        <h4>Conecta GitHub para sincronizar</h4>
        <p>Backup, multi-dispositivo, y perfil público (próximamente).</p>
      </div>
      <button type="button" disabled title="Sign-in shipping in CS-2">
        Sign in with GitHub
      </button>
    </div>
  `;
  modal.querySelector(".score-heatmap-wrap")!.appendChild(renderHeatmap(cells));

  back.appendChild(modal);
  document.body.appendChild(back);
}
