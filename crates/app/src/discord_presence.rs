//! Discord Rich Presence via Discord's local IPC socket.
//!
//! No bot, no token, no network auth — the same mechanism the VS Code
//! "Discord Presence" plugin uses. The frontend composes the status line
//! (workspace + session count + operator state) and calls
//! `discord_presence_set`; this module only owns the socket.
//!
//! Connection is lazy: we connect on the first `set`, and if Discord
//! isn't running the call fails silently and the next update retries.
//! No polling, no reconnect loop.

use discord_rich_presence::{
    activity::{Activity, Assets, Timestamps},
    DiscordIpc, DiscordIpcClient,
};
use std::sync::Mutex;
use tauri::State;

/// Discord application id for "Covenant". Register the app at
/// discord.com/developers (one-time, free), paste its Application ID
/// here, and upload the logo as an asset named `covenant`.
const DISCORD_APP_ID: &str = "0"; // TODO(karluiz): real Application ID

#[derive(Default)]
pub struct DiscordPresence {
    client: Mutex<Option<DiscordIpcClient>>,
}

impl DiscordPresence {
    fn set(&self, details: &str, state: &str, start_unix_secs: i64) -> Result<(), String> {
        if DISCORD_APP_ID == "0" {
            return Err("discord app id not configured".into());
        }
        let mut guard = self.client.lock().map_err(|e| e.to_string())?;
        if guard.is_none() {
            let mut client = DiscordIpcClient::new(DISCORD_APP_ID);
            client.connect().map_err(|e| e.to_string())?;
            *guard = Some(client);
        }
        let activity = Activity::new()
            .details(details)
            .state(state)
            .timestamps(Timestamps::new().start(start_unix_secs))
            .assets(Assets::new().large_image("covenant").large_text("Covenant"));
        // ponytail: drop the client on any failure so the next set reconnects
        let client = guard.as_mut().expect("client set above");
        if let Err(e) = client.set_activity(activity) {
            *guard = None;
            return Err(e.to_string());
        }
        Ok(())
    }

    fn clear(&self) -> Result<(), String> {
        let mut guard = self.client.lock().map_err(|e| e.to_string())?;
        if let Some(client) = guard.as_mut() {
            let _ = client.clear_activity();
            let _ = client.close();
        }
        *guard = None;
        Ok(())
    }
}

/// Publish an activity. Fails quietly (Err string, no panic) when Discord
/// isn't running; the frontend treats that as "try again next tick".
#[tauri::command]
pub fn discord_presence_set(
    presence: State<'_, DiscordPresence>,
    details: String,
    state: String,
    start_unix_secs: i64,
) -> Result<(), String> {
    presence.set(&details, &state, start_unix_secs)
}

/// Clear the activity and drop the connection (toggle off / app quiescent).
#[tauri::command]
pub fn discord_presence_clear(presence: State<'_, DiscordPresence>) -> Result<(), String> {
    presence.clear()
}
