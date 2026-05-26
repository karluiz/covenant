//! Per-(operator, task) sentiment debouncer.
//!
//! Owns the "last sentiment we emitted" map and decides whether a new
//! candidate sentiment should be emitted. Two suppression rules:
//!   1. Change-only: same sentiment as last → suppress.
//!   2. Cooldown: non-hard candidates within `min_interval` of last → suppress.
//! Hard transitions (Blocked/Resumed/Cancelled/Started/Enojo) bypass #2.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use crate::operator_registry::OperatorId;
use crate::teammate::types::{Sentiment, TaskId};

#[derive(Clone, Copy, Debug)]
struct Last { sentiment: Sentiment, at: Instant }

#[derive(Default)]
pub struct SentimentResolver {
    inner: Mutex<HashMap<(OperatorId, TaskId), Last>>,
    min_interval: Duration,
}

impl SentimentResolver {
    pub fn new(min_interval: Duration) -> Self {
        Self { inner: Mutex::new(HashMap::new()), min_interval }
    }

    /// Returns true if the caller should emit a new TaskUpdate carrying
    /// `candidate`. Side effect: when true, updates the last-emitted state.
    pub fn decide(
        &self,
        op: OperatorId,
        task: TaskId,
        candidate: Sentiment,
        hard: bool,
        now: Instant,
    ) -> bool {
        let mut g = self.inner.lock();
        if let Some(last) = g.get(&(op, task)) {
            if last.sentiment == candidate { return false; }
            if !hard && now.duration_since(last.at) < self.min_interval {
                return false;
            }
        }
        g.insert((op, task), Last { sentiment: candidate, at: now });
        true
    }

    /// For the time-based tick: peek the current sentiment without mutating.
    pub fn current(&self, op: OperatorId, task: TaskId) -> Option<Sentiment> {
        self.inner.lock().get(&(op, task)).map(|l| l.sentiment)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ulid::Ulid;
    use crate::operator_registry::OperatorId;
    use crate::teammate::types::{Sentiment, TaskId};

    fn ids() -> (OperatorId, TaskId) { (OperatorId(Ulid::new()), TaskId::new()) }

    #[test]
    fn first_emit_always_succeeds() {
        let r = SentimentResolver::new(Duration::from_secs(60));
        let (op, task) = ids();
        assert!(r.decide(op, task, Sentiment::Expectacion, true, Instant::now()));
    }

    #[test]
    fn same_sentiment_suppressed_even_when_hard() {
        let r = SentimentResolver::new(Duration::from_secs(60));
        let (op, task) = ids();
        let t = Instant::now();
        assert!(r.decide(op, task, Sentiment::Duda, true, t));
        assert!(!r.decide(op, task, Sentiment::Duda, true, t + Duration::from_secs(120)));
    }

    #[test]
    fn cooldown_suppresses_non_hard_change() {
        let r = SentimentResolver::new(Duration::from_secs(60));
        let (op, task) = ids();
        let t = Instant::now();
        assert!(r.decide(op, task, Sentiment::Duda, true, t));
        assert!(!r.decide(op, task, Sentiment::Incomodidad, false, t + Duration::from_secs(30)));
        assert!( r.decide(op, task, Sentiment::Incomodidad, false, t + Duration::from_secs(61)));
    }

    #[test]
    fn hard_bypasses_cooldown() {
        let r = SentimentResolver::new(Duration::from_secs(60));
        let (op, task) = ids();
        let t = Instant::now();
        assert!(r.decide(op, task, Sentiment::Duda, true, t));
        assert!(r.decide(op, task, Sentiment::Feliz, true, t + Duration::from_secs(5)));
    }

    #[test]
    fn current_reflects_last_emit() {
        let r = SentimentResolver::new(Duration::from_secs(60));
        let (op, task) = ids();
        assert_eq!(r.current(op, task), None);
        r.decide(op, task, Sentiment::Enojo, true, Instant::now());
        assert_eq!(r.current(op, task), Some(Sentiment::Enojo));
    }
}
