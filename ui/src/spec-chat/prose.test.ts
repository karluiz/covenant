import { describe, it, expect } from 'vitest';
import { renderProse } from './prose';

describe('renderProse', () => {
  it('passes plain prose through, HTML-escaped', () => {
    expect(renderProse('a < b & c')).toBe('a &lt; b &amp; c');
  });

  it('replaces a closed section block with a done chip and keeps surrounding text', () => {
    const html = renderProse('Listo. <!--section:goal-->## Goal\nBuild it.<!--/section--> sigo');
    expect(html).toContain('Listo. ');
    expect(html).toContain('sec-chip');
    expect(html).toContain('Goal');
    expect(html).not.toContain('## Goal');
    expect(html).not.toContain('<!--');
    expect(html).toContain(' sigo');
  });

  it('hides the body of an unclosed (mid-stream) marker and shows a pending chip', () => {
    const html = renderProse('Consolidando. <!--section:goal-->## Goal\nhalf written');
    expect(html).toContain('sec-chip pending');
    expect(html).not.toContain('## Goal');
    expect(html).not.toContain('half written');
  });

  it('drops a partial opening marker tail (no key terminator yet)', () => {
    const html = renderProse('texto <!--section:go');
    expect(html).toBe('texto ');
  });
});
