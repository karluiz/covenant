import { describe, it, expect } from 'vitest';
import { createStreamState } from './stream-state';

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
});
