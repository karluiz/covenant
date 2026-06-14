import { describe, it, expect } from 'vitest';
import { parsePersistedTranscript } from './transcript';

describe('parsePersistedTranscript', () => {
  it('keeps real user and assistant turns as bubbles', () => {
    const items = parsePersistedTranscript([
      { role: 'user', content: 'add a light theme' },
      { role: 'assistant', content: 'Got it, exploring…' },
    ]);
    expect(items).toEqual([
      { role: 'user', content: 'add a light theme' },
      { role: 'assistant', content: 'Got it, exploring…' },
    ]);
  });

  it('rebuilds verb · arg · summary chips from the persisted header line', () => {
    // Mirrors the backend format: `[tool {name} → {id}] {arg} · {summary}\n{result}\n\n`.
    const feedback =
      '[tool grep → call_abc] {"needle":"SOUL.md"} · 21 matches\nhit hit hit\n\n' +
      '[tool read_file → call_def] {"path":"soul.rs"} · read\nfn main() {}\n\n';
    const items = parsePersistedTranscript([
      { role: 'user', content: 'something like Operator Skills' },
      { role: 'assistant', content: 'Investigating the framework…' },
      { role: 'user', content: feedback },
      { role: 'assistant', content: 'Here are two questions…' },
    ]);
    expect(items).toEqual([
      { role: 'user', content: 'something like Operator Skills' },
      { role: 'assistant', content: 'Investigating the framework…' },
      { role: 'tool', tool: 'grep', arg: '{"needle":"SOUL.md"}', summary: '21 matches' },
      { role: 'tool', tool: 'read_file', arg: '{"path":"soul.rs"}', summary: 'read' },
      { role: 'assistant', content: 'Here are two questions…' },
    ]);
  });

  it('still handles pre-parity drafts with no arg/summary on the header', () => {
    const items = parsePersistedTranscript([
      { role: 'user', content: '[tool grep → call_abc]\n21 matches\n\n' },
    ]);
    expect(items).toEqual([{ role: 'tool', tool: 'grep' }]);
  });

  it('does not misclassify a user message that merely mentions [tool] prose', () => {
    const items = parsePersistedTranscript([
      { role: 'user', content: '[tool] naming is confusing in the docs' },
    ]);
    expect(items).toEqual([
      { role: 'user', content: '[tool] naming is confusing in the docs' },
    ]);
  });
});
