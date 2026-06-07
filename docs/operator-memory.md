# Operator Memory

> Cómo el operador recuerda, aprende y mantiene coherencia a lo largo del tiempo.
> Código en `crates/app/src/{operator,operator_mind,operator_registry,world,memory,storage}.rs`.

---

## 1. ¿Qué es un operador?

Un **operador** es un agente *coordinador* que observa a un **executor** (Claude Code,
Copilot, opencode, aider…) corriendo dentro de un PTY y responde sus prompts rutinarios
en nombre del usuario, dentro de una *charter* explícita.

| Rol | Dónde vive | Qué hace |
|---|---|---|
| **Executor** | Dentro del terminal (PTY) | Hace el trabajo (escribe código, corre comandos) |
| **Operador** | Fuera del terminal, observando los bytes | Decide: `Reply` / `Escalate` / `Wait` |
| **Super-agente** | Registro multi-operador | Coordina varios operadores |

El operador NO es "memoria" en sí: es un bucle (`tick_loop`, cada **500 ms**) que en cada
*tick* lee el estado reciente del executor, consulta su memoria, llama al LLM y decide.
La memoria es lo que le da contexto y coherencia entre ticks.

---

## 2. Las tres capas de memoria

La memoria está estratificada por volatilidad. De más efímera a más persistente:

```
┌─────────────────────────────────────────────────────────────┐
│  CAPA 1 — Tail buffer            (RAM, por sesión)            │  ← bytes crudos recientes
│  CAPA 2 — World model            (RAM, por sesión)            │  ← bloques + resumen LLM
│  CAPA 3 — OperatorMind           (SQLite, por sesión/tab)     │  ← memoria de trabajo multi-turno
│           + operator_memories    (SQLite + vectores)          │  ← decisiones aprendidas (global)
└─────────────────────────────────────────────────────────────┘
```

### Capa 1 — Tail buffer (efímero)
`operator.rs` · `struct OperatorState` (línea ~305)

```rust
pub struct OperatorState {
    pub last_byte_at: Instant,
    pub bytes_total: u64,
    pub tail: VecDeque<u8>,               // buffer rodante
    pub last_decision_at_bytes_total: u64,// marcador de dedup
}
```

- **`TAIL_CAPACITY = 32 KB`** (`operator.rs:97`) — ~4-5 pantallas visibles. Retiene la
  pregunta del executor aunque haya actividad intermedia (un `/rename` + confirmación
  puede ser 10-15 KB).
- Se muestrea a **`SUMMARY_TAIL_TARGET = 16 KB`** (`operator.rs:139`) para downstream.
- Vive solo en RAM (dentro de un `StdMutex`); se descarta al hacer *detach* de la sesión.

### Capa 2 — World model (efímero)
`world.rs` · `struct SessionWorldModel`

```rust
pub struct SessionWorldModel {
    pub cwd: PathBuf,
    pub blocks: VecDeque<BlockSnapshot>,  // MAX_BLOCKS = 16
    pub summary: Option<String>,           // resumen rolling generado por LLM
    pub title: Option<String>,             // etiqueta de actividad (≤ 2 palabras)
    pub in_flight: Option<InFlightBlock>,  // comando ejecutándose ahora
}
```

Constantes (`world.rs:14-16`):
- `MAX_BLOCKS = 16` — los comandos completados más viejos se descartan.
- `MAX_OUTPUT_CHARS = 800` — output por bloque que se retiene.
- `MAX_COMMAND_CHARS = 200`.

El `summary` lo regenera la tarea *summarizer* con debounce (~500 ms) tras cada
`BlockFinished`. Si aún no hay summary, se renderizan los bloques crudos (el LLM igual
recibe contexto). También vive en `AsyncMutex`; se borra al *detach*.

### Capa 3a — OperatorMind (PERSISTENTE, por tab)
`operator_mind.rs` · `struct OperatorMind` — **Spec 3.20**

La memoria de trabajo multi-turno que da coherencia entre decisiones.

```rust
pub struct OperatorMind {
    pub goal: String,                  // objetivo de alto nivel (se fija una vez)
    pub belief: String,                // entendimiento actual, 1-3 frases (cada turno)
    pub open_questions: Vec<String>,   // reemplazo completo; cap 5
    pub tried_failed: VecDeque<String>,// FIFO cap 5; se añade, nunca se borra
    pub next_intent: String,           // qué hacer el próximo turno
    pub recent: VecDeque<TurnRecord>,  // últimos 5 turnos [saw, thought, action, executed]
    pub turn_count: u64,
    pub updated_at: DateTime<Utc>,
}
```

- **`TurnRecord`**: turno #, timestamp, `saw` (excerpt ≤ 400 chars), `thought` (≤ 200 chars),
  `action` (Reply/Execute/Escalate/Ignore), `executed` (bool).
- **Stale**: se marca como obsoleto si `updated_at` > 24 h.
- **Activación**: solo cuando `mind_v2_on = settings.operator.mind_v2 && live`. Si está
  apagado, el operador funciona en modo v1 sin mind.
- **Hidratación lazy**: en el primer tick v2 se carga de SQLite; si no existe, se crea uno
  semilla (`goal` = nombre del archivo de misión).

### Capa 3b — operator_memories (PERSISTENTE, global, vectorial)
`memory.rs` + `storage.rs` — **Spec 3.13**

Decisiones que el usuario "enseña" al operador, recuperadas por similitud semántica.

- `pattern` (la situación) se **embebe** con BGE-small-en-v1.5 → vector 384-dim.
- Almacenado en `operator_memories` + índice `operator_memory_vec` (sqlite-vec).
- `scope` puede ser `"global"` o `"mission:<path>"`.
- Recuperación (cada tick): gate por `COUNT(*)` → embed query → vec search top-20 →
  re-score por overlap de keywords → top-8.

---

## 3. Qué es efímero y qué se persiste

| Componente | Storage | Scope | Vida |
|---|---|---|---|
| Tail buffer | RAM (`VecDeque`) | Por sesión | Sesión |
| World model (bloques, summary) | RAM (`AsyncMutex`) | Por sesión | Sesión |
| **OperatorMind** | SQLite `operator_mind` | Por sesión/tab | **Persistente** |
| **Decisiones aprendidas** | SQLite `operator_memories` + vec0 | Global / por misión | **Persistente** |
| Decisiones (audit) | SQLite `operator_decisions` | Persistente | Para siempre |
| Personas | SQLite `operators` + `SOUL.md` | Global | Persistente (hot-reload 2.5 s) |
| Loop detectors, rate-limit | RAM (`Attached`) | Por sesión | Sesión |

### Tablas SQLite (`storage.rs`)

```sql
-- Audit trail: una fila por decisión, escrita ANTES de ejecutar
operator_decisions(
  id, session_id, timestamp_unix_ms, in_flight_command,
  output_excerpt,      -- ≤ 4 KB
  action,              -- "reply" | "escalate" | "wait"
  reply_text, rationale, executed,
  mission_path, executor_name, operator_id, operator_name,
  cost_usd, applied_memory_id, escalation
)  -- índices: idx_op_dec_session, idx_op_dec_timestamp

-- Decisiones aprendidas (con embedding aparte en operator_memory_vec)
operator_memories(
  id, pattern, decision, rationale,
  scope,               -- "global" | "mission:<path>"
  tags,                -- keywords extraídas (cap 12)
  created_at_unix_ms
)

-- Memoria de trabajo por tab
operator_mind(
  session_id PRIMARY KEY,
  json,                -- OperatorMind serializado
  turn_count,
  updated_at           -- RFC3339
)  -- índice: idx_operator_mind_updated_at

-- Personas / registry
operators(
  id, name, persona, model, hard_constraints,
  voice, soul_path, xp, is_default,
  created_at_unix_ms, updated_at_unix_ms, emoji, color, tags_json
)
```

---

## 4. Ciclo de actualización (coherencia multi-turno)

```
tick_loop (cada 500 ms)
  └─ run_tick(sesión)
       1. Gate offline / idle / decision-point estable / phase
       2. Hidratar OperatorMind (lazy, 1ª vez)
       3. Construir user message: <mind> + <recent-decisions> + tail + cwd
       4. Recuperar decisiones aprendidas (vector search) → top-8
       5. Construir system prompt (persona + misión + learned + directivas)
       6. (opcional) triage barato con Haiku
       7. Llamar al modelo (Sonnet, thinking opcional)
       8. Parsear respuesta → { mind_update?, action }
       9. Aplicar mind_update (cap + FIFO), añadir TurnRecord, mind_dirty = true
      10. Loop detectors (×3) + safety blocklist (si live)
      11. Persistir en operator_decisions
      12. Emitir eventos UI + notificaciones
  └─ flush de todos los minds con mind_dirty → SQLite
```

**Protocolo de update del Mind (Spec 3.20)**: el LLM recibe el `<mind>` actual renderizado
como XML y devuelve JSON con un `mind_update` opcional. `OperatorMind::apply()` aplica los
cambios respetando los caps (open_questions → reemplazo, cap 5; tried_failed → FIFO cap 5).

---

## 5. Cómo llega la memoria al LLM

### System prompt (`build_system_prompt`, `operator.rs:~3704`)
Concatenado en orden fijo:
1. Persona (configurada por operador)
2. `AOM_DIRECTIVE` (si AOM activo)
3. Misión: spec + plan (si attached)
4. `## Learned decisions` (top-8 — **solo si hay hits**)
5. Contexto de proyecto
6. Contrato de review (si archetype = Review)
7. `EXECUTOR_RECOMMENDATION_DIRECTIVE`
8. `HARD_CONSTRAINTS`
9. `voice_directive()` (Terse / Warm / Formal)
10. `OUTPUT_FORMAT`
11. `MIND_V2_DIRECTIVE` (si mind v2 on)

### User message (`render_user_message`, `operator.rs:~4009`)
```
<mind> … </mind>                       (si v2)
<recent-decisions> … </recent-decisions> (si v2)
Executor command: …
Session cwd: …
Bytes idle: …s
<executor_output> …últimos 4000 chars sin ANSI… </executor_output>
```
**Tail-bias**: solo los últimos **`MODEL_EXCERPT_CHARS = 4000`** caracteres (tras strip de
ANSI) van al modelo (`operator.rs:174, 4010-4019`).

### Recuperación de decisiones aprendidas (`operator.rs:~3839`)
1. Query text = `"{cmd}\n{última línea del tail}"`.
2. Extraer keywords (cap 12, sin stopwords).
3. **Gate**: `COUNT(*)` sobre `operator_memories(scope)` — si 0, ni se embebe.
4. Embed con BGE-small (384-dim) en blocking task.
5. Vector search vec0 → top-20 por distancia L2.
6. Re-score: `combined = distance − 0.05 * kw_matches`.
7. Shadowing (más nueva gana ante misma decisión y score casi igual) → top-8.

> **Sin caché en proceso**: cada tick re-consulta la DB para que las ediciones del usuario
> apliquen de inmediato.

---

## 6. Phases y coalescing

### Phases (badge de UI) — `operator.rs:~57`
```
Idle → Observing → Triaging → Deciding → Yielded → Offline
```
Prioridad al agregar globalmente: `Deciding > Triaging > Yielded > Observing > Offline > Idle`.

### Detección de decision-point
- Heurística (`detect_decision_point`): `?`, `:`, `>`, `(y/n)`, menús numerados, en una
  ventana de **`DECISION_SCAN_WINDOW = 800`** chars.
- Umbral idle: **`DECISION_IDLE_THRESHOLD = 2 s`** para decision-point (4 s+ normal).
- **Estabilidad + debounce**: tras inyectar, el executor hace eco del texto → el patrón se
  apaga brevemente; solo se re-arma tras **`DECISION_LOST_DEBOUNCE = 5 s`**.

### Loop detectors (3 independientes)
| Detector | Disparo | Acción |
|---|---|---|
| Loop general | hash(action, rationale, tail-sig) repetido `LOOP_THRESHOLD = 3` veces | ESCALATE forzado + cooldown |
| Repeat-REPLY | mismo REPLY normalizado `REPLY_REPEAT_THRESHOLD = 2` veces | ESCALATE forzado |
| Idle-WAIT | WAIT con progress-signature sin cambios ≥ 5 veces | ESCALATE forzado |

Cooldown: **`LOOP_COOLDOWN = 120 s`**.

### Rate limit y gates de costo
- Máx decisiones/min por sesión (`max_per_min`), ventana **`RATE_WINDOW = 60 s`**.
- **Pre-triage gate**: si la firma de pantalla no cambió desde el último WAIT, emite WAIT
  gratis sin pagar el triage (~$0.018).

---

## 7. Invariantes de diseño

1. **Dedup antes de llamar**: se marca `last_decision_at_bytes_total` *antes* de la llamada
   al LLM, para evitar retry loops ante fallos transitorios de API.
2. **Race guards**: se re-chequea el estado enabled/disabled de la sesión alrededor de la
   llamada al modelo.
3. **Invariante de prefix-cache**: cuando `learned` o `project_context` están vacíos se
   renderizan 0 bytes — el prefijo del prompt queda byte-idéntico para aprovechar el cache.
4. **Masking antes de persistir**: todo texto del Mind pasa por `safety::mask_secrets()`
   antes de escribir a SQLite (redacta API keys, passwords, etc.).
5. **Errores no fatales**: fallos en retrieval/embedder/vec-search degradan a `warn` + lista
   vacía; nunca tumban el tick.

---

## 8. Mapa de archivos

| Componente | Archivo | Líneas |
|---|---|---|
| Coordinador / tick loop | `operator.rs` | 1-23, 1445+, 1782+ |
| `OperatorState` (tail) | `operator.rs` | ~305 |
| `OperatorPhase` | `operator.rs` | ~57 |
| System prompt | `operator.rs` | ~3704 |
| Retrieval de aprendidas | `operator.rs` | ~3839 |
| User message | `operator.rs` | ~4009 |
| Detección decision-point | `operator.rs` | ~4042 |
| Loop detectors | `operator.rs` | ~2810 |
| `OperatorMind` | `operator_mind.rs` | 19-45 |
| Render XML del Mind | `operator_mind.rs` | ~186 |
| Parse de respuesta | `operator_mind.rs` | ~334 |
| Apply/update del Mind | `operator_mind.rs` | ~136 |
| Lógica de retrieval | `memory.rs` | 1-257 |
| `SessionWorldModel` | `world.rs` | 1-144 |
| Esquema SQLite | `storage.rs` | 76-198, 413-464 |
| Registry de operadores | `operator_registry.rs` | 119-200 |
| Embedder (BGE-small) | `embedder.rs` | 1-104 |

---

*Nota: los números de línea son aproximados y referencian el estado del repo al momento de
escribir este documento; usa los nombres de struct/función para localizarlos si el código se
movió.*
