import { runDeviceFlow } from "./signin";
import { getCurrentUser, setCurrentUser } from "./user";
import { scoreSignout, scoreHeatmap, scoreSummary, scoreSyncNow, scoreSyncStatus,
  type DailyCell, type User, type SyncStatus } from "./api";

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

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function renderHeader(user: User | null): string {
  if (!user) return `
    <h3>Covenant Score</h3>
    <div class="sub">Tracking local · No sincronizado</div>`;
  return `
    <div class="score-header">
      <img class="score-avatar" src="${user.avatar_url}" alt="">
      <div>
        <h3>${user.login}</h3>
        <div class="sub">Connected ${formatDate(user.connected_at_ms)}</div>
      </div>
    </div>`;
}

function renderFooter(user: User | null, sync: SyncStatus | null): string {
  if (!user) return `
    <div class="score-cta">
      <div class="text">
        <h4>Conecta GitHub para sincronizar</h4>
        <p>Backup, multi-dispositivo, y perfil público (próximamente).</p>
      </div>
      <button type="button" class="signin-trigger">Sign in with GitHub</button>
    </div>`;
  const syncedText = formatSync(sync);
  return `
    <div class="score-footer">
      <span class="sync-status">${syncedText}</span>
      <a href="#" class="sync-now">Sync now</a>
      <a href="#" class="signout">Disconnect</a>
    </div>`;
}

function formatSync(sync: SyncStatus | null): string {
  if (!sync || !sync.signed_in) return "Not synced";
  if (sync.last_synced_at_ms === 0) return "Pending first sync…";
  const ageMs = Date.now() - sync.last_synced_at_ms;
  const ageMin = Math.floor(ageMs / 60000);
  const ageStr = ageMin === 0 ? "just now" :
                  ageMin < 60 ? `${ageMin}m ago` :
                  `${Math.floor(ageMin/60)}h ago`;
  if (sync.pending_events > 0) return `Synced ${ageStr} · ${sync.pending_events} pending`;
  return `Synced ${ageStr}`;
}

export async function openScoreModal(): Promise<void> {
  const existing = document.querySelector(".score-modal-backdrop");
  if (existing) { existing.remove(); return; }

  const user = await getCurrentUser();
  const syncP = user ? scoreSyncStatus().catch(() => null as SyncStatus | null) : Promise.resolve(null);
  const [summary, cells, sync] = await Promise.all([
    scoreSummary(), scoreHeatmap(), syncP,
  ]);

  const back = document.createElement("div");
  back.className = "score-modal-backdrop";
  back.addEventListener("click", (e) => {
    if (e.target === back) back.remove();
  });

  const modal = document.createElement("div");
  modal.className = "score-modal";
  modal.innerHTML = `
    ${renderHeader(user)}
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
    ${renderFooter(user, sync)}
  `;
  modal.querySelector(".score-heatmap-wrap")!.appendChild(renderHeatmap(cells));

  modal.querySelector(".signin-trigger")?.addEventListener("click", async () => {
    const u = await runDeviceFlow();
    if (u) { back.remove(); void openScoreModal(); }
  });
  modal.querySelector(".sync-now")?.addEventListener("click", async (e) => {
    e.preventDefault();
    const status = modal.querySelector(".sync-status") as HTMLElement;
    status.textContent = "Syncing…";
    try {
      await scoreSyncNow();
      back.remove();
      void openScoreModal();
    } catch (err) {
      status.textContent = `Sync failed: ${err}`;
    }
  });
  modal.querySelector(".signout")?.addEventListener("click", async (e) => {
    e.preventDefault();
    await scoreSignout();
    setCurrentUser(null);
    back.remove();
    void openScoreModal();
  });

  back.appendChild(modal);
  document.body.appendChild(back);
}
