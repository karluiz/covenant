import { specDeepScore } from '../api';
import { applyDeep, type DeepAdjustments, type DimensionKey, type SpecScore } from './engine';

const KEYS: ReadonlySet<string> = new Set<DimensionKey>([
  'goal',
  'verifiability',
  'scope',
  'boundaries',
  'complexity',
  'loose_ends',
  'precision',
]);

/** The judge scores each dimension absolutely (0..weight) from content,
 *  wherever it lives in the document — format-independent by contract. */
export interface DeepVerdict {
  scores: Partial<Record<DimensionKey, number>>;
  findings: string[];
}

export function parseDeepResponse(raw: string): DeepVerdict | null {
  const jsonish = /\{[\s\S]*\}/.exec(raw)?.[0];
  if (!jsonish) return null;
  try {
    const obj = JSON.parse(jsonish) as { scores?: unknown; findings?: unknown };
    const scores: DeepVerdict['scores'] = {};
    if (obj.scores && typeof obj.scores === 'object') {
      for (const [k, v] of Object.entries(obj.scores)) {
        if (KEYS.has(k) && typeof v === 'number' && Number.isFinite(v)) {
          scores[k as DimensionKey] = v;
        }
      }
    }
    const findings = Array.isArray(obj.findings)
      ? obj.findings.filter((f): f is string => typeof f === 'string')
      : [];
    return { scores, findings };
  } catch {
    return null;
  }
}

/** Absolute judge scores → per-dimension deltas against the heuristic base. */
function toAdjustments(verdict: DeepVerdict, base: SpecScore): DeepAdjustments {
  const adjustments: DeepAdjustments['adjustments'] = {};
  for (const d of base.dimensions) {
    const s = verdict.scores[d.key];
    if (typeof s === 'number') {
      adjustments[d.key] = Math.max(0, Math.min(d.weight, Math.round(s))) - d.earned;
    }
  }
  return { adjustments, findings: verdict.findings };
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h);
}

const cache = new Map<string, DeepVerdict>();

/** Deep-score `md` via the LLM judge. Cached by content hash. Throws with a
 *  user-readable reason on failure — the breakdown button surfaces it inline;
 *  swallowing it here read as a dead button. */
export async function deepScore(md: string, base: SpecScore): Promise<SpecScore> {
  const key = hash(md);
  const cached = cache.get(key);
  if (cached) return applyDeep(base, toAdjustments(cached, base));
  let raw: string | null;
  try {
    raw = await specDeepScore(md);
  } catch (err) {
    throw new Error(`Deep score failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!raw) throw new Error('No summary model configured — add one in Settings → Inference');
  const parsed = parseDeepResponse(raw);
  if (!parsed) throw new Error('Judge returned unparseable output — try again');
  cache.set(key, parsed);
  return applyDeep(base, toAdjustments(parsed, base));
}
