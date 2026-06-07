import type { StreamState } from './stream-state';
import type { SpecSectionKey } from './events';

const SECTIONS: { key: SpecSectionKey; title: string }[] = [
  { key: 'goal', title: 'Goal' },
  { key: 'out_of_scope', title: 'Out of scope' },
  { key: 'acceptance', title: 'Acceptance criteria' },
  { key: 'file_boundaries', title: 'File boundaries' },
  { key: 'complexity', title: 'Complexity' },
  { key: 'open_questions', title: 'Open questions' },
];

export function mountLiveSpec(host: HTMLElement, state: StreamState): () => void {
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
      + `<div class="content"><div class="ghost"><span></span><span></span><span></span></div></div>`;
    spec.appendChild(sec);
  }
  host.appendChild(spine);
  host.appendChild(spec);

  const render = () => {
    const active = state.activePhase();
    spine.querySelectorAll<HTMLElement>('.node').forEach((n) =>
      n.classList.toggle('active', n.dataset.key === active));
    for (const s of SECTIONS) {
      const view = state.section(s.key);
      if (!view) continue;
      const sec = spec.querySelector<HTMLElement>(`.sec[data-key="${s.key}"]`)!;
      sec.querySelector('.content')!.textContent = view.markdown;
      sec.classList.toggle('active', s.key === active);
      sec.classList.toggle('done', view.status === 'done');
      if (view.status === 'done') sec.querySelector('.badge')!.textContent = '✓';
    }
  };
  const off = state.onChange(render);
  render();
  return () => { off(); host.removeChild(spine); host.removeChild(spec); };
}
