import { describe, expect, it } from 'vitest';
import { scoreSpec } from './engine';
import { makeSpecScoreBadge, makeSpecScoreChip, makeSpecScoreHoverBadge, renderBreakdown } from './badge';

describe('spec-score UI', () => {
  const s = scoreSpec('## Goal\n\nDo the thing well and completely.\n');

  it('chip renders score+grade and hides on null', () => {
    const chip = makeSpecScoreChip();
    chip.update(s);
    expect(chip.el.hidden).toBe(false);
    expect(chip.el.textContent).toContain(String(s.score));
    expect(chip.el.textContent).toContain(s.grade);
    expect(chip.el.dataset.grade).toBe(s.grade);
    chip.update(null);
    expect(chip.el.hidden).toBe(true);
  });

  it('chip click fires handler', () => {
    const chip = makeSpecScoreChip();
    let clicked = 0;
    chip.setOnClick(() => clicked++);
    chip.el.click();
    expect(clicked).toBe(1);
  });

  it('breakdown renders one row per dimension with findings', () => {
    const el = renderBreakdown(s);
    expect(el.querySelectorAll('.ssd-row')).toHaveLength(7);
    expect(el.textContent).toContain('Verifiability');
    // width proportional to earned/weight
    const bar = el.querySelector<HTMLElement>('.ssd-fill')!;
    expect(bar.style.width.endsWith('%')).toBe(true);
  });

  it('hover badge shows breakdown popover on mouseenter, hides on null update', () => {
    const b = makeSpecScoreHoverBadge();
    document.body.append(b.el);
    b.update(s);
    expect(b.el.hidden).toBe(false);
    expect(b.el.textContent).toBe(`${s.score} ${s.grade}`);
    b.el.dispatchEvent(new MouseEvent('mouseenter'));
    const pop = document.querySelector('.spec-score-pop');
    expect(pop).not.toBeNull();
    expect(pop!.querySelectorAll('.ssd-row')).toHaveLength(7);
    b.update(null);
    expect(b.el.hidden).toBe(true);
    expect(document.querySelector('.spec-score-pop')).toBeNull();
    b.el.remove();
  });

  it('badge is compact text', () => {
    const b = makeSpecScoreBadge(s);
    expect(b.textContent).toBe(`${s.score} ${s.grade}`);
    expect(b.dataset.grade).toBe(s.grade);
  });

  it('breakdown shows deep button when handler given, note when deep applied', () => {
    let called = 0;
    const el = renderBreakdown(s, { onDeep: async () => void called++ });
    const btn = el.querySelector<HTMLButtonElement>('.spec-score-deep-btn')!;
    btn.click();
    expect(called).toBe(1);
    const deepEl = renderBreakdown({ ...s, deep: true }, { onDeep: async () => {} });
    expect(deepEl.querySelector('.spec-score-deep-btn')).toBeNull();
    expect(deepEl.querySelector('.spec-score-deep-note')).not.toBeNull();
  });

  it('deep button shows pending state while onDeep runs', async () => {
    let resolve!: () => void;
    const gate = new Promise<void>((r) => (resolve = r));
    const el = renderBreakdown(s, { onDeep: () => gate });
    const btn = el.querySelector<HTMLButtonElement>('.spec-score-deep-btn')!;
    btn.click();
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe('Scoring…');
    resolve();
    await gate;
  });

  it('missing-key failure renders Open Providers door, not a red error', async () => {
    const el = renderBreakdown(s, {
      onDeep: () =>
        Promise.reject(new Error('The Summary route has no API key. Set it in Settings → Providers.')),
    });
    document.body.append(el);
    el.querySelector<HTMLButtonElement>('.spec-score-deep-btn')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(el.querySelector('.spec-score-deep-error')).toBeNull();
    const door = el.querySelector<HTMLButtonElement>('.spec-score-deep-door')!;
    expect(door.textContent).toBe('Open Providers');
    let opened = 0;
    document.addEventListener('covenant:open-providers', () => opened++, { once: true });
    door.click();
    expect(opened).toBe(1);
    el.remove();
  });

  it('deep button surfaces onDeep failure inline and re-enables', async () => {
    const el = renderBreakdown(s, {
      onDeep: () => Promise.reject(new Error('No summary model configured')),
    });
    const btn = el.querySelector<HTMLButtonElement>('.spec-score-deep-btn')!;
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('Deep score');
    const err = el.querySelector('.spec-score-deep-error');
    expect(err?.textContent).toContain('No summary model configured');
  });
});
