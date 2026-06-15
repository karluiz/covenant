import type { SpecSectionKey } from './events';
import type { SectionView } from './stream-state';

/** Single source of truth for the spec section list + display titles. */
export const SECTIONS: { key: SpecSectionKey; title: string }[] = [
  { key: 'goal', title: 'Goal' },
  { key: 'out_of_scope', title: 'Out of scope' },
  { key: 'acceptance', title: 'Acceptance criteria' },
  { key: 'file_boundaries', title: 'File boundaries' },
  { key: 'complexity', title: 'Complexity' },
  { key: 'open_questions', title: 'Open questions' },
];

export function titleForKey(key: SpecSectionKey): string {
  return SECTIONS.find((s) => s.key === key)?.title ?? key;
}

export function keyForTitle(title: string): SpecSectionKey | null {
  const t = title.trim().toLowerCase();
  return SECTIONS.find((s) => s.title.toLowerCase() === t)?.key ?? null;
}

/** Drop a leading `## <heading>` line from a section body. The agent emits each
 *  section marker with its own `## Title` heading baked in, but the card already
 *  shows the title — and the canonical doc re-adds it on compose — so we store
 *  bodies header-less (consistent with `parseSectionsFromMarkdown`). */
export function stripLeadingHeading(md: string): string {
  return md.replace(/^\s*##\s+[^\n]*\n+/, '');
}

/** Split a spec markdown body on `## <Title>` headers into per-section bodies.
 *  Only known section titles are kept; unknown headers are skipped. Every
 *  parsed section is marked `done` (its header is present on disk). */
export function parseSectionsFromMarkdown(md: string | null): Map<SpecSectionKey, SectionView> {
  const map = new Map<SpecSectionKey, SectionView>();
  if (!md) return map;
  let curKey: SpecSectionKey | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (curKey) map.set(curKey, { markdown: buf.join('\n').trim(), status: 'done' });
  };
  for (const line of md.split('\n')) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      curKey = keyForTitle(m[1]);
      buf = [];
    } else if (curKey) {
      buf.push(line);
    }
  }
  flush();
  return map;
}

const KNOWN_KEYS = new Set<string>(SECTIONS.map((s) => s.key));

/** Extract `<!--section:KEY-->body<!--/section-->` blocks from agent prose. Used
 *  to rebuild section cards on resume from the transcript, since drafts authored
 *  via section markers never persist `partial_md` until a final/edit. Unknown
 *  keys and unclosed markers are skipped; bodies are stored header-less. */
export function parseSectionMarkers(text: string): { key: SpecSectionKey; markdown: string }[] {
  const OPEN = '<!--section:';
  const CLOSE = '<!--/section-->';
  const out: { key: SpecSectionKey; markdown: string }[] = [];
  let rest = text;
  for (;;) {
    const open = rest.indexOf(OPEN);
    if (open === -1) break;
    const after = rest.slice(open + OPEN.length);
    const keyEnd = after.indexOf('-->');
    if (keyEnd === -1) break;
    const rawKey = after.slice(0, keyEnd).trim();
    const body = after.slice(keyEnd + 3);
    const close = body.indexOf(CLOSE);
    if (close === -1) break;
    if (KNOWN_KEYS.has(rawKey)) {
      out.push({ key: rawKey as SpecSectionKey, markdown: stripLeadingHeading(body.slice(0, close).trim()) });
    }
    rest = body.slice(close + CLOSE.length);
  }
  return out;
}
