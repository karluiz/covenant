# AOM Liveness & Offline Awareness

**Date:** 2026-05-05
**Branch:** `feat/aom-liveness`
**Spec link:** none yet — direct response to user feedback "AOM no se siente vivo, toma 5 min en decidir lo obvio"

## Problem

Captura del usuario: ejecutor en spinner ("Worked 38s"), usuario tipea `sí, sigue` en el prompt, AOM badge muestra `WAIT $0.006`. El operador no responde porque:

1. No hay short-circuit cuando el usuario interviene — sigue el ciclo `WAIT` de 5 fallos × rate-limit (10/min ≈ 6s entre intentos) + cooldown de loop (120s) = hasta 5 min de silencio.
2. Una sola llamada al modelo grande (Opus 4.7) por tick decisional → cara y lenta. No hay triage barato.
3. El badge muestra estado estático (`WAIT $0.006`) sin pulso visible → cualquier latencia se siente muerta.
4. Sin internet AOM falla silenciosamente; no hay estado `Offline`.

## Plan

### Task 1 — Yield on user input (highest leverage, smallest blast)

**Cambio:** cuando el usuario escribe en el PTY de un ejecutor activo, resetear inmediatamente el estado WAIT de esa sesión: limpiar `progress_sig_at_last_wait`, `idle_wait_count`, `loop_cooldown_until`. El operador no debe intentar "responder" un prompt al que el usuario ya respondió.

**Tocar:**
- `crates/app/src/operator.rs` — añadir `fn note_user_input(&self, session: SessionId)` que limpia los contadores WAIT/loop por-sesión.
- Wire-up: el handler de `write_to_session` (Tauri command) debe invocar `operator.note_user_input(...)` antes de pasar bytes al PTY, sólo si el ejecutor está siendo monitoreado.
- Test: simular WAIT count = 4, llamar `note_user_input`, verificar que el siguiente tick no escala y resetea idle.

**Done when:** typing en el PTY mientras AOM está en WAIT muestra el badge volviendo a "observing" en el siguiente poll (5s).

### Task 2 — Two-tier model (Haiku triage → Opus decide)

**Cambio:** antes de la llamada cara, correr un clasificador Haiku 4.5 con `max_tokens=64` que devuelve `{action: "act"|"wait"|"yield", confidence: 0..1}`. Sólo si `action=act && confidence>0.6` se llama al modelo grande. `wait` mantiene loop, `yield` baja el watcher temporalmente (5–10s de cooldown).

**Tocar:**
- `crates/agent/src/lib.rs` (o donde viva `ask_oneshot_with_usage`) — añadir helper `triage_oneshot` con prompt de sistema mínimo y schema JSON estricto.
- `crates/app/src/operator.rs` línea ~1493 (call site) — envolver con triage. Cachear system prompt corto.
- `crates/app/src/settings.rs` — `OperatorConfig.triage_model: String` (default `"claude-haiku-4-5-20251001"`). `triage_enabled: bool` (default true).
- `crates/app/src/cost.rs` — la tabla ya soporta Haiku, sólo verificar que la accumulación sume ambas llamadas a la sesión.

**Done when:** un ciclo decisional típico cuesta <$0.001 (triage) la mayoría de los ticks; sólo escala a Opus cuando vale la pena.

### Task 3 — Liveness en el badge

**Cambio:** badge muestra fase actual: `observing 2s` → `triaging…` → `deciding…` → `idle`. Sustituye `WAIT $0.045` estático.

**Tocar:**
- Backend: añadir variant `OperatorPhase { Observing, Triaging, Deciding, Yielded, Offline }` en operator state, exponer vía Tauri command `operator_status(session)` o evento push.
- `ui/src/aom/banner.ts` línea ~163 — render `phase + elapsed`. Costo se mueve a tooltip.
- `ui/src/tabs/manager.ts` línea ~2923 — animación sutil del zap mientras está en `Triaging|Deciding`.

**Done when:** el badge nunca queda estático >2s mientras AOM está activo.

### Task 4 — Offline detection

**Cambio:** nuevo estado global `AomConnectivity { Online, Offline { since: Instant } }`. Detector dual:
- Frontend: listener de `online`/`offline` (evento window) → manda comando `set_connectivity`.
- Backend: heartbeat ligero cada 30s a `https://api.anthropic.com/v1/messages` (HEAD o request de prueba mínima — opcional, podemos depender sólo del listener del browser inicialmente).

Cuando `Offline`, `run_tick` retorna early con `OperatorAction::Wait{rationale: "offline"}` y el banner muestra "AOM pausado — sin conexión" en color warn. Auto-resume al volver `Online`.

**Tocar:**
- `crates/app/src/operator.rs` — campo `connectivity` en estado, gate al inicio de `run_tick`.
- Tauri command `set_connectivity(online: bool)`.
- `ui/src/aom/banner.ts` — listener + dispatcher; render del estado offline.

**Done when:** desconectar wifi → banner cambia a "offline" en <5s y AOM no quema dinero ni emite errores; reconectar → reanuda automáticamente.

## Execution

Tasks 1, 3, 4 son independientes y se pueden paralelizar (subagentes distintos). Task 2 toca el call-site que también toca Task 1, así que va serial después de Task 1.

Orden:
1. **Task 1** (yield-on-input) — solo, primero. Commit.
2. **Task 3 + Task 4** en paralelo — subagentes separados. Dos commits.
3. **Task 2** (triage) — subagente final. Commit.
4. Smoke test manual: levantar `npm run tauri:dev`, reproducir el escenario de la captura (ejecutor con spinner + responder en el prompt) y verificar que AOM cede.

Cada task: TDD donde aplique (operator.rs ya tiene tests), commit por feature (no por step), todo en este worktree.

## Out of scope

- Multi-operator coordination (spec 3.2)
- Rediseño del state machine completo del operador — esto es upgrade, no rewrite
- Persistencia de phase history
