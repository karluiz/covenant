use async_trait::async_trait;
use std::sync::{Arc, Mutex};

const SENDGRID_BASE_URL: &str = "https://api.sendgrid.com";
const SENDGRID_PATH: &str = "/v3/mail/send";

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

pub struct HttpSendGridClient {
    api_key: String,
    base_url: String,
    http: reqwest::Client,
}

impl HttpSendGridClient {
    pub fn new(api_key: String) -> Self {
        Self::with_base_url(api_key, SENDGRID_BASE_URL.to_string())
    }

    pub fn with_base_url(api_key: String, base_url: String) -> Self {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("reqwest client");
        Self {
            api_key,
            base_url,
            http,
        }
    }

    pub fn serialize_body(msg: &EmailMessage) -> Result<String, EmailError> {
        let v = serde_json::json!({
            "personalizations": [{
                "to": [{ "email": msg.to }]
            }],
            "from": { "email": msg.from },
            "subject": msg.subject,
            "content": [{
                "type": "text/plain",
                "value": msg.body
            }]
        });
        serde_json::to_string(&v).map_err(|e| EmailError::Serialize(e.to_string()))
    }
}

#[async_trait]
impl SendGridClient for HttpSendGridClient {
    async fn send(&self, msg: EmailMessage) -> Result<(), EmailError> {
        let body = Self::serialize_body(&msg)?;
        let url = format!("{}{}", self.base_url, SENDGRID_PATH);
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.api_key)
            .header("content-type", "application/json")
            .body(body)
            .send()
            .await
            .map_err(|e| EmailError::Network(e.to_string()))?;
        let status = resp.status();
        if status.is_success() {
            Ok(())
        } else {
            Err(EmailError::Http(status.as_u16()))
        }
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

    #[test]
    fn http_client_builds_v3_mail_send_body() {
        let body = HttpSendGridClient::serialize_body(&EmailMessage {
            from: "from@example.com".into(),
            to: "to@example.com".into(),
            subject: "hello".into(),
            body: "world".into(),
        })
        .unwrap();
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["from"]["email"], "from@example.com");
        assert_eq!(v["personalizations"][0]["to"][0]["email"], "to@example.com");
        assert_eq!(v["subject"], "hello");
        assert_eq!(v["content"][0]["type"], "text/plain");
        assert_eq!(v["content"][0]["value"], "world");
    }

    #[tokio::test]
    async fn http_client_posts_to_sendgrid() {
        use wiremock::matchers::{header, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v3/mail/send"))
            .and(header("authorization", "Bearer SG.unit"))
            .respond_with(ResponseTemplate::new(202))
            .mount(&server)
            .await;

        let client = HttpSendGridClient::with_base_url("SG.unit".into(), server.uri());
        client
            .send(EmailMessage {
                from: "f@x".into(),
                to: "t@x".into(),
                subject: "s".into(),
                body: "b".into(),
            })
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn http_client_maps_401_to_http_err() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v3/mail/send"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;

        let client = HttpSendGridClient::with_base_url("bad".into(), server.uri());
        let err = client
            .send(EmailMessage {
                from: "f@x".into(),
                to: "t@x".into(),
                subject: "s".into(),
                body: "b".into(),
            })
            .await
            .unwrap_err();
        assert!(matches!(err, EmailError::Http(401)));
    }
}

pub async fn check_key_via(base_url: &str, api_key: &str) -> Result<bool, EmailError> {
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| EmailError::Network(e.to_string()))?;
    let url = format!("{}/v3/scopes", base_url);
    let resp = http
        .get(&url)
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|e| EmailError::Network(e.to_string()))?;
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Ok(false);
    }
    if status.is_success() {
        return Ok(true);
    }
    Err(EmailError::Http(status.as_u16()))
}

#[cfg(test)]
mod scope_tests {
    use super::*;

    #[tokio::test]
    async fn key_check_true_on_200() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let s = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v3/scopes"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&s)
            .await;
        assert_eq!(check_key_via(&s.uri(), "k").await.unwrap(), true);
    }

    #[tokio::test]
    async fn key_check_false_on_401() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let s = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v3/scopes"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&s)
            .await;
        assert_eq!(check_key_via(&s.uri(), "k").await.unwrap(), false);
    }
}
