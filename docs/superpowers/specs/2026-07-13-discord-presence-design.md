# Discord Rich Presence — design

Show Covenant activity on the user's Discord profile, like VS Code's
"Discord Presence" plugin. Approved 2026-07-13.

## What it shows

- `details`: `In <workspace>` (falls back to `In Covenant`)
- `state`: `N sessions` + ` · operator running` when any pane has a live operator
- Elapsed timer from app launch
- Large image: `covenant` asset (uploaded to the Discord application)

**Privacy boundary:** workspace name + counts only. Never commands, cwds,
paths, tab titles, or output.

## Architecture

Frontend composes, Rust publishes.

- **Rust** `crates/app/src/discord_presence.rs` — `discord-rich-presence`
  crate over Discord's local IPC socket (no bot, no token). Two commands:
  `discord_presence_set { details, state, start_unix_secs }` and
  `discord_presence_clear`. Lazy connect on first set; on failure the
  client is dropped and the next set reconnects. No reconnect loop.
- **Frontend** `ui/src/presence.ts` — 15-second diff-checked poll over
  `TabManager.presenceSnapshot()` (workspace, tab count, operator flag).
  15s matches Discord's own activity rate limit; idle ticks are free.
  Toggle off → immediate `clear`.
- **Settings** — `discord_presence_enabled: bool`, default **false**.
  Checkbox under Settings → Notifications → Discord. Applied live via
  the panel's `onSaved` hook.

## One-time prerequisite (user)

Register an application named "Covenant" at discord.com/developers,
paste its Application ID into `DISCORD_APP_ID` in
`crates/app/src/discord_presence.rs`, upload the logo as asset
`covenant`. Until then the constant is `"0"` and every set is a no-op Err.

## Testing

- `ui/src/presence.test.ts` — unit tests on `composePresence`.
- Manual: Discord desktop running, toggle on, profile shows activity.

## Skipped (add if ever wanted)

Per-workspace opt-out, idle detection, custom status templates,
buttons/links on the activity.
