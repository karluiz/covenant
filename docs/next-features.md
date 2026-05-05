# Covenant Terminal — WIP

## 1. Visión

Estamos en la 3era generación de IA en el SDLC: los **agentes ejecutores**. Hoy programo con Claude Code, Copilot CLI, OpenCode.

La tesis de Covenant: en esta nueva era el IDE tradicional es overhead — **la terminal debe ser el core**. No queremos abrir un IDE, pero a veces hay que tocar un fichero, y eso debería poder hacerse sin salir de Covenant.

## 2. Problema central

Los agentes ejecutores pausan constantemente esperando inputs triviales:

- "¿Continuamos?"
- "¿Sí, adelante?"
- "¿Ejecuto inline o como sub-agent?"

Son micro-inputs irrelevantes para el progreso real y matan el flow. La meta: un **coordinador** que tome estas decisiones por mí, e idealmente que pueda seguir desarrollando mientras duermo.

## 3. Features

### 3.1 Master Operator

El coordinador autónomo. Configurable:

- Qué tiene permitido hacer
- Permisos / boundaries
- Su propia **"alma"** (personalidad, criterio, defaults)

Hipótesis: un único master operator cubre la mayoría de decisiones triviales en una primera instancia.

### 3.2 Multi-Operator (next phase)

Una vez probado el master, abrir a múltiples operadores:

- Diferentes capacidades por operador
- Diferentes niveles de autonomía
- **Open question**: orquestación entre ellos

### 3.3 Structure — file tree opcional

Hoy el sidebar tiene bloques. Agregarle un **tree list de archivos** llamado **"Structure"**.

Principios:

- 100% opcional — la terminal sigue siendo el core
- Inspirado en Zed: simpleza, tree-as-optional
- Use case: editar un fichero puntual sin salir de Covenant
- No queremos replicar un IDE — queremos el mínimo que evite tener que abrirlo

### 3.4 AOM Mode — Autonomous Operator Mode ~~(AFK UI)~~ — **DEPRECATED 2026-05-05**

> El rol de "pantalla de reposo / déjalo correr" lo absorbe **3.8 Convergence Mode**, que es más denso e informativo (ve todas las sesiones, no solo una). El motor AOM (autonomía nocturna, decisiones, cost cap) **se mantiene** — lo que se retira es la UI AFK como entry point separado. Notificaciones OS (3.6) cubren el alerting away-from-screen.

### 3.5 Self-contained docs

Un hub ligero **dentro de la app** que explique las features que hemos desarrollado: **AOM, Agents, Blocks, Recall**.

- No es documentación pesada — es referencia in-context
- El usuario entiende qué hace cada feature sin salir de Covenant
- Más cercano a un onboarding contextual que a un manual

### 3.6 OS Notifications

El AOM (o el operador a cargo) puede bloquearse — es un escenario real. Cuando eso pasa, Covenant debe disparar **notificaciones del sistema operativo** para que el usuario atienda el bloqueo a tiempo.

Triggers candidatos:

- Bloqueo del operador (necesita decisión humana no-trivial)
- Error irrecuperable
- Tarea completada (opcional / configurable)

### 3.7 Status Bar — contexto del entorno
Una barra inferior no invasiva que refleje el contexto del directorio actual cuando navego entre carpetas.
Información relevante según el proyecto:

Nombre del repo y rama actual (si es un git repo)
Versión del runtime activo: Node, Python, Go, Rust, etc.
Detectada automáticamente según el tipo de proyecto

Principios:

Discreta — informa, no distrae
Contextual — solo muestra lo aplicable (no aparece "Go: —" en un proyecto Node)
Reactiva — se actualiza al cambiar de directorio

### 3.8 Convergence Mode

Un espacio **visual** donde se ven todos los **agent executors** trabajando en paralelo, con el operador supervisándolos. Tipo "control room" / video wall.

- Una tile por sesión (tab): muestra estado actual (idle / working / awaiting-input / blocked), última decisión del operador, preview del último comando + output, costo de la sesión si está bajo AOM.
- Pensado para **ver el sistema entero de un vistazo** sin saltar entre tabs.
- Click en una tile → entra a ese tab.

**Idle/screensaver role (absorbido de 3.4, 2026-05-05)**: Convergence es ahora la vista canónica de reposo. Follow-up tracked: auto-engage tras N minutos sin input (configurable, default off). En v1 sólo se abre por `⌘⇧M`.
