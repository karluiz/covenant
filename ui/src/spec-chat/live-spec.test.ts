// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { mountLiveSpec } from './live-spec';
import { createStreamState } from './stream-state';

describe('mountLiveSpec', () => {
  let host: HTMLElement;
  beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); });

  it('renders six section cards and marks done sections', () => {
    const state = createStreamState();
    mountLiveSpec(host, state);
    expect(host.querySelectorAll('.sec').length).toBe(6);

    state.apply({ kind: 'section_update', section: 'goal', markdown: 'Esc closes', status: 'done' });
    const goal = host.querySelector('.sec[data-key="goal"]')!;
    expect(goal.classList.contains('done')).toBe(true);
    expect(goal.textContent).toContain('Esc closes');
  });

  it('marks the active phase node on the spine', () => {
    const state = createStreamState();
    mountLiveSpec(host, state);
    state.apply({ kind: 'phase', section: 'acceptance' });
    const node = host.querySelector('.node[data-key="acceptance"]')!;
    expect(node.classList.contains('active')).toBe(true);
  });
});
