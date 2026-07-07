/// Somnus JSON explorer — collapsible tree over a parsed JSON value.
/// Native <details>/<summary> does the folding; children are built lazily on
/// first open so a 500 KB payload doesn't explode the DOM up front.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

// ponytail: hard caps instead of virtualization — paginate if real payloads hit them
const CHILD_CAP = 500;
const STR_CAP = 2000;

/// Parse a response body into JSON if it plausibly is JSON; undefined otherwise.
export function parseJsonBody(body: string): Json | undefined {
  const t = body.trim();
  if (!t || (t[0] !== "{" && t[0] !== "[")) return undefined;
  try {
    return JSON.parse(t) as Json;
  } catch {
    return undefined;
  }
}

function span(cls: string, text: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = cls;
  el.textContent = text;
  return el;
}

function leafValue(value: null | boolean | number | string): HTMLSpanElement {
  if (value === null) return span("jt-null", "null");
  switch (typeof value) {
    case "boolean":
      return span("jt-bool", String(value));
    case "number":
      return span("jt-num", String(value));
    default: {
      const s = value.length > STR_CAP ? `${value.slice(0, STR_CAP)}…` : value;
      return span("jt-str", JSON.stringify(s));
    }
  }
}

/// Build one tree node. Objects/arrays render as <details>; the root is open
/// (and eagerly built), everything deeper builds its children on first toggle.
export function jsonTree(value: Json, key: string | null = null, open = true): HTMLElement {
  if (value !== null && typeof value === "object") {
    const entries: ReadonlyArray<readonly [string, Json]> = Array.isArray(value)
      ? value.map((v, i) => [String(i), v] as const)
      : Object.entries(value);
    const det = document.createElement("details");
    det.className = "jt-node";
    const sum = document.createElement("summary");
    if (key !== null) sum.append(span("jt-key", key));
    sum.append(span("jt-badge", Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`));
    const kids = document.createElement("div");
    kids.className = "jt-children";
    det.append(sum, kids);
    let built = false;
    const build = (): void => {
      if (built) return;
      built = true;
      for (const [k, v] of entries.slice(0, CHILD_CAP)) kids.append(jsonTree(v, k, false));
      if (entries.length > CHILD_CAP) {
        kids.append(span("jt-more", `… ${entries.length - CHILD_CAP} more (of ${entries.length})`));
      }
    };
    if (open) {
      det.open = true;
      build();
    } else {
      det.addEventListener("toggle", build, { once: true });
    }
    return det;
  }
  const row = document.createElement("div");
  row.className = "jt-leaf";
  if (key !== null) row.append(span("jt-key", key));
  row.append(leafValue(value));
  return row;
}
