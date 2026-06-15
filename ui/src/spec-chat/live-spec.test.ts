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

  it('marks a completed section node on the spine even when not the active phase', () => {
    const state = createStreamState();
    mountLiveSpec(host, state);
    state.hydrate({ messages: [], markdown: '## Goal\n\nDone goal.' });
    const node = host.querySelector('.node[data-key="goal"]')!;
    expect(node.classList.contains('done')).toBe(true);
  });

  it('fires onPersist with rebuilt markdown when a section body is edited', () => {
    const state = createStreamState();
    const saved: string[] = [];
    mountLiveSpec(host, state, (md) => saved.push(md));
    state.apply({ kind: 'section_update', section: 'goal', markdown: 'old', status: 'done' });
    const content = host.querySelector('.sec[data-key="goal"] .content') as HTMLElement;
    content.textContent = 'edited goal';
    content.dispatchEvent(new Event('blur'));
    expect(saved).toEqual(['## Goal\n\nedited goal']);
  });

  it('does not clobber a section body while it is focused', () => {
    const state = createStreamState();
    mountLiveSpec(host, state);
    state.apply({ kind: 'section_update', section: 'goal', markdown: 'first', status: 'done' });
    const content = host.querySelector('.sec[data-key="goal"] .content') as HTMLElement;
    content.focus();
    content.textContent = 'user typing';
    state.apply({ kind: 'section_update', section: 'goal', markdown: 'first', status: 'done' });
    expect(content.textContent).toBe('user typing');
  });
});
