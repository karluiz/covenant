import { marked } from 'marked';
import { titleForKey } from './sections';
import type { SpecSectionKey } from './events';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ponytail: marked passes raw HTML in the source straight through (no sanitizer
// shipped). Source is our own LLM's output rendered in a local app — low risk.
// Add DOMPurify here if the agent ever echoes untrusted web/repo content.
const md = (s: string): string =>
  s ? (marked.parse(s, { async: false, breaks: true }) as string) : '';

const chip = (title: string, done: boolean) =>
  `<span class="sec-chip${done ? '' : ' pending'}">${done ? '✓' : '✎'} ${esc(title)}${done ? ' drafted' : '…'}</span>`;

/** Render assistant prose as Markdown and turn `<!--section:KEY-->…<!--/section-->`
 *  blocks into inline chips. An unclosed marker (mid-stream) hides its body and
 *  shows a pending chip; a partial opening marker tail is dropped. */
export function renderProse(text: string): string {
  const OPEN = '<!--section:';
  const CLOSE = '<!--/section-->';
  let out = '';
  let rest = text;
  for (;;) {
    const open = rest.indexOf(OPEN);
    if (open === -1) { out += md(rest); break; }
    out += md(rest.slice(0, open));
    const after = rest.slice(open + OPEN.length);
    const keyEnd = after.indexOf('-->');
    if (keyEnd === -1) break; // partial opening marker still streaming — drop tail
    const key = after.slice(0, keyEnd) as SpecSectionKey;
    const title = titleForKey(key);
    const body = after.slice(keyEnd + 3);
    const close = body.indexOf(CLOSE);
    if (close === -1) { out += chip(title, false); break; } // unclosed → pending, hide body
    out += chip(title, true);
    rest = body.slice(close + CLOSE.length);
  }
  return out;
}
