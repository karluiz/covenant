# Rail Homologation v1 — implementation plan

Unify the 6 right-rail panels onto one shared chrome (`.rail-*`). Each panel keeps
its purpose + accent; only the chrome converges. Branch: `worktree-rail-homologation`.

## Decisions (locked)
- **Beacon** → flat `.rail-row` with status spine (drop bordered cards).
- **Project Notes** → adopt `.rail-*` chrome only; keep its `position:fixed` overlay (do NOT degrid).
- **Scope** → foundation + migrate all 6, one branch, review at end.
- Titles in **UI-sans** (uppercase, tracked). Data/meta/numbers in **mono**.
- One status set: `--ok / --running / --fail / --accent / --idle`. Kill the 4 divergent greens + github palette + phantom `--text-secondary`/`--bg-elevated`.

## Slots
header(40px) · controls(36px, optional) · body(scroll) · empty(1 component) · footer(30px, optional).

## Tasks
1. **Foundation** (styles.css): add geometry/type/color tokens to `:root` (+ true-dark/light) and the `.rail-*` component block. *(me)*
2. **Recall** (recall/manager.ts + styles.css `.recall-*`): titled header + search→controls slot; rows→`.rail-row`; cmd text→`--fg`.
3. **Activity** (inline-notch.ts + styles.css `.inline-notch-*`): 64px avatar header→40px `.rail-header`; identity→`.rail-select` controls; feed→`.rail-row` spine in status tokens.
4. **Blocks** (blocks/manager.ts + styles.css `.blocks-*`): titled header; rows→`.rail-row` spine=exit status; running block spine=run.
5. **Beacon** (beacon/{panel.ts,beacon.css}): header icon-buttons; cards→`.rail-row` spine; github dots→app status tokens.
6. **Tasker** (tasker/{panel.ts,styles.css}): folder/board→`.rail-btn`; pills→`.rail-pill`; groups/tasks adopt shared group+task primitives; footer→`.rail-footer`.
7. **Notes/Covenant** (project-notes/{panel.ts,drafts-tab.ts,styles.css}): header dot+title sans + `.rail-btn`; tabs→`.rail-tabs`; empty→`.rail-empty`. Keep overlay.

## Constraints
- Keep vitest green (panels have tests asserting class names — update them).
- `attachTooltip` for header icon buttons (no native `title=`).
- tsc + vitest run from **repo root**, not ui/.
- Mock reference: `scratchpad/rail-homologation.html`.
