# Beacon Run Taxonomy — Design (approved via artifact)

Date: 2026-07-12 · Approved mock: https://claude.ai/code/artifact/4f58336f-c078-4937-bff3-d2f98e5d086e
Frontend-only; consumes existing `beacon_run_jobs` data. Base: v0.9.8 (6238e7e4).

## Changes (all in `ui/src/beacon/panel.ts` + `beacon.css` unless noted)

1. **Meta strip, one line** — state renders as a pill (`.rail-pill` w/ busy/ok/fail variants,
   12% token bg), then `#run · ref (accent) · sha · actor`; strip is `overflow:hidden;
   white-space:nowrap`, actor is the flex item that truncates.
2. **Fixed grids per depth** — run row `18px chev · 1fr · auto time` (indent 10px); job head
   `26px glyph · 1fr name · auto count · 64px dur` (indent 24px); step `26px glyph · 1fr ·
   64px dur` (indent 50px). Durations right-aligned tabular in the shared 64px column.
3. **Spine** — 1px connector through step glyphs (`::before` on step/fold rows, glyph paints
   panel bg above it); run keeps its 2px `data-spine` edge.
4. **Ceremony folds** — pure `groupSteps(steps)`:
   - *post*: name starts with `"Post "` or equals `"Complete job"` (trailing run).
   - *setup*: LEADING consecutive steps whose name starts with `"Set up "` or `"Run actions/"`.
   - remainder = *work*, always rendered.
   Groups render one dim italic row `setup · N steps · Σdur` (fold), click toggles; fold-open
   state lives on BeaconPanel as `folds: Set<"runId:jobId:setup|post">`. A group containing a
   FAILED step never folds (renders inline).
5. **Now marker** — running step: `--lift` bg (`#171b22`-token: use existing `--bg-elevated`?
   No — compose `rgba(var(--ink-rgb),0.05)` per hard rule 3), 2px left `--running` edge, name
   `--fg` bold, duration in `--running` live.
6. **Job dashboard** — header shows `done/total` counter (done = `completed_at != null`) +
   2px progress bar (`--running` while job busy, `--ok` when done, `--fail` if job failed).
7. **Auto-expand on failure** — in fetch() ok-path: runs whose `stateDotColor === "bad"` and
   not yet auto-expanded this session (`autoOpenedFails: Set<runId>`) → add to `expanded` +
   refreshJobs. User collapse wins afterwards (set remembers).
8. **Failed step** — `✕` glyph + name in `--fail` bold. (Failure tail line from annotations
   API = v2, out of scope.)

Glyphs: `✓` ok · `✕` fail · pulsing 7px dot running · 6px hollow ring pending · `▸` fold.
Pills/edges/bars use only `--ok/--fail/--running`. Sharp corners. Reduced-motion kills pulse.

## Tests (panel.test.ts)
- `groupSteps`: setup leading-run heuristic, post trailing, failed-step-in-group → no fold,
  all-work passthrough.
- render: pill present w/ correct variant; meta strip single line (no wrap container);
  job counter + bar width; fold row renders w/ Σdur; clicking fold calls onToggleFold;
  running step gets `.is-now`; failed step `.is-fail-step`; pending dur "—".
- auto-expand: fetch-level logic exercised via exported helper if practical, else covered by
  unit on a pure `failedRunsToOpen(runs, alreadyOpened)`.
