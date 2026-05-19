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
                    if let Some((eid, action)) = parse_callback(&data) {
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

fn parse_callback(s: &str) -> Option<(String, String)> {
    let mut parts = s.splitn(3, ':');
    let prefix = parts.next()?;
    if prefix != "esc" {
        return None;
    }
    let id = parts.next()?.to_string();
    let action = parts.next()?.to_string();
    Some((id, action))
}
