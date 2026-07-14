import './panel.css';
import type { ResourcesSnapshot } from '../api';
import { Icons } from '../icons';
import { attachTooltip } from '../tooltip/tooltip';

export interface ResourcesGroupView {
  id: string;
  name: string;
  sessionIds: string[];
  /** Display label for a session leaf (foreground process / tab title). */
  titleFor: (sessionId: string) => string;
}

export interface ResourcesPanelDeps {
  getGroups: () => ResourcesGroupView[];
  setActive: (active: boolean) => Promise<void>;
  sampleNow: () => Promise<void>;
  onUpdate: (cb: (s: ResourcesSnapshot) => void) => Promise<() => void>;
}

type SortKey = 'mem' | 'cpu';

const fmtPct = (n: number) => `${n.toFixed(1)}%`;
const fmtBytes = (b: number) => {
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(0)} KB`;
  return `${b} B`;
};

/** Machine-% thresholds for the semantic load spine + row tint. */
const loadOf = (cpu: number): 'hot' | 'busy' | 'idle' =>
  cpu >= 60 ? 'hot' : cpu >= 15 ? 'busy' : 'idle';

export function mountResourcesPanel(host: HTMLElement, deps: ResourcesPanelDeps): () => void {
  let sort: SortKey = 'mem';
  let latest: ResourcesSnapshot | null = null;
  const collapsed = new Set<string>();

  host.innerHTML =
    `<div class="res-panel rail-panel">` +
    `<div class="rail-header">` +
    `<div class="rail-title">` +
    `<span class="rail-dot"></span>` +
    `<span class="rail-title-label">Resources</span>` +
    `<span class="rail-title-sub res-totals-sub"></span>` +
    `</div>` +
    `<div class="rail-actions">` +
    `<button class="rail-btn res-sort" type="button" aria-label="Toggle sort">${Icons.chevronsUpDown({ size: 15 })}</button>` +
    `<button class="rail-btn res-refresh" type="button" aria-label="Refresh">${Icons.refresh({ size: 15 })}</button>` +
    `</div></div>` +
    `<div class="rail-body res-body"></div></div>`;

  const body = host.querySelector('.res-body') as HTMLElement;
  const totalsSub = host.querySelector('.res-totals-sub') as HTMLElement;
  const sortBtn = host.querySelector('.res-sort') as HTMLButtonElement;

  let detachSortTip: (() => void) | null = null;
  const refreshSortTip = () => {
    detachSortTip?.();
    detachSortTip = attachTooltip(sortBtn, sort === 'mem' ? 'Sorted by memory' : 'Sorted by CPU');
  };
  refreshSortTip();
  const detachRefreshTip = attachTooltip(
    host.querySelector('.res-refresh') as HTMLElement,
    'Refresh',
  );

  const render = () => {
    const s = latest;
    if (!s) return;
    totalsSub.textContent = `${fmtPct(s.total_cpu)} · ${fmtBytes(s.total_mem_bytes)}`;

    const metric = new Map(s.sessions.map((m) => [m.id, m]));
    const groups = deps.getGroups();
    body.replaceChildren();
    if (groups.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'rail-empty';
      empty.innerHTML =
        `${Icons.boxes({ size: 28 })}` +
        `<div class="rail-empty-title">No active sessions</div>` +
        `<div class="rail-empty-hint">Open a terminal tab to see its footprint here.</div>`;
      body.appendChild(empty);
      return;
    }
    for (const g of groups) {
      const gEl = document.createElement('div');
      gEl.className = 'rail-group';
      const isOpen = !collapsed.has(g.id);
      const head = document.createElement('button');
      head.type = 'button';
      head.className = `rail-group-head${isOpen ? ' open' : ''}`;
      head.innerHTML =
        `<span class="rail-chev">${Icons.chevronRight({ size: 14 })}</span>` +
        `<span class="rail-gname"></span>` +
        `<span class="rail-gcount">${g.sessionIds.length}</span>`;
      (head.querySelector('.rail-gname') as HTMLElement).textContent = g.name;
      head.addEventListener('click', () => {
        if (collapsed.has(g.id)) collapsed.delete(g.id);
        else collapsed.add(g.id);
        render();
      });
      gEl.appendChild(head);

      if (isOpen) {
        const rows = g.sessionIds
          .map((id) => ({ id, m: metric.get(id) }))
          .sort((a, b) => {
            const av = a.m ? (sort === 'mem' ? a.m.mem_bytes : a.m.cpu) : -1;
            const bv = b.m ? (sort === 'mem' ? b.m.mem_bytes : b.m.cpu) : -1;
            return bv - av;
          });
        for (const { id, m } of rows) {
          const r = document.createElement('div');
          r.className = 'res-row';
          r.dataset.load = loadOf(m?.cpu ?? 0);
          // Numeric spans are safe to template; the session title is user-controlled
          // (custom tab names), so set it via textContent to avoid HTML injection.
          r.innerHTML =
            `<span class="res-bar" style="width:${Math.min(m?.cpu ?? 0, 100)}%"></span>` +
            `<div class="res-line">` +
            `<span class="res-name"></span>` +
            `<span class="res-cpu">${m ? fmtPct(m.cpu) : '—'}</span>` +
            `<span class="res-mem">${m ? fmtBytes(m.mem_bytes) : '—'}</span>` +
            `</div>`;
          (r.querySelector('.res-name') as HTMLElement).textContent = g.titleFor(id);
          // Hot processes inside the session subtree — the "why" behind the numbers.
          if (m && m.top && m.top.length > 0) {
            const p = document.createElement('div');
            p.className = 'res-procs';
            p.textContent = m.top
              .map((t) => `${t.name}${t.count > 1 ? ` ×${t.count}` : ''} ${fmtPct(t.cpu)}`)
              .join(' · ');
            r.appendChild(p);
          }
          gEl.appendChild(r);
        }
      }
      body.appendChild(gEl);
    }
  };

  sortBtn.addEventListener('click', () => {
    sort = sort === 'mem' ? 'cpu' : 'mem';
    refreshSortTip();
    render();
  });
  (host.querySelector('.res-refresh') as HTMLElement).addEventListener('click', () => {
    void deps.sampleNow();
  });

  let unlisten: (() => void) | null = null;
  void deps.setActive(true);
  void deps.onUpdate((s) => { latest = s; render(); }).then((u) => { unlisten = u; });

  return () => {
    unlisten?.();
    detachSortTip?.();
    detachRefreshTip();
    void deps.setActive(false);
    host.replaceChildren();
  };
}
