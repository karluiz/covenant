import type { StreamState } from './stream-state';

export function mountActivityStream(host: HTMLElement, state: StreamState): () => void {
  const stream = document.createElement('div');
  stream.className = 'stream';
  host.appendChild(stream);

  let thinkEl: HTMLElement | null = null;
  const toolEls = new Map<string, HTMLElement>();

  const render = () => {
    const think = state.thinking();
    if (think) {
      if (!thinkEl) {
        thinkEl = document.createElement('div');
        thinkEl.className = 'think collapsed';
        thinkEl.innerHTML = `<div class="head"><span class="chev">▶</span> thinking</div><div class="body"></div>`;
        thinkEl.querySelector('.head')!.addEventListener('click', () =>
          thinkEl!.classList.toggle('collapsed'));
        stream.appendChild(thinkEl);
      }
      thinkEl.querySelector('.body')!.textContent = think;
    }
    for (const t of state.tools()) {
      let row = toolEls.get(t.id);
      if (!row) {
        row = document.createElement('div');
        row.className = 'tool running';
        stream.appendChild(row);
        toolEls.set(t.id, row);
      }
      const hit = t.summary ? `<span class="hit">${t.summary}</span>` : '';
      row.innerHTML = `<span class="verb">${t.tool}</span> <span class="path">${t.arg}</span>${hit}`;
      row.classList.toggle('running', t.summary == null);
    }
    stream.scrollTop = stream.scrollHeight;
  };
  const off = state.onChange(render);
  render();
  return () => { off(); host.removeChild(stream); };
}
