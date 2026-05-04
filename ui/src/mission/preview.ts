/// Minimal markdown → HTML for the mission preview pane. Specs are
/// authored by us, not user input — but we still HTML-escape every
/// segment before applying markup, defense-in-depth. Supports: ATX
/// headings (#/##/###), paragraphs, unordered lists (- or *), fenced
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
      !/^[-*]\s+/.test(lines[i]!)
    ) {
      para.push(lines[i]!);
      i++;
    }
    out.push(`<p>${inline(escapeHtml(para.join(" ")))}</p>`);
  }

  return out.join("\n");
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
