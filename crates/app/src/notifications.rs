//! Fan-out dispatcher: fires both the OS notification and the email
//! channel in parallel for a single logical event.

use karl_session::SessionId;

use crate::email::{EmailNotifier, EmailOutcome};
use crate::notify::{Notifier, Trigger};

pub struct DispatchCtx {
    pub trigger: Trigger,
    pub title: String,
    pub body: String,
    pub session_id: Option<SessionId>,
}

pub struct DispatchResult {
    pub email: EmailOutcome,
}

pub async fn dispatch(
    notifier: &Notifier,
    email: &EmailNotifier,
    ctx: DispatchCtx,
) -> DispatchResult {
    let session_short = ctx
        .session_id
        .map(|s| s.to_string().chars().take(6).collect::<String>())
        .unwrap_or_else(|| "-".into());
    let DispatchCtx {
        trigger,
        title,
        body,
        session_id,
    } = ctx;
    let title2 = title.clone();
    let body2 = body.clone();
    let (_, email_out) = tokio::join!(
        notifier.emit(trigger, title, body, session_id),
        email.emit(trigger, title2, body2, session_short),
    );
    DispatchResult { email: email_out }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::email::client::{RecordingSendGridClient, SendGridClient};
    use crate::settings::Settings;
    use std::sync::Arc;
    use tokio::sync::Mutex as AsyncMutex;

    #[tokio::test]
    async fn email_path_runs_with_full_config() {
        let mut s = Settings::default();
        s.sendgrid_api_key = Some("SG".into());
        s.notifications.email_enabled = true;
        s.notifications.email_from = Some("a@b".into());
        s.notifications.email_to = Some("c@d".into());
        let settings = Arc::new(AsyncMutex::new(s));
        let rec = Arc::new(RecordingSendGridClient::default());
        let client: Arc<dyn SendGridClient> = rec.clone();
        let email = EmailNotifier::new(client, settings);
        let out = email
            .emit(
                Trigger::OperatorEscalate,
                "title".into(),
                "body".into(),
                "01HABC".into(),
            )
            .await;
        assert_eq!(out, EmailOutcome::Sent);
        assert_eq!(rec.snapshot().len(), 1);
    }
}
