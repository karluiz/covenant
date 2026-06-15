import type { StreamState } from './stream-state';
import { SECTIONS } from './sections';

/** Mount the right-side SPECIFICATION panel + section nav spine.
 *  `onPersist` (optional) is called with rebuilt canonical markdown whenever the
 *  user edits a section body, so the caller can persist it to disk. */
export function mountLiveSpec(
  host: HTMLElement,
  state: StreamState,
  onPersist?: (markdown: string) => void,
): () => void {
  const spine = document.createElement('div');
  spine.className = 'spine';
  const spec = document.createElement('div');
  spec.className = 'spec';
  for (const s of SECTIONS) {
    const node = document.createElement('div');
    node.className = 'node'; node.dataset.key = s.key;
    node.innerHTML = `<span class="dot"></span><span class="label">${s.title}</span>`;
    spine.appendChild(node);

    const sec = document.createElement('div');
    sec.className = 'sec'; sec.dataset.key = s.key;
    sec.innerHTML = `<div class="stitle"><span class="badge"></span>${s.title}</div>`
      + `<div class="content" tabindex="0"><div class="ghost"><span></span><span></span><span></span></div></div>`;
    spec.appendChild(sec);

    // Commit an edit on blur: overwrite the section and persist rebuilt markdown.
    const content = sec.querySelector('.content') as HTMLElement;
    content.addEventListener('blur', () => {
      if (content.contentEditable !== 'true') return;
      const md = (content.textContent ?? '').trim();
      const cur = state.section(s.key);
      if (!cur || cur.markdown === md) return;
      const rebuilt = state.editSection(s.key, md);
      onPersist?.(rebuilt);
    });
  }
  host.appendChild(spine);
  host.appendChild(spec);

  const render = () => {
    const active = state.activePhase();
    spine.querySelectorAll<HTMLElement>('.node').forEach((n) => {
      const view = state.section(n.dataset.key as never);
      n.classList.toggle('active', n.dataset.key === active);
      n.classList.toggle('done', view?.status === 'done');
    });
    for (const s of SECTIONS) {
      const view = state.section(s.key);
      if (!view) continue;
      const sec = spec.querySelector<HTMLElement>(`.sec[data-key="${s.key}"]`)!;
      const content = sec.querySelector('.content') as HTMLElement;
      // Anti-clobber: never overwrite the body the user is actively editing.
      if (document.activeElement !== content) content.textContent = view.markdown;
      content.contentEditable = view.status === 'done' ? 'true' : 'false';
      sec.classList.toggle('active', s.key === active);
      sec.classList.toggle('done', view.status === 'done');
      if (view.status === 'done') sec.querySelector('.badge')!.textContent = '✓';
    }
  };
  const off = state.onChange(render);
  render();
  return () => { off(); host.removeChild(spine); host.removeChild(spec); };
}
