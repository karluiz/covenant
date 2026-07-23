# Zoom responsivo cross-platform — fix sobre el mecanismo existente

**Fecha:** 2026-07-22
**Estado:** Diseño — pendiente de review del usuario

## Resumen ejecutivo

La historia original propone "migrar el zoom nativo a un sistema `--ui-scale`
controlado que reutilice la lógica responsiva de resize". El mapeo del código
muestra que **esa migración no es necesaria y sería una regresión**. El zoom
nativo del webview YA está acoplado a la responsividad, y `--ui-scale` no existe
como sistema al cual migrar. El scope real son **tres bugs concretos** sobre el
mecanismo que ya funciona.

## Diagnóstico: historia vs. código real

Dos premisas de la historia son falsas según el código:

**Premisa 1 — "el zoom nativo no dispara la lógica responsiva".** Falso.
`ui/src/zoom.ts:96` aplica zoom con `getCurrentWebview().setZoom()`. En las tres
plataformas eso mapea a *page-zoom que reflowea* (macOS `setPageZoom:`, WebView2
`ZoomFactor`, WebKitGTK `zoom_level`), lo que encoge el viewport en CSS-px. Por
lo tanto:
- El `@media (max-width: 880px)` que oculta "COVENANT" (`styles.css:15150`) ya
  dispara con zoom, igual que con resize de ventana.
- El grid `#layout` (sidebars en px fijos + workspace en `1fr`,
  `styles.css:466-475`) ya recomputa con zoom.
- La refit de xterm ya está cableada: `zoom.onChange()` → `applyTerminalSettings`
  (`main.ts:2108-2112`) → `fitAddon.fit()` + `resize_session` al PTY.

**Premisa 2 — "existe un sistema `--ui-scale` controlado al cual migrar".** Falso.
`--ui-scale` no aparece en ninguna parte del código. El sistema de escalado
actual **es** el zoom nativo, y es el primitivo correcto: la UI está dimensionada
en px (no rem), así que solo el page-zoom escala *todo* Y mantiene los media
queries vivos. Un `--ui-scale` hecho a mano regresaría:
- vía `transform: scale()` en el root → el viewport de layout no cambia → los
  media queries dejan de disparar → rompe la responsividad que la historia quiere.
- vía `rem`/font-size → no escala la UI en px.

**Conclusión:** no se toca el mecanismo de zoom. Se arreglan los bugs reales
sobre él.

## Scope

### Dentro (los tres bugs reales)

1. **Ctrl +/-/0 no funciona (cross-platform).** El handler en `main.ts:2547-2571`
   está guardado solo con `e.metaKey`. En Linux/Windows los atajos no hacen nada.
   Fix: usar el helper `modHeld(e)` que ya se usa dos líneas abajo para el chord
   de settings (`main.ts:2575`), en vez de `e.metaKey`.

2. **Status bar / toolbar se recortan a zoom extremo** (`ui-zoom-cropped.png`,
   AC #3). El grid ya reserva la fila del footer (`styles.css:471`), así que la
   causa no es el layout de filas. Requiere reproducir para confirmar la causa
   exacta (candidatos: overflow horizontal del contenido de la status bar, que es
   `white-space:nowrap; overflow:hidden` en `styles.css:6611-6612`; o el titlebar
   creciendo). Fix garantiza: (a) el footer nunca se clipa, (b) la status bar
   **trunca elementos individualmente en vez de ocultar el contenedor completo**,
   (c) el toolbar colapsa (COVENANT + labels del update capsule) antes de
   desbordar — comportamiento que ya existe vía media/container query, verificar
   que cubre todo el rango.

3. **No hay indicador de nivel de zoom** (AC #5, consideración técnica). Añadir un
   pill transitorio ("120%") que aparece al cambiar el zoom y se desvanece tras
   ~1s. Al resetear (Cmd/Ctrl 0) muestra "100%" y desaparece.

### Fuera (YAGNI — la historia lo pide pero no aporta)

- **Reescribir a `--ui-scale`.** Descartado por el diagnóstico de arriba.
- **Interceptar/deshabilitar el zoom nativo del webview.** No aplica: ya usamos la
  API de zoom del webview deliberadamente vía `zoom.ts`; no hay un zoom nativo
  "sin control" corriendo en paralelo que interceptar.
- **Persistencia con tauri-plugin-store.** El zoom ya persiste en localStorage
  (`zoom.ts:117-123`). Cambiar el backend no aporta nada. AC de persistencia ya
  satisfecho.
- **Estrechar el rango a 70–150%.** Hoy es 60–200% (`zoom.ts:20-22`). Estrecharlo
  es una regresión para quien ya usa los extremos, sin razón de rendering. Se
  mantiene 60–200% salvo que el usuario indique lo contrario. (Nota: alinear el
  `min` del input de settings, `panel.ts:1048` dice `min="60"` correcto.)

## Criterios de aceptación — mapeo a la realidad

| AC de la historia | Estado |
|---|---|
| 1. Fuente/iconos escalan con +/-; xterm refit + PTY | **Ya funciona** (page-zoom + `zoom.onChange` refit). Sin trabajo. |
| 2. Reutiliza responsividad (oculta COVENANT, respeta mínimos, preserva sidebar) | **Ya funciona** (media query + grid). Verificar en QA. |
| 3. Status bar nunca desaparece; trunca por elemento | **Bug #2** — trabajo real. |
| 4. Nada se sale de la ventana; sin scroll horizontal | Cubierto por bug #2. |
| 5. Cmd/Ctrl 0 → reset + recálculo, sin parpadeo | Reset ya existe (`zoom.reset()`); falta rama **Ctrl** (bug #1) + indicador (bug #3). |
| DoD: funciona en Mac Y Windows/Linux | **Bug #1** — trabajo real. |
| DoD: preferencia persiste al reiniciar | **Ya funciona** (localStorage). |

## Verificación

- **Bug #1:** test unitario del predicado de atajo (Cmd Y Ctrl disparan zoom;
  Cmd+Shift+= no rompe). El resto es manual: Ctrl+= en Linux/Windows escala.
- **Bug #2:** QA visual contra `ui-normal.png` / `ui-zoom-cropped.png` en zoom
  0.6 y 2.0; assert de que `#status-bar` es visible y su contenido trunca.
- **Bug #3:** manual — el pill aparece y se desvanece; muestra el % correcto.

## Pregunta abierta

Bug #2 necesita **reproducción en la app real** para fijar la causa exacta del
recorte antes de escribir el fix (el grid ya está correcto, así que es contenido
o titlebar). Se resuelve en la fase de plan/implementación, no bloquea este spec.
