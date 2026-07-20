import { parseSectionsFromMarkdown } from '../spec-chat/sections';
import type { SpecSectionKey } from '../spec-chat/events';

export type DimensionKey =
  | 'goal'
  | 'verifiability'
  | 'scope'
  | 'boundaries'
  | 'complexity'
  | 'loose_ends'
  | 'precision';

export type Grade = 'S' | 'A' | 'B' | 'C' | 'D';

export interface DimensionScore {
  key: DimensionKey;
  label: string;
  weight: number;
  earned: number;
  findings: string[];
}

export interface SpecScore {
  score: number;
  grade: Grade;
  dimensions: DimensionScore[];
  deep?: boolean;
}

export interface DeepAdjustments {
  adjustments: Partial<Record<DimensionKey, number>>;
  findings: string[];
}

const VAGUE_RE = /\b(should|maybe|somehow|properly|probably|might|hopefully)\b|\betc\.?/gi;
const LOOSE_RE = /\bTBD\b|\bTODO\b|\?{3}/g;
const UNVERIFIABLE_RE = /\b(works? (well|fine|properly|correctly)|good|nice|as expected|properly|correctly)\b/i;
const PATH_RE = /[\w.-]+\/[\w./-]+|\b[\w-]+\.(ts|tsx|js|rs|css|md|json|toml|py|html)\b/;
const BULLET_RE = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/;

export function gradeFor(score: number): Grade {
  if (score >= 95) return 'S';
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 50) return 'C';
  return 'D';
}

function sentences(text: string): number {
  return text.split(/[.!?]+(?:\s|$)/).filter((s) => s.trim().length > 0).length;
}

export function scoreSpec(md: string | null): SpecScore {
  const doc = md ?? '';
  const secs = parseSectionsFromMarkdown(doc);
  const body = (k: SpecSectionKey) => secs.get(k)?.markdown.trim() ?? '';
  const dims: DimensionScore[] = [];
  const dim = (key: DimensionKey, label: string, weight: number, earned: number, findings: string[]) =>
    dims.push({ key, label, weight, earned: Math.max(0, Math.min(weight, Math.round(earned))), findings });

  // Goal clarity (20)
  {
    const g = body('goal');
    const findings: string[] = [];
    let earned = 0;
    if (!g) findings.push('Goal section is missing or empty.');
    else {
      earned = 10;
      const n = sentences(g);
      if (n >= 1 && n <= 5) earned += 10;
      else {
        findings.push(n === 0 ? 'Goal has no full sentence.' : `Goal is ${n} sentences — keep it to 1–5.`);
        earned += 4;
      }
    }
    dim('goal', 'Goal clarity', 20, earned, findings);
  }

  // Verifiability (25)
  {
    const a = body('acceptance');
    const findings: string[] = [];
    let earned = 0;
    if (!a) findings.push('Acceptance criteria section is missing or empty.');
    else {
      earned = 7;
      const bullets = a
        .split('\n')
        .map((l) => BULLET_RE.exec(l)?.[1]?.trim())
        .filter((b): b is string => !!b);
      if (bullets.length >= 2) earned += 8;
      else findings.push('List at least 2 acceptance criteria as bullets.');
      if (bullets.length > 0) {
        const bad = bullets.filter((b) => b.split(/\s+/).length < 4 || UNVERIFIABLE_RE.test(b));
        earned += (10 * (bullets.length - bad.length)) / bullets.length;
        for (const b of bad.slice(0, 3)) findings.push(`Not verifiable: "${b}"`);
      }
    }
    dim('verifiability', 'Verifiability', 25, earned, findings);
  }

  // Scope discipline (15)
  {
    const s = body('out_of_scope');
    dim('scope', 'Scope discipline', 15, s ? 15 : 0, s ? [] : ['Out of scope is empty — name explicit exclusions.']);
  }

  // Boundaries (10)
  {
    const b = body('file_boundaries');
    const findings: string[] = [];
    let earned = 0;
    if (!b) findings.push('File boundaries section is missing or empty.');
    else {
      earned = 5;
      if (PATH_RE.test(b)) earned += 5;
      else findings.push('File boundaries names no concrete paths.');
    }
    dim('boundaries', 'Boundaries', 10, earned, findings);
  }

  // Complexity honesty (10)
  {
    const c = body('complexity');
    const findings: string[] = [];
    let earned = 0;
    if (!c) findings.push('Complexity section is missing or empty.');
    else {
      earned = 5;
      if (c.length >= 40) earned += 5;
      else findings.push('Complexity is one-word honesty — say why.');
    }
    dim('complexity', 'Complexity honesty', 10, earned, findings);
  }

  // No loose ends (10)
  {
    const findings: string[] = [];
    let earned = 10;
    const oq = body('open_questions');
    if (oq && oq.includes('?')) {
      earned -= 5;
      findings.push('Open questions are unresolved.');
    }
    const loose = doc.match(LOOSE_RE);
    if (loose && loose.length > 0) {
      earned -= 5;
      findings.push(`${loose.length} TBD/TODO marker${loose.length > 1 ? 's' : ''} in the document.`);
    }
    dim('loose_ends', 'No loose ends', 10, earned, findings);
  }

  // Precision (10)
  {
    const findings: string[] = [];
    const matches = doc.match(VAGUE_RE) ?? [];
    const earned = 10 - 2 * matches.length;
    if (matches.length > 0) {
      const unique = [...new Set(matches.map((m) => m.toLowerCase()))];
      findings.push(`Vague wording: ${unique.slice(0, 5).join(', ')}.`);
    }
    dim('precision', 'Precision', 10, earned, findings);
  }

  const score = dims.reduce((acc, d) => acc + d.earned, 0);
  return { score, grade: gradeFor(score), dimensions: dims };
}

/** Apply LLM deep-score adjustments; per-dimension earned clamps to [0, weight].
 *  Deep findings attach once, to the dimension with the largest negative delta. Pure. */
export function applyDeep(base: SpecScore, deep: DeepAdjustments): SpecScore {
  let worst: DimensionKey | null = null;
  let worstDelta = 0;
  for (const [k, v] of Object.entries(deep.adjustments) as [DimensionKey, number][]) {
    if (v < worstDelta) {
      worstDelta = v;
      worst = k;
    }
  }
  const dimensions = base.dimensions.map((d) => {
    const delta = deep.adjustments[d.key] ?? 0;
    const earned = Math.max(0, Math.min(d.weight, d.earned + delta));
    const findings = d.key === worst ? [...d.findings, ...deep.findings] : d.findings;
    return { ...d, earned, findings };
  });
  const score = dimensions.reduce((acc, d) => acc + d.earned, 0);
  return { score, grade: gradeFor(score), dimensions, deep: true };
}
