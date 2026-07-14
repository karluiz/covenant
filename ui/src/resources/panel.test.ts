// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountResourcesPanel, type ResourcesPanelDeps } from './panel';
import type { ResourcesSnapshot } from '../api';

const groups = () => [
  { id: 'g1', name: 'KARLUIZ-SITE', sessionIds: ['s1', 's2'], titleFor: (id: string) => (id === 's1' ? 'zsh' : 'Claude Code') },
];

function makeDeps(over: Partial<ResourcesPanelDeps> = {}): ResourcesPanelDeps {
  return {
    getGroups: groups,
    setActive: vi.fn(async () => {}),
    sampleNow: vi.fn(async () => {}),
    onUpdate: vi.fn(async () => () => {}),
    ...over,
  };
}

const snap: ResourcesSnapshot = {
  total_cpu: 3.1, total_mem_bytes: 1_300_000_000, ram_share: 7, mem_total_bytes: 18_000_000_000,
  sessions: [
    { id: 's1', cpu: 0.0, mem_bytes: 4_600_000, top: [] },
    { id: 's2', cpu: 0.8, mem_bytes: 315_900_000, top: [
      { name: 'vitest', cpu: 33.2, count: 10 },
      { name: 'tsc', cpu: 14.5, count: 1 },
    ] },
  ],
};

describe('mountResourcesPanel', () => {
  let host: HTMLElement;
  beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); });

  it('activates the sampler on mount and deactivates on unmount', async () => {
    const deps = makeDeps();
    const unmount = mountResourcesPanel(host, deps);
    await Promise.resolve();
    expect(deps.setActive).toHaveBeenCalledWith(true);
    unmount();
    expect(deps.setActive).toHaveBeenCalledWith(false);
  });

  it('renders header totals and a Group→Session tree from a snapshot', async () => {
    let cb: (s: ResourcesSnapshot) => void = () => {};
    const deps = makeDeps({ onUpdate: vi.fn(async (h) => { cb = h; return () => {}; }) });
    mountResourcesPanel(host, deps);
    await Promise.resolve();
    cb(snap);
    expect(host.querySelector('.res-total-cpu')!.textContent).toContain('3.1');
    expect(host.querySelector('.res-group')!.textContent).toContain('KARLUIZ-SITE');
    const rows = host.querySelectorAll('.res-session');
    expect(rows.length).toBe(2);
    expect(host.textContent).toContain('Claude Code');
    expect(host.textContent).toContain('zsh');
  });

  it('sorts sessions by memory desc by default', async () => {
    let cb: (s: ResourcesSnapshot) => void = () => {};
    const deps = makeDeps({ onUpdate: vi.fn(async (h) => { cb = h; return () => {}; }) });
    mountResourcesPanel(host, deps);
    await Promise.resolve();
    cb(snap);
    const rows = [...host.querySelectorAll('.res-session')];
    expect(rows[0].textContent).toContain('Claude Code');
  });

  it('renders the hot processes sub-line only for sessions with top entries', async () => {
    let cb: (s: ResourcesSnapshot) => void = () => {};
    const deps = makeDeps({ onUpdate: vi.fn(async (h) => { cb = h; return () => {}; }) });
    mountResourcesPanel(host, deps);
    await Promise.resolve();
    cb(snap);
    const procs = [...host.querySelectorAll('.res-procs')];
    expect(procs.length).toBe(1);
    expect(procs[0].textContent).toBe('vitest ×10 33.2% · tsc 14.5%');
  });

  it('calls sampleNow when the refresh button is clicked', async () => {
    const deps = makeDeps();
    mountResourcesPanel(host, deps);
    await Promise.resolve();
    (host.querySelector('.res-refresh') as HTMLElement).click();
    expect(deps.sampleNow).toHaveBeenCalled();
  });

  it('shows an empty hint when there are no sessions', async () => {
    let cb: (s: ResourcesSnapshot) => void = () => {};
    const deps = makeDeps({ getGroups: () => [], onUpdate: vi.fn(async (h) => { cb = h; return () => {}; }) });
    mountResourcesPanel(host, deps);
    await Promise.resolve();
    cb({ total_cpu: 0, total_mem_bytes: 0, ram_share: 0, mem_total_bytes: 18_000_000_000, sessions: [] });
    expect(host.querySelector('.res-empty')).not.toBeNull();
  });
});
