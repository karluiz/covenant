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

  it('renders attached image thumbnails inside the user bubble', () => {
    const state = createStreamState();
    mountActivityStream(host, state);
    state.addUserMessage('mira esto', [
      'data:image/png;base64,AAAA',
      'javascript:alert(1)', // non-data/blob url must be dropped
    ]);
    const bubble = host.querySelector('.bubble.user')!;
    expect(bubble.querySelector('.bubble-text')!.textContent).toBe('mira esto');
    const imgs = bubble.querySelectorAll<HTMLImageElement>('.bubble-img');
    expect(imgs).toHaveLength(1); // the javascript: url is filtered out
    expect(imgs[0].getAttribute('src')).toBe('data:image/png;base64,AAAA');
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
    expect(node.textContent).toContain('Hello');
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

  it('renders section markers in assistant prose as chips, not raw', () => {
    const state = createStreamState();
    mountActivityStream(host, state);
    state.addUserMessage('go');
    state.apply({ kind: 'text_delta', text: 'Done. <!--section:goal-->## Goal\nx<!--/section-->' });
    state.apply({ kind: 'turn_done', awaiting_user: true });
    const bubble = host.querySelector('.bubble.asst')!;
    expect(bubble.querySelector('.sec-chip')).not.toBeNull();
    expect(bubble.innerHTML).not.toContain('## Goal');
    expect(bubble.textContent).not.toContain('<!--');
  });
});

describe('question cards', () => {
  let host: HTMLElement;
  beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); });

  it('renders chips and fires onAnswer with the clicked label', () => {
    const state = createStreamState();
    const answers: string[] = [];
    mountActivityStream(host, state, { onAnswer: (l) => answers.push(l) });
    state.apply({
      kind: 'question', question: '¿A o B?',
      options: [{ label: 'A (recomendado)', detail: 'porque sí' }, { label: 'B' }],
    });
    const card = host.querySelector('.question-card')!;
    expect(card.querySelector('.q-text')!.textContent).toBe('¿A o B?');
    const chips = card.querySelectorAll<HTMLButtonElement>('.q-chip');
    expect(chips).toHaveLength(2);
    expect(chips[0]!.textContent).toContain('porque sí');
    chips[0]!.click();
    expect(answers).toEqual(['A (recomendado)']);
  });

  it('disables chips once the question is answered', () => {
    const state = createStreamState();
    mountActivityStream(host, state, { onAnswer: () => {} });
    state.apply({ kind: 'question', question: '¿A o B?', options: [{ label: 'A' }, { label: 'B' }] });
    state.addUserMessage('A');
    const chips = host.querySelectorAll<HTMLButtonElement>('.q-chip');
    expect(Array.from(chips).every((c) => c.disabled)).toBe(true);
    expect(host.querySelector('.question-card.answered')).not.toBeNull();
  });
});
