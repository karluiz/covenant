// Turn-level aggregation for the Activity sidebar.
//
// The backend heartbeats `notch:state` every ~3s per session (same phase
// re-emitted), so rendering raw phase events produces a metronome of
// "thinking" rows. This module folds the phase stream into TURNS — one
// entry per agent work cycle — and keeps only *meaningful* events inside
// each turn (commands run, files written, waits, done). `thinking` never
// creates an event: it only advances the turn's clock and token counter.
// `reading` collapses into a distinct-file counter.
//
// Pure data layer: no DOM, no Tauri. See
// docs/superpowers/specs/2026-07-14-activity-turns-design.md.

import type { ExecutorPhase } from "../../notch/store";

export type TurnEventKind = "run" | "write" | "wait" | "done";

export interface TurnEvent {
  ts: number;
  kind: TurnEventKind;
  label: string;
}

export type TurnStatus = "live" | "done" | "ended";

export interface Turn {
  id: string;
  session: string;
  /// Tab label ("COVENANT › karlTerminal"). Updated on every push so
  /// renames propagate.
  tag: string;
  agent: string | null;
  startedAt: number;
  /// Set when the turn freezes (done or idle-out); null while live.
  endedAt: number | null;
  lastTs: number;
  tokens: number;
  events: TurnEvent[];
  /// True once MAX_EVENTS forced us to drop the oldest events.
  eventsDropped: boolean;
  /// Distinct files seen in `reading` phases this turn.
  readFiles: Set<string>;
  status: TurnStatus;
  /// True while the current phase is `waiting` (needs the user).
  waiting: boolean;
}

export interface PhasePush {
  session: string;
  tag: string;
  agent: string | null;
  phase: ExecutorPhase;
  tokens: number;
}

const MAX_TURNS = 30;
const MAX_EVENTS = 50;

export class TurnAggregator {
  /// Chronological, oldest first. Render reversed.
  readonly turns: Turn[] = [];
  private live = new Map<string, Turn>();
  private nextId = 1;

  clear(): void {
    this.turns.length = 0;
    this.live.clear();
  }

  push(p: PhasePush, now: number): void {
    const kind = p.phase.kind;

    if (kind === "idle") {
      // Idle without a live turn is just the executor being quiet — skip.
      const open = this.live.get(p.session);
      if (open) this.freeze(open, "ended", now);
      return;
    }
    if (kind === "done" && !this.live.has(p.session)) {
      // Done replayed on startup (notch_ready) with no turn in progress —
      // nothing to attribute it to.
      return;
    }

    let turn = this.live.get(p.session);
    if (!turn) {
      turn = {
        id: String(this.nextId++),
        session: p.session,
        tag: p.tag,
        agent: p.agent,
        startedAt: now,
        endedAt: null,
        lastTs: now,
        tokens: 0,
        events: [],
        eventsDropped: false,
        readFiles: new Set(),
        status: "live",
        waiting: false,
      };
      this.live.set(p.session, turn);
      this.turns.push(turn);
      if (this.turns.length > MAX_TURNS) {
        const evicted = this.turns.splice(0, this.turns.length - MAX_TURNS);
        for (const t of evicted) {
          if (this.live.get(t.session) === t) this.live.delete(t.session);
        }
      }
    }

    turn.tag = p.tag;
    if (p.agent) turn.agent = p.agent;
    turn.lastTs = now;
    turn.tokens += p.tokens;
    turn.waiting = kind === "waiting";

    switch (p.phase.kind) {
      case "thinking":
        break;
      case "reading":
        turn.readFiles.add(p.phase.file);
        break;
      case "running":
        this.addEvent(turn, "run", `running ${p.phase.cmd}`, now);
        break;
      case "writing":
        this.addEvent(turn, "write", `writing ${p.phase.file}`, now);
        break;
      case "waiting":
        this.addEvent(turn, "wait", `waiting · ${p.phase.reason}`, now);
        break;
      case "done":
        this.addEvent(
          turn,
          "done",
          p.phase.summary ? `done · ${p.phase.summary}` : "done",
          now,
        );
        this.freeze(turn, "done", now);
        break;
    }
  }

  private addEvent(turn: Turn, kind: TurnEventKind, label: string, now: number): void {
    const last = turn.events[turn.events.length - 1];
    // ponytail: heartbeats re-emit the same phase every ~3s and are
    // indistinguishable from a genuine immediate re-run, so consecutive
    // same-label events merge with no ×n counter.
    if (last && last.kind === kind && last.label === label) {
      last.ts = now;
      return;
    }
    turn.events.push({ ts: now, kind, label });
    if (turn.events.length > MAX_EVENTS) {
      turn.events.splice(0, turn.events.length - MAX_EVENTS);
      turn.eventsDropped = true;
    }
  }

  private freeze(turn: Turn, status: "done" | "ended", now: number): void {
    turn.status = status;
    turn.endedAt = now;
    turn.waiting = false;
    this.live.delete(turn.session);
  }
}

/// Latest meaningful event label, for the collapsed row's live tail.
/// A turn that has only thought so far reads "thinking".
export function liveTail(turn: Turn): string {
  const last = turn.events[turn.events.length - 1];
  return last ? last.label : "thinking";
}
