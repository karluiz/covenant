import './spec-score.css';
import type { SpecScore } from './engine';

export function makeSpecScoreChip(): {
  el: HTMLButtonElement;
  update(s: SpecScore | null): void;
  setOnClick(fn: () => void): void;
} {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'spec-score-chip';
  el.hidden = true;
  let onClick: (() => void) | null = null;
  el.addEventListener('click', () => onClick?.());
  return {
    el,
    update(s) {
      if (!s) {
        el.hidden = true;
        return;
      }
      el.hidden = false;
      el.dataset.grade = s.grade;
      el.textContent = '';
      const label = document.createElement('span');
      label.className = 'spec-score-chip-label';
      label.textContent = 'SpecScore';
      const value = document.createElement('span');
      value.className = 'spec-score-chip-value';
      value.textContent = `${s.score} ${s.grade}`;
      el.append(label, value);
    },
    setOnClick(fn) {
      onClick = fn;
    },
  };
}

export function makeSpecScoreBadge(s: SpecScore): HTMLSpanElement {
  const b = document.createElement('span');
  b.className = 'spec-score-badge';
  b.dataset.grade = s.grade;
  b.textContent = `${s.score} ${s.grade}`;
  return b;
}

/** Badge that reveals the full breakdown in a floating popover on hover —
 *  for read-only surfaces (doc viewer header) where a click-to-expand panel
 *  has nowhere to live. A short grace timer keeps the popover open while the
 *  pointer travels from badge to popover. */
export function makeSpecScoreHoverBadge(): {
  el: HTMLSpanElement;
  update(s: SpecScore | null): void;
} {
  const el = document.createElement('span');
  el.className = 'spec-score-badge spec-score-badge--hover';
  el.hidden = true;
  let score: SpecScore | null = null;
  let pop: HTMLElement | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  const hide = () => {
    pop?.remove();
    pop = null;
  };
  const scheduleHide = () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 150);
  };
  const show = () => {
    clearTimeout(hideTimer);
    if (pop || !score) return;
    pop = document.createElement('div');
    pop.className = 'spec-score-pop';
    pop.append(renderBreakdown(score));
    pop.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    pop.addEventListener('mouseleave', scheduleHide);
    document.body.append(pop);
    const r = el.getBoundingClientRect();
    const w = pop.offsetWidth;
    pop.style.top = `${r.bottom + 6}px`;
    pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  };
  el.addEventListener('mouseenter', show);
  el.addEventListener('mouseleave', scheduleHide);

  return {
    el,
    update(s) {
      score = s;
      if (!s) {
        el.hidden = true;
        el.textContent = '';
        hide();
        return;
      }
      el.hidden = false;
      el.dataset.grade = s.grade;
      el.textContent = `${s.score} ${s.grade}`;
      if (pop) {
        pop.replaceChildren(renderBreakdown(s));
      }
    },
  };
}

export function renderBreakdown(s: SpecScore, opts?: { onDeep?: () => Promise<void> }): HTMLElement {
  const root = document.createElement('div');
  root.className = 'spec-score-breakdown';
  for (const d of s.dimensions) {
    const row = document.createElement('div');
    row.className = 'ssd-row';
    const head = document.createElement('div');
    head.className = 'ssd-head';
    const name = document.createElement('span');
    name.className = 'ssd-name';
    name.textContent = d.label;
    const pts = document.createElement('span');
    pts.className = 'ssd-pts';
    pts.textContent = `${d.earned}/${d.weight}`;
    head.append(name, pts);
    const bar = document.createElement('div');
    bar.className = 'ssd-bar';
    const fill = document.createElement('div');
    fill.className = 'ssd-fill';
    fill.style.width = `${Math.round((100 * d.earned) / d.weight)}%`;
    fill.dataset.level = d.earned === d.weight ? 'full' : d.earned >= d.weight / 2 ? 'mid' : 'low';
    bar.append(fill);
    row.append(head, bar);
    for (const f of d.findings) {
      const li = document.createElement('div');
      li.className = 'ssd-finding';
      li.textContent = f;
      row.append(li);
    }
    root.append(row);
  }
  if (s.deep) {
    const note = document.createElement('div');
    note.className = 'spec-score-deep-note';
    note.textContent = 'Deep score applied';
    root.append(note);
  } else if (opts?.onDeep) {
    const onDeep = opts.onDeep;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'spec-score-deep-btn';
    btn.textContent = 'Deep score';
    btn.addEventListener('click', () => {
      root.querySelector('.spec-score-deep-error')?.remove();
      btn.disabled = true;
      btn.textContent = 'Scoring…';
      void onDeep()
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          // An unconfigured route is an empty state, not a failure — same
          // convention as Changes: drop the red and offer the door.
          if (msg.includes('Settings → Providers')) {
            const note = document.createElement('div');
            note.className = 'spec-score-deep-note';
            note.textContent = 'The Summary route has no API key.';
            const door = document.createElement('button');
            door.type = 'button';
            door.className = 'spec-score-deep-btn spec-score-deep-door';
            door.textContent = 'Open Providers';
            door.addEventListener('click', () =>
              document.dispatchEvent(new CustomEvent('covenant:open-providers')),
            );
            btn.replaceWith(note, door);
            return;
          }
          const line = document.createElement('div');
          line.className = 'spec-score-deep-error';
          line.textContent = msg;
          btn.after(line);
        })
        .finally(() => {
          // On success the caller re-renders the breakdown (deep:true → note),
          // so this button only survives — and needs re-enabling — on failure.
          btn.disabled = false;
          btn.textContent = 'Deep score';
        });
    });
    root.append(btn);
  }
  return root;
}
