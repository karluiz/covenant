# Zoom responsivo cross-platform — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Arreglar los tres bugs reales del zoom (Ctrl no bindeado, recorte de status bar a zoom extremo, indicador ausente) sobre el mecanismo de page-zoom existente, sin reescribir a `--ui-scale`.

**Architecture:** El zoom ya usa page-zoom nativo del webview (`ui/src/zoom.ts`), que reflowea el viewport y por tanto ya dispara la responsividad CSS (media query de "COVENANT", grid de sidebars, refit de xterm). No se toca ese mecanismo. Se extrae un predicado puro para los atajos (testeable + cross-platform vía `modHeld`), se añade un pill transitorio de nivel, y se endurece el truncado de la status bar tras reproducir el recorte.

**Tech Stack:** TypeScript (strict), Vitest, Tauri 2 webview zoom API, CSS.

## Global Constraints

- No `as any` sin comentario justificándolo; `strict: true`.
- Tests corren desde la **raíz** del repo con `npm test` (Vitest), no desde `ui/`.
- Copy de UI en inglés (`feedback_english_first_copy`). El indicador muestra solo el número + `%`.
- Sin emoji en chrome; glyphs vía SVG si hicieran falta (no aplica aquí).
- Atajos deben funcionar en todas las plataformas (`feedback_shortcuts_cross_platform`).
- `modHeld(e)` (`ui/src/platform.ts:174`) = `isMac() ? metaKey : ctrlKey` — es el único predicado correcto para "el mod de la plataforma".
- Rango de zoom se mantiene 60–200% (`zoom.ts:20-22`); no estrechar a 70–150%.
- No introducir dependencias nuevas.

## File Structure

- `ui/src/zoom.ts` — añade el predicado puro `zoomIntent()` (export). Sin cambios al ZoomController.
- `ui/src/zoom.test.ts` — **nuevo**, unit tests del predicado.
- `ui/src/main.ts` — reemplaza las 4 ramas de zoom del keydown (`2552-2571`) por una que usa `zoomIntent()`; monta el indicador vía `zoom.onChange`.
- `ui/src/styles.css` — CSS del indicador; endurecimiento del truncado de la status bar (Task 3, condicional a repro).

---

### Task 1: Atajos de zoom cross-platform (bug #1)

Hoy `main.ts:2552-2571` guarda las 4 ramas con `e.metaKey`, así que Ctrl +/-/0 no hace nada en Linux/Windows (falla el DoD). Se extrae un predicado puro y se cablea con `modHeld`.

**Files:**
- Modify: `ui/src/zoom.ts` (añadir export al final, antes de `export const zoom`)
- Create: `ui/src/zoom.test.ts`
- Modify: `ui/src/main.ts:2552-2571`

**Interfaces:**
- Produces: `export type ZoomIntent = "in" | "out" | "reset" | null;` y `export function zoomIntent(key: string, mod: boolean): ZoomIntent;` — Task 2 no lo consume; solo `main.ts` lo usa.

- [ ] **Step 1: Escribir el test que falla**

Crear `ui/src/zoom.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { zoomIntent } from "./zoom";

describe("zoomIntent", () => {
  it("returns null when the platform mod is not held", () => {
    expect(zoomIntent("=", false)).toBe(null);
    expect(zoomIntent("-", false)).toBe(null);
    expect(zoomIntent("0", false)).toBe(null);
  });

  it("maps + / = to zoom in (shifted and unshifted)", () => {
    expect(zoomIntent("=", true)).toBe("in");
    expect(zoomIntent("+", true)).toBe("in");
  });

  it("maps - to zoom out", () => {
    expect(zoomIntent("-", true)).toBe("out");
  });

  it("maps 0 to reset", () => {
    expect(zoomIntent("0", true)).toBe("reset");
  });

  it("ignores unrelated keys and shifted variants of - / 0", () => {
    expect(zoomIntent("a", true)).toBe(null);
    expect(zoomIntent("_", true)).toBe(null); // shift+-
    expect(zoomIntent(")", true)).toBe(null); // shift+0
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npm test -- ui/src/zoom.test.ts`
Expected: FAIL — `zoomIntent is not a function` / import no resuelve.

- [ ] **Step 3: Implementar el predicado**

En `ui/src/zoom.ts`, justo antes de `export const zoom = new ZoomController();` (línea 125), añadir:

```ts
export type ZoomIntent = "in" | "out" | "reset" | null;

/// Pure mapping from a keydown to a zoom action. `mod` = the platform's
/// zoom modifier is held (Cmd on macOS, Ctrl elsewhere — see modHeld).
/// Matches on the resolved key char, so shifted `+` counts as "in" while
/// shifted `-`/`0` (`_`/`)`) are ignored — no separate shift bookkeeping.
export function zoomIntent(key: string, mod: boolean): ZoomIntent {
  if (!mod) return null;
  switch (key) {
    case "=":
    case "+":
      return "in";
    case "-":
      return "out";
    case "0":
      return "reset";
    default:
      return null;
  }
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npm test -- ui/src/zoom.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Cablear en el keydown handler**

En `ui/src/main.ts`, reemplazar las líneas 2552-2571 (las cuatro ramas `if (e.metaKey ...)` de zoom in/in-shift/out/reset) por:

```ts
    const intent = zoomIntent(e.key, modHeld(e));
    if (intent) {
      e.preventDefault();
      if (intent === "in") zoom.zoomIn();
      else if (intent === "out") zoom.zoomOut();
      else zoom.reset();
      return;
    }
```

Verificar que el import de `zoomIntent` existe. El archivo ya importa `modHeld` (usado en 2575) y `zoom`; añadir `zoomIntent` al import existente desde `./zoom` (o al de `./platform` según corresponda — `modHeld` viene de `./platform`, `zoomIntent`/`zoom` de `./zoom`).

- [ ] **Step 6: Verificar el type-check y el build**

Run: `npm run build`
Expected: type-check OK, sin errores.

- [ ] **Step 7: Commit**

```bash
git add ui/src/zoom.ts ui/src/zoom.test.ts ui/src/main.ts
git commit -m "fix(zoom): bind Ctrl +/-/0 on Linux/Windows via modHeld predicate"
```

---

### Task 2: Indicador transitorio de nivel de zoom (bug #3)

Pill que aparece al cambiar el zoom mostrando `N%` y se desvanece tras ~1s. Se cablea vía `zoom.onChange` para cubrir teclado **y** el input de settings (`panel.ts`) con un solo sitio (DRY).

**Files:**
- Modify: `ui/src/main.ts` (junto al `zoom.onChange` existente en 2108-2112)
- Modify: `ui/src/styles.css` (nueva regla `#zoom-indicator`)

**Interfaces:**
- Consumes: `zoom.onChange` y `zoom.level()` de `ui/src/zoom.ts` (ya existen).
- Produces: nada exportado.

- [ ] **Step 1: Añadir el CSS del pill**

En `ui/src/styles.css`, al final del archivo, añadir:

```css
/* Transient zoom-level readout — fades in on any zoom change, out after
   the timer in main.ts clears .visible. Pointer-inert; centered near the
   bottom so it never sits under the toolbar icons. */
#zoom-indicator {
    position: fixed;
    left: 50%;
    bottom: 64px;
    transform: translateX(-50%);
    padding: 6px 14px;
    background: color-mix(in srgb, var(--bg-panel) 92%, transparent);
    border: 1px solid var(--border);
    border-radius: 0;
    color: var(--text-primary);
    font-size: 13px;
    font-feature-settings: "tnum" 1;
    letter-spacing: 0.02em;
    pointer-events: none;
    opacity: 0;
    transition: opacity 220ms ease-out;
    z-index: 9999;
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
}
#zoom-indicator.visible { opacity: 1; }
```

- [ ] **Step 2: Montar y cablear el indicador**

En `ui/src/main.ts`, justo después del bloque `zoom.onChange(...)` existente (termina en la línea 2112), añadir:

```ts
  // Transient zoom-level readout. One onChange covers keyboard shortcuts
  // and the settings input alike. ponytail: inline DOM + one timer, no
  // module — it's ~15 lines and nothing else needs it.
  {
    const el = document.createElement("div");
    el.id = "zoom-indicator";
    document.body.appendChild(el);
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    zoom.onChange((level) => {
      el.textContent = `${Math.round(level * 100)}%`;
      el.classList.add("visible");
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => el.classList.remove("visible"), 1000);
    });
  }
```

- [ ] **Step 3: Verificar el build**

Run: `npm run build`
Expected: OK.

- [ ] **Step 4: Verificación manual**

Correr `npm run tauri:dev`. Pulsar Cmd/Ctrl `+` varias veces → aparece el pill "120%", "130%"… y se desvanece tras ~1s. Pulsar Cmd/Ctrl `0` → muestra "100%" y desaparece. Sin parpadeo entre pulsaciones rápidas (el timer se reinicia).

> ponytail: sin unit test — el único cómputo es `Math.round(level*100)`, trivial. El resto es DOM+timer, bajo valor para jsdom.

- [ ] **Step 5: Commit**

```bash
git add ui/src/main.ts ui/src/styles.css
git commit -m "feat(zoom): transient zoom-level indicator pill"
```

---

### Task 3: Recorte de status bar/toolbar a zoom extremo (bug #2)

**Primero reproducir.** El grid ya reserva la fila del footer (`styles.css:471`), la status bar ya tiene `overflow:hidden` (`6612`) y las zonas ya llevan `min-width:0` (`6659`, `6689`). Por eso hay que confirmar el fallo exacto antes de tocar CSS — el fix depende de qué se rompe realmente.

**Files:**
- Modify: `ui/src/styles.css` (condicional a lo que muestre la repro)

**Interfaces:** ninguna nueva.

- [ ] **Step 1: Reproducir y documentar el fallo**

Correr `npm run tauri:dev` con `settings.status_bar_enabled = true` (la status bar es `hidden` por defecto). Llevar el zoom a 2.0 (Cmd/Ctrl `+` hasta el tope) y a 0.6 (`-` hasta el tope), en ventana estrecha y ancha. Anotar exactamente:
  - ¿Desaparece el `#status-bar` completo, o solo se recortan segmentos individuales?
  - ¿Hay scroll horizontal (`document.documentElement.scrollWidth > clientWidth`)?
  - ¿Algún icono del toolbar queda inaccesible (no solo "COVENANT" oculto, que es correcto)?

Comparar contra `ui-normal.png` / `ui-zoom-cropped.png`.

- [ ] **Step 2: Aplicar el fix según la repro**

**Caso A — la status bar ya sobrevive y solo faltan truncar segmentos (esperado):** endurecer el truncado por elemento. En `ui/src/styles.css`, tras la regla `.sb-zone > .status-segment, .sb-zone > button, .sb-zone > .status-chip { ... }` (empieza en 6700), añadir:

```css
/* At extreme zoom / narrow width, individual segments truncate instead of
   overflowing the bar (AC#3). The zone already has min-width:0; give its
   text children an ellipsis so no single segment forces the bar to clip
   wholesale. The center zone yields first — it holds the least critical
   ephemerals. */
.sb-zone > .status-segment,
.sb-zone > .status-chip {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
}
.sb-center { flex-shrink: 1; }
```

**Caso B — la repro muestra que el `#status-bar` sí desaparece verticalmente:** significa que algo fuerza el alto del contenido por encima del contenedor. Verificar que `#app-content` conserva `min-height:0` (`styles.css:254`) y que `#status-bar` no tiene un `min-height` heredado; añadir si falta:

```css
#status-bar { flex-shrink: 0; }
```

**Caso C — la repro NO reproduce ningún recorte** (el bug ya está resuelto por CSS posterior al screenshot): no tocar CSS. Degradar la tarea a verificación: dejar constancia en el commit de QA de la Task 4 y saltar al Step 4.

- [ ] **Step 3: Re-verificar en la app**

Repetir Step 1 tras el fix: la status bar visible en 0.6 y 2.0, contenido truncado por elemento, sin scroll horizontal, sin iconos de toolbar inaccesibles.

- [ ] **Step 4: Commit**

```bash
git add ui/src/styles.css
git commit -m "fix(zoom): status bar truncates per-segment at zoom extremes instead of clipping"
```

(Si aplicó el Caso C, saltar este commit — no hubo cambio de código.)

---

### Task 4: QA visual contra los criterios de aceptación

Verificación cross-cutting de los ACs que "ya funcionan" (1, 2, 4) más el DoD cross-platform. Sin código.

**Files:** ninguno.

- [ ] **Step 1: QA en macOS**

Con `npm run tauri:dev`, recorrer el rango 0.6→2.0 con Cmd `+`/`-`/`0` y confirmar:
  - Fuente e iconos escalan; el terminal xterm re-renderiza y las selecciones caen bien (AC#1).
  - "COVENANT" se oculta a zoom alto igual que en ventana angosta (AC#2).
  - El sidebar conserva su ancho; el terminal se comprime primero (AC#2).
  - Nada se sale de la ventana; sin scroll horizontal (AC#4).
  - Cmd `0` resetea a 100% sin parpadeo; el pill muestra "100%" (AC#5).

- [ ] **Step 2: QA cross-platform (Ctrl)**

En Linux o Windows (o la VM Azure Win11, `reference_azure_win11_test_vm`), confirmar que Ctrl `+`/`-`/`0` escalan/resetean (bug #1 arreglado). Confirmar que la preferencia persiste tras reiniciar la app (ya vía localStorage).

- [ ] **Step 3: Capturar screenshots**

Guardar capturas normal vs. zoom máximo para el PR (comparables a `ui-normal.png`/`ui-zoom-cropped.png`).

---

## Self-Review

**Spec coverage:**
- Bug #1 (Ctrl) → Task 1. ✓
- Bug #2 (status bar) → Task 3. ✓
- Bug #3 (indicador) → Task 2. ✓
- AC#1 (escala + refit): ya funciona → verificado en Task 4 Step 1. ✓
- AC#2 (reusa responsividad): ya funciona → Task 4 Step 1. ✓
- AC#3 (trunca por elemento): Task 3 Caso A. ✓
- AC#4 (contención, sin scroll H): Task 3 Step 3 + Task 4. ✓
- AC#5 (reset + indicador): Task 1 (reset bindeado) + Task 2 (pill). ✓
- DoD cross-platform: Task 4 Step 2. ✓
- DoD persistencia: ya vía localStorage → Task 4 Step 2. ✓

**Placeholder scan:** Task 3 usa ramas condicionales (Caso A/B/C) en vez de un placeholder — cada caso trae CSS concreto y un criterio observable para elegirlo. Justificado: el bug requiere reproducción real y el grid ya está correcto, así que no se puede fijar la causa a ciegas sin fabricar certeza.

**Type consistency:** `zoomIntent(key: string, mod: boolean): ZoomIntent` se define en Task 1 y se consume en el mismo Task 1 Step 5 con la misma firma. `zoom.onChange((level) => ...)` en Task 2 coincide con `ZoomChangeListener = (zoom: number) => void` (`zoom.ts:25`). ✓
