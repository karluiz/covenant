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

/** Deep-score `md` via the LLM judge. Returns `base` untouched on any failure
 *  (no route configured, bad JSON, network). Cached by content hash. */
export async function deepScore(md: string, base: SpecScore): Promise<SpecScore> {
  const key = hash(md);
  const cached = cache.get(key);
  if (cached) return applyDeep(base, cached);
  try {
    const raw = await specDeepScore(md);
    if (!raw) return base;
    const parsed = parseDeepResponse(raw);
    if (!parsed) return base;
    cache.set(key, parsed);
    return applyDeep(base, parsed);
  } catch {
    return base;
  }
}
