/// One-time heal for souls saved while the editor round-tripped through
/// Milkdown, which escaped markdown block syntax in the body on save
/// (## → \##, - → \-, * → \*). Those literal backslashes otherwise flow
/// straight into the executor's system prompt. Applies to the body only —
/// front-matter can hold regex deny rules (hard_constraints) where a
/// backslash is meaningful — and skips fenced code blocks.
export function healMilkdownEscapes(raw: string): string {
  const m = /^(---\n[\s\S]*?\n---\n)([\s\S]*)$/.exec(raw);
  const head = m ? m[1] : "";
  const body = m ? m[2] : raw;
  // Odd split indexes are the captured ``` fences — pass them through.
  const healed = body
    .split(/(```[\s\S]*?```)/)
    .map((seg, i) => (i % 2 ? seg : seg.replace(/\\([*#_[\]-])/g, "$1")))
    .join("");
  return head + healed;
}
