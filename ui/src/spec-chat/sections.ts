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
