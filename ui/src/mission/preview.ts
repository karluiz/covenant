/// Minimal markdown → HTML for the mission preview pane. Specs are
/// authored by us, not user input — but we still HTML-escape every
/// segment before applying markup, defense-in-depth. Supports: ATX
/// headings (#/##/###), paragraphs, unordered lists (- or *), ordered
/// lists (1. 2. …), GFM tables (| … | with a |---| separator), fenced
/// code (```), inline `code`, **bold**, *italic*. Anything else passes
/// through escaped.
export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block.
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
        buf.push(lines[i]!);
        i++;
      }
      i++; // skip closing fence (or eof)
      out.push(`<pre><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }

    // Headings.
    const h = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      out.push(`<h${level}>${inline(escapeHtml(h[2]!))}</h${level}>`);
      i++;
      continue;
    }

    // Unordered list — consume contiguous `- ` / `* ` lines.
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i]!)) {
        const m = /^[-*]\s+(.*)$/.exec(lines[i]!)!;
        items.push(`<li>${inline(escapeHtml(m[1]!))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // Ordered list — consume contiguous `1. ` / `2. ` … lines.
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i]!)) {
        const m = /^\d+\.\s+(.*)$/.exec(lines[i]!)!;
        items.push(`<li>${inline(escapeHtml(m[1]!))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    // GFM table — a `| … |` header row immediately followed by a
    // `|---|:--:|` alignment separator row.
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]!)) {
      const headers = splitRow(line);
      const aligns = splitRow(lines[i + 1]!).map(alignOf);
      i += 2;
      const bodyRows: string[] = [];
      while (i < lines.length && lines[i]!.trim() !== "" && lines[i]!.includes("|")) {
        const cells = splitRow(lines[i]!);
        const tds = headers
          .map((_, k) => `<td${alignAttr(aligns[k])}>${inline(escapeHtml(cells[k] ?? ""))}</td>`)
          .join("");
        bodyRows.push(`<tr>${tds}</tr>`);
        i++;
      }
      const ths = headers
        .map((c, k) => `<th${alignAttr(aligns[k])}>${inline(escapeHtml(c))}</th>`)
        .join("");
      out.push(
        `<table><thead><tr>${ths}</tr></thead><tbody>${bodyRows.join("")}</tbody></table>`,
      );
      continue;
    }

    // Blank line — paragraph separator.
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph — consume contiguous non-blank, non-special lines.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !/^```/.test(lines[i]!) &&
      !/^#{1,3}\s+/.test(lines[i]!) &&
      !/^[-*]\s+/.test(lines[i]!) &&
      !/^\d+\.\s+/.test(lines[i]!) &&
      !(lines[i]!.includes("|") && isTableSep(lines[i + 1] ?? ""))
    ) {
      para.push(lines[i]!);
      i++;
    }
    out.push(`<p>${inline(escapeHtml(para.join(" ")))}</p>`);
  }

  return out.join("\n");
}

// A GFM table separator row: cells of only dashes/colons/spaces, ≥1 dash.
// ponytail: enough for our own specs; no multi-line-cell / escaped-pipe support.
function isTableSep(line: string): boolean {
  return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line) && line.includes("-");
}

// Split `| a | b |` → ["a", "b"], tolerating missing outer pipes.
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

type Align = "left" | "center" | "right" | "";
function alignOf(sepCell: string): Align {
  const l = sepCell.startsWith(":");
  const r = sepCell.endsWith(":");
  if (l && r) return "center";
  if (r) return "right";
  if (l) return "left";
  return "";
}
function alignAttr(a: Align | undefined): string {
  return a ? ` style="text-align:${a}"` : "";
}

function inline(s: string): string {
  // Order matters: code first (so its contents are protected from bold/italic).
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return s;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[c]!));
}
