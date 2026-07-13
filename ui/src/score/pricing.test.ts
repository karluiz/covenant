import { describe, it, expect } from "vitest";
import { estimateCostUsd, fmtCostUsd, ratesFor } from "./pricing";
import type { ModelCell } from "./api";

const cell = (over: Partial<ModelCell>): ModelCell => ({
  source: "internal",
  agent: null,
  provider: "anthropic",
  model: "claude-opus-4-8",
  calls: 1,
  input_tokens: 0,
  output_tokens: 0,
  cache_read: 0,
  ...over,
});

describe("pricing", () => {
  it("prices opus 4.8 at $5/$25 with 0.1x cache reads", () => {
    // 1M in + 1M out + 1M cache = 5 + 25 + 0.5
    const c = cell({ input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read: 1_000_000 });
    expect(estimateCostUsd(c)).toBeCloseTo(30.5, 6);
  });

  it("matches provider-prefixed ids", () => {
    expect(ratesFor("bedrock", "anthropic.claude-sonnet-5")).toEqual(
      expect.objectContaining({ input: 3, output: 15 }),
    );
  });

  it("local providers are free", () => {
    const c = cell({ provider: "ollama", model: "llama3", input_tokens: 5_000_000 });
    expect(estimateCostUsd(c)).toBe(0);
  });

  it("unknown models return null and render as —", () => {
    const c = cell({ model: "mystery-model-9000" });
    expect(estimateCostUsd(c)).toBeNull();
    expect(fmtCostUsd(null)).toBe("—");
  });

  it("formats sub-cent costs with precision", () => {
    expect(fmtCostUsd(0.0021)).toBe("$0.0021");
    expect(fmtCostUsd(12.345)).toBe("$12.35");
    expect(fmtCostUsd(0)).toBe("$0");
  });
});
