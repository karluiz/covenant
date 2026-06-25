# Repository Guidelines

## Project Structure & Module Organization

Covenant is a Tauri 2 desktop app with a Rust backend and a minimal TypeScript frontend. Rust workspace crates live in `crates/`: `app` owns Tauri commands and app wiring, `pty` wraps terminal process handling, `blocks` parses OSC 133 terminal blocks, `session` manages lifecycle/events, `agent` handles LLM/provider logic, and `capabilities`/`familiar` provide higher-level features. Frontend code is in `ui/src`, with feature folders such as `terminal`, `operator`, `settings`, `spec-chat`, and `project-notes`. Tests sit beside their targets as `*.test.ts` in `ui/src` and under each crate's `tests/` directory. Shell snippets are in `shell-integration/`; design notes and specs are in `docs/`.

## Build, Test, and Development Commands

- `npm install`: install frontend and Tauri CLI dependencies.
- `npm run dev`: run the Vite frontend only.
- `npm run tauri:dev`: run the full desktop app with hot reload.
- `npm run build`: type-check TypeScript and build the Vite bundle.
- `npm run tauri:build`: create a production Tauri build.
- `npm test`: run Vitest tests.
- `cargo test --workspace`: run all Rust workspace tests.
- `cargo fmt --all` and `cargo clippy --workspace --all-targets`: format and lint Rust before larger PRs.

## Coding Style & Naming Conventions

Rust uses edition 2021, 4-space indentation, `snake_case` modules/functions, and `PascalCase` types. Prefer `thiserror` in library crates and `anyhow` at app boundaries. Avoid `unwrap()` outside tests and `main()`. TypeScript is strict ESM; use `camelCase` functions/variables, `PascalCase` types, and typed wrappers for Tauri IPC in `ui/src/api.ts` or local feature APIs. Keep frontend dependencies lightweight; xterm.js renders terminal output.

## Testing Guidelines

Add focused tests with behavior changes. Use `cargo test --workspace` for Rust crates and `npm test` for UI logic. Name UI tests `feature.test.ts` near the source file. New parsing, safety, persistence, or provider behavior should include regression coverage.

## Commit & Pull Request Guidelines

History follows Conventional Commits, for example `feat(pi-rpc): ...` and `chore(shortcuts): ...`. Keep commits scoped and milestone-relevant. PRs should explain why the change exists, list user-visible behavior, link related issues/specs, include screenshots for UI changes, and call out safety implications such as command execution, secret handling, or LLM dispatch paths.

## Architecture & Safety Notes

Respect the PTY-first architecture: do not reimplement VT parsing, do not bypass OSC 133 block handling, and do not call model providers outside the central safety/dispatch path. Never persist or send unmasked secrets or raw ANSI content to LLM code paths.

<!-- cdlc:start -->
# CDLC context (auto-generated — do not edit inside this block)

## kyc-peru v1.0.0

# KYC — Perú (SBS)

Al evaluar onboarding o aprobación de productos:

- **Exigir** documento de identidad vigente y verificación de identidad antes de aprobar.
- Si falta KYC, **rechazar** y citar la resolución SBS aplicable.
- Conservar evidencia de la verificación según el período de retención regulatorio.

## sdd-bian v1.0.0

---
name: sdd-bian
description: >-
  Spec-Driven Development para procesos BIAN siguiendo los lineamientos de
  Credicorp. Úsala cuando tengas que exponer o migrar una API o un proceso
  bancario como contrato verificable: genera OpenAPI 3.x + Arazzo + Overlay,
  con seguridad FAPI 2.0 y validación Spectral/VACUUM. SDD no es vibe-coding.
---

# SDD · BIAN Process Specs (lineamientos Credicorp)

> Skill gobernado por CDLC. Instalado vía `covenant cdlc install sdd-bian`.
> Canónico en `.covenant/cdlc/skills/sdd-bian/`. Versionado y firmado.

## Principio (no negociable)

**SDD no es vibe-coding.** El resultado del trabajo **no es código — son las specs**.
El código (mock-server, cliente, tests) es desechable y se regenera desde las specs.
Las specs son la fuente de verdad y se rigen por reglas deterministas definidas por
Arquitectura, Seguridad y Datos. Si algo no está en una regla, **se pregunta al
arquitecto** — no se inventa.

## Qué produces, en este orden

1. **OpenAPI 3.x spec** — el contrato de cada API del proceso.
2. **Arazzo spec** — la orquestación determinista del proceso (1 por proceso).
3. **Overlay spec** — particularizaciones internas, solo si aplica.
4. **Mock-server** — desde la OpenAPI, con datos de prueba.
5. **Client code** — que llama las OpenAPIs siguiendo el Arazzo.
6. **Test scenarios** — los escenarios de aceptación (ver evals).

## Reglas deterministas (lineamientos)

- **Schema = el contrato.** Es lo más importante. Mapea los datos al modelo de
  industria **BIAN** (service domains, control records). Incluye diccionario de
  datos, dominios, ejemplos y notas funcionales por campo.
- **Operation** lleva el id del proceso/operación BIAN que la API implementa.
- **Security Scheme** debe tornar la API compliant con **FAPI 2.0** (OpenID
  Foundation). No expongas nada sin esquema de auth/autz.
- **Tag** define observabilidad desde el diseño — la API nace conectable a
  herramientas de observabilidad.
- **Encoding / XML** — declara explícitamente para interoperabilidad con legados.
- **Extensions** — usa `x-` para particularizar Credicorp sin romper portabilidad.
- **Arazzo** es determinista: cualquier consumidor que siga el Arazzo correspondiente
  genera **siempre el mismo resultado**. Es lo que permite que un agente encadene
  llamadas sin errores de interpretación.
- **Versionado + retrocompatibilidad.** Cambio estructural → nueva versión de spec,
  reemplazo gradual. Si cambia la implementación pero no la spec, no hay impacto
  para el consumidor.

## Workflow (human-in-the-loop)

1. Define la **especificación de la tarea** completa. Valida cumplimiento de
   lineamientos. **Pide aprobación del arquitecto** para seguir.
2. Crea el **plan de implementación técnica**. Valida. **Pide aprobación.**
3. Pregunta al arquitecto cómo seguir: squad de sub-agentes o paso-a-paso.
4. Crea las **OpenAPI specs** (con datos de prueba para el mock-server).
5. Crea la **Arazzo spec** (considerando el código cliente que llamará las OpenAPIs
   simuladas).
6. Genera el **mock-server**.
7. Genera el **client code** que llama las OpenAPIs siguiendo el proceso del Arazzo.
8. Genera el **código de los escenarios de prueba**.
9. **Ejecuta** todo para garantizar calidad y **valida lineamientos**.
10. Genera documentación (estándar ArchiMate si aplica).

## Gates de compliance (deben pasar antes de publicar)

- **Spectral** — lint del ruleset de Credicorp sobre cada OpenAPI.
- **VACUUM** — validación de compliance/calidad de la OpenAPI.
- Un gate que falla **no se silencia**: queda logueado como señal (fase Observe del
  CDLC) y, si es de compliance, es un hallazgo — no un bug de productividad.

## Context-TDD (evals/) — escenarios de aceptación

Estos escenarios deben pasar para considerar la tarea cumplida. En la estructura CDLC
viven en `evals/`; acá van inline para la demo:

1. **Schema válido contra BIAN** — el schema de cada API mapea a un service domain
   BIAN identificable; sin campos huérfanos ni tipos ambiguos.
2. **FAPI 2.0** — el security scheme declara los requerimientos FAPI; ningún endpoint
   queda sin auth.
3. **Arazzo determinista** — dado el mismo input, el Arazzo produce la misma secuencia
   de llamadas y el mismo resultado en las 5 corridas.
4. **Mock ↔ contrato** — el mock-server responde exactamente lo que declara la OpenAPI
   (status, schema, ejemplos).
5. **Cliente ↔ proceso** — el client code completa el proceso end-to-end contra el
   mock siguiendo el Arazzo, sin intervención manual.

## Caso de referencia: BIAN "Handle Request for Cash Withdrawal from Savings Account"

Service domains del proceso (de la secuencia BIAN): Point of Service, Session Dialogue,
Servicing Order, Payment Order, Party Lifecycle Management, Savings Account, Payment
Execution, Position Keeping, Internal Bank Account.

Secuencia objetivo a orquestar con Arazzo: Handle Customer Contact → Get Requested
Service → Record Request for Cash Withdrawal → Verify Retail Customer → Create Payment
Order → Get Operational Details → Execute Cash Withdrawal → Record/Authorize Debit
Booking (cuenta cliente) → Record/Authorize Credit Booking (cuenta cash) → Pay Out Cash.

Produce una OpenAPI por entidad/dominio relevante, un Arazzo que encadene la secuencia,
y un cliente que ejecute los 5 escenarios de prueba contra los mock-servers.

---

> **Nota de gobierno:** cada spec emitida y cada commit quedan capturados como
> primitivas Covenant (Spec, Commit), y cada turno del agente como Prompt + LLM Call.
> El panel CDLC muestra costo por spec, eval pass-rate y atribución tras la adopción.
<!-- cdlc:end -->
