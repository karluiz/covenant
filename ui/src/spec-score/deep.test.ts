import { describe, expect, it } from 'vitest';
import { parseDeepResponse } from './deep';

describe('parseDeepResponse', () => {
  it('parses a clean JSON object', () => {
    const r = parseDeepResponse('{"scores":{"goal":17},"findings":["Goal is two goals."]}');
    expect(r).toEqual({ scores: { goal: 17 }, findings: ['Goal is two goals.'] });
  });

  it('extracts JSON from a fenced block', () => {
    const r = parseDeepResponse('Here you go:\n```json\n{"scores":{},"findings":[]}\n```');
    expect(r).toEqual({ scores: {}, findings: [] });
  });

  it('drops unknown dimension keys and non-numeric scores', () => {
    const r = parseDeepResponse('{"scores":{"goal":18,"bogus":5,"scope":"x"},"findings":[]}');
    expect(r).toEqual({ scores: { goal: 18 }, findings: [] });
  });

  it('returns null on garbage', () => {
    expect(parseDeepResponse('I cannot help with that')).toBeNull();
  });
});
