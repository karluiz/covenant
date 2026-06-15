import { describe, it, expect } from 'vitest';
import { SECTIONS, titleForKey, keyForTitle, parseSectionsFromMarkdown, parseSectionMarkers, stripLeadingHeading } from './sections';

describe('sections util', () => {
  it('exposes the six canonical sections in order', () => {
    expect(SECTIONS.map((s) => s.key)).toEqual([
      'goal', 'out_of_scope', 'acceptance', 'file_boundaries', 'complexity', 'open_questions',
    ]);
  });

  it('round-trips key <-> title (case-insensitive on title)', () => {
    expect(titleForKey('goal')).toBe('Goal');
    expect(keyForTitle('Goal')).toBe('goal');
    expect(keyForTitle('out of scope')).toBe('out_of_scope');
    expect(keyForTitle('Nonsense')).toBeNull();
  });

  it('parses a full spec markdown into per-section bodies (status done)', () => {
    const md = [
      '## Goal', '', 'Build the thing.', '',
      '## Out of scope', '', 'Not this.', '',
      '## Acceptance criteria', '', '- works', '',
    ].join('\n');
    const map = parseSectionsFromMarkdown(md);
    expect(map.get('goal')).toEqual({ markdown: 'Build the thing.', status: 'done' });
    expect(map.get('out_of_scope')).toEqual({ markdown: 'Not this.', status: 'done' });
    expect(map.get('acceptance')).toEqual({ markdown: '- works', status: 'done' });
    expect(map.has('complexity')).toBe(false);
  });

  it('returns an empty map for null/empty markdown', () => {
    expect(parseSectionsFromMarkdown(null).size).toBe(0);
    expect(parseSectionsFromMarkdown('').size).toBe(0);
  });

  it('ignores unknown ## headers without crashing', () => {
    const map = parseSectionsFromMarkdown('## Random\nx\n## Goal\ny');
    expect(map.has('goal')).toBe(true);
    expect(map.get('goal')!.markdown).toBe('y');
    expect(map.size).toBe(1);
  });

  it('strips a leading ## heading from a section body', () => {
    expect(stripLeadingHeading('## Goal\n\nBuild it.')).toBe('Build it.');
    expect(stripLeadingHeading('## Out of scope\nNot this.')).toBe('Not this.');
  });

  it('leaves a header-less body untouched and keeps mid-body subheadings', () => {
    expect(stripLeadingHeading('Just text.')).toBe('Just text.');
    expect(stripLeadingHeading('Intro\n## Subsection\nmore')).toBe('Intro\n## Subsection\nmore');
  });

  it('extracts closed section markers (header-less bodies, known keys only)', () => {
    const text = 'Here it is. <!--section:goal-->## Goal\n\nBuild it.<!--/section--> and '
      + '<!--section:open_questions-->Anything?<!--/section--> done. '
      + '<!--section:bogus-->ignored<!--/section-->';
    expect(parseSectionMarkers(text)).toEqual([
      { key: 'goal', markdown: 'Build it.' },
      { key: 'open_questions', markdown: 'Anything?' },
    ]);
  });

  it('ignores an unclosed marker', () => {
    expect(parseSectionMarkers('text <!--section:goal-->half written')).toEqual([]);
  });
});
