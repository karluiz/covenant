import { describe, expect, it } from 'vitest';
import { applyDeep, gradeFor, scoreSpec } from './engine';

const GOLDEN = `## Goal

Ship a scoring engine for specs. It runs live in the creator and in the picker.

## Out of scope

- Scoring arbitrary markdown.
- Historical trends.

## Acceptance criteria

- \`scoreSpec\` returns 0-100 plus a grade for any markdown input.
- The picker shows a badge on each published spec row.
- The publish payload includes the score object.

## File boundaries

- \`ui/src/spec-score/engine.ts\` owns all scoring logic.

## Complexity

Low. Pure functions over the existing section parser; no new dependencies.

## Open questions
`;

describe('scoreSpec', () => {
  it('scores a golden spec A or better', () => {
    const s = scoreSpec(GOLDEN);
    expect(s.score).toBeGreaterThanOrEqual(85);
    expect(['S', 'A']).toContain(s.grade);
    expect(s.dimensions).toHaveLength(7);
  });

  it('scores an empty spec D', () => {
    const s = scoreSpec('');
    expect(s.grade).toBe('D');
    expect(s.score).toBeLessThan(50);
  });

  it('null input behaves like empty', () => {
    expect(scoreSpec(null).score).toBe(scoreSpec('').score);
  });

  it('penalizes only goal when goal is missing', () => {
    const md = GOLDEN.replace(/## Goal[\s\S]*?(?=## Out of scope)/, '');
    const s = scoreSpec(md);
    const goal = s.dimensions.find((d) => d.key === 'goal')!;
    expect(goal.earned).toBe(0);
    expect(goal.findings.length).toBeGreaterThan(0);
    const verif = s.dimensions.find((d) => d.key === 'verifiability')!;
    expect(verif.earned).toBe(verif.weight);
  });

  it('flags unverifiable acceptance criteria', () => {
    const md = GOLDEN.replace(
      /## Acceptance criteria[\s\S]*?(?=## File boundaries)/,
      '## Acceptance criteria\n\n- it works well\n- everything behaves properly\n\n',
    );
    const s = scoreSpec(md);
    const verif = s.dimensions.find((d) => d.key === 'verifiability')!;
    expect(verif.earned).toBeLessThan(verif.weight);
    expect(verif.findings.some((f) => f.includes('works well'))).toBe(true);
  });

  it('penalizes empty out-of-scope', () => {
    const md = GOLDEN.replace(/## Out of scope[\s\S]*?(?=## Acceptance)/, '## Out of scope\n\n');
    const scope = scoreSpec(md).dimensions.find((d) => d.key === 'scope')!;
    expect(scope.earned).toBe(0);
  });

  it('rewards real paths in file boundaries', () => {
    const md = GOLDEN.replace(
      /## File boundaries[\s\S]*?(?=## Complexity)/,
      '## File boundaries\n\nSomewhere in the frontend probably.\n\n',
    );
    const b = scoreSpec(md).dimensions.find((d) => d.key === 'boundaries')!;
    expect(b.earned).toBeLessThan(b.weight);
  });

  it('penalizes TBD/TODO anywhere in the doc', () => {
    const s = scoreSpec(GOLDEN + '\nTBD: figure this out\n');
    const loose = s.dimensions.find((d) => d.key === 'loose_ends')!;
    expect(loose.earned).toBeLessThan(loose.weight);
  });

  it('penalizes unresolved open questions', () => {
    const md = GOLDEN.replace(/## Open questions\n/, '## Open questions\n\n- What about Windows?\n');
    const loose = scoreSpec(md).dimensions.find((d) => d.key === 'loose_ends')!;
    expect(loose.earned).toBeLessThan(loose.weight);
  });

  it('penalizes vague wording', () => {
    const md = GOLDEN.replace(
      'Ship a scoring engine for specs.',
      'Maybe we should somehow handle scoring properly, etc.',
    );
    const p = scoreSpec(md).dimensions.find((d) => d.key === 'precision')!;
    expect(p.earned).toBeLessThan(p.weight);
    expect(p.findings.length).toBeGreaterThan(0);
  });
});

describe('gradeFor', () => {
  it('maps thresholds', () => {
    expect(gradeFor(95)).toBe('S');
    expect(gradeFor(85)).toBe('A');
    expect(gradeFor(70)).toBe('B');
    expect(gradeFor(50)).toBe('C');
    expect(gradeFor(49)).toBe('D');
  });
});

describe('applyDeep', () => {
  it('adjusts dimensions, clamps to [0, weight], marks deep', () => {
    const base = scoreSpec(GOLDEN);
    const adjusted = applyDeep(base, {
      adjustments: { goal: -5, precision: +100 },
      findings: ['Goal conflates two outcomes.'],
    });
    const goal = adjusted.dimensions.find((d) => d.key === 'goal')!;
    const baseGoal = base.dimensions.find((d) => d.key === 'goal')!;
    expect(goal.earned).toBe(Math.max(0, baseGoal.earned - 5));
    const p = adjusted.dimensions.find((d) => d.key === 'precision')!;
    expect(p.earned).toBe(p.weight);
    expect(adjusted.deep).toBe(true);
    expect(goal.findings).toContain('Goal conflates two outcomes.');
    expect(base.deep).toBeUndefined(); // base not mutated
  });
});
