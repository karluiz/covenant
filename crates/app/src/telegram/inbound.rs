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
    /// A free-text message that is NOT an answer to an open escalation:
    /// a non-reply message, or a reply to an already-closed/unknown
    /// escalation. Routed to the cross-tab status responder.
    Question {
        chat_id: i64,
        message_id: i64,
        text: String,
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
                    // Resolve the reply target (if any) to an open escalation
                    // under the lock, then route purely.
                    let known = msg.reply_to_message.as_ref().and_then(|reply| {
                        state.map.lock().unwrap().get(&reply.message_id).cloned()
                    });
                    let _ = tx.send(route_message(msg.chat.id, msg.message_id, text, known));
                }
            }
        }
    })
}

/// Route an inbound text message to an [`InboundEvent`].
///
/// `known` is the escalation id this message replies to, resolved from the
/// outbound message map (`Some` only for a reply to a still-open escalation).
/// - reply → open escalation  ⇒ `Resolved { FreeText }` (the answer).
/// - reply → unknown/closed escalation, or a plain non-reply message
///   ⇒ `Question` (routed to the cross-tab status responder).
///
/// Pure so it can be unit-tested without the real long-poll loop.
pub fn route_message(
    chat_id: i64,
    message_id: i64,
    text: String,
    known: Option<String>,
) -> InboundEvent {
    match known {
        Some(escalation_id) => InboundEvent::Resolved {
            escalation_id,
            resolution: ResolutionFromTelegram::FreeText(text),
        },
        None => InboundEvent::Question {
            chat_id,
            message_id,
            text,
        },
    }
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

    #[test]
    fn plain_message_publishes_question() {
        // No reply target → not an answer to any escalation → Question.
        let evt = route_message(42, 7, "what's going on?".into(), None);
        match evt {
            InboundEvent::Question {
                chat_id,
                message_id,
                text,
            } => {
                assert_eq!(chat_id, 42);
                assert_eq!(message_id, 7);
                assert_eq!(text, "what's going on?");
            }
            _ => panic!("plain message must route to Question"),
        }
    }

    #[test]
    fn reply_to_open_escalation_resolves_freetext() {
        let evt = route_message(42, 8, "usa --force".into(), Some("esc-7".into()));
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
            _ => panic!("reply to open escalation must resolve as free text"),
        }
    }

    #[test]
    fn reply_to_closed_escalation_publishes_question() {
        // Reply target not in the open-escalation map → Question.
        let evt = route_message(42, 9, "ping".into(), None);
        assert!(matches!(evt, InboundEvent::Question { .. }));
    }
}
