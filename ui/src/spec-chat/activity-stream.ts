import type { StreamState } from './stream-state';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function mountActivityStream(host: HTMLElement, state: StreamState): () => void {
  const stream = document.createElement('div');
  stream.className = 'stream';
  host.appendChild(stream);

  const render = () => {
    const parts: string[] = [];

    // Committed conversation turns.
    for (const m of state.messages()) {
      const cls = m.role === 'user' ? 'bubble user' : 'bubble asst';
      parts.push(`<div class="item"><div class="${cls}">${esc(m.content)}</div></div>`);
    }

    // Live reasoning for the current turn.
    const think = state.thinking();
    if (think) {
      parts.push(
        `<div class="item"><div class="think collapsed">` +
        `<div class="head"><span class="chev">▶</span> thinking</div>` +
        `<div class="body">${esc(think)}</div></div></div>`,
      );
    }

    // Live tool activity.
    for (const t of state.tools()) {
      const hit = t.summary ? `<span class="hit">${esc(t.summary)}</span>` : '';
      const running = t.summary == null ? ' running' : '';
      parts.push(
        `<div class="item"><div class="tool${running}">` +
        `<span class="verb">${esc(t.tool)}</span> <span class="path">${esc(t.arg)}</span>${hit}` +
        `</div></div>`,
      );
    }

    // Streaming assistant answer (not yet committed).
    const live = state.text();
    if (live) {
      parts.push(`<div class="item"><div class="bubble asst typing">${esc(live)}</div></div>`);
    }

    // Error surface.
    const err = state.error();
    if (err) {
      parts.push(`<div class="item"><div class="bubble error">⚠ ${esc(err)}</div></div>`);
    }

    // Empty state.
    if (parts.length === 0) {
      parts.push(`<div class="empty-hint">Describe the problem and the agent will explore your repo.</div>`);
    }

    stream.innerHTML = parts.join('');
    // Keep the thinking block expandable.
    const thinkEl = stream.querySelector('.think');
    thinkEl?.querySelector('.head')?.addEventListener('click', () =>
      thinkEl.classList.toggle('collapsed'));
    stream.scrollTop = stream.scrollHeight;
  };

  const off = state.onChange(render);
  render();
  return () => { off(); host.removeChild(stream); };
}
