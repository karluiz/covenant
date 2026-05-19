// CodeMirror theme for the StructureEditor. Now ships two variants
// (dark + light) since Covenant supports both themes. The light
// variant uses GitHub-Light-adjacent token colors so files read like
// the rest of the chrome.
//
//   1. `editorTheme(mode)` — chrome (background, gutter, cursor, selection).
//   2. `editorHighlight(mode)` — token colors via Lezer's HighlightStyle.
//
// Callers should consume these via a `Compartment` so the editor can
// hot-swap on theme change without re-mounting.

import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";

export type ThemePaletteMode = "dark" | "light";

interface Palette {
  fg: string;
  muted: string;
  accent: string;
  keyword: string;
  string: string;
  comment: string;
  number: string;
  type: string;
  fn: string;
  punct: string;
  tag: string;
  attr: string;
  invalid: string;
  selection: string;
  selectionMatch: string;
  activeLine: string;
  activeLineGutter: string;
  foldBg: string;
}

const DARK: Palette = {
  fg: "#d6d8db",
  muted: "#6c7280",
  accent: "#b794f4",
  keyword: "#c792ea",
  string: "#9ccc9c",
  comment: "#5b6172",
  number: "#f0d97a",
  type: "#82b1ff",
  fn: "#82aaff",
  punct: "#a0a4ad",
  tag: "#ff8aa1",
  attr: "#f0d97a",
  invalid: "#ff8a8a",
  selection: "rgba(183, 148, 244, 0.22)",
  selectionMatch: "rgba(183, 148, 244, 0.12)",
  activeLine: "rgba(255, 255, 255, 0.025)",
  activeLineGutter: "rgba(255, 255, 255, 0.04)",
  foldBg: "rgba(255,255,255,0.05)",
};

// GitHub Light-inspired palette. Selected for high contrast on a
// near-white surface (#fafbfc) while keeping the accent purple aligned
// with the rest of the app's chrome.
const LIGHT: Palette = {
  fg: "#1a1d22",
  muted: "#6b7280",
  accent: "#6f42c1",
  keyword: "#cf222e",
  string: "#0a3069",
  comment: "#6e7781",
  number: "#0550ae",
  type: "#953800",
  fn: "#8250df",
  punct: "#57606a",
  tag: "#116329",
  attr: "#0550ae",
  invalid: "#cf222e",
  selection: "rgba(132, 124, 244, 0.18)",
  selectionMatch: "rgba(132, 124, 244, 0.12)",
  activeLine: "rgba(0, 0, 0, 0.03)",
  activeLineGutter: "rgba(0, 0, 0, 0.05)",
  foldBg: "rgba(0,0,0,0.05)",
};

function paletteFor(mode: ThemePaletteMode): Palette {
  return mode === "light" ? LIGHT : DARK;
}

export function editorTheme(mode: ThemePaletteMode): Extension {
  const p = paletteFor(mode);
  return EditorView.theme(
    {
      "&": {
        color: p.fg,
        backgroundColor: "var(--bg, #1c1d22)",
        height: "100%",
        fontSize: "12.5px",
      },
      ".cm-content": {
        caretColor: p.accent,
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
        padding: "8px 0",
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: p.accent,
        borderLeftWidth: "1.5px",
      },
      "&.cm-focused .cm-selectionBackground, ::selection": {
        backgroundColor: p.selection,
      },
      ".cm-selectionMatch": { backgroundColor: p.selectionMatch },
      ".cm-activeLine": { backgroundColor: p.activeLine },
      ".cm-activeLineGutter": {
        backgroundColor: p.activeLineGutter,
        color: p.fg,
      },
      ".cm-gutters": {
        backgroundColor: "transparent",
        color: p.muted,
        borderRight: "1px solid var(--border, #2b2d33)",
      },
      ".cm-lineNumbers .cm-gutterElement": {
        padding: "0 12px 0 8px",
        minWidth: "2em",
        fontVariantNumeric: "tabular-nums",
      },
      ".cm-foldPlaceholder": {
        backgroundColor: p.foldBg,
        color: p.muted,
        border: "1px solid var(--border, #2b2d33)",
      },
      ".cm-tooltip": {
        backgroundColor: "var(--bg-overlay, #232528)",
        border: "1px solid var(--border, #2b2d33)",
        color: p.fg,
      },
      ".cm-panels": {
        backgroundColor: "var(--bg-overlay, #232528)",
        color: p.fg,
        borderTop: "1px solid var(--border, #2b2d33)",
      },
      ".cm-panels.cm-panels-bottom": {
        borderTop: "1px solid var(--border, #2b2d33)",
      },
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
        color: p.muted,
      },
      ".cm-panel.cm-search input[type=checkbox]": { margin: "0 2px 0 0" },
      ".cm-textfield": {
        backgroundColor: "var(--bg, #1c1d22)",
        border: "1px solid var(--border, #2b2d33)",
        color: p.fg,
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
        color: p.muted,
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
      ".cm-button:hover": { color: p.fg },
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
        color: p.muted,
        cursor: "pointer",
        lineHeight: "1",
      },
      ".cm-panel.cm-search button[name=close]:hover": {
        color: p.fg,
        borderColor: "var(--border, #2b2d33)",
      },
      ".cm-panel.cm-search button[name=close] svg": { display: "block" },
    },
    { dark: mode === "dark" },
  );
}

export function editorHighlight(mode: ThemePaletteMode): Extension {
  const p = paletteFor(mode);
  return syntaxHighlighting(
    HighlightStyle.define([
      { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], color: p.keyword },
      { tag: [t.string, t.special(t.string), t.regexp], color: p.string },
      { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: p.comment, fontStyle: "italic" },
      { tag: [t.number, t.bool, t.null, t.atom], color: p.number },
      { tag: [t.typeName, t.className, t.namespace], color: p.type },
      { tag: [t.function(t.variableName), t.function(t.propertyName)], color: p.fn },
      { tag: [t.variableName, t.propertyName], color: p.fg },
      { tag: [t.punctuation, t.bracket, t.brace, t.paren], color: p.punct },
      { tag: [t.operator, t.derefOperator, t.logicOperator, t.compareOperator], color: p.punct },
      { tag: [t.tagName, t.angleBracket], color: p.tag },
      { tag: [t.attributeName], color: p.attr },
      { tag: [t.attributeValue], color: p.string },
      { tag: [t.heading, t.heading1, t.heading2, t.heading3], color: p.accent, fontWeight: "600" },
      { tag: [t.link, t.url], color: p.fn, textDecoration: "underline" },
      { tag: [t.emphasis], fontStyle: "italic" },
      { tag: [t.strong], fontWeight: "600", color: p.fg },
      { tag: [t.meta, t.processingInstruction], color: p.muted },
      { tag: [t.invalid], color: p.invalid, textDecoration: "underline wavy" },
    ]),
  );
}

/// Convenience — resolve the current document theme from the body class.
export function currentEditorMode(): ThemePaletteMode {
  return document.body.classList.contains("theme-light") ? "light" : "dark";
}
