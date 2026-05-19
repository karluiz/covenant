pub mod client;
pub mod digest;
pub mod templates;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex as AsyncMutex;

use crate::notify::{Severity, Trigger};
use crate::settings::Settings;
use client::{EmailMessage, SendGridClient};
use digest::{DigestBuffer, DigestEntry};

const EMAIL_THROTTLE_WINDOW: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmailOutcome {
    Sent,
    Buffered,
    SuppressedByConfig,
    SuppressedByThrottle,
    Failed,
}

#[derive(Default)]
struct EmailThrottle {
    last_fire: HashMap<Trigger, Instant>,
}

impl EmailThrottle {
    fn allow(&mut self, trigger: Trigger, now: Instant) -> bool {
        match self.last_fire.get(&trigger).copied() {
            Some(prev) if now.duration_since(prev) < EMAIL_THROTTLE_WINDOW => false,
            _ => {
                self.last_fire.insert(trigger, now);
                true
            }
        }
    }
}

pub struct EmailNotifier {
    client: Arc<dyn SendGridClient>,
    settings: Arc<AsyncMutex<Settings>>,
    throttle: std::sync::Mutex<EmailThrottle>,
    pub(crate) buffer: Arc<DigestBuffer>,
}

impl EmailNotifier {
    pub fn new(client: Arc<dyn SendGridClient>, settings: Arc<AsyncMutex<Settings>>) -> Self {
        Self {
            client,
            settings,
            throttle: std::sync::Mutex::new(EmailThrottle::default()),
            buffer: Arc::new(DigestBuffer::default()),
        }
    }

    pub async fn emit(
        &self,
        trigger: Trigger,
        subject: String,
        body: String,
        session_short: String,
    ) -> EmailOutcome {
        let _ = subject;
        let s = self.settings.lock().await;
        let cfg = s.notifications.clone();
        let key = s.sendgrid_api_key.clone();
        drop(s);

        let activated = cfg.email_enabled
            && key
                .as_deref()
                .map(|k| !k.trim().is_empty())
                .unwrap_or(false)
            && cfg.email_from.is_some()
            && cfg.email_to.is_some();
        if !activated {
            tracing::info!(channel = "email", trigger = ?trigger, outcome = "SuppressedByConfig", "email");
            return EmailOutcome::SuppressedByConfig;
        }

        match trigger.severity() {
            Severity::Info => {
                self.buffer.push(DigestEntry {
                    at: std::time::SystemTime::now(),
                    label: format!("{:?}", trigger),
                    summary: body,
                });
                tracing::info!(channel = "email", trigger = ?trigger, outcome = "Buffered", "email");
                EmailOutcome::Buffered
            }
            Severity::Escalation => {
                if !self.allow_now(trigger) {
                    tracing::info!(channel = "email", trigger = ?trigger, outcome = "SuppressedByThrottle", "email");
                    return EmailOutcome::SuppressedByThrottle;
                }
                let msg = EmailMessage {
                    from: cfg.email_from.unwrap(),
                    to: cfg.email_to.unwrap(),
                    subject: format!("[Covenant] {:?} — {}", trigger, session_short),
                    body,
                };
                match self.client.send(msg).await {
                    Ok(()) => {
                        tracing::info!(channel = "email", trigger = ?trigger, outcome = "Sent", "email");
                        EmailOutcome::Sent
                    }
                    Err(e) => {
                        tracing::warn!(channel = "email", trigger = ?trigger, error = %e, "email send failed");
                        EmailOutcome::Failed
                    }
                }
            }
        }
    }

    fn allow_now(&self, trigger: Trigger) -> bool {
        let mut t = match self.throttle.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        t.allow(trigger, Instant::now())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::Settings;
    use client::RecordingSendGridClient;

    fn settings_with(
        enabled: bool,
        key: Option<&str>,
        from: Option<&str>,
        to: Option<&str>,
    ) -> Arc<AsyncMutex<Settings>> {
        let mut s = Settings::default();
        s.sendgrid_api_key = key.map(|k| k.to_string());
        s.notifications.email_enabled = enabled;
        s.notifications.email_from = from.map(|x| x.to_string());
        s.notifications.email_to = to.map(|x| x.to_string());
        Arc::new(AsyncMutex::new(s))
    }

    #[tokio::test]
    async fn missing_config_suppresses() {
        let rec = Arc::new(RecordingSendGridClient::default());
        let client: Arc<dyn SendGridClient> = rec.clone();
        let n = EmailNotifier::new(client, settings_with(true, None, Some("a@b"), Some("c@d")));
        let out = n
            .emit(
                Trigger::OperatorEscalate,
                "s".into(),
                "b".into(),
                "01H".into(),
            )
            .await;
        assert_eq!(out, EmailOutcome::SuppressedByConfig);
        assert!(rec.snapshot().is_empty());
    }

    #[tokio::test]
    async fn escalation_sends_immediately() {
        let rec = Arc::new(RecordingSendGridClient::default());
        let client: Arc<dyn SendGridClient> = rec.clone();
        let n = EmailNotifier::new(
            client,
            settings_with(true, Some("SG"), Some("a@b"), Some("c@d")),
        );
        let out = n
            .emit(
                Trigger::OperatorEscalate,
                "s".into(),
                "blocked".into(),
                "01H".into(),
            )
            .await;
        assert_eq!(out, EmailOutcome::Sent);
        let snap = rec.snapshot();
        assert_eq!(snap.len(), 1);
        assert!(snap[0].subject.contains("01H"));
    }

    #[tokio::test]
    async fn info_is_buffered_not_sent() {
        let rec = Arc::new(RecordingSendGridClient::default());
        let client: Arc<dyn SendGridClient> = rec.clone();
        let n = EmailNotifier::new(
            client,
            settings_with(true, Some("SG"), Some("a@b"), Some("c@d")),
        );
        let out = n
            .emit(
                Trigger::AomComplete,
                "s".into(),
                "done".into(),
                "01H".into(),
            )
            .await;
        assert_eq!(out, EmailOutcome::Buffered);
        assert!(rec.snapshot().is_empty());
        assert_eq!(n.buffer.len(), 1);
    }

    #[tokio::test]
    async fn escalation_is_throttled_within_60s() {
        let rec = Arc::new(RecordingSendGridClient::default());
        let client: Arc<dyn SendGridClient> = rec.clone();
        let n = EmailNotifier::new(
            client,
            settings_with(true, Some("SG"), Some("a@b"), Some("c@d")),
        );
        let _ = n
            .emit(
                Trigger::OperatorEscalate,
                "s".into(),
                "x".into(),
                "01H".into(),
            )
            .await;
        let out = n
            .emit(
                Trigger::OperatorEscalate,
                "s".into(),
                "y".into(),
                "01H".into(),
            )
            .await;
        assert_eq!(out, EmailOutcome::SuppressedByThrottle);
        assert_eq!(rec.snapshot().len(), 1);
    }

    #[test]
    fn throttle_releases_after_window() {
        let mut t = EmailThrottle::default();
        let t0 = Instant::now();
        assert!(t.allow(Trigger::AomError, t0));
        assert!(!t.allow(Trigger::AomError, t0 + Duration::from_secs(30)));
        assert!(t.allow(Trigger::AomError, t0 + Duration::from_secs(61)));
    }
}
