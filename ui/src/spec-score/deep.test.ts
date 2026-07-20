import { describe, expect, it } from 'vitest';
import { parseDeepResponse } from './deep';

describe('parseDeepResponse', () => {
  it('parses a clean JSON object', () => {
    const r = parseDeepResponse('{"adjustments":{"goal":-3},"findings":["Goal is two goals."]}');
    expect(r).toEqual({ adjustments: { goal: -3 }, findings: ['Goal is two goals.'] });
  });

  it('extracts JSON from a fenced block', () => {
    const r = parseDeepResponse('Here you go:\n```json\n{"adjustments":{},"findings":[]}\n```');
    expect(r).toEqual({ adjustments: {}, findings: [] });
  });

  it('drops unknown dimension keys and non-numeric deltas', () => {
    const r = parseDeepResponse('{"adjustments":{"goal":-2,"bogus":5,"scope":"x"},"findings":[]}');
    expect(r).toEqual({ adjustments: { goal: -2 }, findings: [] });
  });

  it('returns null on garbage', () => {
    expect(parseDeepResponse('I cannot help with that')).toBeNull();
  });
});
