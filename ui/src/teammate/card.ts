// Parses operator `` ```card `` fenced blocks into segments and builds card
// HTML. Pure — no DOM, no panel dependencies. The caller supplies a
// `renderCell` that turns a raw cell string into safe inline HTML (panel.ts
// passes its existing inline renderer so code spans + mention chips work
// inside cells). renderCell MUST escape, since output is assigned via innerHTML.

export interface CardRow {
  label: string | null; // null => full-width cell
  value: string;
}

export type MessageSegment =
  | { kind: "prose"; text: string }
  | { kind: "card"; title: string | null; rows: CardRow[] };

const FENCE_OPEN = /^```card\b(.*)$/;
const FENCE_CLOSE = "```";

function parseTitle(info: string): string | null {
  const t = info.trim();
  if (!t) return null;
  return t.startsWith("title=") ? (t.slice("title=".length).trim() || null) : t;
}

function parseRow(line: string): CardRow {
  const idx = line.indexOf("|");
  if (idx < 0) return { label: null, value: line.trim() };
  return { label: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
}

export function splitMessageSegments(text: string): MessageSegment[] {
  const lines = text.split("\n");
  const segments: MessageSegment[] = [];
  let prose: string[] = [];

  const flushProse = () => {
    if (prose.length) {
      segments.push({ kind: "prose", text: prose.join("\n") });
      prose = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const open = lines[i].match(FENCE_OPEN);
    if (open) {
      // Find the closing fence.
      let close = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === FENCE_CLOSE) {
          close = j;
          break;
        }
      }
      if (close >= 0) {
        flushProse();
        const rows = lines
          .slice(i + 1, close)
          .filter((l) => l.trim() !== "")
          .map(parseRow);
        segments.push({ kind: "card", title: parseTitle(open[1]), rows });
        i = close + 1;
        continue;
      }
      // No closing fence: treat the open line as ordinary prose.
    }
    prose.push(lines[i]);
    i++;
  }
  flushProse();
  return segments;
}

export function renderCardHtml(
  card: Extract<MessageSegment, { kind: "card" }>,
  renderCell: (s: string) => string,
): string {
  let h = '<div class="teammate-card">';
  if (card.title) {
    h += `<div class="teammate-card__title">${renderCell(card.title)}</div>`;
  }
  for (const row of card.rows) {
    if (row.label === null) {
      h += `<div class="teammate-card__row"><span class="teammate-card__cell">${renderCell(row.value)}</span></div>`;
    } else {
      h += `<div class="teammate-card__row"><span class="teammate-card__label">${renderCell(row.label)}</span><span class="teammate-card__value">${renderCell(row.value)}</span></div>`;
    }
  }
  h += "</div>";
  return h;
}

export function renderCardSegments(
  text: string,
  renderCell: (s: string) => string,
): string {
  return splitMessageSegments(text)
    .map((seg) => (seg.kind === "card" ? renderCardHtml(seg, renderCell) : renderCell(seg.text)))
    .join("");
}
