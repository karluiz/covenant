pub mod client;
pub mod inbound;
pub mod outbound;
pub mod types;

use std::sync::Arc;
use tokio::sync::Mutex as AsyncMutex;

use crate::settings::Settings;
use client::TelegramClient;

pub struct TelegramNotifier {
    pub(crate) client: Arc<dyn TelegramClient>,
    pub(crate) settings: Arc<AsyncMutex<Settings>>,
    pub(crate) state: Arc<outbound::OutboundState>,
}

impl TelegramNotifier {
    pub fn new(client: Arc<dyn TelegramClient>, settings: Arc<AsyncMutex<Settings>>) -> Self {
        Self {
            client,
            settings,
            state: Arc::new(outbound::OutboundState::default()),
        }
    }
}

use crate::telegram::outbound::{format_escalation, keyboard_for};
use crate::telegram::types::SendMessageReq;

pub enum MissionKind { Completed, Failed }

impl TelegramNotifier {
    pub async fn send_escalation(
        &self,
        tab_name: &str,
        kind: &str,
        summary: &str,
        escalation_id: &str,
        actions: &[String],
    ) -> anyhow::Result<()> {
        let s = self.settings.lock().await;
        if !s.telegram.enabled
            || s.telegram.bot_token.is_empty()
            || s.telegram.chat_id.is_empty()
            || !s.telegram.events.escalations
        {
            return Ok(());
        }
        let token = s.telegram.bot_token.clone();
        let chat = s.telegram.chat_id.clone();
        drop(s);

        let req = SendMessageReq {
            chat_id: chat,
            text: format_escalation(tab_name, kind, summary),
            reply_markup: Some(keyboard_for(actions, escalation_id)),
            parse_mode: None,
        };
        let result = self.client.send_message(&token, req).await?;
        self.state.map.lock().unwrap().insert(result.message_id, escalation_id.to_string());
        Ok(())
    }

    pub async fn send_mission_event(&self, mission_kind: MissionKind, tab: &str, body: &str) -> anyhow::Result<()> {
        let s = self.settings.lock().await;
        let allowed = match mission_kind {
            MissionKind::Completed => s.telegram.events.mission_completed,
            MissionKind::Failed => s.telegram.events.mission_failed,
        };
        if !s.telegram.enabled
            || !allowed
            || s.telegram.bot_token.is_empty()
            || s.telegram.chat_id.is_empty()
        {
            return Ok(());
        }
        let token = s.telegram.bot_token.clone();
        let chat = s.telegram.chat_id.clone();
        drop(s);
        let prefix = match mission_kind {
            MissionKind::Completed => "✅ MISSION COMPLETED",
            MissionKind::Failed => "❌ MISSION FAILED",
        };
        let req = SendMessageReq {
            chat_id: chat,
            parse_mode: None,
            reply_markup: None,
            text: format!("[tab: {tab}] {prefix}\n{body}"),
        };
        self.client.send_message(&token, req).await?;
        Ok(())
    }

    pub async fn on_resolved(&self, escalation_id: &str, status: &str) -> anyhow::Result<()> {
        let entry = {
            let mut map = self.state.map.lock().unwrap();
            let key = map
                .iter()
                .find(|(_, v)| v.as_str() == escalation_id)
                .map(|(k, _)| *k);
            key.and_then(|k| map.remove(&k).map(|_| k))
        };
        let Some(message_id) = entry else { return Ok(()); };
        let s = self.settings.lock().await;
        if s.telegram.bot_token.is_empty() || s.telegram.chat_id.is_empty() {
            return Ok(());
        }
        let token = s.telegram.bot_token.clone();
        let chat = s.telegram.chat_id.clone();
        drop(s);
        self.client
            .edit_message_text(&token, &chat, message_id, format!("✓ Resolved: {status}"), true)
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{Settings, TelegramSettings};
    use crate::telegram::client::fake::FakeTelegramClient;

    fn settings_with_telegram(enabled: bool, chat: &str) -> Arc<AsyncMutex<Settings>> {
        let mut s = Settings::default();
        s.telegram = TelegramSettings {
            enabled,
            bot_token: "T".into(),
            chat_id: chat.into(),
            ..Default::default()
        };
        Arc::new(AsyncMutex::new(s))
    }

    #[tokio::test]
    async fn send_escalation_records_message_id() {
        let fake = Arc::new(FakeTelegramClient::default());
        *fake.next_message_id.lock().unwrap() = 100;
        let n = TelegramNotifier::new(fake.clone(), settings_with_telegram(true, "42"));
        n.send_escalation("tab1", "BLOCKED", "summary", "esc-1",
            &["Approve".into(), "Reject".into()]).await.unwrap();
        assert_eq!(fake.sent.lock().unwrap().len(), 1);
        let map = n.state.map.lock().unwrap();
        assert_eq!(map.get(&101).map(String::as_str), Some("esc-1"));
    }

    #[tokio::test]
    async fn send_escalation_skipped_when_disabled() {
        let fake = Arc::new(FakeTelegramClient::default());
        let n = TelegramNotifier::new(fake.clone(), settings_with_telegram(false, "42"));
        n.send_escalation("t", "K", "s", "id", &["Approve".into()]).await.unwrap();
        assert!(fake.sent.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn resolve_edits_original_message() {
        let fake = Arc::new(FakeTelegramClient::default());
        *fake.next_message_id.lock().unwrap() = 100;
        let n = TelegramNotifier::new(fake.clone(), settings_with_telegram(true, "42"));
        n.send_escalation("t", "K", "s", "esc-1", &["Approve".into()]).await.unwrap();
        n.on_resolved("esc-1", "Approved via terminal").await.unwrap();
        assert_eq!(fake.edits.lock().unwrap().len(), 1);
        assert!(n.state.map.lock().unwrap().is_empty());
    }
}
