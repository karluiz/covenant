# Telegram Escalation — Design Spec

**Date:** 2026-05-06
**Status:** Draft (pending implementation plan)

## Goal

Permitir que el Operator escale a Telegram de forma bidireccional: cuando una escalación se dispara (decisión bloqueada, comando en blocklist, presupuesto agotado, loop AOM, misión completada/fallida), el usuario recibe un mensaje en Telegram y puede resolverla desde ahí — botones inline para decisiones binarias, o texto libre como instrucción al LLM — sin tocar el terminal.

## Non-Goals

- Control remoto arbitrario (ejecutar comandos shell desde Telegram). Texto libre siempre se inyecta al LLM, nunca al PTY directo.
- Cola persistente / replay offline. Si la app no corre, las escalaciones se pierden (v1).
- Cifrado del bot token. Vive en `settings.json` en plano (FS perms only).
- Bot compartido / infra hosteada. Cada usuario crea su propio bot vía @BotFather.
- Multi-usuario sobre el mismo bot. Un solo `chat_id` whitelisted.

## Architecture

Nueva crate `crates/telegram`, paralela a `crates/agent`. Tres responsabilidades:

1. **Outbound.** Suscribe al event bus existente. Filtra por settings + per-tab overrides. Formatea y manda `sendMessage` con `inline_keyboard`. Mantiene mapa in-memory `telegram_message_id → escalation_id` para resolver replies.
2. **Inbound.** Task dedicada hace long-polling (`getUpdates?timeout=30`) contra `api.telegram.org/bot<token>`. `callback_query` → `EscalationResolved`. `message` con `reply_to_message` válido → `EscalationResolved` con `FreeText(text)`. Mensajes sin reply → respuesta de ayuda; nunca se inyectan.
3. **State.** Solo in-memory. No SQLite nuevo.

Reusa el patrón existente de `notify.rs` (M-OP6 OS notifications): toggle global en Settings + override por tab que hereda del global.

## Data Model

### Nuevos eventos en `crates/session/events.rs`

```rust
pub enum SessionEvent {
    // ...existentes...
    EscalationRequested {
        session: SessionId,
        escalation_id: EscalationId,    // Ulid
        kind: EscalationKind,
        summary: String,                // ≤ 500 chars, ANSI-stripped
        actions: Vec<EscalationAction>,
    },
    EscalationResolved {
        escalation_id: EscalationId,
        resolution: EscalationResolution,
        source: ResolutionSource,
    },
    MissionCompleted { session: SessionId, summary: String },
    MissionFailed    { session: SessionId, reason: String },
}

pub enum EscalationKind {
    Blocked,           // decisión bloqueada por threshold
    Blocklist,         // comando en blocklist hard
    BudgetExhausted,
    Loop,              // AOM detectó loop
}

pub enum EscalationAction { Approve, Reject, Snooze10m }

pub enum EscalationResolution {
    Approved,
    Rejected,
    Snoozed,
    FreeText(String),
}

pub enum ResolutionSource { Terminal, Telegram }
```

### Settings

```jsonc
{
  "telegram": {
    "enabled": false,
    "bot_token": "",
    "chat_id": "",
    "events": {
      "escalations": true,
      "mission_completed": true,
      "mission_failed": true
    },
    "per_tab_overrides": {
      "<tab_id>": { "enabled": false }
    }
  }
}
```

## Flujos

### Outbound: escalación → Telegram

1. Operator publica `EscalationRequested(id, tab, kind, summary, actions)`.
2. UI del terminal muestra modal/banner (camino actual, intacto).
3. `telegram::outbound` recibe del bus:
   - Filtra: `settings.enabled && events.<kind> && !per_tab.disabled`.
   - Formatea: `[tab: <name>] <KIND>\n<summary truncado a 500>`.
   - `POST sendMessage` con `inline_keyboard` de tres botones según `actions`. `callback_data = "esc:<escalation_id>:<action>"`.
   - Guarda `message_id → escalation_id` en mapa.
4. Cuando llega `EscalationResolved` (resuelto desde el terminal o Telegram):
   - `editMessageText` sobre el mensaje original con `"✓ Resolved (<source>): <resolution>"` y quita keyboard. Evita acción duplicada.

**Notificaciones puras (no escalaciones).** `MissionCompleted` y `MissionFailed` se envían por el mismo path pero **sin** `inline_keyboard` ni mapa `message_id → escalation_id`. Son fire-and-forget; no admiten respuesta.

**Truncación.** `summary` se corta a 500 chars con `…`. Telegram permite 4096 pero queremos legible en móvil.

**Rate limit.** Hereda `agent::dispatch()`. Además, semáforo simple para respetar 30 msg/s de Telegram.

**Errores de red.** Log + drop. No retry (consistente con offline=nada).

### Inbound: Telegram → Operator

Long-poll loop:

- `update.callback_query`:
  - Verifica `chat_id == settings.chat_id`. Si no, ignorado silencioso.
  - Parse `callback_data = "esc:<id>:<action>"`.
  - Publica `EscalationResolved(id, action, source=Telegram)`.
  - `answerCallbackQuery` + `editMessageText("✓ <action> via Telegram")`.

- `update.message`:
  - Verifica `chat_id`.
  - Si `reply_to_message` → busca su `message_id` en el mapa:
    - Encontrado → publica `EscalationResolved(id, FreeText(text), source=Telegram)`.
    - No encontrado → reply: "Esa escalación ya cerró".
  - Sin `reply_to_message` → reply: "Responde al mensaje de la tab a la que te refieres". Nunca se inyecta texto suelto.

### Seguridad

- **Whitelist estricta de `chat_id`.** Cualquier otro chat → ignorado, sin acuse.
- **No comandos shell.** Texto libre siempre es input al LLM (mismo path que un mensaje del terminal), nunca PTY directo. Preserva blocklist y policy de la tab.
- **Token en plano.** Settings file con permisos FS. Acepta el riesgo a cambio de simplicidad v1.

### Lifecycle

- Task de polling arranca en `app::setup` si `telegram.enabled && bot_token != ""`.
- Toggle en Settings → drop + respawn del task.
- Token inválido / chat_id incorrecto → log + statusbar muestra ámbar; task duerme 60s y reintenta.

## UI

### Settings → sección "Telegram"

- `[✓] Enabled`
- Bot token (input password) + `[?]` tooltip con instrucciones (`@BotFather`, `/newbot`, copiar token).
- Chat ID (input) + `[?]` tooltip (`@userinfobot` para obtenerlo).
- `[Test connection]` → `getMe` + `sendMessage("✓ Covenant connected")`. Resultado inline.
- `Notify on:` checkboxes para `escalations`, `mission_completed`, `mission_failed`.

### Statusbar

Icono Telegram pequeño cuando `enabled`:
- Verde: último poll OK.
- Ámbar: último poll falló.
- Gris: disabled.

Click → abre Settings en la sección Telegram.

### Tab context menu

"Telegram notifications: [Inherit ▾]" → `Inherit | On | Off`.

### Modal de escalación del terminal

Sin cambios. La integración Telegram es invisible para el flujo existente; el modal sigue siendo el camino primario.

## Testing

- Unit tests en `crates/telegram`:
  - Filtrado outbound (settings off, per-tab off, kind disabled).
  - Truncación de summary.
  - Parseo de `callback_data` (válido, malformado, ID inexistente).
  - Whitelist de `chat_id` (rechaza otros sin panic).
  - Mapa message_id → escalation_id (insert, lookup, drop on resolve).
- Integration test con servidor HTTP fake imitando `api.telegram.org`:
  - Round-trip outbound: evento → request bien formado.
  - Round-trip inbound: `getUpdates` response → `EscalationResolved` publicado.
- Manual test plan:
  - Setup real con bot propio. Escalar desde una tab AOM. Resolver con botón. Resolver con texto libre. Resolver desde el terminal y verificar que el mensaje en Telegram se edita.

## Open Questions

Ninguna pendiente para v1. Posibles extensiones futuras (no en este spec):

- Cola persistente offline (offline=Y).
- Token en Keychain (storage=A).
- Comandos slash `/status`, `/pause` (alcance C).
- Bot compartido con `/link` (alcance B).
- Filtros más granulares por tipo de evento por tab.
