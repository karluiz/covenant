import './panel.css';
import type { ResourcesSnapshot } from '../api';

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

export function mountResourcesPanel(host: HTMLElement, deps: ResourcesPanelDeps): () => void {
  let sort: SortKey = 'mem';
  let latest: ResourcesSnapshot | null = null;

  host.innerHTML =
    `<div class="res-panel">` +
    `<div class="res-head"><span class="res-title">Resources</span>` +
    `<span class="res-sort" role="button" tabindex="0">Memory</span>` +
    `<span class="res-refresh" role="button" tabindex="0" aria-label="Refresh">↻</span></div>` +
    `<div class="res-totals">` +
    `<div><span class="res-cap">CPU</span><span class="res-total-cpu">—</span></div>` +
    `<div><span class="res-cap">MEMORY</span><span class="res-total-mem">—</span></div>` +
    `<div><span class="res-cap">RAM SHARE</span><span class="res-total-share">—</span></div>` +
    `</div><div class="res-body"></div></div>`;

  const body = host.querySelector('.res-body') as HTMLElement;
  const sortEl = host.querySelector('.res-sort') as HTMLElement;

  const render = () => {
    const s = latest;
    if (!s) return;
    (host.querySelector('.res-total-cpu') as HTMLElement).textContent = fmtPct(s.total_cpu);
    (host.querySelector('.res-total-mem') as HTMLElement).textContent = fmtBytes(s.total_mem_bytes);
    (host.querySelector('.res-total-share') as HTMLElement).textContent = fmtPct(s.ram_share);

    const metric = new Map(s.sessions.map((m) => [m.id, m]));
    const groups = deps.getGroups();
    body.replaceChildren();
    if (groups.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'res-empty';
      empty.textContent = 'No active sessions.';
      body.appendChild(empty);
      return;
    }
    for (const g of groups) {
      const gEl = document.createElement('div');
      gEl.className = 'res-group';
      gEl.textContent = g.name;
      body.appendChild(gEl);
      const rows = g.sessionIds
        .map((id) => ({ id, m: metric.get(id) }))
        .sort((a, b) => {
          const av = a.m ? (sort === 'mem' ? a.m.mem_bytes : a.m.cpu) : -1;
          const bv = b.m ? (sort === 'mem' ? b.m.mem_bytes : b.m.cpu) : -1;
          return bv - av;
        });
      for (const { id, m } of rows) {
        const r = document.createElement('div');
        r.className = 'res-session';
        // Numeric spans are safe to template; the session title is user-controlled
        // (custom tab names), so set it via textContent to avoid HTML injection.
        r.innerHTML =
          `<span class="res-name"></span>` +
          `<span class="res-cpu">${m ? fmtPct(m.cpu) : '—'}</span>` +
          `<span class="res-mem">${m ? fmtBytes(m.mem_bytes) : '—'}</span>`;
        (r.querySelector('.res-name') as HTMLElement).textContent = g.titleFor(id);
        body.appendChild(r);
        // Hot processes inside the session subtree — the "why" behind the numbers.
        if (m && m.top && m.top.length > 0) {
          const p = document.createElement('div');
          p.className = 'res-procs';
          p.textContent = m.top
            .map((t) => `${t.name}${t.count > 1 ? ` ×${t.count}` : ''} ${fmtPct(t.cpu)}`)
            .join(' · ');
          body.appendChild(p);
        }
      }
    }
  };

  sortEl.addEventListener('click', () => {
    sort = sort === 'mem' ? 'cpu' : 'mem';
    sortEl.textContent = sort === 'mem' ? 'Memory' : 'CPU';
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
    void deps.setActive(false);
    host.replaceChildren();
  };
}
