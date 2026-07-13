import type { ModelCell } from "./api";

/// Static price table for the Pulse "Token usage · per model" card.
/// USD per million tokens (input / output / cache-read). ESTIMATES ONLY —
/// list prices drift; refresh this table when providers reprice. Claude
/// rates sourced from the Anthropic model catalog (2026-06); cache reads
/// bill at ~0.1× input. Unknown models return null and render as "—".
interface ModelRates {
  input: number;
  output: number;
  cacheRead: number;
}

const claude = (input: number, output: number): ModelRates => ({
  input,
  output,
  cacheRead: input * 0.1,
});

/// Ordered most-specific-first; matched via case-insensitive substring so
/// provider-prefixed ids (`anthropic.claude-opus-4-8`, Azure deployment
/// names embedding the model) still hit.
const RATES: ReadonlyArray<[pattern: string, rates: ModelRates]> = [
  ["claude-fable-5", claude(10, 50)],
  ["claude-mythos-5", claude(10, 50)],
  ["claude-opus-4-8", claude(5, 25)],
  ["claude-opus-4-7", claude(5, 25)],
  ["claude-opus-4-6", claude(5, 25)],
  ["claude-opus-4-5", claude(5, 25)],
  ["claude-opus-4-1", claude(15, 75)],
  ["claude-opus-4", claude(15, 75)],
  ["claude-sonnet-5", claude(3, 15)],
  ["claude-sonnet-4", claude(3, 15)],
  ["claude-haiku-4-5", claude(1, 5)],
  // Non-Anthropic estimates (public list prices; cache-read = provider's
  // cached-input rate where one exists, else input rate).
  ["gpt-4o-mini", { input: 0.15, output: 0.6, cacheRead: 0.075 }],
  ["gpt-4o", { input: 2.5, output: 10, cacheRead: 1.25 }],
  ["gpt-4.1", { input: 2, output: 8, cacheRead: 0.5 }],
];

/// Providers whose inference is local — always $0 regardless of model.
const FREE_PROVIDERS = ["ollama", "lmstudio"];

export function ratesFor(provider: string, model: string): ModelRates | null {
  if (FREE_PROVIDERS.includes(provider.toLowerCase())) {
    return { input: 0, output: 0, cacheRead: 0 };
  }
  const id = model.toLowerCase();
  for (const [pattern, rates] of RATES) {
    if (id.includes(pattern)) return rates;
  }
  return null;
}

/// Estimated USD cost for one usage row, or null when the model is unpriced.
export function estimateCostUsd(cell: ModelCell): number | null {
  const r = ratesFor(cell.provider, cell.model);
  if (!r) return null;
  return (
    (cell.input_tokens * r.input +
      cell.output_tokens * r.output +
      cell.cache_read * r.cacheRead) /
    1_000_000
  );
}

/// "$12.34" / "$0.0021" / "—". Sub-cent costs keep enough precision to
/// not read as zero.
export function fmtCostUsd(cost: number | null): string {
  if (cost == null) return "—";
  if (cost === 0) return "$0";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}
