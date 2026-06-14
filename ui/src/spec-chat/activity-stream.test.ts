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

  it('streams live text into the same node instead of rebuilding it', () => {
    const state = createStreamState();
    mountActivityStream(host, state);
    state.apply({ kind: 'text_delta', text: 'Hel' });
    const node = host.querySelector('.bubble.asst.typing')!;
    state.apply({ kind: 'text_delta', text: 'lo' });
    // Same DOM node grew in place — not replaced on each delta.
    expect(host.querySelector('.bubble.asst.typing')).toBe(node);
    expect(node.textContent).toBe('Hello');
  });

  it('does not rebuild committed bubbles when live text streams', () => {
    const state = createStreamState();
    mountActivityStream(host, state);
    state.addUserMessage('do the thing');
    const committed = host.querySelector('.bubble.user')!;
    state.apply({ kind: 'text_delta', text: 'work' });
    state.apply({ kind: 'text_delta', text: 'ing' });
    // The committed user bubble is the very same element — untouched by streaming.
    expect(host.querySelector('.bubble.user')).toBe(committed);
  });
});
