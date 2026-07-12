// The one markdown renderer. Every surface that shows rendered markdown
// (changelog, ACP agent prose, mission viewer, spec picker preview, canon
// reader) goes through here — do not fork per-surface renderers again.
//
// Scope:
//   # / ## / ### / #### headings
//   bullet lists (`-` or `*`) and ordered lists (1. 2. …)
//   inline `code`, **bold**, *italic*
//   bare links [text](url)
//   horizontal rules (---)
//   GFM tables (| a | b | + |---|:--:| separator, alignment honored)
//   fenced code (``` or ~~~, optional lang → `lang-<x>` class)
//   paragraphs separated by blank lines
//
// We deliberately avoid pulling in a full markdown library — the inputs
// are our own specs/changelogs plus agent prose, and a small custom
// parser saves ~20 KB and one more dep to keep in sync. If the format
// ever needs images or footnotes, swap to `marked`.
//
// Output is safe to drop into innerHTML — text is escaped before
// formatting, and the only HTML produced is from our own templates.

const ESCAPE_RE = /[&<>"']/g;
const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function esc(s: string): string {
  return s.replace(ESCAPE_RE, (c) => ESCAPE_MAP[c]);
}

/// Inline transforms run on already-escaped text. Order matters: code
/// spans first (so their content doesn't get re-formatted), then bold,
/// italic, then links.
function inline(s: string): string {
  let out = esc(s);
  out = out.replace(/`([^`]+)`/g, (_, c: string) => `<code>${c}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  out = out.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, label: string, url: string) =>
      `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`,
  );
  return out;
}

// ponytail: escaped pipes (\|) inside cells are not supported. Add if
// agent output hits it.
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;

/// Split `| a | b |` into trimmed cell strings, tolerating missing
/// boundary pipes.
function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
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

export function renderMarkdown(src: string): string {
  const lines = src.split(/\r?\n/);
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let inPara: string[] = [];

  const flushPara = (): void => {
    if (inPara.length === 0) return;
    out.push(`<p>${inline(inPara.join(" "))}</p>`);
    inPara = [];
  };
  const closeList = (): void => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  const openList = (kind: "ul" | "ol"): void => {
    if (list !== kind) {
      closeList();
      out.push(`<${kind}>`);
      list = kind;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, "");

    // Fenced code block (``` or ~~~). Greedy: scan until the matching
    // closing fence on its own line. Content goes into <pre><code>
    // un-formatted (no inline markdown inside code). Optional language
    // tag after the opening fence becomes a `lang-<x>` class so we
    // can style per-language later if we want.
    const fence = line.match(/^([`~]{3,})\s*([A-Za-z0-9_+-]*)\s*$/);
    if (fence) {
      flushPara();
      closeList();
      const closeRe = new RegExp(`^${fence[1].charAt(0)}{${fence[1].length},}\\s*$`);
      const lang = fence[2] ? ` class="lang-${esc(fence[2])}"` : "";
      const buf: string[] = [];
      i++;
      while (i < lines.length && !closeRe.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      // Trailing fence is consumed by the for-loop's i++; if EOF we
      // just stop.
      out.push(`<pre><code${lang}>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }

    if (line.trim() === "") {
      flushPara();
      closeList();
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushPara();
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    // GFM table: a row with pipes whose NEXT line is a |---|---|
    // separator. The separator needs at least one interior pipe (2+
    // columns), so a plain `---` hr never triggers this branch.
    if (line.includes("|") && TABLE_SEP_RE.test(lines[i + 1] ?? "")) {
      flushPara();
      closeList();
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map(alignOf);
      const rows: string[][] = [];
      i += 2; // skip header + separator
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(splitRow(lines[i]));
        i++;
      }
      i--; // the for-loop's i++ steps past the last row
      const ths = header
        .map((c, k) => `<th${alignAttr(aligns[k])}>${inline(c)}</th>`)
        .join("");
      const tbody = rows
        .map(
          (r) =>
            `<tr>${header.map((_, k) => `<td${alignAttr(aligns[k])}>${inline(r[k] ?? "")}</td>`).join("")}</tr>`,
        )
        .join("");
      out.push(`<table><thead><tr>${ths}</tr></thead><tbody>${tbody}</tbody></table>`);
      continue;
    }

    if (line.match(/^[-*]{3,}$/)) {
      flushPara();
      closeList();
      out.push("<hr>");
      continue;
    }

    const li = line.match(/^[-*]\s+(.*)$/);
    if (li) {
      flushPara();
      openList("ul");
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }

    const oli = line.match(/^\d+\.\s+(.*)$/);
    if (oli) {
      flushPara();
      openList("ol");
      out.push(`<li>${inline(oli[1])}</li>`);
      continue;
    }

    closeList();
    inPara.push(line.trim());
  }

  flushPara();
  closeList();
  return out.join("\n");
}
