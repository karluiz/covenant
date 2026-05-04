# Familiars — Hardening & Deuda Técnica

**Date:** 2026-05-04
**Status:** Draft (post-merge follow-up)
**Parent:** `2026-05-04-familiars-design.md` (Phase 1 MVP merged via `afccb75`)

---

## Contexto

Familiars Phase 1 mergeó a main con 43 commits y 324 tests pasando. La revisión consolidada identificó deuda conocida que no bloqueó el merge pero debe atenderse antes de promover el feature a "production-ready" / habilitar billing premium.

Este spec agrupa los items en tres severidades: **integración semántica** (cambios que el feature no resuelve hoy), **endurecimiento** (correctness/robustez), **pulido** (UX y minor).

---

## 1. Integración semántica

### 1.1 Inyección real de directivas al loop del Operator

**Problema:** `familiar_approve_directive` retorna el rendered string; la UI lo escribe al PTY vía `write_to_session` como bytes crudos. El usuario debe editar y presionar Enter — no hay canal "synthetic user message → Operator agent loop".

**Impacto:** las directivas aprobadas no llegan al Operator como input semántico; no participan del decision threshold ni del cost cap del operator. El Familiar termina actuando como un sugeridor de comandos shell, no como influencia sobre el agente.

**Propuesta:** añadir comando Tauri `operator_inject_user_message(session_id, message, source: "familiar_directive")` que mete el string directamente en el queue de inputs que ve el Operator agent en su próximo cycle (junto al system prompt + mission). Audit trail incluye `source` para distinguir de input humano. La UI cambia su delivery hook a este comando en vez de `write_to_session`.

**Decisión arquitectural pendiente:** ¿el Operator debe poder rechazar una directiva inyectada (ej. si viola su mission)? Default propuesto: sí — el Operator emite un `DirectiveRejected` event que el Familiar puede ver y traer de vuelta al coordinator.

### 1.2 Despawn coordinado con cierre de tab

**Problema:** `FamiliarManager::despawn` existe pero ningún call site lo invoca al cerrar tabs. Memoria + tarea observer leak indefinidamente en sesiones largas.

**Propuesta:** hookear `tabs/manager.ts::removeTab` para llamar `Familiars.despawn(familiarFor(sessionId))` antes de cerrar la sesión. Backend command `familiar_despawn(familiar_id)` no existe aún — añadir en Tauri.

### 1.3 `Memory` `Send`-safety

**Problema:** `rusqlite::Connection` es `!Sync`, así que `&Memory` cruzando `.await` hace los futures `!Send`. Workaround actual: `spawn_blocking` + current-thread runtime en boundary Tauri.

**Propuesta:** refactorizar `karl-familiar::Memory` para no retener `MutexGuard` cruzando awaits. Dos caminos:
- **A** — Cada método sync de `Memory` toma el lock internamente, libera antes de retornar. Operaciones compuestas se hacen vía métodos transaccionales atómicos (ya existe `try_reserve_spend` como precedente).
- **B** — Mover Memory a su propio thread con channel-based API; los callers envían comandos.

A es menos invasivo y suficiente para los call sites actuales.

---

## 2. Endurecimiento

### 2.1 CostGate integration (real enforcement)

**Estado actual:** `try_reserve_spend` atómico existe en `Memory` y `CostGate::try_reserve` lo expone, pero ni `Summarizer::run_eager` ni `ChatAgent::turn` lo invocan antes del LLM call. El cap "duro" del spec no se aplica.

**Propuesta:** inyectar `Option<&CostGate>` en `Summarizer` y `ChatAgent`. Antes de cada `llm.complete(...)`:
1. Estimar `expected_cost_usd` con un budget conservador (ej. max_tokens × price_out_per_mtok)
2. `gate.try_reserve(now_ms, expected_cost_usd)?` — si false, retornar `Err(FamiliarError::Frozen)`
3. Tras el call, refundir delta: `actual_cost - expected_cost` (puede ser negativo si el modelo respondió corto)

Tests con mock LLM que retorna costos variados validando que el spend total no excede el cap aún con concurrencia simulada.

### 2.2 Approve flow state guard

**Problema:** `approve_directive` actualiza estado sin validar transición. Doble-click aprueba una directiva ya rejected.

**Propuesta:** SQL update con `WHERE state = 'proposed'`; si `rows_affected = 0`, retornar `FamiliarError::InvalidDirective("not in proposed state")`. Mismo patrón para `reject_directive` y `mark_executed`.

### 2.3 Directive edit propagation

**Problema:** botón "Edit" del directive card pone `contentEditable=true`, usuario edita el payload, pero al hacer Approve el backend ignora el edit y usa el payload original almacenado en SQLite.

**Propuesta:** dos opciones:
- **A** — Eliminar el botón Edit (UX simple; usuario rechaza y le pide al Familiar de nuevo)
- **B** — Comando `familiar_approve_directive_with_edit(familiar_id, directive_id, edited_payload)` que re-corre `ensure_safe` sobre el edited payload y persiste el override. Audit log refleja el edit.

B es más útil pero suma superficie de validación. Default propuesto: B con cap de longitud + re-run safety.

### 2.4 Audit log XSS hardening

**Problema:** `audit_log.ts::escape` cubre solo `&<>`. `state` y `kind` se interpolan en HTML className y text via `innerHTML`. Hoy seguro por coincidencia (valores vienen del enum Rust Debug); futuro backend que almacene block_reason free-form abre XSS.

**Propuesta:** convertir todas las celdas a `textContent` (como hace directive_card.ts). Eliminar interpolación HTML. Dejar `escape` como helper deprecated o removerlo.

### 2.5 SQLite pragmas en `Memory::open`

**Problema:** abre con defaults — `synchronous=FULL`, sin `busy_timeout`, sin WAL. Multi-Familiar concurrente puede dar `SQLITE_BUSY`.

**Propuesta:** post-`Connection::open`:
```rust
conn.execute_batch("
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
")?;
```

### 2.6 Exhaustive `SessionEvent` matching

**Problema:** `observer.rs::event_kind`/`event_session_id` matchea variantes explícitas. Añadir variante en `karl-session::SessionEvent` rompe compile (bien) pero el contrato no está documentado.

**Propuesta:** añadir comentario `// TIENE QUE COMPILAR-FALLAR si se agrega variante` y un test que materialice cada variante existente. O usar `#[non_exhaustive]` + handler genérico para casos desconocidos.

---

## 3. Pulido

### 3.1 Premium gate cross-await

`require_active` toma el lock de Settings, valida, libera. Si el usuario desactiva Familiars durante un chat call en vuelo, ese call termina. Aceptable, pero comentar:

```rust
/// El gate se evalúa al entrar al command. Calls en vuelo cuando el usuario
/// desactiva continúan; el siguiente call será rechazado. Esto es intencional
/// para evitar tener que cancelar mid-stream un LLM call ya facturado.
fn require_active(...)
```

### 3.2 Dedup `now_ms()`

Definido en `manager.rs`, `observer.rs`, `familiar_commands.rs`. Promover a `karl_familiar::clock::now_ms()`.

### 3.3 `RwLock` para FamiliarManager

`spawn`/`despawn` requieren mutación; `list`/`for_session`/`config_of` solo leen. Cambiar `Arc<Mutex<HashMap<...>>>` a `Arc<RwLock<HashMap<...>>>` permite reads concurrentes con chat turns. Cambio de 5 minutos.

### 3.4 `parse_kind` dedicado

`manager.rs::approve_directive` matchea `row.kind.as_str()` contra strings que vienen de `format!("{:?}", DirectiveKind::Stop)` — frágil si Debug cambia. Añadir `DirectiveKind::from_db_str(&str) -> Option<Self>` y usar consistente.

### 3.5 Helper `run_blocking` en familiar_commands.rs

Cinco comandos repiten boilerplate de `spawn_blocking + new current-thread runtime` por el `!Send` issue. Extraer:
```rust
async fn run_blocking<T, F>(fut: F) -> Result<T, String>
where F: Future<Output = Result<T, FamiliarError>> + Send + 'static
```

(Si 1.3 se implementa, este helper desaparece.)

### 3.6 Two empty commits squash

`0b42a90` y `1cde303` son commits vacíos en el historial. Cosmético; no urgente. Si hay rebase futuro, foldearlos.

---

## Phasing sugerido

**Hardening Tier 1** (bloquea promoción a public premium):
- 1.1 Operator input channel
- 1.2 Despawn on tab close
- 2.1 CostGate enforcement
- 2.5 SQLite pragmas

**Hardening Tier 2** (correctness, fix antes de growth):
- 1.3 Memory Send-safety refactor
- 2.2 State guards
- 2.4 Audit XSS

**Polish Tier 3** (nice-to-have):
- 2.3 Directive edit
- 3.x todos

---

## Out of Scope

Explícitamente NO en este spec:
- Phase 2 features (inline ⌘K, episodic recall, embeddings)
- Cross-Familiar consultation
- Operator → Familiar feedback loop (más allá de DirectiveRejected en 1.1)
- Billing/payment integration

---

## Open Questions

1. **1.1** — ¿El Operator agent puede vetar una directiva inyectada? Default sí; spec final debe ser explícito.
2. **2.3** — ¿Eliminar Edit button (A) o implementar override seguro (B)?
3. **2.6** — ¿`#[non_exhaustive]` en `SessionEvent` o test de materialización?

---

## Tracking

Issue por cada item de Tier 1 al abordar. Tier 2/3 pueden agruparse en mini-PRs temáticos.
