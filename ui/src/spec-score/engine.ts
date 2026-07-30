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
  /** False when the doc lacks the canonical `## Goal` shape — content may
   *  still score via alias headings, but the canonicalize rewrite applies. */
  canonical?: boolean;
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

// Quality lives in the content, not the canonical headings — each dimension
// accepts common alias headings (## Why → goal, ## Non-goals → out of scope,
// ## Risks → complexity, …) so free-form specs score on what they say.
// Titles are normalized (lowercase, non-alphanumerics → spaces) before matching.
const SECTION_ALIASES: [SpecSectionKey, RegExp][] = [
  ['goal', /^(goal|why\b|motivation|purpose|objective|problem|overview|context)/],
  ['out_of_scope', /^(out of scope|non ?goals?\b|not doing|not in scope|exclusions|what this is( ?no|n)t)/],
  ['acceptance', /^(acceptance|success (criteria|metrics)|verification|validation|definition of done|done when|testing)/],
  ['file_boundaries', /^(file boundaries|files( touched)?\b|touched files|where\b|implementation)/],
  ['complexity', /^(complexity|risks?\b|trade ?offs?\b|concerns|edge cases)/],
  ['open_questions', /^(open questions?|questions|unknowns|unresolved)/],
];

function sectionsByAlias(doc: string): Map<SpecSectionKey, string> {
  const map = new Map<SpecSectionKey, string>();
  let cur: SpecSectionKey | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (cur && !map.has(cur)) map.set(cur, buf.join('\n').trim());
  };
  for (const line of doc.split('\n')) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      const t = m[1].toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      cur = SECTION_ALIASES.find(([, re]) => re.test(t))?.[0] ?? null;
      buf = [];
    } else if (cur) {
      buf.push(line);
    }
  }
  flush();
  return map;
}

/** First prose paragraph of the preamble (before any `##`) — the goal of a
 *  free-form spec usually lives there. Bullets and code fences don't count. */
function firstParagraph(doc: string): string {
  const buf: string[] = [];
  for (const line of doc.split('\n')) {
    if (/^##\s/.test(line)) break;
    if (/^#|^```/.test(line) || !line.trim() || BULLET_RE.test(line)) {
      if (buf.length) break;
      continue;
    }
    buf.push(line.trim());
  }
  return buf.join(' ');
}

export function scoreSpec(md: string | null): SpecScore {
  const doc = md ?? '';
  const secs = sectionsByAlias(doc);
  const body = (k: SpecSectionKey) => secs.get(k) ?? '';
  const dims: DimensionScore[] = [];
  const dim = (key: DimensionKey, label: string, weight: number, earned: number, findings: string[]) =>
    dims.push({ key, label, weight, earned: Math.max(0, Math.min(weight, Math.round(earned))), findings });

  // Goal clarity (20)
  {
    const g = body('goal') || firstParagraph(doc);
    const findings: string[] = [];
    let earned = 0;
    if (!g) findings.push('No goal section and no opening paragraph stating one.');
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
    if (b) {
      earned = 5;
      if (PATH_RE.test(b)) earned += 5;
      else findings.push('File boundaries names no concrete paths.');
    } else if (PATH_RE.test(doc)) {
      // ponytail: paths anywhere count — a dedicated section is nicer, not required
      earned = 8;
    } else {
      findings.push('No concrete file paths anywhere in the document.');
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

  // Precision (10) — density-based: an absolute per-match penalty nuked long
  // specs (5 "should"s in 2k words is fine; 5 in 100 words is not).
  {
    const findings: string[] = [];
    const matches = doc.match(VAGUE_RE) ?? [];
    const words = doc.split(/\s+/).filter(Boolean).length;
    const per100 = words > 0 ? (matches.length * 100) / words : 0;
    const earned = 10 - Math.round(per100 * 4);
    if (matches.length > 0) {
      const unique = [...new Set(matches.map((m) => m.toLowerCase()))];
      findings.push(`Vague wording: ${unique.slice(0, 5).join(', ')}.`);
    }
    dim('precision', 'Precision', 10, earned, findings);
  }

  const score = dims.reduce((acc, d) => acc + d.earned, 0);
  const canonical = /^##\s+goal\s*$/im.test(doc);
  return { score, grade: gradeFor(score), dimensions: dims, canonical };
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
  return { ...base, score, grade: gradeFor(score), dimensions, deep: true };
}
