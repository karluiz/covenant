// In-page find highlighter for the Mission viewer modal.
//
// `highlightMatches` walks the text nodes under `root` and wraps every
// case-insensitive occurrence of `query` in a `<mark class="mv-find-hit">`,
// returning the created marks in document order so the caller can drive
// next/prev navigation. `clearMarks` reverses it, restoring plain text.
//
// Kept dependency-free and DOM-only so it works over rendered markdown
// (nested <strong>/<code>/<h2> …) as well as the raw <pre> source view.

const HIT_CLASS = "mv-find-hit";

export function highlightMatches(root: HTMLElement, query: string): HTMLElement[] {
  const marks: HTMLElement[] = [];
  if (!query) return marks;
  const needle = query.toLowerCase();

  // Collect text nodes first — mutating the tree mid-walk would invalidate
  // the walker. Skip nodes already inside a mark (defensive; callers clear
  // before re-highlighting).
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const t = node as Text;
    if (!t.nodeValue) continue;
    if (t.parentElement?.tagName === "MARK") continue;
    texts.push(t);
  }

  for (const tn of texts) {
    const text = tn.nodeValue ?? "";
    const lower = text.toLowerCase();
    if (!lower.includes(needle)) continue;

    const frag = document.createDocumentFragment();
    let last = 0;
    let idx = lower.indexOf(needle);
    while (idx !== -1) {
      if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)));
      const mark = document.createElement("mark");
      mark.className = HIT_CLASS;
      mark.textContent = text.slice(idx, idx + needle.length);
      frag.appendChild(mark);
      marks.push(mark);
      last = idx + needle.length;
      idx = lower.indexOf(needle, last);
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    tn.parentNode?.replaceChild(frag, tn);
  }

  return marks;
}

export function clearMarks(marks: HTMLElement[]): void {
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark);
    // Re-merge the adjacent text nodes so a subsequent search sees the
    // original, un-split text (matches that straddle a former mark boundary
    // would otherwise be missed).
    parent.normalize();
  }
}
