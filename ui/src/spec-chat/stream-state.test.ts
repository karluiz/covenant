import { describe, it, expect } from 'vitest';
import { composePartialMarkdown, createStreamState } from './stream-state';
import type { SectionView } from './stream-state';
import type { SpecSectionKey } from './events';

describe('composePartialMarkdown', () => {
  it('composes only present sections with canonical headers', () => {
    const sections = new Map<SpecSectionKey, SectionView>([
      ['goal', { markdown: 'Do the thing.', status: 'done' }],
      ['acceptance', { markdown: '- it does the thing', status: 'filling' }],
    ]);
    const md = composePartialMarkdown({ section: (k) => sections.get(k) ?? null });
    expect(md).toContain('## Goal\n\nDo the thing.');
    expect(md).toContain('## Acceptance criteria');
    expect(md).not.toContain('## Out of scope');
  });
});

describe('createStreamState', () => {
  it('accumulates thinking + tool activity and tracks sections', () => {
    const s = createStreamState();
    s.apply({ kind: 'phase', section: 'goal' });
    s.apply({ kind: 'thinking_delta', text: 'look' });
    s.apply({ kind: 'thinking_delta', text: 'ing' });
    s.apply({ kind: 'tool_start', id: 't1', tool: 'grep', arg: '{"needle":"x"}' });
    s.apply({ kind: 'tool_result', id: 't1', summary: '3 matches', ok: true });
    s.apply({ kind: 'section_update', section: 'goal', markdown: 'Esc closes modals', status: 'done' });
    s.apply({ kind: 'turn_done', awaiting_user: true });

    expect(s.activePhase()).toBe('goal');
    expect(s.thinking()).toBe('looking');
    expect(s.tools()).toHaveLength(1);
    expect(s.tools()[0].summary).toBe('3 matches');
    expect(s.section('goal')).toEqual({ markdown: 'Esc closes modals', status: 'done' });
    expect(s.awaitingUser()).toBe(true);
  });

  it('appends final markdown and flips ready', () => {
    const s = createStreamState();
    s.apply({ kind: 'final', markdown: '## Goal\n...' });
    expect(s.finalMarkdown()).toContain('## Goal');
    expect(s.ready()).toBe(true);
  });

  it('hydrate restores prior conversation turns', () => {
    const s = createStreamState();
    s.hydrate({
      messages: [
        { role: 'user', content: 'first ask' },
        { role: 'assistant', content: 'reply' },
      ],
    });
    expect(s.messages()).toEqual([
      { role: 'user', content: 'first ask' },
      { role: 'assistant', content: 'reply' },
    ]);
    expect(s.ready()).toBe(false);
  });

  it('hydrate with finalMarkdown makes a completed draft publishable', () => {
    const s = createStreamState();
    s.hydrate({ messages: [], finalMarkdown: '## Goal\ndone' });
    expect(s.finalMarkdown()).toContain('## Goal');
    expect(s.ready()).toBe(true);
  });

  it('addUserMessage stores image previews on the message', () => {
    const s = createStreamState();
    s.addUserMessage('with pics', ['data:image/png;base64,AAAA']);
    s.addUserMessage('no pics');
    const msgs = s.messages();
    expect(msgs[0]).toEqual({ role: 'user', content: 'with pics', previews: ['data:image/png;base64,AAAA'] });
    expect(msgs[1]).toEqual({ role: 'user', content: 'no pics' }); // no previews key when empty
  });

  it('hydrate replaces existing messages rather than appending', () => {
    const s = createStreamState();
    s.addUserMessage('stale');
    s.hydrate({ messages: [{ role: 'user', content: 'fresh' }] });
    expect(s.messages()).toEqual([{ role: 'user', content: 'fresh' }]);
  });

  it('hydrate with markdown rebuilds the section map (status done)', () => {
    const s = createStreamState();
    s.hydrate({ messages: [], markdown: '## Goal\n\nBuild it.\n\n## Complexity\n\nLow.' });
    expect(s.section('goal')).toEqual({ markdown: 'Build it.', status: 'done' });
    expect(s.section('complexity')).toEqual({ markdown: 'Low.', status: 'done' });
    expect(s.section('acceptance')).toBeNull();
  });

  it('hydrate rebuilds sections from transcript markers when partial_md is null', () => {
    const s = createStreamState();
    s.hydrate({
      messages: [
        { role: 'user', content: 'goal?' },
        { role: 'assistant', content: 'Drafted: <!--section:goal-->## Goal\n\nBuild it.<!--/section-->' },
        { role: 'assistant', content: 'And <!--section:complexity-->Medium.<!--/section-->' },
      ],
      markdown: null,
    });
    expect(s.section('goal')).toEqual({ markdown: 'Build it.', status: 'done' });
    expect(s.section('complexity')).toEqual({ markdown: 'Medium.', status: 'done' });
    expect(s.section('acceptance')).toBeNull();
  });

  it('hydrate prefers partial_md over transcript markers for the same section', () => {
    const s = createStreamState();
    s.hydrate({
      messages: [{ role: 'assistant', content: '<!--section:goal-->stale draft<!--/section-->' }],
      markdown: '## Goal\n\nedited & saved',
    });
    expect(s.section('goal')).toEqual({ markdown: 'edited & saved', status: 'done' });
  });

  it('editSection updates the map and returns rebuilt canonical markdown', () => {
    const s = createStreamState();
    s.apply({ kind: 'section_update', section: 'goal', markdown: 'old', status: 'done' });
    const rebuilt = s.editSection('goal', 'new goal text');
    expect(s.section('goal')).toEqual({ markdown: 'new goal text', status: 'done' });
    expect(rebuilt).toBe('## Goal\n\nnew goal text');
  });

  it('editSection rebuilds finalMarkdown when a final already exists', () => {
    const s = createStreamState();
    s.apply({ kind: 'final', markdown: '## Goal\n\nold' });
    s.apply({ kind: 'section_update', section: 'goal', markdown: 'old', status: 'done' });
    s.editSection('goal', 'edited');
    expect(s.finalMarkdown()).toBe('## Goal\n\nedited');
  });

  it('section_update strips the agent\'s baked-in ## heading from the body', () => {
    const s = createStreamState();
    s.apply({ kind: 'section_update', section: 'goal', markdown: '## Goal\n\nBuild it.', status: 'done' });
    expect(s.section('goal')).toEqual({ markdown: 'Build it.', status: 'done' });
  });

  it('becomes publishable once all six sections are done, composing the doc', () => {
    const s = createStreamState();
    const keys = ['goal', 'out_of_scope', 'acceptance', 'file_boundaries', 'complexity', 'open_questions'] as const;
    for (const k of keys) {
      expect(s.ready()).toBe(false); // not yet — still missing sections
      s.apply({ kind: 'section_update', section: k, markdown: `body of ${k}`, status: 'done' });
    }
    expect(s.ready()).toBe(true);
    const md = s.finalMarkdown()!;
    // contains every required heading in canonical order, no agent `final` needed
    expect(md).toContain('## Goal');
    expect(md).toContain('## Out of scope');
    expect(md).toContain('## Open questions');
    expect(md.indexOf('## Goal')).toBeLessThan(md.indexOf('## Open questions'));
  });

  it('is not publishable when a section is still filling', () => {
    const s = createStreamState();
    const keys = ['goal', 'out_of_scope', 'acceptance', 'file_boundaries', 'complexity'] as const;
    for (const k of keys) s.apply({ kind: 'section_update', section: k, markdown: 'x', status: 'done' });
    s.apply({ kind: 'section_update', section: 'open_questions', markdown: 'x', status: 'filling' });
    expect(s.ready()).toBe(false);
    expect(s.finalMarkdown()).toBeNull();
  });
});

describe('ask_user question flow', () => {
  it('question event commits prose and appends an unanswered card', () => {
    const s = createStreamState();
    s.apply({ kind: 'text_delta', text: 'Exploré el repo.' });
    s.apply({ kind: 'question', question: '¿A o B?', options: [{ label: 'A (recomendado)', detail: 'why' }, { label: 'B' }] });
    const msgs = s.messages();
    expect(msgs[msgs.length - 2]).toEqual({ role: 'assistant', content: 'Exploré el repo.' });
    const card = msgs[msgs.length - 1]!;
    expect(card.role).toBe('question');
    if (card.role === 'question') {
      expect(card.question).toBe('¿A o B?');
      expect(card.options).toHaveLength(2);
      expect(card.answered).toBe(false);
    }
  });

  it('answering marks pending question cards answered', () => {
    const s = createStreamState();
    s.apply({ kind: 'question', question: '¿A o B?', options: [{ label: 'A' }, { label: 'B' }] });
    s.addUserMessage('A');
    const card = s.messages().find((m) => m.role === 'question')!;
    expect(card.role === 'question' && card.answered).toBe(true);
  });
});
