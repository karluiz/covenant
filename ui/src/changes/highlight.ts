import { EditorState } from "@codemirror/state";
import { language as languageFacet } from "@codemirror/language";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { languageForPath } from "../structure/languages";

/**
 * Replaces `textEl`'s content with syntax-highlighted token `<span>`s.
 *
 * Contract:
 * - LOSSLESS: after this runs, `textEl.textContent === code` exactly.
 * - IDEMPOTENT: safe to call multiple times on the same element.
 * - FALLBACK: on unknown language, parse error, or partial coverage the
 *   element is left untouched (plain text preserved).
 *
 * Uses `classHighlighter` from @lezer/highlight which emits stable `tok-*`
 * class names (e.g. `tok-keyword`, `tok-string`) rather than the opaque
 * hashed classes emitted by `defaultHighlightStyle`. The hashed classes rely
 * on a CodeMirror EditorView injecting its StyleModule — which never happens
 * in this standalone diff pane. The `tok-*` classes are styled in changes.css.
 */
export function highlightInto(textEl: HTMLElement, code: string, path: string): void {
  try {
    const ext = languageForPath(path, code);
    if (!ext) return; // unknown language — leave plain text

    const state = EditorState.create({ doc: code, extensions: [ext] });
    const lang = state.facet(languageFacet);
    if (!lang) return; // extension did not register a language facet

    const tree = lang.parser.parse(code);

    const frag = document.createDocumentFragment();
    let pos = 0;

    highlightTree(tree, classHighlighter, (from, to, classes) => {
      // emit any unstyled gap before this token
      if (from > pos) {
        frag.appendChild(document.createTextNode(code.slice(pos, from)));
      }
      const span = document.createElement("span");
      if (classes) span.className = classes;
      span.textContent = code.slice(from, to);
      frag.appendChild(span);
      pos = to;
    });

    // trailing unstyled text after the last token
    if (pos < code.length) {
      frag.appendChild(document.createTextNode(code.slice(pos)));
    }

    // Safety guard: only swap DOM if the fragment reproduces the full text.
    // This catches any parser/walker edge case without needing to enumerate
    // every failure mode explicitly.
    if (frag.textContent === code) {
      textEl.replaceChildren(frag);
    }
  } catch {
    // Any unexpected error (parser crash, missing DOM API in test env, etc.)
    // -- silently leave the plain text untouched.
  }
}
