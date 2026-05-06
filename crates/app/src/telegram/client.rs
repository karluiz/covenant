use async_trait::async_trait;

use super::types::*;

#[async_trait]
pub trait TelegramClient: Send + Sync {
    async fn send_message(&self, token: &str, req: SendMessageReq) -> anyhow::Result<MessageResult>;
    async fn edit_message_text(&self, token: &str, chat_id: &str, message_id: i64, text: String, remove_keyboard: bool) -> anyhow::Result<()>;
    async fn answer_callback_query(&self, token: &str, callback_id: &str) -> anyhow::Result<()>;
    async fn get_updates(&self, token: &str, offset: Option<i64>, timeout_secs: u64) -> anyhow::Result<Vec<Update>>;
    async fn get_me(&self, token: &str) -> anyhow::Result<()>;
}

pub struct ReqwestTelegramClient {
    http: reqwest::Client,
}

impl ReqwestTelegramClient {
    pub fn new() -> Self {
        Self { http: reqwest::Client::builder().build().expect("http client") }
    }
    fn url(token: &str, method: &str) -> String {
        format!("https://api.telegram.org/bot{token}/{method}")
    }
}
