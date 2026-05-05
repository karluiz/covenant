# Operator Session Summary (3.19) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir que el coordinador escriba `/summary` (o `/resumen`) en el chat del familiar y reciba un resumen ejecutivo de la sesión actual con foco en decisiones autónomas, costos, bloqueos resueltos y open items. Variantes: `/summary mission`, `/summary today`. Sin UI nueva, sin schema nuevo — composición sobre `crates/familiar`.

**Defaults resueltos (Open Qs de 3.19):**
- Idioma: sigue el idioma del último mensaje del chat (detectado en system prompt, no por código).
- Ventana `today`: rodante de 24h (no día calendario).
- Formato: markdown plano dentro del chat (sin bloques colapsables, sin UI nueva).
- Modelo: reutiliza el `Llm` configurado del familiar (Sonnet lazy para rollups; el comando NO hace eager de Haiku).
- Staleness threshold: 50 eventos desde el último rolling summary → invoca Sonnet; si no, sirve cacheado.
- Cost cap: respeta `cost.rs` del familiar; en frozen-mode devuelve último cacheado + disclaimer.

**Architecture:** El parser de slash commands vive en `agent.rs` antes del flujo normal de `turn()`. Si el texto del usuario empieza con `/summary` (o `/resumen`), `ChatAgent::turn()` desvía a `summary_turn(scope)` que (a) calcula la ventana de eventos según scope, (b) decide cache-hit vs Sonnet-call según staleness + frozen-mode, (c) construye un prompt fijo (en `prompts.rs::summary_prompt`), (d) llama al `Llm`, (e) persiste el assistant turn vía `memory.append_chat`. No emite directives. La señal "primer chat tras AOM completado" para el placeholder UI sale de un nuevo helper `memory.has_recent_closed_mission(since_ms)`.

**Tech Stack:** Rust + tokio + rusqlite (existente). Tests: `cargo test -p karl-familiar` con `Llm` mock (patrón ya usado en `summarizer.rs::tests`). UI: TS estricto, mínimo cambio (placeholder condicional).

---

## File Structure

**Create:**
- `crates/familiar/tests/summary.rs` (~200 líneas) — integration: parser, scopes, cache-hit, frozen-mode, prompt content.

**Modify:**
- `crates/familiar/src/agent.rs` (≤ 80 líneas añadidas) — parser `parse_slash` + branch a `summary_turn`.
- `crates/familiar/src/prompts.rs` (≤ 60 líneas añadidas) — `summary_prompt(scope, summary_text, missions, directives, costs, last_user_lang_hint)`.
- `crates/familiar/src/memory.rs` (≤ 50 líneas añadidas) — `directives_in_window`, `events_in_window`, `has_recent_closed_mission`, `costs_in_window`. Sin cambios de schema.
- `ui/src/familiar/chat.tsx` (o equivalente, ≤ 30 líneas) — placeholder condicional vía nuevo Tauri command `familiar_has_recent_closed_mission`.
- `crates/app/src/lib.rs` (o donde se registren) — registrar el nuevo command.
- `ui/src/api.ts` — wrapper tipado.

**DO NOT touch:**
- `crates/familiar/src/summarizer.rs` — el motor de summarization se consume tal cual; no extender.
- `crates/familiar/src/observer.rs` — el observer no necesita cambios; ya pobla todo.
- `crates/familiar/src/cost.rs` — se usa, no se modifica.
- `crates/familiar/src/directive.rs` — `/summary` nunca emite directives.
- `crates/familiar/migrations/` — schema no cambia.
- AOM morning report code — ortogonal por design.

---

## Task 1: Memory query helpers (read-only, no schema change)

**Files:**
- Modify: `crates/familiar/src/memory.rs`
- Test: `crates/familiar/tests/summary.rs` (crear archivo, escribir tests de helpers primero)

**Why:** El comando necesita ventanas temporales y una señal de "mission cerrada recientemente". Centralizar en `memory.rs` mantiene a `agent.rs` libre de SQL.

- [ ] **Step 1.1:** Test-first. En `tests/summary.rs`, escribir tests que abren `Memory::open_in_memory`, insertan rows sintéticos (events, missions, directives, daily_spend) y assertan:
  - `events_in_window(since_ms)` devuelve sólo events con `ts_ms >= since_ms`, ordenados asc.
  - `directives_in_window(since_ms)` igual sobre directives (filtrando por `proposed_ms`).
  - `costs_in_window(since_ms)` suma `daily_spend.usd` por días que caen en la ventana (no fracciona días — toma el día completo si su epoch-of-day cae dentro).
  - `has_recent_closed_mission(since_ms)` true sii existe mission con `finished_ms IS NOT NULL AND finished_ms >= since_ms`.

- [ ] **Step 1.2:** Implementar los 4 helpers como métodos `pub fn` sobre `Memory`. Reutilizar el patrón de `events_since` para el SQL.

- [ ] **Step 1.3:** Correr `cargo test -p karl-familiar` — todos los tests existentes deben seguir verdes; los nuevos pasan.

**Acceptance:** Helpers disponibles, 4 tests verdes, sin cambios de schema (verificar con `git diff -- crates/familiar/migrations/` vacío).

---

## Task 2: Slash command parser

**Files:**
- Modify: `crates/familiar/src/agent.rs`
- Test: `crates/familiar/tests/summary.rs`

**Why:** El parser debe ser estricto (sólo `/summary` y `/resumen` con scope opcional `mission` | `today`) y no consumir mensajes que empiezan con `/` pero no matchean — esos siguen como chat normal.

- [ ] **Step 2.1:** Test-first. Tests para `parse_slash(&str) -> Option<SummaryScope>`:
  - `"/summary"` → `Some(Session)`
  - `"/resumen"` → `Some(Session)`
  - `"/summary mission"` → `Some(Mission)`
  - `"/summary today"` → `Some(Today)`
  - `"  /summary  today  "` → `Some(Today)` (trim + collapse spaces)
  - `"/summary tomorrow"` → `None` (scope desconocido → tratar como chat normal con un nudge en respuesta — pero el parser devuelve `None` y `turn()` decide; en este plan: devolvemos `None` y dejamos que el flujo normal le pase al LLM, que es la decisión más simple).
  - `"hola /summary"` → `None` (no empieza con slash).
  - `"/summarize"` → `None` (no es prefix loose).

- [ ] **Step 2.2:** Definir tipos en `agent.rs`:
  ```rust
  #[derive(Debug, Clone, Copy, PartialEq, Eq)]
  pub enum SummaryScope { Session, Mission, Today }

  fn parse_slash(input: &str) -> Option<SummaryScope> { /* ... */ }
  ```

- [ ] **Step 2.3:** Cablear en `ChatAgent::turn()`: al inicio, tras `append_chat("user", ...)`, llamar `parse_slash`. Si `Some(scope)`, delegar a `self.summary_turn(now_ms, scope).await` (Task 3). Si `None`, seguir con el flujo existente.

**Acceptance:** Tests del parser verdes; chat normal sigue funcionando (correr suite completa).

---

## Task 3: `summary_turn` — cache + Sonnet branch

**Files:**
- Modify: `crates/familiar/src/agent.rs`, `crates/familiar/src/prompts.rs`
- Test: `crates/familiar/tests/summary.rs`

**Why:** Es el corazón del comando. Decide cache-vs-LLM, respeta cost cap, persiste el turn, devuelve `ChatTurn` consistente con el flujo normal (sin directive).

- [ ] **Step 3.1:** En `prompts.rs`, añadir:
  ```rust
  pub fn summary_prompt(
      scope: SummaryScope,
      rolling_summary: &str,
      missions_text: &str,
      directives_text: &str,
      costs_usd: f64,
      last_user_msg: &str,   // para que el LLM detecte idioma
  ) -> (String, String)      // (system, user)
  ```
  System: instrucciones rígidas — "responde en el idioma del último mensaje del usuario", "estructura fija con secciones: Decisiones autónomas / Costos / Bloqueos resueltos / Misiones / Open items pendientes", "markdown plano, sin bloques colapsables", "no propongas directives". User: payload con los datos.

- [ ] **Step 3.2:** Test-first para `summary_turn`:
  - **Cache-hit**: con `<50` events nuevos desde último rolling, el mock `Llm` NO debe ser llamado; respuesta sale del rolling summary directamente formateada vía un fallback determinístico (`format_cached_summary(...)`).
  - **Cache-miss**: con `≥50` events nuevos, el mock recibe exactamente un `complete()` con system/user del prompt esperado.
  - **Frozen-mode**: si `cost::is_frozen(...)` (o equivalente) → no llama LLM, devuelve último cacheado + disclaimer al final del texto: "(modo congelado: cost cap diario alcanzado)".
  - **Persistencia**: tras la respuesta, `memory.chat_history(2)` contiene el `user` con `/summary` y el `assistant` con la respuesta.
  - **Sin directive**: `ChatTurn.proposed_directive == None` siempre.

- [ ] **Step 3.3:** Implementar:
  ```rust
  impl<'a, L: Llm> ChatAgent<'a, L> {
      async fn summary_turn(&self, now_ms: i64, scope: SummaryScope) -> Result<ChatTurn> {
          let since_ms = match scope {
              SummaryScope::Session => session_start_ms(self.config),  // helper en memory: epoch del primer event de la sesión actual; si no hay session_id en config, fallback a today.
              SummaryScope::Mission => active_mission_started_ms(self.memory)?, // último mission abierto; si no hay → fallback a session.
              SummaryScope::Today  => now_ms - 24 * 3600 * 1000,
          };
          // ... carga rolling, missions, directives_in_window, costs_in_window
          // ... staleness = events_since(rolling.last_event_id).len() >= 50
          // ... frozen = cost::is_frozen(...)
          // ... cache-hit branch | cache-miss branch
      }
  }
  ```

- [ ] **Step 3.4:** Implementar `format_cached_summary(rolling, missions, directives, costs)` — función pura, determinística, sin LLM. Markdown plano con las mismas secciones que pediría el prompt. Sirve para cache-hit y frozen-mode.

- [ ] **Step 3.5:** Suite completa verde: `cargo test -p karl-familiar`.

**Acceptance:** `/summary` funciona end-to-end con `Llm` mock en los 4 escenarios (cache-hit, cache-miss, frozen, sin directive).

---

## Task 4: UI placeholder condicional

**Files:**
- Modify: `crates/app/src/lib.rs` (registro de command), `ui/src/api.ts`, `ui/src/familiar/chat.tsx`
- Test: visual + manual

**Why:** El comando es invisible si nadie sabe que existe. Mostrar el hint sólo cuando hay señal de uso (mission cerrada en últimas 24h) evita ruido permanente.

- [ ] **Step 4.1:** Tauri command `familiar_has_recent_closed_mission(familiar_id: String, since_hours: u32) -> bool` que delega en `memory.has_recent_closed_mission(now - hours*3600*1000)`.

- [ ] **Step 4.2:** `ui/src/api.ts`: wrapper tipado.

- [ ] **Step 4.3:** En el componente del chat, al montar, llamar el wrapper con `since_hours = 24`. Si `true`, placeholder = `"prueba: /summary"`. Si `false`, placeholder genérico existente. **No** persistir; recalcula al re-montar.

- [ ] **Step 4.4:** Manual smoke: con DB sintética con un mission cerrado hace 1h → placeholder muestra hint; sin missions → placeholder default.

**Acceptance:** Hint aparece cuando corresponde, no aparece cuando no, sin clics extra.

---

## Task 5: Docs hub note + smoke

**Files:**
- Modify: contenido del docs hub (3.5) — sección de Familiars, añadir nota corta sobre `/summary` (≤ 15 líneas markdown). Si la sección de Familiars no existe todavía, **escalate** y parar — no inventar UI nueva.

**Why:** Discoverability secundaria. Hint UI + docs hub cubren ambos canales sin requerir vista dedicada.

- [ ] **Step 5.1:** Localizar el archivo de docs hub para Familiars. Si no existe → escalate.
- [ ] **Step 5.2:** Añadir sección "Resumen de sesión" con: comando, scopes, ejemplo de respuesta truncado.
- [ ] **Step 5.3:** Smoke E2E manual con app real:
  1. Iniciar sesión, dejar correr unos comandos (generar events).
  2. Abrir chat del familiar, escribir `/summary` → respuesta estructurada en idioma del usuario.
  3. `/summary today` → ventana 24h.
  4. `/summary mission` con mission activa → digest.
  5. Verificar que un mensaje normal sigue funcionando (no rompe parser).

**Acceptance:** 5 pasos del smoke pasan; nota de docs publicada o escalation registrada.

---

## Risks & Escalation

- **Riesgo:** `cost::is_frozen` puede no exponer una función pública usable desde `agent.rs`. **Mitigation:** si está privada, **escalate** antes de mover visibilidad. No introducir hack temporal.
- **Riesgo:** `session_start_ms` requiere saber el `session_id` actual del familiar. **Mitigation:** si `FamiliarConfig` no lo tiene, escalate — no inventar campo nuevo en este plan; fallback temporal a `today` para cerrar Task 3 mientras se decide.
- **Riesgo:** Detección de idioma vía LLM puede fallar con 1 mensaje corto. **Mitigation:** el prompt incluye los últimos 3 mensajes del usuario, no sólo el último. Documentado en `summary_prompt`.

## Out of plan (no implementar)

- Vista UI dedicada (panel separado).
- Export markdown / share link.
- Slash commands genéricos (framework). Sólo `/summary` y `/resumen`.
- Cambios al engine de summarization (Haiku eager / Sonnet lazy).
- Reemplazar morning reports de AOM.
