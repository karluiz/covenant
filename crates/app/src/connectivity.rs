//! Internet connectivity awareness for AOM.
//!
//! When the OS reports we're offline (frontend `online`/`offline`
//! events forwarded via `set_connectivity`), the operator tick must
//! short-circuit: there is no point burning rate-limit budget on
//! API calls that will fail with DNS errors. We resume automatically
//! when connectivity is restored.
//!
//! This module is intentionally minimal. v0 trusts the browser's
//! `navigator.onLine` / `online`+`offline` events as the single
//! source of truth. A backend heartbeat (HEAD to api.anthropic.com
//! every 30s with a 5s timeout) is a future enhancement; left as a
//! TODO so we don't take a new `reqwest`/transitive dep for it now.

use std::sync::Arc;
use std::time::Instant;

use tokio::sync::RwLock;

#[derive(Debug, Clone, Copy)]
pub enum Connectivity {
    Online,
    Offline { since: Instant },
}

impl Default for Connectivity {
    fn default() -> Self {
        Connectivity::Online
    }
}

impl Connectivity {
    pub fn is_offline(&self) -> bool {
        matches!(self, Connectivity::Offline { .. })
    }
}

/// Shared handle. RwLock for the same reason as AomHandle: the
/// operator tick reads it on every poll (cheap), the IPC command
/// writes rarely (only on actual transitions).
pub type ConnectivityHandle = Arc<RwLock<Connectivity>>;

pub fn new_handle() -> ConnectivityHandle {
    Arc::new(RwLock::new(Connectivity::default()))
}

/// Pure helper used by `operator::run_tick` and by the unit test.
/// Centralizing the predicate keeps the gate easy to verify without
/// constructing the whole `Inner` fixture.
pub fn should_skip_for_offline(c: &Connectivity) -> bool {
    c.is_offline()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn online_does_not_skip() {
        assert!(!should_skip_for_offline(&Connectivity::Online));
    }

    #[test]
    fn offline_skips_run_tick() {
        let c = Connectivity::Offline {
            since: Instant::now(),
        };
        assert!(should_skip_for_offline(&c));
        assert!(c.is_offline());
    }

    #[test]
    fn default_is_online() {
        assert!(!Connectivity::default().is_offline());
    }
}
