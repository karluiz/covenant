use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Default)]
pub struct OutboundState {
    pub map: Mutex<HashMap<i64, String>>, // message_id -> escalation_id
}
