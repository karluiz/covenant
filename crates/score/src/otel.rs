//! OpenTelemetry metrics exporter for Covenant CDLC metrics.
//!
//! Spawns a background task that periodically reads the score store and
//! reports gauge/counter values via the OTLP exporter (gRPC by default,
//! configurable via `OTEL_EXPORTER_OTLP_ENDPOINT`).
//!
//! All metrics are emitted under the `covenant.cdlc` namespace.

use crate::ScoreStore;
use opentelemetry::metrics::{Meter, MeterProvider};
use opentelemetry::KeyValue;
use opentelemetry_sdk::metrics::SdkMeterProvider;
use std::sync::Arc;
use std::time::Duration;

const EXPORT_INTERVAL: Duration = Duration::from_secs(60);

/// Initialize the OTEL meter provider with an OTLP exporter and return it.
/// The provider must be kept alive for the lifetime of the application.
pub fn init_meter_provider() -> Result<SdkMeterProvider, Box<dyn std::error::Error + Send + Sync>> {
    use opentelemetry_otlp::MetricExporter;
    use opentelemetry_sdk::metrics::PeriodicReader;

    let exporter = MetricExporter::builder()
        .with_tonic()
        .build()?;

    let reader = PeriodicReader::builder(exporter)
        .with_interval(EXPORT_INTERVAL)
        .build();

    let provider = SdkMeterProvider::builder()
        .with_reader(reader)
        .build();

    opentelemetry::global::set_meter_provider(provider.clone());

    Ok(provider)
}

/// Register all CDLC observable gauges against the given meter + store.
/// The callbacks read from the ScoreStore on each collection cycle.
pub fn register_metrics(meter: &Meter, store: Arc<ScoreStore>) {
    let s = store.clone();
    let _ = meter
        .u64_observable_gauge("covenant.cdlc.total_prompts")
        .with_description("Lifetime prompt count")
        .with_callback(move |gauge| {
            if let Ok(summary) = s.summary() {
                gauge.observe(summary.total_prompts, &[]);
            }
        })
        .build();

    let s = store.clone();
    let _ = meter
        .u64_observable_gauge("covenant.cdlc.total_commits")
        .with_description("Lifetime commit count")
        .with_callback(move |gauge| {
            if let Ok(summary) = s.summary() {
                gauge.observe(summary.total_commits, &[]);
            }
        })
        .build();

    let s = store.clone();
    let _ = meter
        .u64_observable_gauge("covenant.cdlc.total_tokens")
        .with_description("Lifetime LLM token consumption")
        .with_callback(move |gauge| {
            if let Ok(summary) = s.summary() {
                gauge.observe(summary.total_tokens, &[]);
            }
        })
        .build();

    let s = store.clone();
    let _ = meter
        .u64_observable_gauge("covenant.cdlc.today_prompts")
        .with_description("Prompts recorded today")
        .with_callback(move |gauge| {
            if let Ok(summary) = s.summary() {
                gauge.observe(summary.today_prompts as u64, &[]);
            }
        })
        .build();

    let s = store.clone();
    let _ = meter
        .u64_observable_gauge("covenant.cdlc.today_commits")
        .with_description("Commits recorded today")
        .with_callback(move |gauge| {
            if let Ok(summary) = s.summary() {
                gauge.observe(summary.today_commits as u64, &[]);
            }
        })
        .build();

    let s = store.clone();
    let _ = meter
        .u64_observable_gauge("covenant.cdlc.current_streak")
        .with_description("Current consecutive-day activity streak")
        .with_callback(move |gauge| {
            if let Ok(summary) = s.summary() {
                gauge.observe(summary.current_streak as u64, &[]);
            }
        })
        .build();

    let s = store.clone();
    let _ = meter
        .u64_observable_gauge("covenant.cdlc.longest_streak")
        .with_description("Longest consecutive-day activity streak ever")
        .with_callback(move |gauge| {
            if let Ok(summary) = s.summary() {
                gauge.observe(summary.longest_streak as u64, &[]);
            }
        })
        .build();

    let s = store.clone();
    let _ = meter
        .u64_observable_gauge("covenant.cdlc.total_specs")
        .with_description("Total spec/note files tracked")
        .with_callback(move |gauge| {
            if let Ok(summary) = s.summary() {
                gauge.observe(summary.total_specs as u64, &[]);
            }
        })
        .build();

    // Per-repo breakdown — each repo emits its own labeled data point.
    let s = store.clone();
    let _ = meter
        .u64_observable_gauge("covenant.cdlc.repo.prompts")
        .with_description("Prompts by repository")
        .with_callback(move |gauge| {
            let filter = crate::ScoreFilter::default();
            if let Ok(repos) = s.breakdown_repos(&filter) {
                for r in repos {
                    gauge.observe(r.prompts as u64, &[KeyValue::new("repo", r.repo.clone())]);
                }
            }
        })
        .build();

    let s = store.clone();
    let _ = meter
        .u64_observable_gauge("covenant.cdlc.repo.commits")
        .with_description("Commits by repository")
        .with_callback(move |gauge| {
            let filter = crate::ScoreFilter::default();
            if let Ok(repos) = s.breakdown_repos(&filter) {
                for r in repos {
                    gauge.observe(r.commits as u64, &[KeyValue::new("repo", r.repo.clone())]);
                }
            }
        })
        .build();

    // Per-agent breakdown.
    let s = store.clone();
    let _ = meter
        .u64_observable_gauge("covenant.cdlc.agent.prompts")
        .with_description("Prompts by executor agent")
        .with_callback(move |gauge| {
            let filter = crate::ScoreFilter::default();
            if let Ok(agents) = s.breakdown_agents(&filter) {
                for a in agents {
                    gauge.observe(a.prompts as u64, &[KeyValue::new("agent", a.agent.clone())]);
                }
            }
        })
        .build();

    // Per-model token usage.
    let s = store.clone();
    let _ = meter
        .u64_observable_gauge("covenant.cdlc.model.input_tokens")
        .with_description("Input tokens by model")
        .with_callback(move |gauge| {
            let filter = crate::ScoreFilter::default();
            for source in [crate::ModelSource::Internal, crate::ModelSource::External] {
                if let Ok(models) = s.breakdown_models(&filter, source) {
                    for m in models {
                        let attrs = [
                            KeyValue::new("provider", m.provider.clone()),
                            KeyValue::new("model", m.model.clone()),
                        ];
                        gauge.observe(m.input_tokens, &attrs);
                    }
                }
            }
        })
        .build();

    let s = store.clone();
    let _ = meter
        .u64_observable_gauge("covenant.cdlc.model.output_tokens")
        .with_description("Output tokens by model")
        .with_callback(move |gauge| {
            let filter = crate::ScoreFilter::default();
            for source in [crate::ModelSource::Internal, crate::ModelSource::External] {
                if let Ok(models) = s.breakdown_models(&filter, source) {
                    for m in models {
                        let attrs = [
                            KeyValue::new("provider", m.provider.clone()),
                            KeyValue::new("model", m.model.clone()),
                        ];
                        gauge.observe(m.output_tokens, &attrs);
                    }
                }
            }
        })
        .build();

    let s = store;
    let _ = meter
        .u64_observable_gauge("covenant.cdlc.model.cache_read_tokens")
        .with_description("Cache-read tokens by model")
        .with_callback(move |gauge| {
            let filter = crate::ScoreFilter::default();
            for source in [crate::ModelSource::Internal, crate::ModelSource::External] {
                if let Ok(models) = s.breakdown_models(&filter, source) {
                    for m in models {
                        let attrs = [
                            KeyValue::new("provider", m.provider.clone()),
                            KeyValue::new("model", m.model.clone()),
                        ];
                        gauge.observe(m.cache_read, &attrs);
                    }
                }
            }
        })
        .build();
}

/// One-shot: initialize the OTLP provider, register all CDLC metrics, and
/// return the provider handle. The caller must keep it alive (typically by
/// storing it on the app state or `mem::forget`-ing it).
///
/// Returns `None` when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset — meaning the
/// user hasn't opted in to telemetry export.
pub fn start(store: Arc<ScoreStore>) -> Option<SdkMeterProvider> {
    if std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT").is_err() {
        tracing::debug!(target: "score::otel", "OTEL_EXPORTER_OTLP_ENDPOINT not set, skipping OTEL export");
        return None;
    }

    match init_meter_provider() {
        Ok(provider) => {
            let meter = provider.meter("covenant.cdlc");
            register_metrics(&meter, store);
            tracing::info!(target: "score::otel", "OTEL CDLC metrics exporter started");
            Some(provider)
        }
        Err(e) => {
            tracing::warn!(target: "score::otel", error = %e, "Failed to initialize OTEL meter provider");
            None
        }
    }
}
