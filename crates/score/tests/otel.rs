#![cfg(feature = "otel")]

use karl_score::{otel, ScoreStore};
use opentelemetry::metrics::MeterProvider;
use opentelemetry_sdk::metrics::{InMemoryMetricExporter, SdkMeterProvider};
use std::sync::Arc;

/// Smoke test: register_metrics does not panic and the gauges produce values.
#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn register_metrics_smoke() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Arc::new(ScoreStore::open(tmp.path()).unwrap());

    // Seed a prompt so summary is non-trivial.
    karl_score::set_recorder(store.clone());
    karl_score::record_prompt("test-agent");

    let exporter = InMemoryMetricExporter::default();
    let provider = SdkMeterProvider::builder()
        .with_periodic_exporter(exporter.clone())
        .build();

    let meter = provider.meter("covenant.cdlc.test");
    otel::register_metrics(&meter, store);

    // Force a collection + export cycle.
    provider.force_flush().unwrap();

    let metrics = exporter.get_finished_metrics().unwrap();
    let scope = metrics
        .iter()
        .flat_map(|rm| rm.scope_metrics())
        .find(|sm| sm.scope().name() == "covenant.cdlc.test")
        .expect("should have our scope");

    let names: Vec<&str> = scope.metrics().map(|m| m.name().as_ref()).collect();
    assert!(
        names.contains(&"covenant.cdlc.total_prompts"),
        "expected total_prompts gauge, got {names:?}"
    );
    assert!(
        names.contains(&"covenant.cdlc.current_streak"),
        "expected current_streak gauge, got {names:?}"
    );
    assert!(
        names.contains(&"covenant.cdlc.total_tokens"),
        "expected total_tokens gauge, got {names:?}"
    );
    // repo/model/agent gauges only emit when data exists — verify at least
    // the agent breakdown shows (we seeded a prompt with agent "test-agent").
    assert!(
        names.contains(&"covenant.cdlc.agent.prompts"),
        "expected agent.prompts gauge, got {names:?}"
    );

    karl_score::clear_recorder_for_test();
}
