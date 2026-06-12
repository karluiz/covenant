# Spec Creator — Constellation Entrance

**Date:** 2026-06-12
**Status:** Approved (direction + light-theme variant confirmed by Karluiz)

## Problem

The Spec Creator entrance (`renderChooser()` in `ui/src/spec-chat/index.ts:151-256`) is a flat
modal: plain buttons on a dim scrim. The immersive creator behind it has a strong visual language
(blue `#7c8cff` accent, pulsing spark, glow shadows, spring-curve rise animations) but the door to
it sells none of that. The entrance should feel premium and animated — something that makes you
want to open it again.

## Direction (chosen)

**Constellation** — a full-bleed takeover, like the immersive itself. The entrance becomes the
"lobby" of the immersive creator: a living particle sky behind centered content. Drafts float as
rich cards; a hero CTA anchors the room.

## Scope

- New module `ui/src/spec-chat/entrance.ts` + `ui/src/spec-chat/entrance.css` (imported the same
  way `immersive.css` is).
- `renderChooser()` in `index.ts` delegates to `mountSpecEntrance(drafts, callbacks)`. Controller
  logic, draft listing (`specAuthorListDrafts`), and the no-drafts → straight-to-immersive path are
  unchanged.
- Old `.spec-chat-chooser*` CSS in `styles.css` (≈12886–13018, including light-theme overrides) is
  retired with the old markup.

Out of scope: any change to the immersive creator itself, draft persistence/API, or the blank
wizard.

## Structure

Fixed root below the titlebar (`top: 38px; left/right/bottom: 0`), z-index 10100 (same layer as
the current chooser):

```
.spec-entrance
├─ .scrim                  deep dark scrim, blur
├─ canvas.sky              particle field
└─ .content                centered column
   ├─ .brand               pulsing spark + "Spec Creator" + lead line
   ├─ .drafts              up to 3 draft cards, horizontal row (wraps)
   ├─ .cta                 hero "✦ Start a new spec"
   ├─ .blank               quiet "blank draft (no chat)" text link
   └─ .kbd-hint            "esc", bottom corner
```

## The sky (canvas)

- ~80 particles, slow drift with edge wraparound; faint accent tint (`#7c8cff` at 4–12% alpha).
- Lines drawn between particle pairs closer than ~110px — the constellation effect.
- DPR-aware sizing; re-sized on container resize.
- `requestAnimationFrame` loop, cancelled on close (no leaks).
- `prefers-reduced-motion`: no animation loop — render one static frame of dots.
- jsdom guard: `canvas.getContext('2d')` returning null → skip all drawing (tests stay green).

## Content details

**Brand.** Spark icon reusing the immersive `pulse` animation + accent drop-shadow glow.
"Spec Creator" title with a subtle gradient-text shimmer. Lead line: "what do you want to build?".

**Draft cards** (up to 3, most recent first — same data as today):
- Summary: first user message, 2-line clamp (replaces today's truncate-at-60-chars inline text).
- Meta row: message count + relative age (`relativeTime`, reused).
- Progress strip: 6 dots mapped to the known spec sections (Goal, Out of scope, Acceptance,
  File boundaries, Complexity, Open questions); a dot is filled when the matching `##` header
  exists in `partial_md`. Cheap string check, no new API.
- Trash button revealed on hover; delete behavior identical to today (re-render; deleting the
  last draft jumps straight to the immersive).
- Hover: `translateY(-3px)` lift + accent border glow. Click anywhere on the card resumes.

**Hero CTA.** "✦ Start a new spec" — accent gradient pill, glow shadow, periodic shimmer sweep
(CSS animation, disabled under reduced motion).

**Blank draft.** Quiet text link beneath the CTA. Hierarchy: CTA loudest, drafts second, blank a
whisper.

## Choreography

- Open: `.open` class added on the next animation frame (same pattern as `immersive.ts`).
  Scrim + sky fade in (~400ms) → brand rises → draft cards stagger-rise 60ms apart → CTA lands
  last with a soft glow bloom. Spring curve `cubic-bezier(.18,.7,.27,1)` to match the immersive.
- Close: ~300ms reverse fade, then DOM removal + rAF cancel + listener cleanup.
- All entrance animations are pure CSS keyed off `.open`; only the sky uses JS animation.

## Behavior contract (preserved)

Identical to today, verified by the existing test suite adapted to new class names:

1. No in-progress drafts → immersive opens directly, no entrance shown.
2. In-progress drafts → entrance shows them (most recent 3).
3. Click a draft → entrance closes, immersive mounts with that `draftId`.
4. "Blank draft (no chat)" → `openBlankWizard()`, entrance closes.
5. Publish flow → `openWizardWithBody()` + `markPublished()` (untouched).
6. Esc → dismiss. Backdrop/sky click (outside `.content` interactive elements) → dismiss.
7. Delete the only draft → entrance closes, immersive opens.
8. Delete one of several → card removed, entrance stays.

All 9 scenarios in `ui/src/spec-chat/index.test.ts` are kept, none dropped; selectors updated.
New small unit coverage: progress-dot derivation from `partial_md` headers.

## Theming

- **Dark (default):** scoped palette matching `immersive.css` tokens — near-black blue-tinted
  surfaces, `#7c8cff` accent.
- **True Dark / OLED:** pure-black sky; card/CTA surfaces use neutral (text-primary–derived)
  lifts, not accent tints, per the established True Dark rule.
- **Light theme:** a proper light variant (not dark-always): pale sky (paper-white with a faint
  blue-tinted gradient), particles at deeper accent alpha so they read on light ground, white
  cards with soft shadows, dark text. Keyed off the same body-level light-theme selector used by
  the existing light overrides being retired.

## Error handling

- Canvas unavailable (jsdom, exotic webview state): entrance still fully functional, just no sky.
- Zero drafts after a delete race: same as today — close entrance, open immersive.
- All listeners (`keydown`, resize observer, rAF) torn down in a single `close()` path.

## Testing

- Adapt the 9 existing entrance tests in `index.test.ts` to the new DOM.
- Add: progress-dot derivation unit test; reduced-motion guard (no rAF scheduled when matchMedia
  reports reduce); close cancels rAF (spy).
- Manual in-app verification pass (open/close, hover states, all three themes) before merge.
