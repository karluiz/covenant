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

  it('scales the vague-word penalty by document length', () => {
    const filler = 'word '.repeat(1000);
    const md = GOLDEN + `\n## Complexity\n\n${filler} should ${filler} should ${filler} should\n`;
    const p = scoreSpec(md).dimensions.find((d) => d.key === 'precision')!;
    expect(p.earned).toBeGreaterThanOrEqual(8);
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

describe('scoreSpec on free-form specs', () => {
  const FREEFORM = `# UI Vitals — terminal-speed metrics

Date: 2026-07-29. Detect speed regressions between releases from real local usage. No network, no telemetry.

## Why

Speed is the product metric for a terminal. A 2-3s first switch shipped unnoticed.

## Non-goals

- Cloud telemetry of any kind.
- Windows support in v1.

## Success criteria

- Every shell-tab activation writes one row to \`vitals_events\` in SQLite.
- \`hyperfine\` shows no measurable overhead on tab switch.

## Risks

The rAF-based window can land after the heavy work; sampling for ~1s after reveal covers it.

## Implementation

Lives in \`ui/src/terminal/activate.ts\` and \`crates/app/src/vitals.rs\`.
`;

  it('scores content under alias headings, not just canonical ones', () => {
    const s = scoreSpec(FREEFORM);
    expect(s.dimensions.find((d) => d.key === 'goal')!.earned).toBeGreaterThan(0);
    expect(s.dimensions.find((d) => d.key === 'scope')!.earned).toBeGreaterThan(0);
    expect(s.dimensions.find((d) => d.key === 'verifiability')!.earned).toBeGreaterThan(0);
    expect(s.dimensions.find((d) => d.key === 'complexity')!.earned).toBeGreaterThan(0);
    expect(s.dimensions.find((d) => d.key === 'boundaries')!.earned).toBeGreaterThan(0);
    expect(s.score).toBeGreaterThanOrEqual(70);
    expect(s.canonical).toBe(false);
  });

  it('matches numbered headings (## 19. Acceptance criteria)', () => {
    const md = [
      '# Spec',
      '## 1. Goal',
      'Ship a thing that does X for Y.',
      '## 19. Acceptance criteria for the full system',
      '- Running `npm test` passes with the new suite enabled.',
      '- The badge renders in `ui/src/foo.ts` within 16ms.',
      '## 21. Complexity',
      'Medium — the rule engine touches persistence and needs a dedupe pass.',
    ].join('\n\n');
    const s = scoreSpec(md);
    expect(s.dimensions.find((d) => d.key === 'goal')!.earned).toBe(20);
    expect(s.dimensions.find((d) => d.key === 'verifiability')!.earned).toBeGreaterThan(0);
    expect(s.dimensions.find((d) => d.key === 'complexity')!.earned).toBe(10);
  });

  it('falls back to the opening paragraph for the goal', () => {
    const md = '# Title\n\nShip a thing that does X for Y.\n\n## Notes\n\n- whatever\n';
    const goal = scoreSpec(md).dimensions.find((d) => d.key === 'goal')!;
    expect(goal.earned).toBe(goal.weight);
  });

  it('does not read bullets of a later section as the goal', () => {
    const md = GOLDEN.replace(/## Goal[\s\S]*?(?=## Out of scope)/, '');
    expect(scoreSpec(md).dimensions.find((d) => d.key === 'goal')!.earned).toBe(0);
  });

  it('credits paths anywhere when no boundaries section exists', () => {
    const md = '# T\n\nDo X.\n\nThe change lives in \`ui/src/foo.ts\`.\n';
    const b = scoreSpec(md).dimensions.find((d) => d.key === 'boundaries')!;
    expect(b.earned).toBe(8);
  });

  it('marks canonical specs canonical', () => {
    expect(scoreSpec(GOLDEN).canonical).toBe(true);
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
