// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { mountActivityStream } from './activity-stream';
import { createStreamState } from './stream-state';

describe('mountActivityStream', () => {
  let host: HTMLElement;
  beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); });

  it('renders a tool row with verb, arg and result summary', () => {
    const state = createStreamState();
    mountActivityStream(host, state);
    state.apply({ kind: 'tool_start', id: 't1', tool: 'grep', arg: '{"needle":"onKeydown"}' });
    state.apply({ kind: 'tool_result', id: 't1', summary: '4 matches', ok: true });
    const row = host.querySelector('.tool')!;
    expect(row.textContent).toContain('grep');
    expect(row.textContent).toContain('4 matches');
  });

  it('renders a thinking block', () => {
    const state = createStreamState();
    mountActivityStream(host, state);
    state.apply({ kind: 'thinking_delta', text: 'reasoning…' });
    expect(host.querySelector('.think')!.textContent).toContain('reasoning');
  });
});
