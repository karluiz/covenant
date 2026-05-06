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
