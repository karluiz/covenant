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

describe('question markers', () => {
  const marker = (q: object) => `<!--question:${JSON.stringify(q)}-->`;

  it('rebuilds an answered question card mid-transcript', () => {
    const items = parsePersistedTranscript([
      { role: 'user', content: 'quiero X' },
      { role: 'assistant', content: marker({ question: '¿A o B?', options: [{ label: 'A' }, { label: 'B' }] }) },
      { role: 'user', content: 'A' },
    ]);
    expect(items).toHaveLength(3);
    const card = items[1]!;
    expect(card.role).toBe('question');
    if (card.role === 'question') {
      expect(card.question).toBe('¿A o B?');
      expect(card.answered).toBe(true);
    }
  });

  it('a trailing question is still awaiting an answer on resume', () => {
    const items = parsePersistedTranscript([
      { role: 'user', content: 'quiero X' },
      { role: 'assistant', content: marker({ question: '¿A o B?', options: [{ label: 'A' }] }) },
    ]);
    const card = items[items.length - 1]!;
    expect(card.role === 'question' && !card.answered).toBe(true);
  });

  it('survives --> inside the question text', () => {
    const items = parsePersistedTranscript([
      { role: 'assistant', content: marker({ question: 'migrar A --> B?', options: [{ label: 'sí' }] }) },
    ]);
    const card = items[0]!;
    expect(card.role === 'question' && card.question).toBe('migrar A --> B?');
  });

  it('malformed question JSON falls back to a plain assistant bubble', () => {
    const items = parsePersistedTranscript([
      { role: 'assistant', content: '<!--question:{not json}-->' },
    ]);
    expect(items[0]!.role).toBe('assistant');
  });
});
