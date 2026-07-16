// The soul's Reflexes layer, read as a delegation contract instead of raw
// markdown. The right pane parses the body's "don't ask" / "wake me" bullets
// and renders them as two scannable groups + the escalation threshold — the
// one view of a soul that shows something the prose editor can't.

import type { SoulView } from "../api";

export type Reflex = { action: string; result: string | null };
export type Reflexes = { yes: Reflex[]; escalate: Reflex[] };

// A `## heading` opens a bucket by its wording. ESCALATE is checked first so
// "only I can decide — wake me" wins over an incidental "decide".
const ESC_RE = /wake me|escalate|only i can decide|ask me|stop\b/i;
const YES_RE = /don'?t ask|handle it|already decided|always[- ]?yes|run them|just do/i;
const BULLET_RE = /^[-—*•]\s+(.*)$/;
const HEADING_RE = /^#{1,6}\s+(.*)$/;
const ARROW_RE = /\s*(?:→|->)\s*/;

/// Parse a soul body into the two reflex buckets. Bullets under a matched
/// heading are collected until the next heading; each splits on the first
/// arrow (`→`/`->`) into action / result (result null if no arrow).
export function parseReflexes(body: string): Reflexes {
  const yes: Reflex[] = [];
  const escalate: Reflex[] = [];
  let bucket: Reflex[] | null = null;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    const h = HEADING_RE.exec(line);
    if (h) {
      bucket = ESC_RE.test(h[1]) ? escalate : YES_RE.test(h[1]) ? yes : null;
      continue;
    }
    if (!bucket) continue;
    const b = BULLET_RE.exec(line);
    if (!b) continue;
    const parts = b[1].split(ARROW_RE);
    if (parts.length >= 2) {
      const result = parts.slice(1).join(" → ").trim();
      bucket.push({ action: parts[0].trim(), result: result || null });
    } else {
      bucket.push({ action: b[1].trim(), result: null });
    }
  }
  return { yes, escalate };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function group(title: string, kind: "yes" | "escalate", rows: Reflex[]): HTMLElement {
  const g = document.createElement("div");
  g.className = `op-reflex-group is-${kind}`;
  const head = document.createElement("div");
  head.className = "op-reflex-head";
  const dot = document.createElement("span");
  dot.className = "op-reflex-dot";
  const t = document.createElement("span");
  t.textContent = title;
  const count = document.createElement("span");
  count.className = "op-reflex-count";
  count.textContent = String(rows.length);
  head.append(dot, t, count);
  g.append(head);
  if (!rows.length) {
    const none = document.createElement("div");
    none.className = "op-reflex-none";
    none.textContent = "none";
    g.append(none);
  }
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "op-reflex-row";
    const a = document.createElement("span");
    a.className = "op-reflex-act";
    a.textContent = r.action;
    row.append(a);
    if (r.result) {
      const arr = document.createElement("span");
      arr.className = "op-reflex-arr";
      arr.textContent = "→";
      const res = document.createElement("span");
      res.className = "op-reflex-res";
      res.textContent = r.result;
      row.append(arr, res);
    }
    g.append(row);
  }
  return g;
}

/// Render the reflex ledger element for a soul view. Empty souls (no Reflexes
/// layer) get an authoring nudge instead of a blank pane.
export function renderReflexLedger(view: SoulView): HTMLElement {
  const { yes, escalate } = parseReflexes(view.body ?? "");
  const root = document.createElement("div");
  root.className = "op-reflex-root";

  if (!yes.length && !escalate.length) {
    const empty = document.createElement("div");
    empty.className = "op-reflex-empty";
    empty.textContent =
      "No reflexes yet — add a “## Reflexes” section with “don’t ask” and “wake me” bullets.";
    root.append(empty);
    return root;
  }

  root.append(group("Runs without asking", "yes", yes));
  root.append(group("Wakes you", "escalate", escalate));

  const th = clamp01(view.escalate_threshold ?? 0.6);
  const thresh = document.createElement("div");
  thresh.className = "op-reflex-thresh";
  const top = document.createElement("div");
  top.className = "op-reflex-thresh-top";
  const lbl = document.createElement("span");
  lbl.textContent = "Escalation threshold";
  const val = document.createElement("b");
  val.textContent = th.toFixed(2);
  top.append(lbl, val);
  const bar = document.createElement("div");
  bar.className = "op-reflex-bar";
  const fill = document.createElement("i");
  fill.style.width = `${Math.round(th * 100)}%`;
  bar.append(fill);
  const cap = document.createElement("div");
  cap.className = "op-reflex-cap";
  cap.textContent = `Acts autonomously on all but the top ${Math.round((1 - th) * 100)}% most-irreversible calls.`;
  thresh.append(top, bar, cap);
  root.append(thresh);
  return root;
}
