import type {
  AchievementAward,
  AchievementCategory,
  AchievementDefinition,
  AchievementProgress,
  AchievementSummary,
} from "./api";
import {
  scoreAchievementCatalog,
  scoreAchievementSummary,
  scoreAchievementAwards,
} from "./api";

const RARITY_RANK: Record<string, number> = {
  common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4,
};

const TIER_LABELS = ["—", "I", "II", "III", "IV", "V"];

const DIMENSIONS: AchievementCategory[] = [
  "craft", "safety", "reliability", "orchestration", "memory", "focus",
];

export async function renderAchievementsCard(host: HTMLElement): Promise<void> {
  host.innerHTML = `
    <div class="cov-ach-header">
      <h4>Achievements <span class="hint">earned through verified work</span></h4>
      <div class="cov-ach-counts" data-role="counts"></div>
    </div>
    <div class="cov-ach-rep" data-role="reputation"></div>
    <div class="cov-ach-grid">
      <div class="cov-ach-col">
        <h5>In progress</h5>
        <div data-role="progress"></div>
      </div>
      <div class="cov-ach-col">
        <h5>Recently earned</h5>
        <div data-role="awards"></div>
      </div>
    </div>
    <h5 class="cov-ach-section">Catalog</h5>
    <div class="cov-ach-catalog" data-role="catalog"></div>
  `;

  const countsHost = host.querySelector<HTMLElement>("[data-role=counts]")!;
  const repHost = host.querySelector<HTMLElement>("[data-role=reputation]")!;
  const progressHost = host.querySelector<HTMLElement>("[data-role=progress]")!;
  const awardsHost = host.querySelector<HTMLElement>("[data-role=awards]")!;
  const catalogHost = host.querySelector<HTMLElement>("[data-role=catalog]")!;

  const [summary, catalog, awards] = await Promise.all([
    scoreAchievementSummary(),
    scoreAchievementCatalog(),
    scoreAchievementAwards(20),
  ]);

  renderCounts(countsHost, summary, catalog);
  renderReputation(repHost, summary);
  renderProgress(progressHost, summary.in_progress, catalog);
  renderAwards(awardsHost, awards, catalog);
  renderCatalog(catalogHost, catalog, summary.in_progress);
}

function renderCounts(host: HTMLElement, s: AchievementSummary, catalog: AchievementDefinition[]): void {
  const totalDefs = catalog.filter((d) => !d.hidden).length;
  host.innerHTML = `
    <span class="cov-ach-pill"><strong>${s.total_awards}</strong> badges earned</span>
    <span class="cov-ach-pill">${totalDefs} achievements in catalog</span>
  `;
}

function renderReputation(host: HTMLElement, s: AchievementSummary): void {
  const map = new Map(s.by_category.map((c) => [c.category, c.points]));
  const max = Math.max(1, ...s.by_category.map((c) => c.points));
  host.innerHTML = DIMENSIONS.map((dim) => {
    const pts = map.get(dim) ?? 0;
    const pct = Math.round((pts / max) * 100);
    return `
      <div class="cov-rep-row">
        <span class="cov-rep-label">${capitalize(dim)}</span>
        <div class="cov-rep-bar"><div class="cov-rep-fill" style="width:${pct}%"></div></div>
        <span class="cov-rep-value">${pts}</span>
      </div>
    `;
  }).join("");
}

function renderProgress(
  host: HTMLElement,
  progress: AchievementProgress[],
  catalog: AchievementDefinition[],
): void {
  if (progress.length === 0) {
    host.innerHTML = `<div class="cov-empty">No achievements in progress yet. Verified work will appear here.</div>`;
    return;
  }
  const byId = new Map(catalog.map((d) => [d.id, d]));
  host.innerHTML = progress
    .map((p) => {
      const def = byId.get(p.achievement_id);
      if (!def || def.hidden) return "";
      const pct = Math.min(100, Math.round((p.progress / Math.max(1, p.target)) * 100));
      const tierLabel = TIER_LABELS[p.tier] ?? "—";
      const nextLabel = p.next_tier ? TIER_LABELS[p.next_tier] : "max";
      return `
        <div class="cov-ach-prog">
          <div class="cov-ach-prog-head">
            <span class="cov-ach-title">${escHtml(def.title)} ${tierLabel}</span>
            <span class="cov-ach-target">${p.progress} / ${p.target} → ${nextLabel}</span>
          </div>
          <div class="cov-rep-bar"><div class="cov-rep-fill" style="width:${pct}%"></div></div>
          <div class="cov-ach-sub">${escHtml(def.summary)}</div>
        </div>
      `;
    })
    .join("");
}

function renderAwards(
  host: HTMLElement,
  awards: AchievementAward[],
  catalog: AchievementDefinition[],
): void {
  if (awards.length === 0) {
    host.innerHTML = `<div class="cov-empty">No badges earned yet.</div>`;
    return;
  }
  const byId = new Map(catalog.map((d) => [d.id, d]));
  host.innerHTML = awards
    .map((a) => {
      const def = byId.get(a.achievement_id);
      const rarity = def?.rarity ?? "common";
      const subject = a.subject_id ?? a.subject_type;
      const when = new Date(a.earned_at_ms).toLocaleDateString();
      return `
        <div class="cov-ach-award cov-rarity-${rarity}">
          <div class="cov-ach-badge">${TIER_LABELS[a.tier] ?? "?"}</div>
          <div class="cov-ach-award-body">
            <div class="cov-ach-title">${escHtml(a.title)} ${TIER_LABELS[a.tier] ?? ""}</div>
            <div class="cov-ach-sub">${escHtml(subject)} · ${when}</div>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderCatalog(
  host: HTMLElement,
  catalog: AchievementDefinition[],
  progress: AchievementProgress[],
): void {
  const earned = new Map<string, number>();
  for (const p of progress) {
    const cur = earned.get(p.achievement_id) ?? 0;
    if (p.tier > cur) earned.set(p.achievement_id, p.tier);
  }
  const visible = catalog
    .filter((d) => !d.hidden)
    .slice()
    .sort((a, b) => (RARITY_RANK[a.rarity] ?? 0) - (RARITY_RANK[b.rarity] ?? 0));
  host.innerHTML = visible
    .map((d) => {
      const tier = earned.get(d.id) ?? 0;
      const tierBadge = tier > 0 ? TIER_LABELS[tier] : "—";
      const earnedClass = tier > 0 ? "cov-ach-earned" : "cov-ach-locked";
      return `
        <div class="cov-ach-cat cov-rarity-${d.rarity} ${earnedClass}">
          <div class="cov-ach-badge">${tierBadge}</div>
          <div class="cov-ach-award-body">
            <div class="cov-ach-title">${escHtml(d.title)}</div>
            <div class="cov-ach-sub">${escHtml(d.summary)}</div>
            <div class="cov-ach-meta">${d.category} · ${d.rarity}</div>
          </div>
        </div>
      `;
    })
    .join("");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
