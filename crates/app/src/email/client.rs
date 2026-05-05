use async_trait::async_trait;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmailMessage {
    pub from: String,
    pub to: String,
    pub subject: String,
    pub body: String,
}

#[derive(Debug, thiserror::Error)]
pub enum EmailError {
    #[error("missing config")]
    MissingConfig,
    #[error("sendgrid http {0}")]
    Http(u16),
    #[error("network: {0}")]
    Network(String),
    #[error("serialize: {0}")]
    Serialize(String),
}

#[async_trait]
pub trait SendGridClient: Send + Sync {
    async fn send(&self, msg: EmailMessage) -> Result<(), EmailError>;
}

#[derive(Default, Clone)]
pub struct RecordingSendGridClient {
    pub sent: Arc<Mutex<Vec<EmailMessage>>>,
}

#[async_trait]
impl SendGridClient for RecordingSendGridClient {
    async fn send(&self, msg: EmailMessage) -> Result<(), EmailError> {
        self.sent.lock().unwrap().push(msg);
        Ok(())
    }
}

impl RecordingSendGridClient {
    pub fn snapshot(&self) -> Vec<EmailMessage> {
        self.sent.lock().unwrap().clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn recording_client_captures_message() {
        let c = RecordingSendGridClient::default();
        c.send(EmailMessage {
            from: "a@b".into(),
            to: "c@d".into(),
            subject: "s".into(),
            body: "b".into(),
        })
        .await
        .unwrap();
        let snap = c.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].subject, "s");
    }
}
