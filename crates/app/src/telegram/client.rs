use async_trait::async_trait;

use super::types::*;

#[async_trait]
pub trait TelegramClient: Send + Sync {
    async fn send_message(&self, token: &str, req: SendMessageReq)
        -> anyhow::Result<MessageResult>;
    async fn edit_message_text(
        &self,
        token: &str,
        chat_id: &str,
        message_id: i64,
        text: String,
        remove_keyboard: bool,
    ) -> anyhow::Result<()>;
    async fn answer_callback_query(&self, token: &str, callback_id: &str) -> anyhow::Result<()>;
    async fn get_updates(
        &self,
        token: &str,
        offset: Option<i64>,
        timeout_secs: u64,
    ) -> anyhow::Result<Vec<Update>>;
    async fn get_me(&self, token: &str) -> anyhow::Result<()>;
}

pub struct ReqwestTelegramClient {
    http: reqwest::Client,
}

impl ReqwestTelegramClient {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::builder().build().expect("http client"),
        }
    }
    fn url(token: &str, method: &str) -> String {
        format!("https://api.telegram.org/bot{token}/{method}")
    }
}

#[async_trait]
impl TelegramClient for ReqwestTelegramClient {
    async fn send_message(
        &self,
        token: &str,
        req: SendMessageReq,
    ) -> anyhow::Result<MessageResult> {
        let resp: SendMessageResp = self
            .http
            .post(Self::url(token, "sendMessage"))
            .json(&req)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        resp.result
            .ok_or_else(|| anyhow::anyhow!("telegram sendMessage returned ok=false"))
    }

    async fn edit_message_text(
        &self,
        token: &str,
        chat_id: &str,
        message_id: i64,
        text: String,
        remove_keyboard: bool,
    ) -> anyhow::Result<()> {
        let mut body = serde_json::json!({
            "chat_id": chat_id,
            "message_id": message_id,
            "text": text,
        });
        if remove_keyboard {
            body["reply_markup"] = serde_json::json!({ "inline_keyboard": [] });
        }
        self.http
            .post(Self::url(token, "editMessageText"))
            .json(&body)
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    async fn answer_callback_query(&self, token: &str, callback_id: &str) -> anyhow::Result<()> {
        self.http
            .post(Self::url(token, "answerCallbackQuery"))
            .json(&serde_json::json!({ "callback_query_id": callback_id }))
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    async fn get_updates(
        &self,
        token: &str,
        offset: Option<i64>,
        timeout_secs: u64,
    ) -> anyhow::Result<Vec<Update>> {
        let mut body = serde_json::json!({ "timeout": timeout_secs });
        if let Some(o) = offset {
            body["offset"] = o.into();
        }
        let resp: GetUpdatesResp = self
            .http
            .post(Self::url(token, "getUpdates"))
            .json(&body)
            .timeout(std::time::Duration::from_secs(timeout_secs + 10))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        Ok(resp.result)
    }

    async fn get_me(&self, token: &str) -> anyhow::Result<()> {
        self.http
            .get(Self::url(token, "getMe"))
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }
}

#[cfg(test)]
pub mod fake {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    pub struct FakeTelegramClient {
        pub sent: Mutex<Vec<SendMessageReq>>,
        pub edits: Mutex<Vec<(String, i64, String, bool)>>,
        pub answers: Mutex<Vec<String>>,
        pub queued_updates: Mutex<Vec<Vec<Update>>>,
        pub next_message_id: Mutex<i64>,
    }

    #[async_trait]
    impl TelegramClient for FakeTelegramClient {
        async fn send_message(
            &self,
            _t: &str,
            req: SendMessageReq,
        ) -> anyhow::Result<MessageResult> {
            let mut id = self.next_message_id.lock().unwrap();
            *id += 1;
            let result_id = *id;
            self.sent.lock().unwrap().push(req);
            Ok(MessageResult {
                message_id: result_id,
            })
        }
        async fn edit_message_text(
            &self,
            _t: &str,
            chat: &str,
            mid: i64,
            text: String,
            rm: bool,
        ) -> anyhow::Result<()> {
            self.edits
                .lock()
                .unwrap()
                .push((chat.into(), mid, text, rm));
            Ok(())
        }
        async fn answer_callback_query(&self, _t: &str, cid: &str) -> anyhow::Result<()> {
            self.answers.lock().unwrap().push(cid.into());
            Ok(())
        }
        async fn get_updates(
            &self,
            _t: &str,
            _offset: Option<i64>,
            _timeout: u64,
        ) -> anyhow::Result<Vec<Update>> {
            let mut q = self.queued_updates.lock().unwrap();
            if q.is_empty() {
                Ok(vec![])
            } else {
                Ok(q.remove(0))
            }
        }
        async fn get_me(&self, _t: &str) -> anyhow::Result<()> {
            Ok(())
        }
    }
}
