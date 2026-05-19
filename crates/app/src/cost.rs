//! Token-cost estimation for the Operator's Anthropic API calls.
//!
//! AOM uses this to track accumulated USD per session and auto-stop
//! when the budget is hit. The pricing table is hardcoded; rates
//! occasionally change (Anthropic publishes them at
//! https://docs.anthropic.com/en/docs/about-claude/pricing). When
//! they shift, update `pricing_for` and bump the table comment.
//!
//! Pricing as of 2026-05 (per 1M tokens):
//!   - Claude Sonnet 4.6:  $3 in / $15 out / $3.75 cache-write / $0.30 cache-read
//!   - Claude Opus 4.7:   $15 in / $75 out / $18.75 cache-write / $1.50 cache-read
//!   - Claude Haiku 4.5:   $1 in /  $5 out / $1.25 cache-write / $0.10 cache-read
//!
//! Unknown models fall back to Sonnet rates — overestimating a few
//! cents per call is preferable to underestimating and overshooting
//! the user's budget cap.

use karl_agent::TokenUsage;

#[derive(Debug, Clone, Copy)]
struct Pricing {
    /// USD per 1 token. Stored pre-divided so estimate() is one mul +
    /// add per field instead of a divide-by-million per call.
    input: f64,
    output: f64,
    cache_write: f64,
    cache_read: f64,
}

const SONNET: Pricing = Pricing {
    input: 3.0 / 1_000_000.0,
    output: 15.0 / 1_000_000.0,
    cache_write: 3.75 / 1_000_000.0,
    cache_read: 0.30 / 1_000_000.0,
};

const OPUS: Pricing = Pricing {
    input: 15.0 / 1_000_000.0,
    output: 75.0 / 1_000_000.0,
    cache_write: 18.75 / 1_000_000.0,
    cache_read: 1.50 / 1_000_000.0,
};

const HAIKU: Pricing = Pricing {
    input: 1.0 / 1_000_000.0,
    output: 5.0 / 1_000_000.0,
    cache_write: 1.25 / 1_000_000.0,
    cache_read: 0.10 / 1_000_000.0,
};

fn pricing_for(model: &str) -> Pricing {
    let m = model.to_ascii_lowercase();
    if m.contains("opus") {
        OPUS
    } else if m.contains("haiku") {
        HAIKU
    } else {
        // Default to Sonnet — covers `claude-sonnet-*`, `claude-3-5-sonnet`,
        // `claude-sonnet-4-6`, and any unknown model name (overestimate
        // is safer than underestimate for budget enforcement).
        SONNET
    }
}

pub fn estimate_usd(model: &str, usage: TokenUsage) -> f64 {
    let p = pricing_for(model);
    (usage.input_tokens as f64) * p.input
        + (usage.output_tokens as f64) * p.output
        + (usage.cache_creation_input_tokens as f64) * p.cache_write
        + (usage.cache_read_input_tokens as f64) * p.cache_read
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx_eq(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn sonnet_simple_call() {
        // 1000 in + 500 out = 0.001 * 3 + 0.0005 * 15 = $0.003 + $0.0075 = $0.0105
        let cost = estimate_usd(
            "claude-sonnet-4-6",
            TokenUsage {
                input_tokens: 1000,
                output_tokens: 500,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
            },
        );
        assert!(approx_eq(cost, 0.0105), "got {cost}");
    }

    #[test]
    fn opus_more_expensive_than_sonnet() {
        let usage = TokenUsage {
            input_tokens: 1000,
            output_tokens: 1000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
        };
        let sonnet = estimate_usd("claude-sonnet-4-6", usage);
        let opus = estimate_usd("claude-opus-4-7", usage);
        assert!(
            opus > sonnet * 4.0,
            "opus {opus} should be ~5x sonnet {sonnet}"
        );
    }

    #[test]
    fn haiku_cheaper_than_sonnet() {
        let usage = TokenUsage {
            input_tokens: 1000,
            output_tokens: 1000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
        };
        let sonnet = estimate_usd("claude-sonnet-4-6", usage);
        let haiku = estimate_usd("claude-haiku-4-5", usage);
        assert!(haiku < sonnet, "haiku {haiku} should be < sonnet {sonnet}");
    }

    #[test]
    fn cache_read_is_much_cheaper_than_fresh_input() {
        // 10k tokens as fresh input vs 10k tokens as cache read.
        // Cache read should be ~10x cheaper for Sonnet ($0.30 vs $3).
        let fresh = estimate_usd(
            "claude-sonnet-4-6",
            TokenUsage {
                input_tokens: 10_000,
                ..TokenUsage::default()
            },
        );
        let cached = estimate_usd(
            "claude-sonnet-4-6",
            TokenUsage {
                cache_read_input_tokens: 10_000,
                ..TokenUsage::default()
            },
        );
        assert!(fresh > cached * 9.0);
    }

    #[test]
    fn unknown_model_falls_back_to_sonnet() {
        let usage = TokenUsage {
            input_tokens: 1000,
            output_tokens: 0,
            ..TokenUsage::default()
        };
        let known = estimate_usd("claude-sonnet-4-6", usage);
        let unknown = estimate_usd("some-future-model", usage);
        assert!(approx_eq(known, unknown));
    }

    #[test]
    fn zero_usage_costs_zero() {
        assert!(approx_eq(
            estimate_usd("claude-sonnet-4-6", TokenUsage::default()),
            0.0
        ));
    }
}
