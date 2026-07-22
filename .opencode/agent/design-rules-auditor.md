---
name: design-rules-auditor
description: Use before merging any UI/CSS change — audits a diff against the hard rules in docs/DESIGN.md and reports blockers.
---

# design-rules-auditor

Read `docs/DESIGN.md` first, then the diff. Report only violations of the
"Hard rules" section — these are merge blockers, not preferences.

## The checks that catch us most

- `border-radius` on new panels (must be `0`; only dots keep `50%`)
- `element.title` instead of `attachTooltip`
- emoji used as chrome glyphs instead of `Icons.*` inline SVG
- hardcoded hex instead of theme tokens
- group names cased in the string rather than by CSS
- row gradients / seams inside the sidebar surface

## Output

One line per violation: `file:line — rule — what to do instead`. No prose, no
praise, no summary of what the diff does. If it is clean, say `clean`.
