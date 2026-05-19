use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
pub struct SendMessageReq {
    pub chat_id: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_markup: Option<InlineKeyboardMarkup>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parse_mode: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct InlineKeyboardMarkup {
    pub inline_keyboard: Vec<Vec<InlineKeyboardButton>>,
}

#[derive(Debug, Serialize, Clone)]
pub struct InlineKeyboardButton {
    pub text: String,
    pub callback_data: String,
}

#[derive(Debug, Deserialize)]
pub struct SendMessageResp {
    pub ok: bool,
    pub result: Option<MessageResult>,
}

#[derive(Debug, Deserialize)]
pub struct MessageResult {
    pub message_id: i64,
}

#[derive(Debug, Deserialize)]
pub struct GetUpdatesResp {
    pub ok: bool,
    #[serde(default)]
    pub result: Vec<Update>,
}

#[derive(Debug, Deserialize)]
pub struct Update {
    pub update_id: i64,
    pub message: Option<IncomingMessage>,
    pub callback_query: Option<CallbackQuery>,
}

#[derive(Debug, Deserialize)]
pub struct IncomingMessage {
    pub message_id: i64,
    pub chat: Chat,
    pub text: Option<String>,
    pub reply_to_message: Option<Box<IncomingMessage>>,
}

#[derive(Debug, Deserialize)]
pub struct Chat {
    pub id: i64,
}

#[derive(Debug, Deserialize)]
pub struct CallbackQuery {
    pub id: String,
    pub from: From,
    pub message: Option<IncomingMessage>,
    pub data: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct From {
    pub id: i64,
}
