// CodeMirror theme for the StructureEditor. Two pieces:
//
//   1. `editorTheme` — chrome (background, gutter, cursor, selection).
//      Matches the rest of Covenant's surface so the editor doesn't
//      feel imported from a different app.
//
//   2. `editorHighlight` — token colors via Lezer's HighlightStyle.
//      Tuned to read well on the dark surface; accent reuses the
//      app's purple (#b794f4) so highlight harmonises with the
//      AOM/mission chips and the version chip.

import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

const FG = "#d6d8db";
const MUTED = "#6c7280";
const ACCENT = "#b794f4";

// Token palette — small + intentional. Don't paint every token type;
// pick the meaningful axes (keyword, string, comment, name, number,
// punctuation) so files read like prose-with-emphasis instead of a
// rainbow.
const KEYWORD = "#c792ea"; // purple — control flow, fn, let, async
const STRING = "#9ccc9c"; // soft green — strings, regex
const COMMENT = "#5b6172"; // dim — comments, block doc
const NUMBER = "#f0d97a"; // amber — numbers, booleans
const TYPE = "#82b1ff"; // blue — types, classes
const FN = "#82aaff"; // blue (fn name) — slightly different shade
const VAR = FG; // identifiers stay default to keep noise low
const PUNCT = "#a0a4ad"; // grey — brackets, separators
const TAG = "#ff8aa1"; // markup tags
const ATTR = "#f0d97a"; // markup attributes

export const editorTheme = EditorView.theme(
  {
    "&": {
      color: FG,
      backgroundColor: "var(--bg, #1c1d22)",
      height: "100%",
      fontSize: "12.5px",
    },
    ".cm-content": {
      caretColor: ACCENT,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      padding: "8px 0",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: ACCENT,
      borderLeftWidth: "1.5px",
    },
    "&.cm-focused .cm-selectionBackground, ::selection": {
      backgroundColor: "rgba(183, 148, 244, 0.22)",
    },
    ".cm-selectionMatch": {
      backgroundColor: "rgba(183, 148, 244, 0.12)",
    },
    ".cm-activeLine": {
      backgroundColor: "rgba(255, 255, 255, 0.025)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "rgba(255, 255, 255, 0.04)",
      color: FG,
    },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: MUTED,
      borderRight: "1px solid var(--border, #2b2d33)",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      padding: "0 12px 0 8px",
      minWidth: "2em",
      fontVariantNumeric: "tabular-nums",
    },
    ".cm-foldPlaceholder": {
      backgroundColor: "rgba(255,255,255,0.05)",
      color: MUTED,
      border: "1px solid var(--border, #2b2d33)",
    },
    ".cm-tooltip": {
      backgroundColor: "var(--bg-overlay, #232528)",
      border: "1px solid var(--border, #2b2d33)",
      color: FG,
    },
    // Search panel — anchors at the bottom of the editor, picks up
    // the same chrome as the operator/release modals so it feels
    // native to Covenant rather than CM6 default.
    ".cm-panels": {
      backgroundColor: "var(--bg-overlay, #232528)",
      color: FG,
      borderTop: "1px solid var(--border, #2b2d33)",
    },
    ".cm-panels.cm-panels-bottom": {
      borderTop: "1px solid var(--border, #2b2d33)",
    },
    // Search panel — compact single-row layout. Default CM6 stacks
    // find / replace on two rows with wide inputs; we wrap, shrink the
    // controls and let everything sit on one (or two on narrow widths)
    // line so the panel doesn't eat vertical space above the file.
    ".cm-panel.cm-search": {
      display: "flex",
      flexWrap: "wrap",
      alignItems: "center",
      gap: "4px",
      padding: "6px 8px",
      fontSize: "11px",
    },
    ".cm-panel.cm-search br": { display: "none" },
    ".cm-panel.cm-search label": {
      display: "inline-flex",
      alignItems: "center",
      gap: "3px",
      fontSize: "10.5px",
      color: MUTED,
    },
    ".cm-panel.cm-search input[type=checkbox]": {
      margin: "0 2px 0 0",
    },
    ".cm-textfield": {
      backgroundColor: "var(--bg, #1c1d22)",
      border: "1px solid var(--border, #2b2d33)",
      color: FG,
      padding: "2px 6px",
      borderRadius: "4px",
      fontSize: "11px",
    },
    ".cm-panel.cm-search .cm-textfield": {
      width: "180px",
      flex: "0 1 180px",
    },
    ".cm-button": {
      backgroundColor: "transparent",
      border: "1px solid var(--border, #2b2d33)",
      color: MUTED,
      padding: "2px 8px",
      borderRadius: "4px",
      fontSize: "11px",
      cursor: "pointer",
      backgroundImage: "none",
    },
    ".cm-panel.cm-search .cm-button": {
      padding: "2px 6px",
      fontSize: "10.5px",
    },
    ".cm-button:hover": {
      color: FG,
    },
    // Close button — JS replaces its `×` glyph with the same lucide-X
    // icon used in the editor header so both X buttons read identical.
    // Position mirrors the header close (top-right, 14px square).
    ".cm-panel.cm-search button[name=close]": {
      position: "absolute",
      top: "8px",
      right: "10px",
      width: "20px",
      height: "20px",
      padding: "0",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      background: "transparent",
      border: "1px solid transparent",
      borderRadius: "3px",
      color: MUTED,
      cursor: "pointer",
      lineHeight: "1",
    },
    ".cm-panel.cm-search button[name=close]:hover": {
      color: FG,
      borderColor: "var(--border, #2b2d33)",
    },
    ".cm-panel.cm-search button[name=close] svg": {
      display: "block",
    },
  },
  { dark: true },
);

export const editorHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], color: KEYWORD },
    { tag: [t.string, t.special(t.string), t.regexp], color: STRING },
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: COMMENT, fontStyle: "italic" },
    { tag: [t.number, t.bool, t.null, t.atom], color: NUMBER },
    { tag: [t.typeName, t.className, t.namespace], color: TYPE },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: FN },
    { tag: [t.variableName, t.propertyName], color: VAR },
    { tag: [t.punctuation, t.bracket, t.brace, t.paren], color: PUNCT },
    { tag: [t.operator, t.derefOperator, t.logicOperator, t.compareOperator], color: PUNCT },
    { tag: [t.tagName, t.angleBracket], color: TAG },
    { tag: [t.attributeName], color: ATTR },
    { tag: [t.attributeValue], color: STRING },
    { tag: [t.heading, t.heading1, t.heading2, t.heading3], color: ACCENT, fontWeight: "600" },
    { tag: [t.link, t.url], color: FN, textDecoration: "underline" },
    { tag: [t.emphasis], fontStyle: "italic" },
    { tag: [t.strong], fontWeight: "600", color: FG },
    { tag: [t.meta, t.processingInstruction], color: MUTED },
    { tag: [t.invalid], color: "#ff8a8a", textDecoration: "underline wavy" },
  ]),
);
