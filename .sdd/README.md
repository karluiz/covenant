# SDD workspace

This directory contains lightweight Spec-Driven Development context for Covenant.

## Steering documents

- `steering/product.md` — product vision, user value, scope guardrails.
- `steering/tech.md` — stack, architecture, safety constraints, validation commands.
- `steering/structure.md` — repository layout, file ownership, spec conventions.

## Feature specs

Canonical feature specs currently live in `docs/specs/` and use `docs/specs/_template.md`.
Use that location for implementation-ready specs unless the project explicitly migrates them here.

## Workflow

1. Start with the steering docs before proposing a feature.
2. Draft or update a spec in `docs/specs/` with clear acceptance criteria and file boundaries.
3. Keep implementation within the stated blast radius; escalate rather than silently expanding scope.
4. Validate with the narrowest relevant checks first, then broader checks when touching shared code.
