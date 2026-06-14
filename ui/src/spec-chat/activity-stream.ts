import type { StreamState } from './stream-state';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const itemFromHtml = (html: string): HTMLElement => {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d.firstElementChild as HTMLElement;
};

/** Mount the reasoning/exploration stream. Renders incrementally: committed
 *  turns are append-only and live nodes (thinking, tools, streaming text) are
 *  updated in place, so a fast token stream never rebuilds the whole DOM. */
export function mountActivityStream(host: HTMLElement, state: StreamState): () => void {
  const stream = document.createElement('div');
  stream.className = 'stream';
  host.appendChild(stream);

  // Live region pinned as the last child; committed items are inserted before it.
  const live = document.createElement('div');
  live.className = 'live';
  const thinkSlot = document.createElement('div');
  const toolsWrap = document.createElement('div');
  const textSlot = document.createElement('div');
  const errSlot = document.createElement('div');
  live.append(thinkSlot, toolsWrap, textSlot, errSlot);
  stream.appendChild(live);

  let committedCount = 0;
  let emptyEl: HTMLElement | null = null;
  let thinkBody: HTMLElement | null = null;
  let liveText: HTMLElement | null = null;
  let errEl: HTMLElement | null = null;
  const toolRows = new Map<string, { box: HTMLElement; verb: HTMLElement; path: HTMLElement; hit: HTMLElement }>();

  const renderCommitted = () => {
    const msgs = state.messages();
    // Committed turns are immutable & append-only; a shorter list means a
    // wholesale replace (hydrate/reset), so rebuild from scratch.
    if (msgs.length < committedCount) {
      while (stream.firstChild && stream.firstChild !== live) stream.removeChild(stream.firstChild);
      committedCount = 0;
    }
    for (let i = committedCount; i < msgs.length; i++) {
      const m = msgs[i]!;
      let el: HTMLElement;
      if (m.role === 'tool') {
        const path = m.arg ? ` <span class="path">${esc(m.arg)}</span>` : '';
        const hit = m.summary ? `<span class="hit">${esc(m.summary)}</span>` : '';
        el = itemFromHtml(
          `<div class="item"><div class="tool">` +
          `<span class="verb">${esc(m.tool)}</span>${path}${hit}</div></div>`);
      } else {
        el = itemFromHtml(`<div class="item"><div class="bubble ${m.role === 'user' ? 'user' : 'asst'}">${esc(m.content)}</div></div>`);
      }
      stream.insertBefore(el, live);
    }
    committedCount = msgs.length;
  };

  const renderThinking = () => {
    const think = state.thinking();
    if (think) {
      if (!thinkBody) {
        const el = itemFromHtml(
          `<div class="item"><div class="think collapsed">` +
          `<div class="head"><span class="chev">▶</span> thinking</div>` +
          `<div class="body"></div></div></div>`);
        const think_ = el.querySelector('.think')!;
        el.querySelector('.head')!.addEventListener('click', () => think_.classList.toggle('collapsed'));
        thinkBody = el.querySelector('.body') as HTMLElement;
        thinkSlot.appendChild(el);
      }
      thinkBody.textContent = think;
    } else if (thinkBody) {
      thinkSlot.replaceChildren();
      thinkBody = null;
    }
  };

  const renderTools = () => {
    const tools = state.tools();
    const seen = new Set<string>();
    for (const t of tools) {
      seen.add(t.id);
      let row = toolRows.get(t.id);
      if (!row) {
        const el = itemFromHtml(
          `<div class="item"><div class="tool">` +
          `<span class="verb"></span> <span class="path"></span><span class="hit"></span>` +
          `</div></div>`);
        row = {
          box: el.querySelector('.tool') as HTMLElement,
          verb: el.querySelector('.verb') as HTMLElement,
          path: el.querySelector('.path') as HTMLElement,
          hit: el.querySelector('.hit') as HTMLElement,
        };
        toolsWrap.appendChild(el);
        toolRows.set(t.id, row);
      }
      row.box.className = t.summary == null ? 'tool running' : 'tool';
      row.verb.textContent = t.tool;
      row.path.textContent = t.arg;
      row.hit.textContent = t.summary ?? '';
      row.hit.style.display = t.summary ? '' : 'none';
    }
    for (const [id, row] of toolRows) {
      if (!seen.has(id)) { row.box.closest('.item')?.remove(); toolRows.delete(id); }
    }
  };

  const renderLiveText = () => {
    const t = state.text();
    if (t) {
      if (!liveText) {
        const el = itemFromHtml(`<div class="item"><div class="bubble asst typing"></div></div>`);
        liveText = el.querySelector('.bubble') as HTMLElement;
        textSlot.appendChild(el);
      }
      liveText.textContent = t;
    } else if (liveText) {
      textSlot.replaceChildren();
      liveText = null;
    }
  };

  const renderError = () => {
    const e = state.error();
    if (e) {
      if (!errEl) {
        const el = itemFromHtml(`<div class="item"><div class="bubble error"></div></div>`);
        errEl = el.querySelector('.bubble') as HTMLElement;
        errSlot.appendChild(el);
      }
      errEl.textContent = `⚠ ${e}`;
    } else if (errEl) {
      errSlot.replaceChildren();
      errEl = null;
    }
  };

  const renderEmpty = () => {
    const isEmpty = state.messages().length === 0 && !state.thinking()
      && state.tools().length === 0 && !state.text() && !state.error();
    if (isEmpty && !emptyEl) {
      emptyEl = itemFromHtml(
        `<div class="empty-hint">Describe the problem and the agent will explore your repo.</div>`);
      stream.insertBefore(emptyEl, live);
    } else if (!isEmpty && emptyEl) {
      emptyEl.remove();
      emptyEl = null;
    }
  };

  const render = () => {
    // Pin to bottom only when the user is already there, so streaming doesn't
    // yank the view while they scroll back to read.
    const nearBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 80;
    renderEmpty();
    renderCommitted();
    renderThinking();
    renderTools();
    renderLiveText();
    renderError();
    if (nearBottom) stream.scrollTop = stream.scrollHeight;
  };

  const off = state.onChange(render);
  render();
  return () => { off(); host.removeChild(stream); };
}
