pub mod client;
pub mod inbound;
pub mod outbound;
pub mod status;
pub mod types;

pub use inbound::{InboundEvent, ResolutionFromTelegram};

use std::sync::Arc;
use std::time::Instant;
use tokio::sync::Mutex as AsyncMutex;

use crate::operator_registry::OperatorRegistry;
use crate::settings::Settings;
use client::TelegramClient;

pub struct TelegramNotifier {
    pub(crate) client: Arc<dyn TelegramClient>,
    pub(crate) settings: Arc<AsyncMutex<Settings>>,
    pub(crate) state: Arc<outbound::OutboundState>,
    pub(crate) registry: Arc<OperatorRegistry>,
}

impl TelegramNotifier {
    pub fn new(
        client: Arc<dyn TelegramClient>,
        settings: Arc<AsyncMutex<Settings>>,
        registry: Arc<OperatorRegistry>,
    ) -> Self {
        Self {
            client,
            settings,
            state: Arc::new(outbound::OutboundState::default()),
            registry,
        }
    }
}

use crate::telegram::outbound::{format_message, keyboard_for, OutboundContext};
use crate::telegram::types::SendMessageReq;
use karl_session::{EscalationKind, OperatorAction, OperatorRef, ProjectRef};

pub enum MissionKind {
    Completed,
    Failed,
}

/// Typed inputs for [`TelegramNotifier::send_escalation`]. Replaces the
/// prior positional `&str`/`&[String]` parameter pile so the operator's
/// identity and the action set travel together.
pub struct SendEscalationArgs<'a> {
    pub operator: &'a OperatorRef,
    pub project: &'a ProjectRef,
    pub session_short: &'a str,
    pub kind: &'a EscalationKind,
    pub summary: &'a str,
    pub actions: &'a [OperatorAction],
    pub escalation_id: &'a str,
    pub session_id: &'a str,
    pub tab_id: Option<&'a str>,
}

#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TelegramStatus {
    Disabled,
    Ok,
    Error,
}

impl TelegramNotifier {
    pub async fn status(&self) -> TelegramStatus {
        let s = self.settings.lock().await;
        if !s.telegram.enabled || s.telegram.bot_token.is_empty() || s.telegram.chat_id.is_empty() {
            return TelegramStatus::Disabled;
        }
        drop(s);
        match self.state.status.load(std::sync::atomic::Ordering::Relaxed) {
            outbound::STATUS_ERROR => TelegramStatus::Error,
            // Settings are valid; default (no traffic yet) and STATUS_OK
            // both render as "Ok" so the user sees the configured state
            // immediately, not "disabled until first send".
            _ => TelegramStatus::Ok,
        }
    }
}

impl TelegramNotifier {
    pub async fn send_escalation(&self, args: &SendEscalationArgs<'_>) -> anyhow::Result<()> {
        let s = self.settings.lock().await;
        if !s.telegram.enabled {
            return Ok(());
        }
        if let Some(tid) = args.tab_id {
            if let Some(ovr) = s.telegram.per_tab_overrides.get(tid) {
                if matches!(ovr.enabled, Some(false)) {
                    return Ok(());
                }
            }
        }
        if s.telegram.bot_token.is_empty()
            || s.telegram.chat_id.is_empty()
            || !s.telegram.events.escalations
        {
            return Ok(());
        }
        let token = s.telegram.bot_token.clone();
        let chat = s.telegram.chat_id.clone();
        drop(s);

        let ctx = OutboundContext {
            operator: args.operator,
            project: args.project,
            session_short: args.session_short,
            kind: args.kind,
            summary: args.summary,
            actions: args.actions,
        };

        // Coalesce: if an unresolved ping of the same (session, kind) exists
        // within the window, edit the live message in place instead of
        // posting a duplicate. Keep its keyboard so the user can still act.
        const COALESCE_WINDOW: std::time::Duration = std::time::Duration::from_secs(120);
        let key = (args.session_id.to_string(), outbound::kind_key(args.kind));
        // Compute the coalesce target under the lock, then release the guard
        // before awaiting (the MutexGuard isn't Send across `.await`).
        let coalesce: Option<(i64, u32)> = {
            let mut active = self.state.active.lock().unwrap();
            match active.get_mut(&key) {
                Some(p) if p.last_sent.elapsed() < COALESCE_WINDOW => {
                    p.count += 1;
                    p.last_sent = Instant::now();
                    Some((p.message_id, p.count))
                }
                _ => None,
            }
        };
        if let Some((mid, count)) = coalesce {
            let text = format!("{}\n\n(updated ×{count})", format_message(&ctx));
            self.client
                .edit_message_text(&token, &chat, mid, text, false)
                .await?;
            return Ok(());
        }

        let req = SendMessageReq {
            chat_id: chat,
            text: format_message(&ctx),
            reply_markup: Some(keyboard_for(&ctx, args.escalation_id)),
            parse_mode: None,
            reply_to_message_id: None,
        };
        let result = self.client.send_message(&token, req).await?;
        self.state
            .map
            .lock()
            .unwrap()
            .insert(result.message_id, args.escalation_id.to_string());
        self.state
            .session_map
            .lock()
            .unwrap()
            .insert(args.escalation_id.to_string(), args.session_id.to_string());
        self.state.active.lock().unwrap().insert(
            key,
            outbound::ActivePing {
                message_id: result.message_id,
                escalation_id: args.escalation_id.to_string(),
                last_sent: Instant::now(),
                count: 1,
            },
        );
        Ok(())
    }

    pub async fn send_mission_event(
        &self,
        mission_kind: MissionKind,
        tab: &str,
        body: &str,
        tab_id: Option<&str>,
    ) -> anyhow::Result<()> {
        let s = self.settings.lock().await;
        if !s.telegram.enabled {
            return Ok(());
        }
        if let Some(tid) = tab_id {
            if let Some(ovr) = s.telegram.per_tab_overrides.get(tid) {
                if matches!(ovr.enabled, Some(false)) {
                    return Ok(());
                }
            }
        }
        let allowed = match mission_kind {
            MissionKind::Completed => s.telegram.events.mission_completed,
            MissionKind::Failed => s.telegram.events.mission_failed,
        };
        if !allowed || s.telegram.bot_token.is_empty() || s.telegram.chat_id.is_empty() {
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
            reply_to_message_id: None,
        };
        self.client.send_message(&token, req).await?;
        Ok(())
    }

    pub async fn on_resolved(
        &self,
        escalation_id: &str,
        action_kind: crate::telegram::inbound::ActionKind,
    ) -> anyhow::Result<()> {
        // Remove any coalescer entry pointing at this escalation so the next
        // escalation of the same kind posts a fresh message instead of editing
        // a resolved one.
        self.state
            .active
            .lock()
            .unwrap()
            .retain(|_, p| p.escalation_id != escalation_id);

        let entry = {
            let mut map = self.state.map.lock().unwrap();
            let key = map
                .iter()
                .find(|(_, v)| v.as_str() == escalation_id)
                .map(|(k, _)| *k);
            key.and_then(|k| map.remove(&k).map(|_| k))
        };
        let Some(message_id) = entry else {
            return Ok(());
        };

        // Look up the operator that was driving the session at the time of
        // resolution so the reply names them. Falls back to the registry
        // default if the session pin isn't found (effective_for handles that).
        let operator_name = {
            let sid_opt: Option<karl_session::SessionId> = self
                .state
                .session_map
                .lock()
                .unwrap()
                .get(escalation_id)
                .and_then(|s| s.parse().ok());
            match sid_opt {
                Some(sid) => self.registry.effective_for(sid).name,
                None => self
                    .registry
                    .default()
                    .map(|op| op.name)
                    .unwrap_or_else(|| "Operator".to_string()),
            }
        };
        let reply =
            crate::telegram::inbound::render_confirmation(&operator_name, action_kind, None);

        let s = self.settings.lock().await;
        if s.telegram.bot_token.is_empty() || s.telegram.chat_id.is_empty() {
            return Ok(());
        }
        let token = s.telegram.bot_token.clone();
        let chat = s.telegram.chat_id.clone();
        drop(s);
        self.client
            .edit_message_text(&token, &chat, message_id, reply, true)
            .await?;
        Ok(())
    }
}

impl TelegramNotifier {
    pub async fn test_connection(&self) -> Result<(), String> {
        let s = self.settings.lock().await;
        if s.telegram.bot_token.is_empty() || s.telegram.chat_id.is_empty() {
            return Err("token y chat_id requeridos".into());
        }
        let token = s.telegram.bot_token.clone();
        let chat = s.telegram.chat_id.clone();
        drop(s);
        self.client
            .get_me(&token)
            .await
            .map_err(|e| format!("getMe: {e}"))?;
        self.client
            .send_message(
                &token,
                SendMessageReq {
                    chat_id: chat,
                    text: "✓ Covenant connected".into(),
                    reply_markup: None,
                    parse_mode: None,
                    reply_to_message_id: None,
                },
            )
            .await
            .map_err(|e| format!("sendMessage: {e}"))?;
        Ok(())
    }
}

impl TelegramNotifier {
    pub async fn spawn_inbound(
        &self,
        tx: tokio::sync::mpsc::UnboundedSender<InboundEvent>,
    ) -> tokio::task::JoinHandle<()> {
        let s = self.settings.lock().await;
        let token = s.telegram.bot_token.clone();
        let chat_str = s.telegram.chat_id.clone();
        drop(s);
        let allowed_chat_id: i64 = chat_str.parse().unwrap_or(0);
        if token.is_empty() || allowed_chat_id == 0 {
            return tokio::spawn(async {});
        }
        inbound::spawn(
            self.client.clone(),
            self.state.clone(),
            inbound::InboundConfig {
                token,
                allowed_chat_id,
            },
            tx,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{Settings, TelegramSettings};
    use crate::telegram::client::fake::FakeTelegramClient;
    use karl_session::VoiceToneSnapshot;

    fn op() -> OperatorRef {
        OperatorRef {
            id: "01H".into(),
            name: "Maya".into(),
            emoji: "🟣".into(),
            color: "#a855f7".into(),
            voice: VoiceToneSnapshot::Terse,
        }
    }

    fn pr() -> ProjectRef {
        ProjectRef {
            repo: "karlTerminal".into(),
            branch: "main".into(),
        }
    }

    fn args<'a>(
        operator: &'a OperatorRef,
        project: &'a ProjectRef,
        kind: &'a EscalationKind,
        actions: &'a [OperatorAction],
        escalation_id: &'a str,
        session_id: &'a str,
        summary: &'a str,
    ) -> SendEscalationArgs<'a> {
        SendEscalationArgs {
            operator,
            project,
            session_short: "ab12",
            kind,
            summary,
            actions,
            escalation_id,
            session_id,
            tab_id: None,
        }
    }

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
        let n = TelegramNotifier::new(
            fake.clone(),
            settings_with_telegram(true, "42"),
            crate::operator_registry::OperatorRegistry::for_tests("Maya"),
        );
        let operator = op();
        let project = pr();
        let kind = EscalationKind::Blocked;
        let actions = vec![OperatorAction::PushAndPR, OperatorAction::Reply];
        n.send_escalation(&args(
            &operator, &project, &kind, &actions, "esc-1", "sess-1", "summary",
        ))
        .await
        .unwrap();
        assert_eq!(fake.sent.lock().unwrap().len(), 1);
        let map = n.state.map.lock().unwrap();
        assert_eq!(map.get(&101).map(String::as_str), Some("esc-1"));
    }

    #[tokio::test]
    async fn duplicate_escalation_edits_instead_of_resending() {
        let fake = Arc::new(FakeTelegramClient::default());
        *fake.next_message_id.lock().unwrap() = 100;
        let n = TelegramNotifier::new(
            fake.clone(),
            settings_with_telegram(true, "42"),
            crate::operator_registry::OperatorRegistry::for_tests("Maya"),
        );
        let operator = op();
        let project = pr();
        let kind = EscalationKind::Loop;
        let actions = vec![OperatorAction::Reply];
        // First escalation: sends a new message + records the active ping.
        n.send_escalation(&args(
            &operator,
            &project,
            &kind,
            &actions,
            "e1",
            "sess-coalesce",
            "executor not accepting input",
        ))
        .await
        .unwrap();
        // Second identical (same session + kind) within the window: edits.
        n.send_escalation(&args(
            &operator,
            &project,
            &kind,
            &actions,
            "e2",
            "sess-coalesce",
            "executor not accepting input",
        ))
        .await
        .unwrap();
        assert_eq!(
            fake.sent.lock().unwrap().len(),
            1,
            "second identical escalation must not re-send"
        );
        assert!(
            !fake.edits.lock().unwrap().is_empty(),
            "second escalation must edit the live message"
        );
        // The edit kept the keyboard (remove_keyboard == false) and is an
        // update of the original message id.
        let edits = fake.edits.lock().unwrap();
        assert_eq!(edits[0].1, 101, "edited the original message id");
        assert!(!edits[0].3, "coalesce edit keeps the inline keyboard");
        assert!(
            edits[0].2.contains("updated ×2"),
            "coalesced text marks the repeat: {}",
            edits[0].2
        );
    }

    #[tokio::test]
    async fn send_escalation_skipped_when_disabled() {
        let fake = Arc::new(FakeTelegramClient::default());
        let n = TelegramNotifier::new(
            fake.clone(),
            settings_with_telegram(false, "42"),
            crate::operator_registry::OperatorRegistry::for_tests("Maya"),
        );
        let operator = op();
        let project = pr();
        let kind = EscalationKind::Blocked;
        let actions = vec![OperatorAction::PushAndPR];
        n.send_escalation(&args(
            &operator, &project, &kind, &actions, "id", "sess", "s",
        ))
        .await
        .unwrap();
        assert!(fake.sent.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn resolve_edits_original_message() {
        let fake = Arc::new(FakeTelegramClient::default());
        *fake.next_message_id.lock().unwrap() = 100;
        let n = TelegramNotifier::new(
            fake.clone(),
            settings_with_telegram(true, "42"),
            crate::operator_registry::OperatorRegistry::for_tests("Maya"),
        );
        let operator = op();
        let project = pr();
        let kind = EscalationKind::Blocked;
        let actions = vec![OperatorAction::PushAndPR];
        n.send_escalation(&args(
            &operator, &project, &kind, &actions, "esc-1", "sess", "s",
        ))
        .await
        .unwrap();
        n.on_resolved("esc-1", crate::telegram::inbound::ActionKind::PushPR)
            .await
            .unwrap();
        let edits = fake.edits.lock().unwrap();
        assert_eq!(edits.len(), 1);
        // The reply must name the operator and describe the action.
        let text = &edits[0].2;
        assert!(
            text.contains("Maya"),
            "expected operator name in reply: {text}"
        );
        assert!(
            text.to_lowercase().contains("pushed"),
            "expected action verb: {text}"
        );
        drop(edits);
        assert!(n.state.map.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn callback_query_publishes_resolution() {
        use crate::telegram::types::*;
        let fake = Arc::new(FakeTelegramClient::default());
        fake.queued_updates.lock().unwrap().push(vec![Update {
            update_id: 1,
            message: None,
            callback_query: Some(CallbackQuery {
                id: "cb1".into(),
                from: From { id: 42 },
                message: Some(IncomingMessage {
                    message_id: 99,
                    chat: Chat { id: 42 },
                    text: None,
                    reply_to_message: None,
                }),
                data: Some("esc:abc:Approve".into()),
            }),
        }]);
        let n = TelegramNotifier::new(
            fake.clone(),
            settings_with_telegram(true, "42"),
            crate::operator_registry::OperatorRegistry::for_tests("Maya"),
        );
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let handle = n.spawn_inbound(tx).await;
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        handle.abort();

        let evt = rx.try_recv().expect("expected resolution");
        match evt {
            InboundEvent::Resolved {
                escalation_id,
                resolution,
            } => {
                assert_eq!(escalation_id, "abc");
                assert!(matches!(resolution, ResolutionFromTelegram::Approved));
            }
            _ => panic!("wrong event"),
        }
        assert_eq!(fake.answers.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn message_from_other_chat_ignored() {
        use crate::telegram::types::*;
        let fake = Arc::new(FakeTelegramClient::default());
        fake.queued_updates.lock().unwrap().push(vec![Update {
            update_id: 1,
            callback_query: None,
            message: Some(IncomingMessage {
                message_id: 1,
                chat: Chat { id: 999 },
                text: Some("hi".into()),
                reply_to_message: None,
            }),
        }]);
        let n = TelegramNotifier::new(
            fake.clone(),
            settings_with_telegram(true, "42"),
            crate::operator_registry::OperatorRegistry::for_tests("Maya"),
        );
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let handle = n.spawn_inbound(tx).await;
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        handle.abort();
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn reply_message_publishes_freetext() {
        use crate::telegram::types::*;
        let fake = Arc::new(FakeTelegramClient::default());
        *fake.next_message_id.lock().unwrap() = 100;
        let n = TelegramNotifier::new(
            fake.clone(),
            settings_with_telegram(true, "42"),
            crate::operator_registry::OperatorRegistry::for_tests("Maya"),
        );
        let operator = op();
        let project = pr();
        let kind = EscalationKind::Blocked;
        let actions = vec![OperatorAction::PushAndPR];
        n.send_escalation(&args(
            &operator, &project, &kind, &actions, "esc-7", "sess", "s",
        ))
        .await
        .unwrap();
        fake.queued_updates.lock().unwrap().push(vec![Update {
            update_id: 1,
            callback_query: None,
            message: Some(IncomingMessage {
                message_id: 200,
                chat: Chat { id: 42 },
                text: Some("usa --force".into()),
                reply_to_message: Some(Box::new(IncomingMessage {
                    message_id: 101,
                    chat: Chat { id: 42 },
                    text: None,
                    reply_to_message: None,
                })),
            }),
        }]);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let handle = n.spawn_inbound(tx).await;
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        handle.abort();
        let evt = rx.recv().await.unwrap();
        match evt {
            InboundEvent::Resolved {
                escalation_id,
                resolution,
            } => {
                assert_eq!(escalation_id, "esc-7");
                assert!(
                    matches!(resolution, ResolutionFromTelegram::FreeText(t) if t == "usa --force")
                );
            }
            _ => panic!(),
        }
    }
}
