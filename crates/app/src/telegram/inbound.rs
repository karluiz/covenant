use std::sync::atomic::Ordering;
use std::sync::Arc;
use tokio::sync::mpsc::UnboundedSender;
use tokio::task::JoinHandle;

use super::client::TelegramClient;
use super::outbound::{OutboundState, STATUS_ERROR, STATUS_OK};

#[derive(Debug)]
pub enum InboundEvent {
    Resolved {
        escalation_id: String,
        resolution: ResolutionFromTelegram,
    },
    UnknownReply {
        chat_id: i64,
        message_id: i64,
    },
}

#[derive(Debug)]
pub enum ResolutionFromTelegram {
    Approved,
    Rejected,
    Snoozed,
    FreeText(String),
}

pub struct InboundConfig {
    pub token: String,
    pub allowed_chat_id: i64,
}

pub fn spawn(
    client: Arc<dyn TelegramClient>,
    state: Arc<OutboundState>,
    cfg: InboundConfig,
    tx: UnboundedSender<InboundEvent>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut offset: Option<i64> = None;
        loop {
            let updates = match client.get_updates(&cfg.token, offset, 30).await {
                Ok(u) => {
                    state.status.store(STATUS_OK, Ordering::Relaxed);
                    u
                }
                Err(e) => {
                    state.status.store(STATUS_ERROR, Ordering::Relaxed);
                    tracing::warn!(error=%e, "telegram getUpdates failed; sleeping 60s");
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    continue;
                }
            };
            for u in updates {
                offset = Some(u.update_id + 1);
                if let Some(cb) = u.callback_query {
                    if cb.from.id != cfg.allowed_chat_id {
                        continue;
                    }
                    let _ = client.answer_callback_query(&cfg.token, &cb.id).await;
                    let Some(data) = cb.data else {
                        continue;
                    };
                    if let Some(cb) = parse_callback(&data) {
                        let res = match cb.action_kind {
                            ActionKind::PushPR | ActionKind::Run => {
                                ResolutionFromTelegram::Approved
                            }
                            ActionKind::Reply => ResolutionFromTelegram::Rejected,
                            ActionKind::Snooze => ResolutionFromTelegram::Snoozed,
                            ActionKind::Custom => continue,
                        };
                        let _ = tx.send(InboundEvent::Resolved {
                            escalation_id: cb.escalation_id,
                            resolution: res,
                        });
                    } else if let Some((eid, action)) = parse_callback_legacy(&data) {
                        // Backwards-compat: pre-typed-callback messages still in flight.
                        let res = match action.as_str() {
                            "Approve" => ResolutionFromTelegram::Approved,
                            "Reject" => ResolutionFromTelegram::Rejected,
                            "Snooze10m" => ResolutionFromTelegram::Snoozed,
                            _ => continue,
                        };
                        let _ = tx.send(InboundEvent::Resolved {
                            escalation_id: eid,
                            resolution: res,
                        });
                    }
                } else if let Some(msg) = u.message {
                    if msg.chat.id != cfg.allowed_chat_id {
                        continue;
                    }
                    let Some(text) = msg.text else {
                        continue;
                    };
                    if let Some(reply) = msg.reply_to_message {
                        let map = state.map.lock().unwrap();
                        if let Some(eid) = map.get(&reply.message_id).cloned() {
                            drop(map);
                            let _ = tx.send(InboundEvent::Resolved {
                                escalation_id: eid,
                                resolution: ResolutionFromTelegram::FreeText(text),
                            });
                        } else {
                            drop(map);
                            let _ = tx.send(InboundEvent::UnknownReply {
                                chat_id: msg.chat.id,
                                message_id: reply.message_id,
                            });
                        }
                    } else {
                        let _ = tx.send(InboundEvent::UnknownReply {
                            chat_id: msg.chat.id,
                            message_id: msg.message_id,
                        });
                    }
                }
            }
        }
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionKind {
    PushPR,
    Run,
    Reply,
    Snooze,
    Custom,
}

pub struct Callback {
    pub escalation_id: String,
    pub action_kind: ActionKind,
}

pub fn parse_callback(data: &str) -> Option<Callback> {
    let mut parts = data.splitn(3, ':');
    if parts.next()? != "esc" {
        return None;
    }
    let escalation_id = parts.next()?.to_string();
    let kind = match parts.next()? {
        "push_pr" => ActionKind::PushPR,
        "run" => ActionKind::Run,
        "reply" => ActionKind::Reply,
        "snooze" => ActionKind::Snooze,
        "custom" => ActionKind::Custom,
        _ => return None,
    };
    Some(Callback {
        escalation_id,
        action_kind: kind,
    })
}

pub fn render_confirmation(operator_name: &str, kind: ActionKind, detail: Option<&str>) -> String {
    let verb = match kind {
        ActionKind::PushPR => "pushed and opened",
        ActionKind::Run => "ran",
        ActionKind::Reply => "rejected",
        ActionKind::Snooze => "snoozed",
        ActionKind::Custom => "acted on",
    };
    match detail {
        Some(d) => format!("✓ {} {} {}", operator_name, verb, d),
        None => format!("✓ {} {}", operator_name, verb),
    }
}

fn parse_callback_legacy(s: &str) -> Option<(String, String)> {
    let mut parts = s.splitn(3, ':');
    let prefix = parts.next()?;
    if prefix != "esc" {
        return None;
    }
    let id = parts.next()?.to_string();
    let action = parts.next()?.to_string();
    Some((id, action))
}

#[cfg(test)]
mod confirmation_tests {
    use super::*;

    #[test]
    fn parses_typed_callback_data() {
        let cb = parse_callback("esc:01KX:push_pr").unwrap();
        assert_eq!(cb.escalation_id, "01KX");
        assert!(matches!(cb.action_kind, ActionKind::PushPR));
    }

    #[test]
    fn confirmation_names_operator() {
        let s = render_confirmation("Maya", ActionKind::PushPR, Some("PR #42"));
        assert!(s.contains("Maya"));
        assert!(s.to_lowercase().contains("pushed"));
        assert!(s.contains("PR #42"));
    }
}
