# Agentic Spec Creation (3.18) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reemplazar el formulario en blanco como punto de entrada para crear specs con un chat agéntico que hace 3-5 preguntas dirigidas y emite markdown válido contra `docs/specs/_template.md`. El editor existente queda como visualizador/editor de revisión pre-rellenado.

**Defaults resueltos (Open Qs de 3.18):**
- Batched, no streaming token-level: una pregunta a la vez vía `agent::dispatch()`.
- Agente NO lee el repo en v0 (sin tool use de fs); decisiones a partir de las respuestas del coordinador solamente.
- Modelo: `claude-sonnet-4-6`.
- Persistencia del draft: `~/.covenant/spec-drafts/<ulid>.json` con `{messages, partialMd, lastUpdated, status}`.

**Architecture:** Frontend (panel chat) + Rust (autor). El panel `ui/src/spec-chat/` mantiene el diálogo y el draft local; cuando el usuario responde, se llama un nuevo Tauri command `spec_author_step(draft_id, messages) -> {nextQuestion?, finalMarkdown?}` que delega en `crates/agent/src/spec_author.rs`. El autor reusa `agent::dispatch()` (rate limit + cost cap aplican). Al cerrar el diálogo, el panel monta el editor existente con `initialDraft = finalMarkdown`. La persistencia vive en disco (`~/.covenant/spec-drafts/<ulid>.json`) escrita por el backend tras cada step.

**Tech Stack:** TypeScript estricto sin framework (vanilla DOM, igual que 3.17). Rust + tokio + reqwest (Anthropic Messages API streaming, pero consumido como respuesta completa por step). Tests: vitest para UI, `cargo test` para `agent`.

---

## File Structure

**Create:**
- `crates/agent/src/spec_author.rs` (~250 líneas) — prompt del autor, máquina de estados (5 fases), serialización de draft, llamada a `dispatch()`.
- `crates/agent/src/spec_author/prompt.md` (~80 líneas) — system prompt del autor con el template y reglas de emisión.
- `crates/agent/tests/spec_author.rs` (~120 líneas) — tests de fases, validación de markdown emitido.
- `ui/src/spec-chat/panel.ts` (~180 líneas) — UI del panel.
- `ui/src/spec-chat/state.ts` (~120 líneas) — estado del draft en memoria + sync con backend.
- `ui/src/spec-chat/emit.ts` (~80 líneas) — handoff al editor existente.
- `ui/src/spec-chat/dialogue.ts` (~80 líneas) — render de pregunta/respuesta.
- `ui/src/spec-chat/panel.test.ts` (~100 líneas).
- `ui/src/spec-chat/state.test.ts` (~80 líneas).

**Modify:**
- `crates/agent/src/lib.rs` — `pub mod spec_author;`.
- `crates/app/src/lib.rs` (o donde se registren commands) — registrar `spec_author_step`, `spec_author_load_draft`, `spec_author_list_drafts`.
- `ui/src/api.ts` — wrappers tipados de los 3 commands.
- `ui/src/sidebar.ts` (o equivalente) — botón "New spec" (≤ 20 líneas).
- `ui/src/commands.ts` (o cmd palette) — atajo `⌘N` (≤ 15 líneas).
- Editor de specs existente — aceptar prop `initialDraft: string` que pre-puebla las 6 secciones (≤ 30 líneas).
- `ui/src/styles.css` — estilos del panel chat.

**DO NOT touch:**
- `crates/app/src/spec_detector.rs` (3.16) — detección sigue igual.
- `docs/specs/_template.md` — el formato es contrato.
- `crates/agent/src/safety.rs` — el autor es read-only sobre FS hasta `Publish` (que ya pasa por path normal del editor).

---

## Task 1: Backend — `spec_author` skeleton + draft persistence

**Files:**
- Create: `crates/agent/src/spec_author.rs`, `crates/agent/src/spec_author/prompt.md`
- Modify: `crates/agent/src/lib.rs`
- Test: `crates/agent/tests/spec_author.rs`

**Why:** El autor necesita una máquina de estados explícita (5 fases: goal → out-of-scope → acceptance → file-boundaries → complexity → emit) para que el agente no se vaya por las ramas. La persistencia en disco asegura que `⌘N` retome aunque se cierre la app.

- [ ] **Step 1.1:** Definir tipos en `spec_author.rs`:

  ```rust
  #[derive(Serialize, Deserialize, Clone, Debug)]
  pub struct SpecDraft {
      pub id: Ulid,
      pub messages: Vec<DraftMessage>,
      pub partial_md: Option<String>,
      pub last_updated: SystemTime,
      pub status: DraftStatus,
  }

  #[derive(Serialize, Deserialize, Clone, Debug)]
  pub enum DraftStatus { InProgress { phase: Phase }, Ready, Published }

  #[derive(Serialize, Deserialize, Clone, Debug)]
  pub enum Phase { Goal, OutOfScope, Acceptance, FileBoundaries, Complexity, Emit }
  ```

- [ ] **Step 1.2:** Implementar `load_draft(id) -> Result<SpecDraft>` y `save_draft(&SpecDraft)` leyendo/escribiendo `~/.covenant/spec-drafts/<ulid>.json`. Crear el directorio si no existe.

- [ ] **Step 1.3:** Implementar `list_drafts() -> Vec<SpecDraft>` ordenado por `last_updated` desc, máx 20.

- [ ] **Step 1.4:** Test: round-trip de un draft (save → load → assert eq).

- [ ] **Step 1.5:** Test: `list_drafts` ignora archivos malformados (no panic).

---

## Task 2: Backend — prompt + step function

**Files:**
- Modify: `crates/agent/src/spec_author.rs`
- Create: `crates/agent/src/spec_author/prompt.md`
- Test: `crates/agent/tests/spec_author.rs`

**Why:** El system prompt del autor es el contrato real. Aquí vive la disciplina: forzar al modelo a hacer una sola pregunta por turno, en secuencia fija de fases, y al final emitir markdown que matchea `_template.md` 1:1.

- [ ] **Step 2.1:** Escribir `prompt.md` con: (a) rol del autor, (b) las 6 secciones del `_template.md` embebidas literalmente como referencia, (c) regla "una pregunta por turno", (d) regla "al terminar fase Emit, devolver SOLO el markdown entre `<spec>...</spec>`", (e) regla "si la respuesta del coordinador es ambigua, repreguntar UNA vez antes de avanzar de fase".

- [ ] **Step 2.2:** Implementar `step(draft: &mut SpecDraft, user_msg: String) -> Result<StepOutput>`:

  ```rust
  pub enum StepOutput {
      Question { phase: Phase, text: String },
      Final { markdown: String },
  }
  ```

  Construye el prompt = `system_prompt` + draft.messages + nuevo user_msg, llama `agent::dispatch()` con modelo `claude-sonnet-4-6`, parsea la respuesta. Si contiene `<spec>...</spec>` → `Final`; si no → `Question`. Append a `draft.messages`, `save_draft`.

- [ ] **Step 2.3:** Validar markdown final: parsear secciones, asegurar las 6 presentes (`Goal`, `Out of scope`, `Acceptance criteria`, `File boundaries`, `Complexity`, `Open questions`). Si falta una, devolver `Err` y NO transicionar a `Ready`.

- [ ] **Step 2.4:** Test con respuesta mockeada del LLM (inyectar trait `Dispatcher`): primer step devuelve `Question{phase: Goal}`, después de 5 respuestas devuelve `Final` con markdown válido.

- [ ] **Step 2.5:** Test: si el markdown final no tiene la sección "File boundaries", `step` devuelve error y el draft queda en `InProgress`.

**Escalate if:** `agent::dispatch()` no permite inyectar un dispatcher fake para tests. Si es así, parar y proponer al coordinador agregar un trait `Dispatcher` antes de seguir.

---

## Task 3: Tauri commands

**Files:**
- Modify: `crates/app/src/lib.rs` (registro de commands)
- Modify: `ui/src/api.ts`

**Why:** Tres commands cubren todo el flujo: empezar/continuar (`step`), retomar (`load_draft`), entrada inicial (`list_drafts`).

- [ ] **Step 3.1:** Implementar `#[tauri::command] async fn spec_author_step(draft_id: Option<String>, user_msg: String) -> Result<StepResult, String>`. Si `draft_id` es `None`, crea un draft nuevo con `Ulid::new()`. Devuelve `{draft_id, output}` donde output es `Question` o `Final`.

- [ ] **Step 3.2:** Implementar `spec_author_load_draft(id: String) -> Result<SpecDraft, String>` y `spec_author_list_drafts() -> Result<Vec<SpecDraft>, String>`.

- [ ] **Step 3.3:** Registrar los tres en `tauri::Builder::invoke_handler!`.

- [ ] **Step 3.4:** Wrappers en `ui/src/api.ts`:

  ```typescript
  export async function specAuthorStep(draftId: string | null, userMsg: string): Promise<StepResult> { ... }
  export async function specAuthorLoadDraft(id: string): Promise<SpecDraft> { ... }
  export async function specAuthorListDrafts(): Promise<SpecDraft[]> { ... }
  ```

---

## Task 4: UI — chat panel state

**Files:**
- Create: `ui/src/spec-chat/state.ts`
- Test: `ui/src/spec-chat/state.test.ts`

**Why:** Un store mínimo que mantiene `currentDraft` + `messages` y dispara re-render cuando llega respuesta del backend. Separado del DOM para que sea testeable.

- [ ] **Step 4.1:** `createSpecChatState()` con campos: `draftId | null`, `messages: Message[]`, `awaitingAnswer: boolean`, `finalMarkdown: string | null`. Métodos: `submit(userMsg)`, `restoreDraft(id)`, `reset()`, `onChange(cb)`.

- [ ] **Step 4.2:** `submit` debe: marcar `awaitingAnswer = true`, append message, llamar `specAuthorStep`, recibir output, append question o set `finalMarkdown`, marcar `awaitingAnswer = false`, fire listeners.

- [ ] **Step 4.3:** Test: `submit` actualiza messages y dispara onChange exactamente 2 veces (una al submit, una al recibir).

- [ ] **Step 4.4:** Test: `restoreDraft` puebla messages desde el backend.

---

## Task 5: UI — chat panel render + dialogue

**Files:**
- Create: `ui/src/spec-chat/panel.ts`, `ui/src/spec-chat/dialogue.ts`
- Modify: `ui/src/styles.css`
- Test: `ui/src/spec-chat/panel.test.ts`

**Why:** UI ligera: lista scrolleable de mensajes (agente preguntas en gris, respuestas del coordinador en blanco), input al pie, botón "Cerrar (draft persiste)". Cuando llega `finalMarkdown`, mostrar botón "Revisar y publicar" que dispara handoff (Task 6).

- [ ] **Step 5.1:** `dialogue.ts` — `renderMessage(msg): HTMLElement` (split por `Question` vs `Answer`).

- [ ] **Step 5.2:** `panel.ts` — `mountSpecChatPanel(root, state)`. Subscribe a `state.onChange`, re-render lista. Input handler: `Enter` llama `state.submit`, deshabilita mientras `awaitingAnswer`.

- [ ] **Step 5.3:** Estilos en `styles.css`: panel modal centrado o sidebar derecho (consistente con docs hub 3.5). Reusar variables existentes.

- [ ] **Step 5.4:** Test: mount + simular state.onChange con un mensaje → DOM contiene el texto.

- [ ] **Step 5.5:** Test: input deshabilitado cuando `awaitingAnswer = true`.

---

## Task 6: Handoff al editor existente

**Files:**
- Create: `ui/src/spec-chat/emit.ts`
- Modify: editor de specs existente (aceptar `initialDraft`)

**Why:** Cerrar el loop: cuando el agente devuelve `Final`, parsear el markdown a las 6 secciones y abrir el editor con esas secciones pre-rellenadas. El coordinador edita libremente y publica.

- [ ] **Step 6.1:** `emit.ts` — `parseSpecMarkdown(md): SpecSections` que extrae las 6 secciones por heading `## ...`. Si falta una, throw.

- [ ] **Step 6.2:** `openEditorWithDraft(sections, draftId)` — montar el editor existente con `initialDraft = sections`. Al `Publish`, marcar el draft como `Published` (llamar nuevo command `spec_author_mark_published`) y mover el archivo `.json` a `~/.covenant/spec-drafts/published/`.

- [ ] **Step 6.3:** Modificar el editor para aceptar prop `initialDraft?: SpecSections`. Si está presente, pre-poblar los 6 textareas. (Cambio mínimo, ≤ 30 líneas.)

- [ ] **Step 6.4:** Test: `parseSpecMarkdown` con un fixture válido devuelve las 6 secciones; con uno al que le falta `File boundaries` lanza error.

---

## Task 7: Entrada — sidebar + cmd palette + retomar draft

**Files:**
- Modify: `ui/src/sidebar.ts` (o equivalente), `ui/src/commands.ts` (o cmd palette), `ui/src/main.ts`

**Why:** `⌘N` y botón "New spec" abren el panel. Al abrir, si hay drafts en `InProgress`, ofrecer "Retomar el último" o "Empezar uno nuevo" (modal pequeño). Esto cubre el criterio de "el draft persiste y `⌘N` retoma".

- [ ] **Step 7.1:** Botón "New spec" en sidebar (≤ 20 líneas) que dispara `openSpecChat()`.

- [ ] **Step 7.2:** Atajo `⌘N` en `commands.ts` (≤ 15 líneas) que llama lo mismo.

- [ ] **Step 7.3:** `openSpecChat()`: llamar `specAuthorListDrafts()`. Si hay alguno con `status === InProgress`, mostrar prompt "¿Retomar `<resumen>` o empezar uno nuevo?". Si no, abrir el panel con state nuevo.

- [ ] **Step 7.4:** Entrada secundaria "Blank draft" en el mismo prompt (10% case) — abre el editor existente directo sin pasar por chat.

---

## Task 8: Integración + smoke test manual

- [ ] **Step 8.1:** `cargo test -p agent` y `pnpm test --run ui/src/spec-chat` — todo verde.

- [ ] **Step 8.2:** Smoke manual: `⌘N` → describir "quiero exportar specs como PDF" → contestar 5 preguntas → revisar editor pre-rellenado → publicar a `docs/specs/3.19-pdf-export-smoke.md` (luego borrar) → verificar archivo válido.

- [ ] **Step 8.3:** Smoke: `⌘N` a media conversación → cerrar app → reabrir → `⌘N` → debe ofrecer retomar.

- [ ] **Step 8.4:** Smoke: "Blank draft" abre el editor sin chat.

- [ ] **Step 8.5:** Verificar que `cargo test -p covenant` (o el suite global) sigue pasando.

---

## Rollout

- Branch: `feature/3.18-agentic-spec-creation`.
- Un commit por Task (8 commits totales), cada uno con tests verdes (preferencia de granularidad del coordinador: una commit por feature, no por TDD step → aquí "feature" = task).
- Merge a `main` tras smoke manual aprobado.

## Open issues for follow-up (post-merge)

- v2: el agente puede leer el repo (read-only) para sugerir file boundaries (Open Q #2 de 3.18).
- v2: streaming token-level si la latencia de Sonnet 4.6 molesta.
- v2: import de specs externos (markdown pegado) que pase por el mismo editor.
