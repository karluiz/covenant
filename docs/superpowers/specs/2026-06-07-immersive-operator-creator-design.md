# Immersive Operator Creator — Design

**Date:** 2026-06-07
**Status:** Approved, pre-implementation

## Goal

Bring the "premium creation" feel of the Spec Creator (`ui/src/spec-chat/immersive.*`)
to the operator create/edit experience. Today's editor lives in a cramped
75vw right-anchored drawer (`.op-modal*` in `ui/src/settings/operators.ts`).
Replace that drawer with a full-screen immersive shell that organizes the form
into clear sections so operators can be authored "de forma correcta."

This is a **layout + visual-polish reskin**. The form's data model and save
logic are reused verbatim. No new fields, no streaming, no agent.

## Layout — Option C: nav rail + controls + live SOUL

```
.op-creator (fixed top:38px → bottom, z above panels, like .spec-creator)
 ├─ .scrim                          blur backdrop, opacity fade-in
 └─ .creator (role=dialog, scale-in)
     ├─ header
     │   ├─ .brand        ✦ New operator  /  Edit operator
     │   ├─ .op-hero-chip live operator chip (avatar + name + color), updates live
     │   └─ .kbd          esc
     ├─ .stage  (3-col grid: rail / controls / soul)
     │   ├─ .op-rail        Start* · Identity · Behaviour · The Soul   (*create only)
     │   ├─ .op-section     active section's controls (middle)
     │   └─ .op-soul-live   rendered SOUL.md (live) + ▾ SOUL.md source toggle
     └─ footer .op-creator-foot
         └─ Set-as-default · Cancel · Delete(edit only) · Save operator
```

Both **create and edit** use this shell. The old drawer is removed.

## Visual language (lifted from immersive.css)

- Scrim: blur + opacity fade-in; click-scrim closes.
- `.creator`: `scale(.94) translateY(14px) → scale(1) translateY(0)` entry,
  matching exit on close (animate out, then `remove()` after ~420ms).
- Dark gradient background, hairline accent borders, focus-within glow on
  inputs, section panels rise-in.
- Accent tint derives from the operator's chosen color (reuse the existing
  `--operator-color` hero tinting).
- **Rail = the "spine" equivalent**: clickable section nav; active item gets the
  accent glow; a filled/check dot once a section has content.

## Sections & component mapping

All existing renderers in `operators.ts` are reused; only their container DOM
and the surrounding shell change.

- **Start** (create only): existing `renderArchetypeGallery` becomes the landing
  section — archetype cards + `＋ Blank`. Picking one seeds `soulRaw` and advances
  the rail to Identity. Edit mode omits Start and starts on Identity.
- **Identity**: name, avatar grid (`AVATAR_PACK_V2`, hover pose-cycle kept),
  color swatches, tags. Reuses the Identity block of `paintControls`.
- **Behaviour**: voice, model, escalate-threshold slider, collapsible
  hard-constraints. Reuses the Behaviour block.
- **The Soul**: the `.op-soul-body` prose textarea (large, focused) in the middle
  column. The right `.op-soul-live` pane is **always visible** regardless of the
  active section: live `marked`-rendered SOUL.md + collapsible `SOUL.md source`
  textarea (today's `rawDetails`).

## State, save, plumbing

- Keep the `SoulView` ↔ `soulRawFromView` model and `commit(repaintControls)`
  regeneration verbatim. Only the DOM layout changes.
- Rail switching shows/hides section panels (no full rebuild for nav). `commit()`
  still repaints the active section + hero chip + live pane. Preserve the
  focused-field caret guard (skip `paintControls` while a text field is focused).
- Async `operatorSoulRead` seeding (edit + duplicate) stays as-is.
- **Footer button classes must stay** `op-modal-save` / `op-modal-delete`, OR the
  `OperatorsPane.openModalWith` hooks (operators.ts ~lines 98–160, which
  `querySelector(".op-modal-save")` / `.op-modal-delete` and wrap save/delete)
  must be updated in lockstep. Pick one and keep them consistent.
- Esc closes via a capture-phase `keydown` listener (like immersive).

## Styling

- New file `ui/src/settings/operator-creator.css`, imported by `operators.ts`.
- Remove the old `.op-modal*` drawer rules from `operator_chip.css` (and any
  now-dead selectors), keeping shared chip styles.

## Out of scope (YAGNI)

- No new operator fields.
- No streaming / agent / live reasoning pane (that's Spec Creator's domain).
- No wizard step-gating — rail is free navigation, not a forced sequence.

## Header decisions (resolved)

- Live operator chip lives in the **header** (`.op-hero-chip`), not inside Identity.
- Styles go in a **separate** `operator-creator.css`, not appended to `operator_chip.css`.
