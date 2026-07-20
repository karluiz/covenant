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

export function parseDeepResponse(raw: string): DeepAdjustments | null {
  const jsonish = /\{[\s\S]*\}/.exec(raw)?.[0];
  if (!jsonish) return null;
  try {
    const obj = JSON.parse(jsonish) as { adjustments?: unknown; findings?: unknown };
    const adjustments: DeepAdjustments['adjustments'] = {};
    if (obj.adjustments && typeof obj.adjustments === 'object') {
      for (const [k, v] of Object.entries(obj.adjustments)) {
        if (KEYS.has(k) && typeof v === 'number' && Number.isFinite(v)) {
          adjustments[k as DimensionKey] = v;
        }
      }
    }
    const findings = Array.isArray(obj.findings)
      ? obj.findings.filter((f): f is string => typeof f === 'string')
      : [];
    return { adjustments, findings };
  } catch {
    return null;
  }
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h);
}

const cache = new Map<string, DeepAdjustments>();

/** Deep-score `md` via the LLM judge. Cached by content hash. Throws with a
 *  user-readable reason on failure — the breakdown button surfaces it inline;
 *  swallowing it here read as a dead button. */
export async function deepScore(md: string, base: SpecScore): Promise<SpecScore> {
  const key = hash(md);
  const cached = cache.get(key);
  if (cached) return applyDeep(base, cached);
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
  return applyDeep(base, parsed);
}
