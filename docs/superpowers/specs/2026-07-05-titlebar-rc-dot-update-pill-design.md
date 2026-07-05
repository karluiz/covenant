# Titlebar: RC presence dot docks inside the update pill

**Date:** 2026-07-05 · **Status:** approved (option picked via preview)

## Problem

`#app-titlebar-center` holds the COVENANT brand plus the RC presence dot.
When an update arrives, `showUpdateBanner` hides the brand and appends the
update capsule — leaving the red RC dot as an orphaned blob floating beside
the capsule, its red pulse competing with the capsule's blue pulse.

## Design (approved)

While the update banner is mounted, the RC dot lives **inside** the capsule,
at its left edge, before the blue pulse: one coherent capsule. The dot keeps
its identity (red, pulsing) and its full behavior (hover popover, click-pin,
kill switch) — only its parent changes.

- `showUpdateBanner` adopts an already-mounted `#rc-presence-dot` by
  prepending it into the banner; dismissing the banner returns the dot to
  `#app-titlebar-center`.
- `mountRemotePresenceDot` prefers an existing banner as mount host (covers
  the reverse race: banner shown before the dot mounts).
- CSS: inside `.update-banner` the dot drops its `margin-left: 8px` (the
  capsule's flex gap spaces it).
- Popover positioning already uses `getBoundingClientRect` — parent-agnostic.

## Testing

Vitest, extending the existing DOM-harness pattern:
- banner shown while dot exists → dot's parent is the banner; dismiss → back
  in `#app-titlebar-center`.
- dot mounted while banner exists → dot lands inside the banner.
