import { describe, it, expect } from 'vitest';
import { renderProse } from './prose';

describe('renderProse', () => {
  it('renders plain prose as markdown, HTML-escaped', () => {
    const html = renderProse('a < b & c');
    expect(html).toContain('a &lt; b &amp; c');
    expect(html).toContain('<p>');
  });

  it('renders markdown formatting (bold, headings, lists)', () => {
    expect(renderProse('**bold**')).toContain('<strong>bold</strong>');
    expect(renderProse('## Heading')).toContain('<h2>Heading</h2>');
    const list = renderProse('- one\n- two');
    expect(list).toContain('<li>one</li>');
    expect(list).toContain('<li>two</li>');
    expect(renderProse('`code`')).toContain('<code>code</code>');
  });

  it('replaces a closed section block with a done chip and keeps surrounding text', () => {
    const html = renderProse('Listo. <!--section:goal-->## Goal\nBuild it.<!--/section--> sigo');
    expect(html).toContain('Listo.');
    expect(html).toContain('sec-chip');
    expect(html).toContain('Goal');
    expect(html).not.toContain('## Goal');
    expect(html).not.toContain('<!--');
    expect(html).toContain('sigo');
  });

  it('hides the body of an unclosed (mid-stream) marker and shows a pending chip', () => {
    const html = renderProse('Consolidando. <!--section:goal-->## Goal\nhalf written');
    expect(html).toContain('sec-chip pending');
    expect(html).not.toContain('## Goal');
    expect(html).not.toContain('half written');
  });

  it('drops a partial opening marker tail (no key terminator yet)', () => {
    const html = renderProse('texto <!--section:go');
    expect(html).toContain('texto');
    expect(html).not.toContain('<!--');
  });
});
